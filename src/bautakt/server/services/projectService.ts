/**
 * Fachlogik rund um Projekte: Plan speichern (mit Änderungshistorie), Baustellen-
 * Updates, Baselines, Dashboard-Kennzahlen. Nutzt dieselbe Engine wie der Client.
 */

import type { Db } from '../db.ts'
import { newId, nowISO } from '../db.ts'
import { Repo } from '../repo.ts'
import { HttpError } from '../auth.ts'
import type {
  Baseline,
  ChangeHistoryEntry,
  ChangeSource,
  CreateProjectRequest,
  CriticalEvent,
  ISODate,
  Project,
  ProjectBundle,
  ProjectSummary,
  SavePlanRequest,
  SavePlanResponse,
  Session,
  SiteUpdateRequest,
  Task,
  TaskDependency,
} from '../../shared/types.ts'
import { analyzeProject, criticalEvents } from '../../shared/engine/analysis.ts'
import { computeSchedule, applyScheduleToTasks } from '../../shared/engine/schedule.ts'
import { recompute, updateTaskFields, setEndDate, shiftFixedDates, type PlanContext } from '../../shared/engine/operations.ts'
import { resolveCalendars } from '../../shared/engine/calendar.ts'
import { formatDate, fromDayNumber, todayISO, toDayNumber } from '../../shared/engine/dates.ts'
import { DELAY_REASON_LABELS, SITE_FLAG_LABELS } from '../../shared/labels.ts'
import { instantiateTemplate } from '../../shared/templates/instantiate.ts'
import { mapProcessToTemplate } from '../../shared/integrations/buildflow/adapter.ts'
import { parseBuildFlowExport } from '../../shared/integrations/buildflow/types.ts'
import { extractedToTemplateTasks, normalizeExtractedPlan, type ExtractedPlan } from '../../shared/integrations/planextract/types.ts'
import { HOLIDAY_REGIONS } from '../../shared/engine/holidays.ts'
import { refreshProjectNotifications, pushNotification } from './notificationService.ts'

const TASK_COLUMNS: (keyof Task)[] = [
  'id', 'project_id', 'parent_id', 'name', 'description', 'type', 'sort_order', 'start_date', 'end_date', 'duration', 'progress', 'status',
  'trade_id', 'responsible_user_id', 'responsible_user_ids', 'responsible_name', 'company_id', 'resource_id', 'actual_start', 'actual_finish', 'remaining_duration', 'constraint_type',
  'constraint_date', 'scheduling_mode', 'calendar_id', 'is_critical', 'total_float', 'free_float', 'early_start', 'early_finish', 'late_start',
  'late_finish', 'has_conflict', 'notes', 'section_id', 'quantity', 'unit', 'productivity_rate', 'crew_size', 'actual_duration',
  'start_time', 'end_time', 'duration_hours',
]

/** Felder, deren Änderung in der Historie protokolliert wird (mit Anzeigename) */
const TRACKED: Partial<Record<keyof Task, string>> = {
  name: 'Bezeichnung',
  start_date: 'Start',
  end_date: 'Ende',
  duration: 'Dauer',
  progress: 'Fortschritt',
  status: 'Status',
  trade_id: 'Gewerk',
  responsible_user_id: 'Verantwortlicher',
  responsible_user_ids: 'Verantwortliche',
  responsible_name: 'Verantwortlich (Name)',
  company_id: 'Firma',
  actual_start: 'Ist-Start',
  actual_finish: 'Ist-Ende',
  parent_id: 'Übergeordnet',
  type: 'Typ',
  constraint_date: 'Einschränkung',
  scheduling_mode: 'Planungsmodus',
}

export class ProjectService {
  readonly db: Db
  readonly repo: Repo
  constructor(db: Db) {
    this.db = db
    this.repo = new Repo(db)
  }

  planContext(bundle: ProjectBundle, today = todayISO()): PlanContext {
    return {
      projectId: bundle.project.id,
      projectStart: bundle.project.start_date,
      projectCalendarId: bundle.project.calendar_id,
      calendars: bundle.calendars,
      exceptions: bundle.exceptions,
      holidayRegion: bundle.project.holiday_region,
      resources: bundle.resources,
      today,
    }
  }

  async requireBundle(orgId: string, projectId: string): Promise<ProjectBundle> {
    const b = await this.repo.bundle(orgId, projectId)
    if (!b) throw new HttpError(404, 'Projekt nicht gefunden.')
    return b
  }

  /** Alle Vorgänge/Abhängigkeiten eines Projekts ersetzen (Bulk), Historie schreiben */
  async savePlan(session: Session, projectId: string, req: SavePlanRequest): Promise<SavePlanResponse> {
    const bundle = await this.requireBundle(session.org.id, projectId)
    if (req.expected_version !== bundle.project.version) {
      throw new HttpError(409, 'Der Plan wurde zwischenzeitlich von jemand anderem geändert. Bitte neu laden.')
    }
    const ctx = this.planContext(bundle)
    const incoming: Task[] = req.tasks.map((t) => sanitizeTask({ ...t, project_id: projectId }))
    const incomingDeps: TaskDependency[] = req.dependencies.map((d) => ({ ...d, project_id: projectId, lag_days: Number(d.lag_days) | 0 }))
    const { state } = recompute({ tasks: incoming, dependencies: incomingDeps }, ctx)

    const source = req.source ?? 'MANUAL'
    const changes = diffTasks(bundle.tasks, state.tasks, session, projectId, req.reason ?? '', source)
    const depChanges = diffDependencies(bundle.dependencies, state.dependencies, bundle.tasks, state.tasks, session, projectId, req.reason ?? '', source)
    const version = bundle.project.version + 1

    await this.db.transaction(async () => {
      await this.replacePlan(projectId, state.tasks, state.dependencies)
      for (const c of [...changes, ...depChanges]) await this.db.insert('change_history', c)
      await this.db.update('projects', projectId, { version, updated_at: nowISO() })
    })
    await refreshProjectNotifications(this.db, session.org.id, await this.requireBundle(session.org.id, projectId))
    return { version, tasks: state.tasks, changes: [...changes, ...depChanges] }
  }

  private async replacePlan(projectId: string, tasks: Task[], deps: TaskDependency[]): Promise<void> {
    const keep = new Set(tasks.map((t) => t.id))
    const existing = await this.repo.tasks(projectId)
    for (const t of existing) if (!keep.has(t.id)) await this.db.run('DELETE FROM tasks WHERE id = ? AND project_id = ?', t.id, projectId)
    for (const t of tasks) {
      const row: Record<string, unknown> = {}
      for (const k of TASK_COLUMNS) row[k] = t[k]
      await this.db.upsert('tasks', row)
    }
    await this.db.run('DELETE FROM task_dependencies WHERE project_id = ?', projectId)
    for (const d of deps) {
      if (!keep.has(d.predecessor_id) || !keep.has(d.successor_id)) continue
      await this.db.insert('task_dependencies', { id: d.id, project_id: projectId, predecessor_id: d.predecessor_id, successor_id: d.successor_id, type: d.type, lag_days: d.lag_days, lag_unit: d.lag_unit ?? 'workdays', is_driving: !!d.is_driving })
    }
  }

  /** Engine über gespeicherten Plan laufen lassen und Ergebnis persistieren (ohne Historie) */
  async recomputeAndPersist(orgId: string, projectId: string): Promise<void> {
    const bundle = await this.requireBundle(orgId, projectId)
    const ctx = this.planContext(bundle)
    const result = computeSchedule({ ...ctx, tasks: bundle.tasks, dependencies: bundle.dependencies }, { today: ctx.today })
    const tasks = applyScheduleToTasks(bundle.tasks, result)
    await this.db.transaction(async () => {
      for (const t of tasks) {
        const row: Record<string, unknown> = {}
        for (const k of TASK_COLUMNS) row[k] = t[k]
        await this.db.upsert('tasks', row)
      }
    })
  }

  /** Baustellen-Update: Schnellaktion vom Bauleiter → Status, Fortschritt, Verzögerung, Prognose */
  async siteUpdate(session: Session, projectId: string, taskId: string, req: SiteUpdateRequest): Promise<{ tasks: Task[]; version: number }> {
    const bundle = await this.requireBundle(session.org.id, projectId)
    const task = bundle.tasks.find((t) => t.id === taskId)
    if (!task) throw new HttpError(404, 'Vorgang nicht gefunden.')
    const ctx = this.planContext(bundle)
    const today = ctx.today!
    let state = { tasks: bundle.tasks, dependencies: bundle.dependencies }
    const patch: Partial<Task> = {}
    const progress = req.progress !== undefined ? Math.max(0, Math.min(100, Math.round(req.progress))) : task.progress

    switch (req.flag) {
      case 'done':
        patch.status = 'done'
        patch.progress = 100
        patch.actual_finish = today
        if (!task.actual_start) patch.actual_start = task.start_date <= today ? task.start_date : today
        break
      case 'on_track':
        patch.status = progress > 0 ? 'in_progress' : task.status === 'delayed' || task.status === 'blocked' || task.status === 'at_risk' ? 'in_progress' : task.status
        patch.progress = progress
        if (!task.actual_start && (progress > 0 || task.start_date <= today)) patch.actual_start = task.start_date <= today ? task.start_date : today
        break
      case 'at_risk':
        patch.status = 'at_risk'
        patch.progress = progress
        if (!task.actual_start && task.start_date <= today) patch.actual_start = task.start_date
        break
      case 'delayed':
        patch.status = 'delayed'
        patch.progress = progress
        if (!task.actual_start && task.start_date <= today) patch.actual_start = task.start_date
        break
    }
    state = updateTaskFields(state, ctx, taskId, patch)
    let delayDays = 0
    if ((req.flag === 'delayed' || req.flag === 'at_risk') && req.new_forecast_end && req.new_forecast_end > task.end_date) {
      state = setEndDate(state, ctx, taskId, req.new_forecast_end, true)
      const cal = recompute(state, ctx).result.tasks.get(taskId)!.calendar
      delayDays = cal.countWorkdays(toDayNumber(task.end_date), toDayNumber(req.new_forecast_end)) - 1
    }
    const reasonLabel = req.delay_reason ? DELAY_REASON_LABELS[req.delay_reason] : ''
    const reason = [reasonLabel, req.comment].filter(Boolean).join(' – ')
    const changes = diffTasks(bundle.tasks, state.tasks, session, projectId, reason || `Baustellen-Update: ${SITE_FLAG_LABELS[req.flag]}`, 'SITE_UPDATE')
    const version = bundle.project.version + 1

    await this.db.transaction(async () => {
      await this.replacePlan(projectId, state.tasks, state.dependencies)
      for (const c of changes) await this.db.insert('change_history', c)
      await this.db.insert('progress_updates', {
        id: newId('pu'),
        project_id: projectId,
        task_id: taskId,
        user_id: session.user.id,
        created_at: nowISO(),
        flag: req.flag,
        progress: patch.progress ?? task.progress,
        comment: req.comment ?? '',
        delay_reason: req.delay_reason ?? null,
        new_forecast_end: req.new_forecast_end ?? null,
        attachments: [],
      })
      if (req.flag === 'delayed' || (req.flag === 'at_risk' && req.delay_reason)) {
        await this.db.insert('delay_events', {
          id: newId('dl'),
          project_id: projectId,
          task_id: taskId,
          user_id: session.user.id,
          created_at: nowISO(),
          reason: req.delay_reason ?? 'other',
          days: delayDays,
          comment: req.comment ?? '',
        })
      }
      await this.db.update('projects', projectId, { version, updated_at: nowISO() })
    })
    await pushNotification(this.db, {
      org_id: session.org.id,
      project_id: projectId,
      type: 'site_update',
      severity: req.flag === 'delayed' ? 'critical' : req.flag === 'at_risk' ? 'warning' : 'info',
      title: `Baustellen-Update: ${task.name}`,
      message: `${session.user.name} meldet "${SITE_FLAG_LABELS[req.flag]}"${reasonLabel ? ` (${reasonLabel})` : ''}${delayDays ? `, +${delayDays} Arbeitstage` : ''} – ${bundle.project.name}`,
    })
    await refreshProjectNotifications(this.db, session.org.id, await this.requireBundle(session.org.id, projectId))
    return { tasks: state.tasks, version }
  }

  async saveBaseline(session: Session, projectId: string, name: string): Promise<Baseline> {
    const bundle = await this.requireBundle(session.org.id, projectId)
    const ctx = this.planContext(bundle)
    const { state, result } = recompute({ tasks: bundle.tasks, dependencies: bundle.dependencies }, ctx)
    const baseline: Baseline = {
      id: newId('bl'),
      project_id: projectId,
      name: name || `Baseline ${formatDate(todayISO())}`,
      created_at: nowISO(),
      created_by: session.user.id,
      is_active: true,
      project_end: fromDayNumber(result.projectEnd),
    }
    await this.db.transaction(async () => {
      await this.db.run('UPDATE baselines SET is_active = 0 WHERE project_id = ?', projectId)
      await this.db.insert('baselines', baseline)
      for (const t of state.tasks) {
        await this.db.insert('baseline_tasks', { baseline_id: baseline.id, task_id: t.id, start_date: t.start_date, end_date: t.end_date, duration: t.duration })
      }
      await this.db.insert('change_history', {
        id: newId('ch'),
        project_id: projectId,
        task_id: null,
        task_name: '',
        user_id: session.user.id,
        user_name: session.user.name,
        created_at: nowISO(),
        field: 'baseline',
        old_value: null,
        new_value: baseline.name,
        reason: 'Baseline gespeichert',
        source: 'MANUAL',
      })
    })
    await pushNotification(this.db, {
      org_id: session.org.id,
      project_id: projectId,
      type: 'baseline_saved',
      severity: 'info',
      title: `Baseline gespeichert: ${bundle.project.name}`,
      message: `${session.user.name} hat "${baseline.name}" eingefroren. Fertigstellung laut Baseline: ${formatDate(baseline.project_end)}.`,
    })
    return baseline
  }

  async activateBaseline(orgId: string, projectId: string, baselineId: string): Promise<void> {
    await this.requireBundle(orgId, projectId)
    await this.db.transaction(async () => {
      await this.db.run('UPDATE baselines SET is_active = 0 WHERE project_id = ?', projectId)
      await this.db.run('UPDATE baselines SET is_active = 1 WHERE project_id = ? AND id = ?', projectId, baselineId)
    })
  }

  async createProject(session: Session, req: CreateProjectRequest): Promise<Project> {
    const now = nowISO()
    const id = newId('prj')
    const org = await this.repo.organization(session.org.id)
    const project: Project = {
      id,
      org_id: session.org.id,
      number: req.number,
      name: req.name,
      customer: req.customer,
      address: req.address,
      city: req.city,
      project_type: req.project_type,
      construction_method: req.construction_method,
      start_date: req.start_date,
      target_end_date: req.target_end_date,
      area_sqm: req.area_sqm,
      floors: req.floors,
      has_basement: req.has_basement,
      project_manager_id: req.project_manager_id,
      site_manager_id: req.site_manager_id,
      state: 'active',
      calendar_id: null,
      planning_kind: req.planning_kind ?? 'construction',
      holiday_region: req.holiday_region && HOLIDAY_REGIONS.some((r) => r.code === req.holiday_region) ? req.holiday_region : (org?.holiday_region ?? 'DE-BY'),
      version: 1,
      created_at: now,
      updated_at: now,
    }
    if (project.planning_kind !== 'construction') {
      // baubezogene Felder sind für freie/vorbereitende/prozessbasierte Pläne nicht relevant
      project.project_type = 'individuell'
      project.construction_method = 'individuell'
      project.area_sqm = null
      project.floors = null
      project.has_basement = false
    }
    await this.db.transaction(async () => {
      await this.db.insert('projects', project)
      if (req.project_manager_id) await this.db.upsert('project_members', { project_id: id, user_id: req.project_manager_id, role: 'project_manager' }, ['project_id', 'user_id'])
      if (req.site_manager_id) await this.db.upsert('project_members', { project_id: id, user_id: req.site_manager_id, role: 'site_manager' }, ['project_id', 'user_id'])
      // Bauabschnitte: explizit übergebene, sonst die der Vorlage
      const tplTasks = req.plan_source.kind === 'template' ? await this.repo.templateTasks(req.plan_source.template_id) : []
      const sectionNames = req.sections?.length ? req.sections : [...new Set(tplTasks.map((t) => t.section_name).filter((x): x is string => !!x))]
      const sectionByName = new Map<string, string>()
      let sIdx = 0
      for (const name of sectionNames) {
        const sid = newId('sec')
        sectionByName.set(name.toLowerCase(), sid)
        await this.db.insert('project_sections', { id: sid, project_id: id, name, sort_order: sIdx })
        sIdx++
      }
      if (req.plan_source.kind === 'template') {
        const tpl = await this.repo.template(session.org.id, req.plan_source.template_id)
        if (!tpl) throw new HttpError(404, 'Vorlage nicht gefunden.')
        const bundle = await this.requireBundle(session.org.id, id)
        const ctx = this.planContext(bundle)
        const plan = instantiateTemplate(tplTasks, ctx, await this.repo.trades(session.org.id), () => newId('t'), sectionByName)
        await this.replacePlan(id, plan.tasks, plan.dependencies)
        for (const c of plan.constraints) await this.db.insert('task_constraints', { id: newId('cs'), ...c, created_at: now, updated_at: now })
        await this.db.insert('change_history', {
          id: newId('ch'), project_id: id, task_id: null, task_name: '', user_id: session.user.id, user_name: session.user.name,
          created_at: now, field: 'plan', old_value: null, new_value: tpl.name, reason: 'Plan aus Vorlage erstellt', source: 'MANUAL',
        })
      } else if (req.plan_source.kind === 'buildflow') {
        await this.attachBuildFlow(session, id, req.plan_source.process)
      } else if (req.plan_source.kind === 'import') {
        await this.attachExtractedPlan(session, id, req.plan_source.plan)
      } else if (req.plan_source.kind === 'ai') {
        // Austauschpunkt für die spätere KI-Planerstellung (siehe shared/types AiPlanningContext)
        throw new HttpError(501, 'KI-Planerstellung ist vorbereitet, aber noch nicht verfügbar.')
      }
    })
    return (await this.repo.project(session.org.id, id))!
  }

  /**
   * BuildFlow-Prozess(e) (JSON-Export) in ein Projekt übernehmen: je Prozess eine Phase mit
   * Schritten, Abhängigkeiten, Voraussetzungen und Fristen; Verknüpfung + Snapshot für den
   * späteren Abgleich („BuildFlow wurde geändert“). Bei bestehendem Plan werden die Phasen
   * hinten angefügt.
   */
  async attachBuildFlow(session: Session, projectId: string, raw: unknown): Promise<{ processes: string[]; tasks_created: number }> {
    const processes = parseBuildFlowExport(raw)
    if (!processes.length) throw new HttpError(400, 'Kein gültiger BuildFlow-Prozess (erwartet: JSON-Export mit nodes/edges).')
    const now = nowISO()
    const bundle = await this.requireBundle(session.org.id, projectId)
    const ctx = this.planContext(bundle)
    const trades = await this.repo.trades(session.org.id)
    const existingTop = bundle.tasks.filter((t) => !t.parent_id).length
    let allTasks: Task[] = [...bundle.tasks]
    let allDeps: TaskDependency[] = [...bundle.dependencies]
    let created = 0
    const pendingConstraints: ReturnType<typeof instantiateTemplate>['constraints'] = []
    const links = (await this.db.all<{ id: string }>('SELECT id FROM project_process_links WHERE project_id = ?', projectId)).length
    await this.db.transaction(async () => {
      let i = 0
      for (const proc of processes) {
        const mapped = mapProcessToTemplate(proc, { keyPrefix: `bf${links + i + 1}`, projectStart: bundle.project.start_date, projectEnd: bundle.project.target_end_date })
        const plan = instantiateTemplate(mapped.tasks, ctx, trades, () => newId('t'))
        const idByKey = new Map(mapped.tasks.map((tt, idx) => [tt.key, plan.tasks[idx].id]))
        // Fristen (FNLT) aus BuildFlow
        for (const dl of mapped.deadlines) {
          const t = plan.tasks.find((x) => x.id === idByKey.get(dl.key))
          if (t) { t.constraint_type = 'fnlt'; t.constraint_date = dl.date; t.notes = [t.notes, dl.note].filter(Boolean).join('\n') }
        }
        for (const t of plan.tasks) if (!t.parent_id) t.sort_order += (existingTop + i) * 1000
        allTasks = [...allTasks, ...plan.tasks]
        allDeps = [...allDeps, ...plan.dependencies]
        created += plan.tasks.length
        pendingConstraints.push(...plan.constraints)
        const taskIdByNode: Record<string, string> = {}
        for (const [nodeId, key] of mapped.keyByNode) { const tid = idByKey.get(key); if (tid) taskIdByNode[nodeId] = tid }
        const phase = plan.tasks.find((t) => !t.parent_id && t.type === 'phase')
        await this.db.insert('project_process_links', { id: newId('ppl'), project_id: projectId, process_id: proc.id, process_name: proc.name, process_version: proc.templateVersion ?? String(proc.version), snapshot: proc, mapping: taskIdByNode, phase_task_id: phase?.id ?? null, created_at: now, last_synced_at: now })
        i++
      }
      const state = recompute({ tasks: allTasks, dependencies: allDeps }, ctx).state
      await this.replacePlan(projectId, state.tasks, state.dependencies)
      for (const c of pendingConstraints) await this.db.insert('task_constraints', { id: newId('cs'), ...c, created_at: now, updated_at: now })
      await this.db.insert('change_history', {
        id: newId('ch'), project_id: projectId, task_id: null, task_name: '', user_id: session.user.id, user_name: session.user.name,
        created_at: now, field: 'plan', old_value: null, new_value: processes.map((p) => p.name).join(', '), reason: 'Plan aus BuildFlow-Prozess übernommen', source: 'BUILDFLOW_SYNC',
      })
      await this.db.update('projects', projectId, { version: bundle.project.version + 1, updated_at: now })
    })
    return { processes: processes.map((p) => p.name), tasks_created: created }
  }

  /**
   * Importierten Plan (Lucidchart-Diagramm oder KI-Dokumentenanalyse) in ein Projekt
   * übernehmen: Gliederung, Dauern und Abhängigkeiten wie bei einer Vorlage, zusätzlich
   * werden Verantwortliche per Name/E-Mail auf Teammitglieder gemappt.
   */
  async attachExtractedPlan(session: Session, projectId: string, rawPlan: ExtractedPlan): Promise<{ tasks_created: number; unmatched: string[] }> {
    const plan = normalizeExtractedPlan(rawPlan, { source: rawPlan?.source, name: rawPlan?.name, reference: rawPlan?.reference })
    if (!plan.tasks.length) throw new HttpError(400, 'Der importierte Plan enthält keine Aufgaben.')
    const now = nowISO()
    const bundle = await this.requireBundle(session.org.id, projectId)
    const ctx = this.planContext(bundle)
    const trades = await this.repo.trades(session.org.id)
    const members = await this.repo.members(session.org.id)
    const existingTop = bundle.tasks.filter((t) => !t.parent_id).length
    const prefix = `im${existingTop + 1}`
    const { tasks: tplTasks, responsibleByKey } = extractedToTemplateTasks(plan, prefix)
    const instantiated = instantiateTemplate(tplTasks, ctx, trades, () => newId('t'))
    const idByKey = new Map(tplTasks.map((tt, idx) => [tt.key, instantiated.tasks[idx].id]))

    // Verantwortliche zuordnen: exakte E-Mail, sonst Namensvergleich
    const unmatched: string[] = []
    for (const [key, who] of responsibleByKey) {
      const taskId = idByKey.get(key)
      const task = instantiated.tasks.find((t) => t.id === taskId)
      if (!task) continue
      const needle = who.trim().toLowerCase()
      const hit = members.find((m) => m.user && (m.user.email.toLowerCase() === needle || m.user.name.toLowerCase() === needle))
        ?? members.find((m) => m.user && (m.user.name.toLowerCase().includes(needle) || needle.includes(m.user.name.toLowerCase())))
      if (hit?.user) {
        task.responsible_user_id = hit.user_id
        task.responsible_user_ids = [hit.user_id]
      } else {
        task.responsible_name = who.trim()
        if (!unmatched.includes(who.trim())) unmatched.push(who.trim())
      }
    }

    for (const t of instantiated.tasks) if (!t.parent_id) t.sort_order += existingTop * 1000
    await this.db.transaction(async () => {
      const state = recompute({ tasks: [...bundle.tasks, ...instantiated.tasks], dependencies: [...bundle.dependencies, ...instantiated.dependencies] }, ctx).state
      await this.replacePlan(projectId, state.tasks, state.dependencies)
      for (const c of instantiated.constraints) await this.db.insert('task_constraints', { id: newId('cs'), ...c, created_at: now, updated_at: now })
      await this.db.insert('change_history', {
        id: newId('ch'), project_id: projectId, task_id: null, task_name: '', user_id: session.user.id, user_name: session.user.name,
        created_at: now, field: 'plan', old_value: null, new_value: plan.name,
        reason: plan.source === 'lucidchart' ? 'Plan aus Lucidchart importiert' : 'Plan aus Dokument (KI) importiert', source: 'MANUAL',
      })
      await this.db.update('projects', projectId, { version: bundle.project.version + 1, updated_at: now })
    })
    return { tasks_created: instantiated.tasks.length, unmatched }
  }


  /** Projektstart nachträglich verschieben: feste Termine wandern mit, Historie mit Grund. */
  async shiftProjectStart(session: Session, projectId: string, oldStart: ISODate, newStart: ISODate): Promise<void> {
    const bundle = await this.requireBundle(session.org.id, projectId)
    const ctx = this.planContext(bundle)
    const cal = resolveCalendars({ calendars: bundle.calendars, exceptions: bundle.exceptions, projectId, projectCalendarId: bundle.project.calendar_id, holidayRegion: bundle.project.holiday_region, resources: bundle.resources }).base
    const a = cal.nextWorkday(toDayNumber(oldStart))
    const b = cal.nextWorkday(toDayNumber(newStart))
    const delta = b >= a ? cal.countWorkdays(a, b) - 1 : -(cal.countWorkdays(b, a) - 1)
    const state = shiftFixedDates({ tasks: bundle.tasks, dependencies: bundle.dependencies }, ctx, delta)
    await this.savePlan(session, projectId, { expected_version: bundle.project.version, tasks: state.tasks, dependencies: state.dependencies, reason: `Projektstart ${formatDate(oldStart)} → ${formatDate(newStart)} (${delta >= 0 ? '+' : ''}${delta} AT)`, source: 'MANUAL' })
  }

  /**
   * Plan (ganz oder ausgewählte Vorgänge inkl. Unter- und Oberknoten) als neues Projekt
   * kopieren. Fortschritt/Ist-Termine werden zurückgesetzt, Termine relativ zum neuen Start.
   */
  async duplicateProject(session: Session, sourceId: string, opts: { name?: string; number?: string; start_date?: string; task_ids?: string[]; reset_progress?: boolean }): Promise<Project> {
    const src = await this.requireBundle(session.org.id, sourceId)
    const now = nowISO()
    const id = newId('prj')
    const start = opts.start_date ?? src.project.start_date
    const deltaDays = toDayNumber(start) - toDayNumber(src.project.start_date)
    const project: Project = {
      ...src.project, id, name: opts.name?.trim() || `${src.project.name} (Kopie)`, number: opts.number ?? '', start_date: start,
      target_end_date: fromDayNumber(toDayNumber(src.project.target_end_date) + deltaDays), state: 'planning', version: 1, created_at: now, updated_at: now,
    }
    // Auswahl: gewählte Vorgänge + Nachkommen + Vorfahren (Struktur bleibt erhalten)
    const byId = new Map(src.tasks.map((t) => [t.id, t]))
    let keep: Set<string>
    if (opts.task_ids?.length) {
      keep = new Set<string>()
      const addDesc = (tid: string) => { keep.add(tid); for (const t of src.tasks) if (t.parent_id === tid) addDesc(t.id) }
      for (const tid of opts.task_ids) if (byId.has(tid)) addDesc(tid)
      for (const tid of [...keep]) { let p = byId.get(tid)?.parent_id ?? null; while (p) { keep.add(p); p = byId.get(p)?.parent_id ?? null } }
    } else keep = new Set(src.tasks.map((t) => t.id))
    const idMap = new Map<string, string>()
    for (const tid of keep) idMap.set(tid, newId('t'))
    const reset = opts.reset_progress !== false
    const shift = (iso: ISODate | null) => (iso ? fromDayNumber(toDayNumber(iso) + deltaDays) : null)
    const sectionMap = new Map<string, string>()
    const tasks: Task[] = src.tasks.filter((t) => keep.has(t.id)).map((t) => ({
      ...t, id: idMap.get(t.id)!, project_id: id, parent_id: t.parent_id ? (idMap.get(t.parent_id) ?? null) : null,
      start_date: shift(t.start_date)!, end_date: shift(t.end_date)!, constraint_date: shift(t.constraint_date),
      ...(reset ? { status: 'not_started' as const, progress: 0, actual_start: null, actual_finish: null, remaining_duration: null, actual_duration: null } : {}),
      section_id: t.section_id ? (sectionMap.get(t.section_id) ?? (sectionMap.set(t.section_id, newId('sec')), sectionMap.get(t.section_id)!)) : null,
    }))
    const deps: TaskDependency[] = src.dependencies.filter((d) => keep.has(d.predecessor_id) && keep.has(d.successor_id)).map((d) => ({ ...d, id: newId('dep'), project_id: id, predecessor_id: idMap.get(d.predecessor_id)!, successor_id: idMap.get(d.successor_id)! }))
    await this.db.transaction(async () => {
      await this.db.insert('projects', project)
      for (const m of src.members) await this.db.insert('project_members', { ...m, project_id: id })
      for (const sec of src.sections) if (sectionMap.has(sec.id)) await this.db.insert('project_sections', { ...sec, id: sectionMap.get(sec.id), project_id: id })
      const ctx = this.planContext(await this.requireBundle(session.org.id, id))
      const state = recompute({ tasks, dependencies: deps }, ctx).state
      await this.replacePlan(id, state.tasks, state.dependencies)
      for (const cs of src.constraints) if (keep.has(cs.task_id)) await this.db.insert('task_constraints', { ...cs, id: newId('cs'), project_id: id, task_id: idMap.get(cs.task_id), status: reset ? 'open' : cs.status, created_at: now, updated_at: now })
      await this.db.insert('change_history', {
        id: newId('ch'), project_id: id, task_id: null, task_name: '', user_id: session.user.id, user_name: session.user.name,
        created_at: now, field: 'plan', old_value: null, new_value: src.project.name, reason: opts.task_ids?.length ? `${opts.task_ids.length} ausgewählte Vorgänge aus „${src.project.name}“ kopiert` : `Plan aus „${src.project.name}“ kopiert`, source: 'MANUAL',
      })
    })
    return (await this.repo.project(session.org.id, id))!
  }

  async summaries(orgId: string, today = todayISO()): Promise<{ summaries: ProjectSummary[]; events: CriticalEvent[] }> {
    const projects = await this.repo.projects(orgId)
    const calendars = await this.repo.calendars(orgId)
    const exceptions = await this.repo.exceptions(orgId)
    const summaries: ProjectSummary[] = []
    const events: CriticalEvent[] = []
    for (const project of projects) {
      const bundle: ProjectBundle = {
        project,
        tasks: await this.repo.tasks(project.id),
        dependencies: await this.repo.dependencies(project.id),
        calendars,
        exceptions,
        baselines: await this.repo.baselines(project.id),
        baseline_tasks: await this.repo.baselineTasks(project.id),
        assignments: [],
        members: [],
        sections: [],
        constraints: [],
        resources: [],
      }
      const a = analyzeProject(bundle, today)
      summaries.push({
        project,
        health: a.health,
        progress: a.progress,
        planned_end: a.planned_end,
        baseline_end: a.baseline_end,
        forecast_end: a.forecast_end,
        variance_days: a.variance_days,
        next_milestone: a.next_milestone,
        critical_count: a.critical_count,
        delayed_count: a.delayed_count,
        overdue_count: a.overdue_count,
        task_count: a.task_count,
        done_count: a.done_count,
        project_manager_name: await this.repo.userName(project.project_manager_id),
        site_manager_name: await this.repo.userName(project.site_manager_id),
      })
      if (project.state === 'active') events.push(...criticalEvents(project, bundle, a, today))
    }
    events.sort((x, y) => severityRank(y.severity) - severityRank(x.severity) || x.date.localeCompare(y.date))
    return { summaries, events }
  }
}

function severityRank(s: CriticalEvent['severity']): number {
  return s === 'critical' ? 2 : s === 'warning' ? 1 : 0
}

function sanitizeTask(t: Task): Task {
  return {
    ...t,
    name: String(t.name ?? '').slice(0, 200),
    duration: Math.max(0, Number(t.duration) | 0),
    progress: Math.max(0, Math.min(100, Number(t.progress) | 0)),
    sort_order: Number(t.sort_order) || 0,
    description: String(t.description ?? ''),
    notes: String(t.notes ?? ''),
    responsible_name: String(t.responsible_name ?? '').slice(0, 120),
    responsible_user_ids: Array.isArray(t.responsible_user_ids) ? t.responsible_user_ids.map(String).slice(0, 20) : [],
  }
}

function diffTasks(before: Task[], after: Task[], session: Session, projectId: string, reason: string, source: ChangeSource = 'MANUAL'): ChangeHistoryEntry[] {
  const out: ChangeHistoryEntry[] = []
  const now = nowISO()
  const byId = new Map(before.map((t) => [t.id, t]))
  const base = { project_id: projectId, user_id: session.user.id, user_name: session.user.name, created_at: now, reason, source }
  for (const t of after) {
    const old = byId.get(t.id)
    if (!old) {
      out.push({ id: newId('ch'), ...base, task_id: t.id, task_name: t.name, field: 'created', old_value: null, new_value: `${formatDate(t.start_date)}–${formatDate(t.end_date)}` })
      continue
    }
    // Start+Ende gemeinsam als "Termin" protokollieren, damit die Historie lesbar bleibt
    if (old.start_date !== t.start_date || old.end_date !== t.end_date) {
      out.push({
        id: newId('ch'), ...base, task_id: t.id, task_name: t.name, field: 'Termin',
        old_value: `${formatDate(old.start_date)}–${formatDate(old.end_date)}`, new_value: `${formatDate(t.start_date)}–${formatDate(t.end_date)}`,
      })
    }
    for (const key of Object.keys(TRACKED) as (keyof Task)[]) {
      if (key === 'start_date' || key === 'end_date') continue
      if (old[key] !== t[key]) {
        out.push({ id: newId('ch'), ...base, task_id: t.id, task_name: t.name, field: TRACKED[key]!, old_value: fmt(old[key]), new_value: fmt(t[key]) })
      }
    }
  }
  const afterIds = new Set(after.map((t) => t.id))
  for (const t of before) if (!afterIds.has(t.id)) out.push({ id: newId('ch'), ...base, task_id: t.id, task_name: t.name, field: 'deleted', old_value: t.name, new_value: null })
  return out
}

function diffDependencies(before: TaskDependency[], after: TaskDependency[], oldTasks: Task[], newTasks: Task[], session: Session, projectId: string, reason: string, source: ChangeSource = 'MANUAL'): ChangeHistoryEntry[] {
  const key = (d: TaskDependency) => `${d.predecessor_id}>${d.successor_id}:${d.type}:${d.lag_days}`
  const b = new Map(before.map((d) => [key(d), d]))
  const a = new Map(after.map((d) => [key(d), d]))
  const names = new Map([...oldTasks, ...newTasks].map((t) => [t.id, t.name]))
  const out: ChangeHistoryEntry[] = []
  const base = { project_id: projectId, user_id: session.user.id, user_name: session.user.name, created_at: nowISO(), reason, source }
  const label = (d: TaskDependency) => `${names.get(d.predecessor_id) ?? '?'} → ${names.get(d.successor_id) ?? '?'} (${d.type}${d.lag_days ? (d.lag_days > 0 ? '+' : '') + d.lag_days : ''})`
  for (const [k, d] of a) if (!b.has(k)) out.push({ id: newId('ch'), ...base, task_id: d.successor_id, task_name: names.get(d.successor_id) ?? '', field: 'Abhängigkeit', old_value: null, new_value: label(d) })
  for (const [k, d] of b) if (!a.has(k)) out.push({ id: newId('ch'), ...base, task_id: d.successor_id, task_name: names.get(d.successor_id) ?? '', field: 'Abhängigkeit', old_value: label(d), new_value: null })
  return out
}

function fmt(v: unknown): string | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return formatDate(v as ISODate)
  return String(v)
}
