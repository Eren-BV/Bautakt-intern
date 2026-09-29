/**
 * Schreibende Jarvis-Werkzeuge. Jarvis handelt mit den Rechten des angemeldeten Nutzers und führt
 * jede Anweisung sofort aus - ohne Rückfrage, denn jede Änderung bleibt über den Rückgängig-Chip
 * an der Schrittzeile rücknehmbar. Ohne Planrechte wird aus einer Terminänderung ein Vorschlag an
 * die Projektleitung statt einer direkten Änderung.
 */

import { newId, nowISO } from '../../db.ts'
import { Repo } from '../../repo.ts'
import { ProjectService } from '../../services/projectService.ts'
import { pushNotification } from '../../services/notificationService.ts'
import { broadcastProject } from '../../services/realtime.ts'
import { decideProposal } from '../../services/proposalService.ts'
import { generatePlanFromBrief } from '../../services/aiPlanService.ts'
import type { ChangeProposal, CreateProjectRequest, DelayReason, ISODate, PlanningKind, ProjectBundle, ProjectTemplate, SiteFlag, Task } from '../../../shared/types.ts'
import { PLANNING_KIND_LABELS } from '../../../shared/labels.ts'
import { addDependency, createTask, deleteTasks, moveTask, moveTasks, recompute, setDuration, setEndDate, updateTaskFields, type PlanContext, type PlanState } from '../../../shared/engine/operations.ts'
import { addDays, fromDayNumber, toDayNumber } from '../../../shared/engine/dates.ts'
import { instantiateTemplate } from '../../../shared/templates/instantiate.ts'
import { extractedToTemplateTasks, type ExtractedPlan } from '../../../shared/integrations/planextract/types.ts'
import { fetchLucidPlan } from '../../services/lucidService.ts'
import { MailboxService } from '../../services/mailboxService.ts'
import { uploadBytes } from '../../services/storage.ts'
import { resolveOne } from '../resolve.ts'
import { applyPlanUndo, finishAction, latestUndoable, latestUndoableChain, planDiff, recordAction, type JarvisAction, type JarvisUndo } from '../actions.ts'
import {
  allowed, commitPlan, count, findCompany, findPerson, findProject, findTask, findTasks, forbidden, int, isoDate, planContextFor, projectCalendar,
  projectPath, s, shortDate, spokenDate, str, summarizeImpact, taskView, withConflictRetry, type Args, type ToolCtx, type ToolDef, type ToolResult,
} from './common.ts'

const DELAY_REASONS: DelayReason[] = ['weather', 'material', 'staff', 'subcontractor', 'predecessor', 'planning', 'client', 'authority', 'delivery', 'other']

// ---------------------------------------------------------------- Termin ändern

export const changeSchedule: ToolDef = {
  name: 'change_schedule',
  description: 'Termin eines Vorgangs ändern: neuer Start, neues Ende, neue Dauer ODER Verschiebung um Arbeitstage. Nachfolger wandern automatisch mit (außer only_this_task). Liefert die neuen Termine und die Auswirkung auf Projektende und Meilensteine.',
  parameters: s.object({
    project: s.nstr('Projekt-ID oder Name; null = aktuelles Projekt'),
    task: s.nstr('Vorgang-ID (bevorzugt), laufende Vorgangsnummer oder Name; null = ausgewählter Vorgang'),
    new_start: s.nstr('Neuer Start JJJJ-MM-TT'),
    new_end: s.nstr('Neues Ende JJJJ-MM-TT'),
    duration_workdays: s.nint('Neue Dauer in Arbeitstagen'),
    shift_workdays: s.nint('Verschiebung in Arbeitstagen: positiv = später, negativ = früher'),
    only_this_task: s.bool('true = Nachfolger nicht mitverschieben'),
    reason: s.nstr('Kurzer Grund, erscheint in der Historie'),
  }),
  label: () => 'Ändere Termin …',
  async run(ctx, a) {
    const canEdit = allowed(ctx, 'plan.edit')
    if (!canEdit && !allowed(ctx, 'site.update')) return forbidden('Du darfst keine Termine ändern oder vorschlagen.')
    const pr = await findProject(ctx, a.project)
    if (pr.result) return pr.result
    const svc = new ProjectService(ctx.db)
    return withConflictRetry(async (attempt) => {
      const bundle = await svc.requireBundle(ctx.session.org.id, pr.item.id)
      const tr = findTask(ctx, bundle, a.task)
      if (tr.result) return tr.result
      const task = tr.item
      const pctx = planContextFor(ctx, bundle)
      const before: PlanState = { tasks: bundle.tasks, dependencies: bundle.dependencies }
      const cascade = a.only_this_task !== true
      const shift = int(a.shift_workdays)
      const newStart = isoDate(a.new_start)
      const newEnd = isoDate(a.new_end)
      const duration = int(a.duration_workdays)
      let after = before
      if (shift) after = moveTasks(after, pctx, [task.id], shift, cascade)
      if (newStart) after = moveTask(after, pctx, task.id, newStart, cascade)
      if (duration !== null && duration > 0) after = setDuration(after, pctx, task.id, duration, cascade)
      if (newEnd) after = setEndDate(after, pctx, task.id, newEnd, cascade)
      if (after === before) return { ok: false, status: 'invalid', message: 'Keine Änderung angegeben – Start, Ende, Dauer oder Verschiebung fehlt.' }
      const target = after.tasks.find((t) => t.id === task.id)!
      const impact = summarizeImpact(bundle, before, after, pctx)
      const what = `„${task.name}“ ${shortDate(target.start_date)}–${shortDate(target.end_date)}`
      if (attempt === 0) {
        ctx.emit({ type: 'tool_update', id: ctx.callId, label: `Ändere ${what} …` })
        ctx.emit({ type: 'ui', action: 'focus_task', project_id: bundle.project.id, task_id: task.id, open_drawer: false })
      }

      if (!canEdit) return proposeInstead(ctx, bundle.project.id, bundle.project.name, task, target, str(a.reason))

      const summary = `${what} · ${impact.moved > 1 ? count(impact.moved - 1, 'Folgevorgang angepasst', 'Folgevorgänge angepasst') : 'keine Folgevorgänge betroffen'} · ${impact.project_end_shift_workdays === 0 ? 'Projektende unverändert' : `Projektende ${shortDate(impact.project_end_new)}`}`
      const { action_id } = await commitPlan(ctx, bundle, before, after, {
        tool: 'change_schedule', args: a, reason: str(a.reason) ?? `${task.name} geändert`, summary, highlight: [task.id, ...after.tasks.filter((t) => t.id !== task.id && changedDates(bundle.tasks, t)).map((t) => t.id)],
      })
      return { ok: true, summary, action_id, undoable: true, task: taskView(target), impact: stripRows(impact), link: { label: 'Im Plan ansehen', to: `${projectPath(bundle.project.id, 'gantt')}?task=${task.id}` } }
    })
  },
}

function changedDates(before: Task[], t: Task): boolean {
  const old = before.find((x) => x.id === t.id)
  return !!old && (old.start_date !== t.start_date || old.end_date !== t.end_date)
}

function stripRows(impact: ReturnType<typeof summarizeImpact>) {
  const { rows: _rows, ...rest } = impact
  return { ...rest, project_end_new_text: spokenDate(impact.project_end_new) }
}

/** Ohne Planrechte: Änderung als Vorschlag an die Projektleitung. */
async function proposeInstead(ctx: ToolCtx, projectId: string, projectName: string, task: Task, target: Task, reason: string | null): Promise<ToolResult> {
  const p: ChangeProposal = {
    id: newId('cp'), project_id: projectId, task_id: task.id, source: 'FUTURE_AI', status: 'open',
    title: `${task.name}: ${shortDate(target.start_date)} – ${shortDate(target.end_date)}`,
    proposed_start: target.start_date !== task.start_date ? target.start_date : null,
    proposed_end: target.end_date !== task.end_date ? target.end_date : null,
    operations: [], reason: 'ai', comment: reason ?? '', submitted_by_name: `${ctx.session.user.name} (über Jarvis)`, submitted_by_user_id: ctx.session.user.id,
    share_link_id: null, origin_kind: 'ai', origin_ref: null, created_at: nowISO(), decided_at: null, decided_by: null, decision_note: '',
  }
  await ctx.db.insert('change_proposals', p)
  await broadcastProject(ctx.session.org.id, projectId, 'proposal')
  await pushNotification(ctx.db, {
    org_id: ctx.session.org.id, project_id: projectId, type: 'info', severity: 'info',
    title: `Änderungsvorschlag von ${ctx.session.user.name}`,
    message: `${projectName}: „${task.name}“ ${shortDate(target.start_date)} – ${shortDate(target.end_date)} (über Jarvis). Bitte prüfen.`,
  })
  return { ok: true, proposal_created: true, summary: 'Vorschlag an die Projektleitung geschickt', message: 'Keine Planrechte – als Änderungsvorschlag an die Projektleitung geschickt.', link: { label: 'Vorschläge', to: projectPath(projectId, 'proposals') } }
}

// ---------------------------------------------------------------- Vorgang anlegen

export const createTaskTool: ToolDef = {
  name: 'create_task',
  description: 'Neuen Vorgang (Aufgabe) oder Meilenstein anlegen, optional mit Vorgänger, Termin und Verantwortlichem. Ohne Datum beginnt er frühestens am nächsten Arbeitstag. Der Verantwortliche wird benachrichtigt.',
  parameters: s.object({
    project: s.nstr('Projekt-ID oder Name; null = aktuelles Projekt'),
    name: s.str('Bezeichnung des Vorgangs'),
    type: s.nenum(['task', 'milestone'], 'Standard: task'),
    start_date: s.nstr('Start JJJJ-MM-TT'),
    end_date: s.nstr('Ende JJJJ-MM-TT'),
    duration_workdays: s.nint('Dauer in Arbeitstagen (schätzen, wenn nicht genannt)'),
    predecessor: s.nstr('Vorgang (ID, Vorgangsnummer oder Name), nach dem dieser beginnt'),
    lag_workdays: s.nint('Wartezeit nach dem Vorgänger in Arbeitstagen'),
    parent: s.nstr('Phase/Gruppe (ID oder Name), unter der der Vorgang liegt'),
    responsible: s.nstr('Verantwortliche Person (Name oder E-Mail)'),
    company: s.nstr('Ausführende Firma'),
    note: s.nstr('Notiz'),
  }),
  label: (a) => `Lege „${String(a.name ?? '')}“ an …`,
  async run(ctx, a) {
    if (!allowed(ctx, 'plan.edit')) return forbidden('Neue Aufgaben anlegen darf nur, wer den Terminplan bearbeiten darf.')
    const name = str(a.name)
    if (!name) return { ok: false, status: 'invalid', message: 'Name der Aufgabe fehlt.' }
    const pr = await findProject(ctx, a.project)
    if (pr.result) return pr.result
    const person = str(a.responsible) ? await findPerson(ctx, a.responsible) : null
    if (person?.result) return person.result
    const company = str(a.company) ? await findCompany(ctx, a.company) : null
    if (company?.result) return company.result
    const svc = new ProjectService(ctx.db)

    return withConflictRetry(async () => {
      const bundle = await svc.requireBundle(ctx.session.org.id, pr.item.id)
      const pctx = planContextFor(ctx, bundle)
      const cal = projectCalendar(bundle)
      let parentId: string | null = null
      let afterId: string | null = null
      let predecessor: Task | null = null
      if (str(a.predecessor)) {
        const r = findTask(ctx, bundle, a.predecessor)
        if (r.result) return r.result
        predecessor = r.item
        parentId = predecessor.parent_id
        afterId = predecessor.id
      }
      if (str(a.parent)) {
        const r = findTask(ctx, bundle, a.parent)
        if (r.result) return r.result
        parentId = r.item.id
        afterId = null
      }
      const type = a.type === 'milestone' ? 'milestone' : 'task'
      const earliest = fromDayNumber(cal.nextWorkday(Math.max(toDayNumber(ctx.today), toDayNumber(bundle.project.start_date))))
      let start = isoDate(a.start_date)
      const end = isoDate(a.end_date)
      let duration = type === 'milestone' ? 0 : int(a.duration_workdays)
      if (end && !start && duration) start = fromDayNumber(cal.addWorkdays(cal.prevWorkday(toDayNumber(end)), -(duration - 1)))
      if (end && !duration && type !== 'milestone') duration = Math.max(1, cal.countWorkdays(toDayNumber(start ?? earliest), toDayNumber(end)))
      if (duration === null) duration = 1

      const id = newId('t')
      const before: PlanState = { tasks: bundle.tasks, dependencies: bundle.dependencies }
      let state = createTask(before, pctx, { id, name, type, parent_id: parentId, after_id: afterId, duration, start_date: start ?? undefined })
      if (predecessor) {
        const r = addDependency(state, pctx, { id: newId('dep'), predecessor_id: predecessor.id, successor_id: id, type: 'FS', lag_days: Math.max(0, int(a.lag_workdays) ?? 0) })
        if (r.error) return { ok: false, status: 'invalid', message: r.error }
        state = r.state
      }
      // Ohne festen Termin: frühestens ab heute, der Vorgänger kann ihn weiter nach hinten schieben.
      if (!start) state = updateTaskFields(state, pctx, id, { constraint_type: 'snet', constraint_date: earliest })
      const patch: Partial<Task> = {}
      if (person?.item) {
        patch.responsible_user_id = person.item.user_id
        patch.responsible_user_ids = [person.item.user_id]
      }
      if (company?.item) patch.company_id = company.item.id
      if (str(a.note)) patch.notes = str(a.note)!
      if (Object.keys(patch).length) state = updateTaskFields(state, pctx, id, patch)

      const created = state.tasks.find((t) => t.id === id)!
      const impact = summarizeImpact(bundle, before, state, pctx)
      if (predecessor) ctx.emit({ type: 'ui', action: 'focus_task', project_id: bundle.project.id, task_id: predecessor.id, open_drawer: false })
      const who = person?.item ? ` · ${person.item.user.name}` : company?.item ? ` · ${company.item.name}` : ''
      const summary = `Angelegt: „${name}“ ${shortDate(created.start_date)}–${shortDate(created.end_date)}${who}`
      const { action_id } = await commitPlan(ctx, bundle, before, state, { tool: 'create_task', args: a, reason: `„${name}“ angelegt`, summary, highlight: [id] })
      ctx.emit({ type: 'ui', action: 'focus_task', project_id: bundle.project.id, task_id: id, open_drawer: false })
      if (person?.item && person.item.user_id !== ctx.session.user.id) await notifyAssignment(ctx, bundle.project.id, bundle.project.name, created, person.item.user_id, null)
      return {
        ok: true, summary: person?.item && person.item.user_id !== ctx.session.user.id ? `${summary} · benachrichtigt` : summary, action_id, undoable: true,
        task: taskView(created), responsible: person?.item?.user.name ?? company?.item?.name ?? null, impact: stripRows(impact),
        link: { label: 'Im Plan ansehen', to: `${projectPath(bundle.project.id, 'gantt')}?task=${id}` },
      }
    })
  },
}

async function notifyAssignment(ctx: ToolCtx, projectId: string, projectName: string, task: Task, userId: string, message: string | null) {
  await pushNotification(ctx.db, {
    org_id: ctx.session.org.id,
    user_id: userId,
    project_id: projectId,
    type: 'task_assigned',
    severity: 'info',
    title: `Neue Aufgabe: ${task.name}`,
    message: `${ctx.session.user.name} hat dir „${task.name}“ zugewiesen (${projectName}, ${shortDate(task.start_date)} – ${shortDate(task.end_date)}).${message ? ` ${message}` : ''}`,
    channels: ['in_app', 'email'],
  })
}

// ---------------------------------------------------------------- Zuweisen

export const assignTask: ToolDef = {
  name: 'assign_task',
  description: 'Einem Vorgang eine verantwortliche Person oder ausführende Firma zuweisen. Die Person wird benachrichtigt.',
  parameters: s.object({
    project: s.nstr('Projekt-ID oder Name; null = aktuelles Projekt'),
    task: s.nstr('Vorgang-ID, laufende Vorgangsnummer oder Name; null = ausgewählter Vorgang'),
    person: s.nstr('Person (Name oder E-Mail)'),
    company: s.nstr('Firma'),
    mode: s.nenum(['replace', 'add'], 'replace = ersetzt bisherige Verantwortliche (Standard), add = zusätzlich'),
    message: s.nstr('Kurze Nachricht an die Person'),
  }),
  label: () => 'Weise Verantwortung zu …',
  async run(ctx, a) {
    if (!allowed(ctx, 'plan.edit')) return forbidden('Zuweisen darf nur, wer den Terminplan bearbeiten darf.')
    if (!str(a.person) && !str(a.company)) return { ok: false, status: 'invalid', message: 'Wem soll die Aufgabe zugewiesen werden?' }
    const pr = await findProject(ctx, a.project)
    if (pr.result) return pr.result
    const person = str(a.person) ? await findPerson(ctx, a.person) : null
    if (person?.result) return person.result
    const company = str(a.company) ? await findCompany(ctx, a.company) : null
    if (company?.result) return company.result
    const svc = new ProjectService(ctx.db)
    return withConflictRetry(async (attempt) => {
      const bundle = await svc.requireBundle(ctx.session.org.id, pr.item.id)
      const tr = findTask(ctx, bundle, a.task)
      if (tr.result) return tr.result
      const task = tr.item
      const who = person?.item?.user.name ?? company?.item?.name ?? ''
      if (attempt === 0) {
        ctx.emit({ type: 'tool_update', id: ctx.callId, label: `Weise „${task.name}“ ${who} zu …` })
        ctx.emit({ type: 'ui', action: 'focus_task', project_id: bundle.project.id, task_id: task.id, open_drawer: true })
      }
      const patch: Partial<Task> = {}
      if (person?.item) {
        const ids = a.mode === 'add' ? [...new Set([...(task.responsible_user_ids ?? []), person.item.user_id])] : [person.item.user_id]
        patch.responsible_user_ids = ids
        patch.responsible_user_id = ids[0] ?? null
        if (a.mode !== 'add') patch.responsible_name = ''
      }
      if (company?.item) patch.company_id = company.item.id
      const pctx = planContextFor(ctx, bundle)
      const before: PlanState = { tasks: bundle.tasks, dependencies: bundle.dependencies }
      const after = updateTaskFields(before, pctx, task.id, patch)
      const summary = `${who} ist verantwortlich für „${task.name}“`
      const { action_id } = await commitPlan(ctx, bundle, before, after, { tool: 'assign_task', args: a, reason: `${task.name}: ${who} zugewiesen`, summary, highlight: [task.id] })
      const notify = person?.item && person.item.user_id !== ctx.session.user.id
      if (notify) await notifyAssignment(ctx, bundle.project.id, bundle.project.name, after.tasks.find((t) => t.id === task.id)!, person!.item!.user_id, str(a.message))
      return { ok: true, summary: notify ? `${summary} · benachrichtigt` : summary, action_id, undoable: true, task: taskView(task) }
    })
  },
}

// ---------------------------------------------------------------- Fortschritt melden

export const reportProgress: ToolDef = {
  name: 'report_progress',
  description: 'Vor-Ort-Meldung zu einem Vorgang: erledigt, im Plan (mit Fortschritt), gefährdet oder verzögert (mit Grund und neuem Ende). Verzögerungen verschieben die Nachfolger automatisch.',
  parameters: s.object({
    project: s.nstr('Projekt-ID oder Name; null = aktuelles Projekt'),
    task: s.nstr('Vorgang-ID, laufende Vorgangsnummer oder Name; null = ausgewählter Vorgang'),
    status: s.enum(['done', 'on_track', 'at_risk', 'delayed'], 'done = erledigt, on_track = läuft nach Plan, at_risk = gefährdet, delayed = verzögert'),
    progress_percent: s.nint('Fortschritt 0–100'),
    delay_reason: s.nenum(DELAY_REASONS, 'Grund bei gefährdet/verzögert'),
    new_end: s.nstr('Neues voraussichtliches Ende JJJJ-MM-TT (bei Verzögerung)'),
    comment: s.nstr('Kommentar'),
  }),
  label: () => 'Melde Stand …',
  async run(ctx, a) {
    if (!allowed(ctx, 'site.update')) return forbidden('Du darfst keine Vor-Ort-Meldungen abgeben.')
    const pr = await findProject(ctx, a.project)
    if (pr.result) return pr.result
    const svc = new ProjectService(ctx.db)
    const bundle = await svc.requireBundle(ctx.session.org.id, pr.item.id)
    const tr = findTask(ctx, bundle, a.task)
    if (tr.result) return tr.result
    const task = tr.item
    const flag = (['done', 'on_track', 'at_risk', 'delayed'].includes(String(a.status)) ? a.status : 'on_track') as SiteFlag
    const labels: Record<SiteFlag, string> = { done: 'erledigt', on_track: 'im Plan', at_risk: 'gefährdet', delayed: 'verzögert' }
    ctx.emit({ type: 'tool_update', id: ctx.callId, label: `Melde „${task.name}“ als ${labels[flag]} …` })
    const progress = int(a.progress_percent)
    const res = await svc.siteUpdate(ctx.session, bundle.project.id, task.id, {
      flag,
      progress: progress === null ? undefined : Math.max(0, Math.min(100, progress)),
      comment: str(a.comment) ?? '',
      delay_reason: DELAY_REASONS.includes(a.delay_reason as DelayReason) ? (a.delay_reason as DelayReason) : null,
      new_forecast_end: isoDate(a.new_end),
    })
    ctx.writes.count++
    const pctx = planContextFor(ctx, bundle)
    const before: PlanState = { tasks: bundle.tasks, dependencies: bundle.dependencies }
    const after: PlanState = { tasks: res.tasks, dependencies: bundle.dependencies }
    const impact = summarizeImpact(bundle, before, after, pctx)
    const summary =`„${task.name}“ ${labels[flag]}${impact.project_end_shift_workdays ? ` · Projektende ${shortDate(impact.project_end_new)}` : ''}`
    const action_id = await recordAction(ctx.db, ctx.session, { conversation_id: ctx.conversationId, project_id: bundle.project.id, tool: 'report_progress', args: a, status: 'done', summary, version_after: res.version, undo: planDiff(before, after) })
    ctx.emit({ type: 'ui', action: 'reload_project', project_id: bundle.project.id, version: res.version })
    ctx.emit({ type: 'ui', action: 'highlight', project_id: bundle.project.id, task_ids: [task.id] })
    ctx.emit({ type: 'ui', action: 'data_changed', scope: 'site' })
    const updated = res.tasks.find((t) => t.id === task.id)
    const ready = res.tasks.filter((t) => bundle.dependencies.some((d) => d.predecessor_id === task.id && d.successor_id === t.id) && t.status === 'not_started').map((t) => t.name)
    return { ok: true, summary, action_id, undoable: true, task: updated ? taskView(updated) : null, impact: stripRows(impact), next_tasks: flag === 'done' ? ready.slice(0, 3) : [] }
  },
}

// ---------------------------------------------------------------- Projekt anlegen

/** Vorbereiteter Stand, aus dem finalizeCreate das Projekt anlegt (leer/Vorlage sofort, KI-Plan nach Bestätigung). */
type CreateProjectPreview = {
  start: ISODate
  end: ISODate
  source: CreateProjectRequest['plan_source']
  template: Pick<ProjectTemplate, 'planning_kind' | 'project_type' | 'construction_method'> | null
  /** Explizit vom Nutzer genannte Art (überstimmt die Vorlage); ohne Angabe/Vorlage Standard 'internal'. */
  kind: PlanningKind | null
}

/** Legt das Projekt tatsächlich an und protokolliert die (bereits erledigte) Aktion samt Rückgängig-Daten. */
async function finalizeCreate(ctx: ToolCtx, repo: Repo, orgId: string, name: string, a: Args, stored: CreateProjectPreview): Promise<ToolResult> {
  ctx.emit({ type: 'tool_update', id: ctx.callId, label: `Lege Projekt „${name}“ an …` })
  const planningKind = stored.kind ?? stored.template?.planning_kind ?? 'internal'
  const project = await new ProjectService(ctx.db).createProject(ctx.session, {
    number: '', name, customer: str(a.customer) ?? '', address: str(a.address) ?? '', city: str(a.city) ?? '',
    project_manager_id: ctx.session.user.id, site_manager_id: null,
    planning_kind: planningKind, project_type: stored.template?.project_type ?? 'individuell', construction_method: stored.template?.construction_method ?? 'individuell',
    start_date: stored.start, target_end_date: stored.end, area_sqm: null, floors: null, has_basement: false, plan_source: stored.source,
  })
  ctx.writes.count++
  const fresh = await repo.project(orgId, project.id)
  const summary = `Projekt „${name}“ angelegt`
  const undo: JarvisUndo = { kind: 'delete_project', project_id: project.id }
  const action_id = await recordAction(ctx.db, ctx.session, { conversation_id: ctx.conversationId, project_id: project.id, tool: 'create_project', args: a, status: 'done', summary, version_after: fresh?.version ?? 1, undo })
  ctx.emit({ type: 'ui', action: 'navigate', to: projectPath(project.id, 'gantt') })
  ctx.emit({ type: 'ui', action: 'data_changed', scope: 'projects' })
  return { ok: true, summary: 'Projekt angelegt · Terminplan geöffnet', action_id, undoable: true, project: { id: project.id, name, start: stored.start, end: stored.end, end_text: spokenDate(stored.end) }, link: { label: 'Terminplan öffnen', to: projectPath(project.id, 'gantt') } }
}

export const createProjectTool: ToolDef = {
  name: 'create_project',
  description: 'Neues Projekt anlegen – leer, aus einer Vorlage oder mit einem von der KI entworfenen Terminplan aus einer Beschreibung. Wird sofort angelegt. Ein KI-Entwurf dauert etwa eine halbe bis eine Minute, das vorher ankündigen.',
  parameters: s.object({
    name: s.str('Projektname'),
    kind: s.nenum(
      ['internal', 'coaching', 'software', 'free', 'development', 'construction', 'process'],
      'Art des Vorhabens, falls erkennbar (internal=interne Aufgaben, coaching=Coaching/Beratung, software=Software-Entwicklung, free=freier Ablauf, development=Projektentwicklung, construction=Bauausführung, process=aus Prozessdiagramm); null = aus Vorlage übernehmen, sonst Standard „interne Aufgaben“',
    ),
    start_date: s.nstr('Start JJJJ-MM-TT; null = nächster Arbeitstag'),
    end_date: s.nstr('Zieltermin JJJJ-MM-TT; null = aus dem Plan berechnet'),
    template: s.nstr('Vorlage (ID oder Name), falls gewünscht'),
    description: s.nstr('Beschreibung des Vorhabens für einen KI-Terminplan (Umfang, Schritte, Besonderheiten) - nur wenn ausdrücklich gewünscht, sonst leer lassen'),
    customer: s.nstr('Kunde/Auftraggeber (bei Bauprojekten: Bauherr)'),
    city: s.nstr('Ort'),
    address: s.nstr('Adresse'),
  }),
  label: (a) => (str(a.description) ? 'Entwerfe Terminplan mit KI …' : `Lege Projekt „${String(a.name ?? '')}“ an …`),
  async run(ctx, a) {
    if (!allowed(ctx, 'project.create')) return forbidden('Du darfst keine Projekte anlegen.')
    const name = str(a.name)
    if (!name) return { ok: false, status: 'invalid', message: 'Projektname fehlt.' }
    const repo = new Repo(ctx.db)
    const orgId = ctx.session.org.id
    const org = await repo.organization(orgId)
    const calendars = await repo.calendars(orgId)
    const exceptions = await repo.exceptions(orgId)
    const trades = await repo.trades(orgId)
    const start0 = isoDate(a.start_date) ?? addDays(ctx.today, 1)
    const pctx: PlanContext = { projectId: 'vorschau', projectStart: start0, projectCalendarId: null, calendars, exceptions, holidayRegion: org?.holiday_region ?? 'DE-BY', resources: [], today: ctx.today }
    const baseCal = projectCalendarForPreview(pctx)
    const start = fromDayNumber(baseCal.nextWorkday(toDayNumber(start0)))
    pctx.projectStart = start

    const explicitKind = str(a.kind) as PlanningKind | null
    const kindLabel = PLANNING_KIND_LABELS[explicitKind ?? 'internal']
    let source: CreateProjectRequest['plan_source'] = { kind: 'empty' }
    let template: ProjectTemplate | null = null
    let taskCount = 0
    let phases: string[] = []
    let planEnd: ISODate | null = null
    if (str(a.template)) {
      const templates = await repo.templates(orgId)
      const r = resolveOne(String(a.template), templates.map((t) => ({ item: t, text: t.name, extra: [t.description].filter(Boolean) })), (id) => templates.find((t) => t.id === id))
      if (r.status === 'ambiguous') return { ok: false, status: 'ambiguous', message: 'Mehrere Vorlagen passen – frag nach.', options: r.options.map((t) => ({ id: t.id, name: t.name })) }
      if (r.status === 'not_found') return { ok: false, status: 'not_found', message: `Keine Vorlage „${String(a.template)}“ gefunden.` }
      template = r.item
      const tplTasks = await repo.templateTasks(template.id)
      const inst = instantiateTemplate(tplTasks, pctx, trades, () => newId('t'))
      const res = recompute({ tasks: inst.tasks, dependencies: inst.dependencies }, pctx).result
      planEnd = fromDayNumber(res.projectEnd)
      taskCount = inst.tasks.length
      phases = inst.tasks.filter((t) => !t.parent_id).slice(0, 6).map((t) => t.name)
      source = { kind: 'template', template_id: template.id }
    } else if (str(a.description)) {
      const people = (await repo.members(orgId)).map((m) => m.user?.name).filter((x): x is string => !!x)
      const plan: ExtractedPlan = await generatePlanFromBrief(`${name}\n\n${String(a.description)}`, { kind: kindLabel, people, effort: 'low' })
      const tpl = extractedToTemplateTasks(plan, 'jv').tasks
      const inst = instantiateTemplate(tpl, pctx, trades, () => newId('t'))
      const res = recompute({ tasks: inst.tasks, dependencies: inst.dependencies }, pctx).result
      planEnd = fromDayNumber(res.projectEnd)
      taskCount = plan.tasks.length
      phases = plan.tasks.filter((t) => t.type === 'phase').slice(0, 6).map((t) => t.name)
      source = { kind: 'import', plan: { ...plan, name } }
    }
    const end = isoDate(a.end_date) ?? planEnd ?? addDays(start, 90)
    const stored: CreateProjectPreview = { start, end, source, template: template ? { planning_kind: template.planning_kind, project_type: template.project_type, construction_method: template.construction_method } : null, kind: explicitKind }
    return finalizeCreate(ctx, repo, orgId, name, a, stored)
  },
}

function projectCalendarForPreview(pctx: PlanContext) {
  return recompute({ tasks: [], dependencies: [] }, pctx).result.calendar
}

/**
 * Gezielte Einfügestelle für plan_with_ai / import_lucid_diagram: under_task macht den Vorgang
 * zur Phase und hängt die neuen Vorgänge darunter ein, after_task fügt sie direkt dahinter ein
 * (gleiche Ebene). Ohne beides: ans Ende anhängen (bisheriges Verhalten).
 */
function resolvePosition(ctx: ToolCtx, bundle: ProjectBundle, a: Args): { result?: ToolResult; parent_id?: string | null; after_id?: string | null; label?: string } {
  if (a.under_task) {
    const tr = findTask(ctx, bundle, a.under_task)
    if (tr.result) return { result: tr.result }
    return { parent_id: tr.item.id, label: `unter „${tr.item.name}“ eingeordnet` }
  }
  if (a.after_task) {
    const tr = findTask(ctx, bundle, a.after_task)
    if (tr.result) return { result: tr.result }
    return { after_id: tr.item.id, parent_id: tr.item.parent_id, label: `hinter „${tr.item.name}“ eingefügt` }
  }
  return {}
}

// ---------------------------------------------------------------- Plan mit KI (bestehendes Projekt)

export const planWithAi: ToolDef = {
  name: 'plan_with_ai',
  description:
    'Mit KI Vorgänge aus einer Beschreibung entwerfen und direkt an ein BESTEHENDES Projekt anhängen (z. B. „plan den Innenausbau: Trockenbau, Estrich, Maler“). Der Entwurf dauert etwa eine halbe Minute, das vorher ankündigen. Standardmäßig werden die neuen Vorgänge ans Ende des Terminplans angehängt; mit under_task oder after_task lässt sich gezielt an einer bestehenden Stelle erweitern (z. B. „erweitere Vorgang 14 mit …“ macht Vorgang 14 zur Phase und ordnet die neuen Vorgänge darunter ein). Für neue Projekte create_project verwenden, für einzelne Aufgaben create_task.',
  parameters: s.object({
    project: s.nstr('Projekt-ID oder Name; null = aktuelles Projekt'),
    brief: s.str('Was geplant werden soll: Kategorien, Umfang, Reihenfolge, Besonderheiten, Personen'),
    under_task: s.nstr('Bestehender Vorgang (Name oder Nummer), der zur Phase werden und die neuen Vorgänge als Kinder bekommen soll; null = keine Verschachtelung'),
    after_task: s.nstr('Bestehender Vorgang (Name oder Nummer), direkt hinter dem die neuen Vorgänge eingefügt werden sollen; wird ignoriert, wenn under_task gesetzt ist; null = ans Ende anhängen'),
  }),
  label: () => 'Entwerfe Vorgänge mit KI …',
  async run(ctx, a) {
    if (!allowed(ctx, 'plan.edit')) return forbidden('Du darfst den Terminplan nicht ändern.')
    const pr = await findProject(ctx, a.project)
    if (pr.result) return pr.result
    const project = pr.item
    const brief = str(a.brief)
    if (!brief || brief.length < 10) return { ok: false, status: 'invalid', message: 'Frag nach, was genau geplant werden soll (Kategorien, Umfang).' }
    const svc = new ProjectService(ctx.db)
    // Der KI-Entwurf ist mit Abstand der langsamste Schritt (mehrere Sekunden) - Bundle und
    // Kategorien/Mitglieder liefen bisher NACH ihm; jetzt laufen sie währenddessen im Hintergrund mit.
    const members = await new Repo(ctx.db).members(ctx.session.org.id)
    const people = members.map((m) => m.user?.name).filter((x): x is string => !!x)
    ctx.emit({ type: 'tool_update', id: ctx.callId, label: 'Die KI entwirft die Vorgänge … (dauert etwas)' })
    const [before, plan, trades] = await Promise.all([
      svc.requireBundle(ctx.session.org.id, project.id),
      generatePlanFromBrief(`Projekt: ${project.name}\n\n${brief}`, { kind: PLANNING_KIND_LABELS[project.planning_kind], people, effort: 'low' }),
      new Repo(ctx.db).trades(ctx.session.org.id),
    ])
    if (!plan.tasks.length) return { ok: false, status: 'invalid', message: 'Die KI konnte aus der Beschreibung keinen Plan ableiten.' }
    const pos = resolvePosition(ctx, before, a)
    if (pos.result) return pos.result
    const cal = projectCalendar(before)
    // Angehängte Vorgänge beginnen frühestens am nächsten Arbeitstag (nur ohne gezielte Einfügestelle relevant)
    const earliest = fromDayNumber(cal.nextWorkday(Math.max(toDayNumber(addDays(ctx.today, 1)), toDayNumber(before.project.start_date))))

    ctx.emit({ type: 'tool_update', id: ctx.callId, label: `Hänge ${count(plan.tasks.length, 'Vorgang', 'Vorgänge')} an …` })
    const res = await svc.attachExtractedPlan(ctx.session, project.id, plan, { source: 'FUTURE_AI', reason: 'Jarvis: KI-Plan ergänzt', notBefore: earliest, bundle: before, trades, members, parent_id: pos.parent_id, after_id: pos.after_id })
    ctx.writes.count++
    const undo = planDiff({ tasks: before.tasks, dependencies: before.dependencies }, { tasks: res.tasks, dependencies: res.dependencies })
    const summary = `KI-Plan: ${count(plan.tasks.length, 'Vorgang', 'Vorgänge')}${pos.label ? ` ${pos.label}` : ' ergänzt'}`
    const action_id = await recordAction(ctx.db, ctx.session, { conversation_id: ctx.conversationId, project_id: project.id, tool: 'plan_with_ai', args: a, status: 'done', summary, version_after: res.version, undo })
    ctx.emit({ type: 'ui', action: 'reload_project', project_id: project.id, version: res.version })
    if (res.task_ids[0]) ctx.emit({ type: 'ui', action: 'focus_task', project_id: project.id, task_id: res.task_ids[0], open_drawer: false })
    ctx.emit({ type: 'ui', action: 'highlight', project_id: project.id, task_ids: res.task_ids.slice(0, 30) })
    const added = res.tasks.filter((t) => res.task_ids.includes(t.id))
    const end = added.reduce<string | null>((m, t) => (!m || t.end_date > m ? t.end_date : m), null)
    return {
      ok: true, summary, action_id, undoable: true,
      added: { tasks: plan.tasks.length, start: shortDate(earliest), end: shortDate(end), end_text: spokenDate(end), project_end: shortDate(before.project.target_end_date) },
      ...(res.unmatched.length ? { unmatched_people: res.unmatched } : {}),
      link: { label: 'Terminplan', to: projectPath(project.id, 'gantt') },
    }
  },
}

// ---------------------------------------------------------------- Lucidchart-Diagramm übernehmen

export const importLucidDiagram: ToolDef = {
  name: 'import_lucid_diagram',
  description: 'Ein Lucidchart-Diagramm (Dokument-ID aus find_lucid_documents oder Link) laden und als neue Vorgänge an ein BESTEHENDES Projekt anhängen. Nur wenn der Nutzer das Diagramm ausdrücklich übernehmen will, nicht nur ansehen. Standardmäßig werden die neuen Vorgänge ans Ende des Terminplans angehängt; mit under_task oder after_task lässt sich gezielt an einer bestehenden Stelle erweitern (z. B. „Vorgang 14 wird zur Phase“).',
  parameters: s.object({
    project: s.nstr('Projekt-ID oder Name; null = aktuelles Projekt'),
    document: s.str('Lucidchart-Link oder Dokument-ID (aus find_lucid_documents)'),
    under_task: s.nstr('Bestehender Vorgang (Name oder Nummer), der zur Phase werden und die neuen Vorgänge als Kinder bekommen soll; null = keine Verschachtelung'),
    after_task: s.nstr('Bestehender Vorgang (Name oder Nummer), direkt hinter dem die neuen Vorgänge eingefügt werden sollen; wird ignoriert, wenn under_task gesetzt ist; null = ans Ende anhängen'),
  }),
  label: () => 'Übernehme Lucidchart-Diagramm …',
  async run(ctx, a) {
    if (!allowed(ctx, 'plan.edit')) return forbidden('Du darfst den Terminplan nicht ändern.')
    const pr = await findProject(ctx, a.project)
    if (pr.result) return pr.result
    const project = pr.item
    const document = str(a.document)
    if (!document) return { ok: false, status: 'invalid', message: 'Welches Diagramm soll übernommen werden?' }
    const svc = new ProjectService(ctx.db)
    ctx.emit({ type: 'tool_update', id: ctx.callId, label: 'Lade Diagramm …' })
    // Unabhängige Umläufe (Lucid-API, Datenbank) gleichzeitig statt nacheinander - spart spürbar Zeit
    const [before, plan, trades, members] = await Promise.all([
      svc.requireBundle(ctx.session.org.id, project.id),
      fetchLucidPlan(document),
      new Repo(ctx.db).trades(ctx.session.org.id),
      new Repo(ctx.db).members(ctx.session.org.id),
    ])
    const pos = resolvePosition(ctx, before, a)
    if (pos.result) return pos.result
    const cal = projectCalendar(before)
    const earliest = fromDayNumber(cal.nextWorkday(Math.max(toDayNumber(addDays(ctx.today, 1)), toDayNumber(before.project.start_date))))
    ctx.emit({ type: 'tool_update', id: ctx.callId, label: `Hänge ${count(plan.tasks.length, 'Vorgang', 'Vorgänge')} an …` })
    const res = await svc.attachExtractedPlan(ctx.session, project.id, plan, { source: 'FUTURE_AI', reason: 'Jarvis: Lucidchart-Diagramm übernommen', notBefore: earliest, bundle: before, trades, members, parent_id: pos.parent_id, after_id: pos.after_id })
    ctx.writes.count++
    const undo = planDiff({ tasks: before.tasks, dependencies: before.dependencies }, { tasks: res.tasks, dependencies: res.dependencies })
    const summary = `Lucidchart: ${count(plan.tasks.length, 'Vorgang', 'Vorgänge')}${pos.label ? ` ${pos.label}` : ' übernommen'}`
    const action_id = await recordAction(ctx.db, ctx.session, { conversation_id: ctx.conversationId, project_id: project.id, tool: 'import_lucid_diagram', args: a, status: 'done', summary, version_after: res.version, undo })
    ctx.emit({ type: 'ui', action: 'reload_project', project_id: project.id, version: res.version })
    if (res.task_ids[0]) ctx.emit({ type: 'ui', action: 'focus_task', project_id: project.id, task_id: res.task_ids[0], open_drawer: false })
    ctx.emit({ type: 'ui', action: 'highlight', project_id: project.id, task_ids: res.task_ids.slice(0, 30) })
    return { ok: true, summary, action_id, undoable: true, link: { label: 'Terminplan', to: projectPath(project.id, 'gantt') } }
  },
}

// ---------------------------------------------------------------- E-Mail

export const sendEmail: ToolDef = {
  name: 'send_email',
  description: 'Verfasst und versendet eine E-Mail über das verbundene, echte Postfach (Microsoft 365) des Nutzers. Wird sofort gesendet – E-Mails lassen sich danach NICHT zurückholen, also den Inhalt vorher sauber diktieren lassen (Empfänger, Betreff, Text müssen eindeutig sein, bei Unklarheit nachfragen statt zu raten).',
  parameters: s.object({
    to: s.str('Empfängeradresse(n), mit Komma getrennt bei mehreren'),
    cc: s.nstr('CC-Adresse(n)'),
    subject: s.str('Betreff'),
    body: s.str('Nachrichtentext'),
    project: s.nstr('Projekt-ID oder Name, mit dem die Mail verknüpft wird; null = kein Bezug'),
  }),
  label: () => 'Sende E-Mail …',
  async run(ctx, a) {
    const to = str(a.to)
    const subject = str(a.subject)
    const body = str(a.body)
    if (!to) return { ok: false, status: 'invalid', message: 'An wen soll die E-Mail gehen?' }
    if (!subject) return { ok: false, status: 'invalid', message: 'Welcher Betreff?' }
    if (!body) return { ok: false, status: 'invalid', message: 'Was soll in der E-Mail stehen?' }
    let projectId: string | null = null
    if (str(a.project)) {
      const pr = await findProject(ctx, a.project)
      if (pr.result) return pr.result
      projectId = pr.item.id
    }
    const rec = await new MailboxService(ctx.db).send(ctx.session.user.id, ctx.session.org.id, { provider: 'microsoft365', to_email: to, cc_email: str(a.cc) ?? undefined, subject, body_text: body, project_id: projectId })
    ctx.writes.count++
    return { ok: true, summary: `E-Mail an ${to} gesendet: „${subject}“`, sent: { to: rec.to_email, subject: rec.subject, status: rec.status } }
  },
}

export const fileEmailAttachment: ToolDef = {
  name: 'file_email_attachment',
  description: 'Lädt einen Anhang einer per search_email gefundenen E-Mail herunter und legt ihn als Datei in einem Projekt ab (optional an einen Vorgang gehängt). Verändert oder löscht nichts im Postfach.',
  parameters: s.object({
    email: s.str('E-Mail-ID aus search_email'),
    attachment: s.nstr('Name des Anhangs (aus der E-Mail); null = der einzige bzw. erste Anhang'),
    project: s.nstr('Projekt-ID oder Name, unter dem die Datei abgelegt wird; null = aktuelles Projekt'),
    task: s.nstr('Vorgang (ID, Vorgangsnummer oder Name), an den die Datei zusätzlich gehängt wird; null = nur Projekt'),
  }),
  label: () => 'Lege E-Mail-Anhang ab …',
  async run(ctx, a) {
    const pr = await findProject(ctx, a.project)
    if (pr.result) return pr.result
    const emailId = str(a.email)
    if (!emailId) return { ok: false, status: 'invalid', message: 'Welche E-Mail (email-ID aus search_email)?' }
    let taskId: string | null = null
    if (str(a.task)) {
      const repo = new Repo(ctx.db)
      const bundle = await repo.bundle(ctx.session.org.id, pr.item.id)
      if (!bundle) return { ok: false, status: 'not_found', message: 'Projekt hat keinen Terminplan.' }
      const tr = findTask(ctx, bundle, a.task)
      if (tr.result) return tr.result
      taskId = tr.item.id
    }
    const mailbox = new MailboxService(ctx.db)
    const list = await mailbox.messageAttachments(ctx.session.user.id, ctx.session.org.id, 'microsoft365', emailId)
    if (!list.length) return { ok: false, status: 'not_found', message: 'Diese E-Mail hat keine Datei-Anhänge.' }
    const wanted = str(a.attachment)
    const chosen = wanted ? list.find((x) => x.name.toLowerCase().includes(wanted.toLowerCase())) : list[0]
    if (!chosen) return { ok: false, status: 'not_found', message: `Kein Anhang „${wanted}“ gefunden. Vorhanden: ${list.map((x) => x.name).join(', ')}.` }
    const file = await mailbox.downloadAttachment(ctx.session.user.id, ctx.session.org.id, 'microsoft365', emailId, chosen.id)
    const id = newId('att')
    const storageKey = `${ctx.session.org.id}/${pr.item.id}/${id}-${file.name}`
    await uploadBytes(storageKey, file.bytes, file.contentType)
    await ctx.db.insert('attachments', { id, org_id: ctx.session.org.id, project_id: pr.item.id, task_id: taskId, progress_update_id: null, filename: file.name, mime: file.contentType, size: file.bytes.length, storage_key: storageKey, created_at: nowISO() })
    await broadcastProject(ctx.session.org.id, pr.item.id, 'attachment', { task_id: taskId, progress_update_id: null })
    ctx.writes.count++
    return { ok: true, summary: `„${file.name}“ in „${pr.item.name}“ abgelegt`, file: { id, filename: file.name, size_kb: Math.round(file.bytes.length / 1024) } }
  },
}

// ---------------------------------------------------------------- Rückgängig

export const undoLast: ToolDef = {
  name: 'undo_last',
  description: 'Macht die letzte(n) Jarvis-Änderung(en) für diesen Nutzer rückgängig (höchstens zwei Stunden alt, nur solange seitdem niemand weiter geändert hat). Mit steps mehrere Schritte auf einmal, z. B. „die letzten drei Änderungen rückgängig“ (höchstens 10). Wird sofort ausgeführt.',
  parameters: s.object({ project: s.nstr('Projekt-ID oder Name; null = letzte Änderung überhaupt'), steps: s.nint('Wie viele Schritte rückgängig; null/1 = nur der letzte, höchstens 10') }),
  label: (a) => (int(a.steps) && int(a.steps)! > 1 ? `Mache die letzten ${int(a.steps)} Änderungen rückgängig …` : 'Mache die letzte Änderung rückgängig …'),
  async run(ctx, a) {
    let projectId: string | null = null
    if (str(a.project)) {
      const pr = await findProject(ctx, a.project)
      if (pr.result) return pr.result
      projectId = pr.item.id
    }
    const steps = Math.min(10, Math.max(1, int(a.steps) ?? 1))
    if (steps > 1) {
      if (!projectId) {
        const latest = await latestUndoable(ctx.db, ctx.session, null, ctx.conversationId)
        if (!latest) return { ok: false, status: 'not_found', message: 'Es gibt keine Jarvis-Änderung der letzten zwei Stunden, die sich rückgängig machen lässt.' }
        projectId = latest.action.project_id
      }
      if (projectId) return undoChain(ctx, projectId, steps)
    }
    const latest = await latestUndoable(ctx.db, ctx.session, projectId, ctx.conversationId)
    if (!latest) return { ok: false, status: 'not_found', message: 'Es gibt keine Jarvis-Änderung der letzten zwei Stunden, die sich rückgängig machen lässt.' }
    return undoAction(ctx, latest.action)
  },
}

/** Mehrere Schritte auf einmal: Diffs in Folge anwenden und in EINEM Speichervorgang übernehmen. */
async function undoChain(ctx: ToolCtx, projectId: string, steps: number): Promise<ToolResult> {
  const chain = await latestUndoableChain(ctx.db, ctx.session, projectId, steps)
  if (!chain.length) return { ok: false, status: 'not_found', message: 'Es gibt keine Jarvis-Änderung der letzten zwei Stunden, die sich rückgängig machen lässt.' }
  if (chain.length === 1) return undoAction(ctx, chain[0]!)
  const svc = new ProjectService(ctx.db)
  const bundle = await svc.requireBundle(ctx.session.org.id, projectId)
  if (bundle.project.version !== chain[0]!.version_after) {
    return { ok: false, status: 'conflict', message: 'Seitdem wurde der Plan weiter geändert – rückgängig bitte über die Historie.', link: { label: 'Historie', to: projectPath(bundle.project.id, 'history') } }
  }
  let state: PlanState = { tasks: bundle.tasks, dependencies: bundle.dependencies }
  const touched = new Set<string>()
  for (const action of chain) {
    const undo = action.undo as Extract<JarvisUndo, { kind: 'plan' }>
    for (const t of undo.tasks_before) touched.add(t.id)
    for (const id of undo.tasks_created) touched.add(id)
    state = applyPlanUndo(state, undo)
  }
  const res = await svc.savePlan(ctx.session, projectId, { expected_version: bundle.project.version, tasks: state.tasks, dependencies: state.dependencies, reason: `Jarvis: ${chain.length} Änderungen rückgängig`, source: 'FUTURE_AI' })
  for (const action of chain) await finishAction(ctx.db, action.id, { status: 'undone' })
  ctx.emit({ type: 'ui', action: 'reload_project', project_id: bundle.project.id, version: res.version })
  ctx.emit({ type: 'ui', action: 'highlight', project_id: bundle.project.id, task_ids: [...touched].slice(0, 30) })
  const summary = `${chain.length} Änderungen rückgängig: ${chain.map((a) => a.summary).join(' · ')}`
  return { ok: true, summary: summary.length > 300 ? `${chain.length} Änderungen rückgängig gemacht` : summary, undoable: false }
}

export async function undoAction(ctx: ToolCtx, action: JarvisAction): Promise<ToolResult> {
  const repo = new Repo(ctx.db)
  const undo = action.undo!
  if (undo.kind === 'delete_project') {
    const p = await repo.project(ctx.session.org.id, undo.project_id)
    if (!p) return { ok: false, status: 'not_found', message: 'Das Projekt existiert nicht mehr.' }
    const fresh = Date.now() - Date.parse(action.created_at) < 30 * 60_000
    if (!allowed(ctx, 'project.delete') || p.version !== action.version_after || !fresh) {
      return { ok: false, status: 'conflict', message: 'Das Projekt wurde inzwischen bearbeitet oder ist älter als 30 Minuten – löschen bitte über die Projektdaten.' }
    }
    await ctx.db.run('DELETE FROM projects WHERE id = ? AND org_id = ?', p.id, ctx.session.org.id)
    await finishAction(ctx.db, action.id, { status: 'undone' })
    // Nur wer gerade in diesem Projekt ist, muss die Seite verlassen
    const inside = ctx.context.path === projectPath(p.id) || ctx.context.path.startsWith(`${projectPath(p.id)}/`)
    if (inside) ctx.emit({ type: 'ui', action: 'navigate', to: '/projects' })
    ctx.emit({ type: 'ui', action: 'data_changed', scope: 'projects' })
    return { ok: true, summary: `Projekt „${p.name}“ wieder entfernt` }
  }
  const svc = new ProjectService(ctx.db)
  const bundle = await svc.requireBundle(ctx.session.org.id, action.project_id!)
  if (bundle.project.version !== action.version_after) {
    return { ok: false, status: 'conflict', message: 'Seitdem wurde der Plan weiter geändert – rückgängig bitte über die Historie.', link: { label: 'Historie', to: projectPath(bundle.project.id, 'history') } }
  }
  const current: PlanState = { tasks: bundle.tasks, dependencies: bundle.dependencies }
  const restored = applyPlanUndo(current, undo)
  const res = await svc.savePlan(ctx.session, bundle.project.id, { expected_version: bundle.project.version, tasks: restored.tasks, dependencies: restored.dependencies, reason: `Jarvis: rückgängig – ${action.summary}`, source: 'FUTURE_AI' })
  await finishAction(ctx.db, action.id, { status: 'undone' })
  ctx.emit({ type: 'ui', action: 'reload_project', project_id: bundle.project.id, version: res.version })
  ctx.emit({ type: 'ui', action: 'highlight', project_id: bundle.project.id, task_ids: undo.tasks_before.map((t) => t.id).slice(0, 30) })
  return { ok: true, summary: `Rückgängig: ${action.summary}` }
}

// ---------------------------------------------------------------- Stufe B: verknüpfen, löschen, Vorschläge entscheiden

export const linkTasks: ToolDef = {
  name: 'link_tasks',
  description: 'Abhängigkeit anlegen: Vorgang B beginnt erst nach Vorgang A (optional mit Wartezeit). Verschiebt ggf. B und seine Nachfolger.',
  parameters: s.object({
    project: s.nstr('Projekt-ID oder Name; null = aktuelles Projekt'),
    predecessor: s.str('Vorgang A (ID, Vorgangsnummer oder Name), der zuerst fertig sein muss'),
    successor: s.str('Vorgang B (ID, Vorgangsnummer oder Name), der danach beginnt'),
    lag_workdays: s.nint('Wartezeit in Arbeitstagen, z. B. Trocknungszeit'),
  }),
  label: () => 'Verknüpfe Vorgänge …',
  async run(ctx, a) {
    if (!allowed(ctx, 'plan.edit')) return forbidden('Verknüpfen darf nur, wer den Terminplan bearbeiten darf.')
    const pr = await findProject(ctx, a.project)
    if (pr.result) return pr.result
    const svc = new ProjectService(ctx.db)
    return withConflictRetry(async () => {
      const bundle = await svc.requireBundle(ctx.session.org.id, pr.item.id)
      const pa = findTask(ctx, bundle, a.predecessor)
      if (pa.result) return pa.result
      const pb = findTask(ctx, bundle, a.successor)
      if (pb.result) return pb.result
      const pctx = planContextFor(ctx, bundle)
      const before: PlanState = { tasks: bundle.tasks, dependencies: bundle.dependencies }
      const r = addDependency(before, pctx, { id: newId('dep'), predecessor_id: pa.item.id, successor_id: pb.item.id, type: 'FS', lag_days: Math.max(0, int(a.lag_workdays) ?? 0) })
      if (r.error) return { ok: false, status: 'invalid', message: r.error }
      const impact = summarizeImpact(bundle, before, r.state, pctx)
      const summary = `„${pb.item.name}“ beginnt jetzt nach „${pa.item.name}“`
      const { action_id } = await commitPlan(ctx, bundle, before, r.state, { tool: 'link_tasks', args: a, reason: summary, summary, highlight: [pa.item.id, pb.item.id] })
      return { ok: true, summary, action_id, undoable: true, impact: stripRows(impact) }
    })
  },
}

export const deleteTasksTool: ToolDef = {
  name: 'delete_tasks',
  description: 'Vorgänge (inklusive Untervorgänge) löschen. Wird sofort ausgeführt, ist per Rückgängig-Chip rücknehmbar.',
  parameters: s.object({
    project: s.nstr('Projekt-ID oder Name; null = aktuelles Projekt'),
    tasks: s.list({ type: 'string' }, 'Vorgänge (IDs, Vorgangsnummern, Namen oder EIN Nummernbereich wie „3-7“/„3 bis 7“ als einzelner Eintrag)'),
  }),
  label: () => 'Lösche Vorgänge …',
  async run(ctx, a) {
    if (!allowed(ctx, 'plan.edit')) return forbidden('Löschen darf nur, wer den Terminplan bearbeiten darf.')
    const pr = await findProject(ctx, a.project)
    if (pr.result) return pr.result
    const svc = new ProjectService(ctx.db)
    const bundle = await svc.requireBundle(ctx.session.org.id, pr.item.id)
    const refs = Array.isArray(a.tasks) ? (a.tasks as unknown[]).slice(0, 20) : []
    if (!refs.length) return { ok: false, status: 'invalid', message: 'Welche Vorgänge sollen gelöscht werden?' }
    const tr = findTasks(ctx, bundle, refs)
    if (tr.result) return tr.result
    const found = tr.item
    const pctx = planContextFor(ctx, bundle)
    const before: PlanState = { tasks: bundle.tasks, dependencies: bundle.dependencies }
    const after = deleteTasks(before, pctx, found.map((t) => t.id))
    const removed = before.tasks.length - after.tasks.length
    const summary = `${removed} Vorgang${removed === 1 ? '' : 'e'} gelöscht`
    const { action_id } = await commitPlan(ctx, bundle, before, after, { tool: 'delete_tasks', args: a, reason: `${found.map((t) => t.name).join(', ')} gelöscht`, summary, highlight: [] })
    return { ok: true, summary, action_id, undoable: true }
  },
}

export const decideProposalTool: ToolDef = {
  name: 'decide_proposal',
  description: 'Einen offenen Änderungsvorschlag (z. B. Terminvorschlag eines Nachunternehmers) annehmen oder ablehnen. Wird sofort ausgeführt.',
  parameters: s.object({
    project: s.nstr('Projekt-ID oder Name; null = aktuelles Projekt'),
    proposal: s.nstr('Vorschlag (ID, Titel, Vorgang oder Absender); null = der einzige offene'),
    decision: s.enum(['accept', 'reject'], 'annehmen oder ablehnen'),
    note: s.nstr('Begründung, v. a. bei Ablehnung'),
  }),
  label: () => 'Entscheide über den Vorschlag …',
  async run(ctx, a) {
    if (!allowed(ctx, 'plan.edit')) return forbidden('Über Vorschläge entscheidet die Projektleitung.')
    const pr = await findProject(ctx, a.project)
    if (pr.result) return pr.result
    const repo = new Repo(ctx.db)
    const open = (await repo.proposals(pr.item.id)).filter((p) => p.status === 'open')
    if (!open.length) return { ok: false, status: 'not_found', message: 'In diesem Projekt gibt es keine offenen Vorschläge.' }
    let proposal = open.length === 1 && !str(a.proposal) ? open[0]! : null
    if (!proposal) {
      const r = resolveOne(str(a.proposal) ?? '', open.map((p) => ({ item: p, text: p.title, extra: [p.submitted_by_name, p.comment].filter(Boolean) })), (id) => open.find((p) => p.id === id))
      if (r.status === 'ok') proposal = r.item
      else return { ok: false, status: r.status === 'ambiguous' ? 'ambiguous' : 'not_found', message: 'Welcher Vorschlag ist gemeint?', options: open.slice(0, 3).map((p) => ({ id: p.id, title: p.title, from: p.submitted_by_name })) }
    }
    const decision = a.decision === 'reject' ? 'reject' : 'accept'
    const result = await decideProposal(ctx.db, ctx.session, pr.item.id, proposal.id, decision, str(a.note) ?? '')
    ctx.writes.count++
    const fresh = await repo.project(ctx.session.org.id, pr.item.id)
    if (fresh) ctx.emit({ type: 'ui', action: 'reload_project', project_id: fresh.id, version: fresh.version })
    return { ok: true, summary: `Vorschlag ${decision === 'accept' ? 'angenommen – Plan aktualisiert' : 'abgelehnt'}`, proposal: { title: result.title, status: result.status } }
  },
}

// ---------------------------------------------------------------- Anzeigen

const VIEWS: Record<string, { path: string; project?: string }> = {
  overview: { path: '/' },
  projects: { path: '/projects' },
  portfolio: { path: '/portfolio' },
  site: { path: '/site' },
  inbox: { path: '/inbox' },
  notifications: { path: '/notifications' },
  team: { path: '/team' },
  project: { path: '', project: '' },
  gantt: { path: '', project: 'gantt' },
  tasks: { path: '', project: 'tasks' },
  lookahead: { path: '', project: 'lookahead' },
  milestones: { path: '', project: 'milestones' },
  proposals: { path: '', project: 'proposals' },
  history: { path: '', project: 'history' },
}

export const show: ToolDef = {
  name: 'show',
  description: 'Zeigt dem Nutzer eine Ansicht: Übersicht, Projektliste, Portfolio, Tagesansicht, Posteingang, Benachrichtigungen, Team oder in einem Projekt Cockpit, Terminplan (gantt), Vorgänge, Lookahead, Meilensteine, Vorschläge, Historie. Mit task wird der Vorgang im Terminplan angesprungen.',
  parameters: s.object({
    view: s.enum(Object.keys(VIEWS), 'Ansicht'),
    project: s.nstr('Projekt-ID oder Name (für Projektansichten); null = aktuelles'),
    task: s.nstr('Vorgang (ID, Vorgangsnummer oder Name), der im Terminplan gezeigt werden soll'),
  }),
  label: () => 'Öffne die Ansicht …',
  async run(ctx, a) {
    const view = VIEWS[String(a.view)] ?? VIEWS.overview!
    if (view.project === undefined && !str(a.task)) {
      ctx.emit({ type: 'ui', action: 'navigate', to: view.path })
      return { ok: true, summary: 'Ansicht geöffnet' }
    }
    const pr = await findProject(ctx, a.project)
    if (pr.result) return pr.result
    if (str(a.task)) {
      const bundle = (await new Repo(ctx.db).bundle(ctx.session.org.id, pr.item.id))!
      const tr = findTask(ctx, bundle, a.task)
      if (tr.result) return tr.result
      ctx.emit({ type: 'ui', action: 'focus_task', project_id: pr.item.id, task_id: tr.item.id, open_drawer: true })
      return { ok: true, summary: `„${tr.item.name}“ im Terminplan` }
    }
    ctx.emit({ type: 'ui', action: 'navigate', to: projectPath(pr.item.id, view.project) })
    return { ok: true, summary: `${pr.item.name} geöffnet` }
  },
}
