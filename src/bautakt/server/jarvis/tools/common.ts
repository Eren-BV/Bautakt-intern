/**
 * Gemeinsame Bausteine der Jarvis-Werkzeuge: Kontext, JSON-Schema-Helfer, Namensauflösung,
 * Datumsformate und der Schreibpfad (Plan speichern, Rückgängig-Daten, Bestätigung).
 */

import type { Db } from '../../db.ts'
import { HttpError, sha256Hex } from '../../auth.ts'
import { Repo } from '../../repo.ts'
import { ProjectService } from '../../services/projectService.ts'
import { can, type Capability } from '../../../shared/permissions.ts'
import type { Company, ISODate, OrganizationMember, Project, ProjectBundle, Session, Task, User } from '../../../shared/types.ts'
import type { JarvisContext, JarvisEvent, JarvisImpactRow } from '../../../shared/jarvis/protocol.ts'
import { resolveCalendars, type WorkCalendar } from '../../../shared/engine/calendar.ts'
import { analyzeImpact, flattenTree, type PlanContext, type PlanState } from '../../../shared/engine/operations.ts'
import { toDayNumber } from '../../../shared/engine/dates.ts'
import { resolveOne } from '../resolve.ts'
import { planDiff, recordAction, type JarvisUndo } from '../actions.ts'

export interface ToolCtx {
  db: Db
  session: Session
  context: JarvisContext
  today: ISODate
  emit: (e: JarvisEvent) => void
  callId: string
  conversationId: string | null
  /** Direkte Schreibvorgänge in dieser Runde (ab dem vierten ist eine Bestätigung nötig) */
  writes: { count: number }
  /** Ausführung einer vom Nutzer bestätigten Aktion (nie vom Modell gesetzt) */
  confirmed: { action_id: string; fingerprint: string | null } | null
}

export type Args = Record<string, unknown>

export interface ToolResult {
  ok: boolean
  status?: 'needs_confirmation' | 'ambiguous' | 'not_found' | 'forbidden' | 'invalid' | 'conflict'
  /** Kurzfassung für die Aktionsliste im Jarvis-Fenster */
  summary?: string
  action_id?: string
  undoable?: boolean
  link?: { label: string; to: string }
  [k: string]: unknown
}

export interface ToolDef {
  name: string
  description: string
  parameters: Record<string, unknown>
  /** Beschriftung, solange das Werkzeug läuft */
  label: (a: Args) => string
  run: (ctx: ToolCtx, a: Args) => Promise<ToolResult>
}

// ---------------------------------------------------------------- JSON-Schema (strict mode)

export const s = {
  str: (description: string) => ({ type: 'string', description }),
  nstr: (description: string) => ({ type: ['string', 'null'], description }),
  nint: (description: string) => ({ type: ['integer', 'null'], description }),
  bool: (description: string) => ({ type: 'boolean', description }),
  nbool: (description: string) => ({ type: ['boolean', 'null'], description }),
  nenum: (values: string[], description: string) => ({ type: ['string', 'null'], enum: [...values, null], description }),
  enum: (values: string[], description: string) => ({ type: 'string', enum: values, description }),
  nlist: (items: object, description: string) => ({ type: ['array', 'null'], items, description }),
  list: (items: object, description: string) => ({ type: 'array', items, description }),
  object: (props: Record<string, object>) => ({ type: 'object', additionalProperties: false, required: Object.keys(props), properties: props }),
}

export const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
export const int = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : null)
export const isoDate = (v: unknown): ISODate | null => {
  const t = str(v)
  return t && /^\d{4}-\d{2}-\d{2}$/.test(t) ? t : null
}

// ---------------------------------------------------------------- Rechte

export function allowed(ctx: ToolCtx, cap: Capability): boolean {
  return can(ctx.session.role, cap)
}

export function forbidden(message: string): ToolResult {
  return { ok: false, status: 'forbidden', message, summary: 'Keine Berechtigung' }
}

// ---------------------------------------------------------------- Datumsformate

const WEEKDAY_SHORT = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa']

export function shortDate(iso: ISODate | null | undefined): string {
  if (!iso) return '–'
  const d = new Date(`${iso}T12:00:00Z`)
  return `${WEEKDAY_SHORT[d.getUTCDay()]} ${iso.slice(8, 10)}.${iso.slice(5, 7)}.`
}

/** „1 Vorgang“ / „3 Vorgänge“ */
export function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

const spokenFormat = new Intl.DateTimeFormat('de-DE', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' })

/** „Montag, 12. Oktober“ - mit Jahr, wenn es nicht das laufende ist („Montag, 22. Februar 2027“) */
export function spokenDate(iso: ISODate | null | undefined): string {
  if (!iso) return ''
  const text = spokenFormat.format(new Date(`${iso}T12:00:00Z`))
  return iso.slice(0, 4) === String(new Date().getFullYear()) ? text : `${text} ${iso.slice(0, 4)}`
}

// ---------------------------------------------------------------- Auflösung von Namen

type Found<T> = { item: T; result?: undefined } | { item?: undefined; result: ToolResult }

export async function findProject(ctx: ToolCtx, ref: unknown): Promise<Found<Project>> {
  const repo = new Repo(ctx.db)
  const orgId = ctx.session.org.id
  const text = str(ref)
  if (!text) {
    if (ctx.context.project_id) {
      const p = await repo.project(orgId, ctx.context.project_id)
      if (p) return { item: p }
    }
    return { result: { ok: false, status: 'invalid', message: 'Kein Projekt angegeben und keins geöffnet – frag, welches Projekt gemeint ist.' } }
  }
  const projects = await repo.projects(orgId)
  const r = resolveOne(
    text,
    projects.map((p) => ({ item: p, text: p.name, extra: [p.number, p.customer, p.city, p.address].filter(Boolean), boost: p.id === ctx.context.project_id ? 0.1 : 0 })),
    (id) => projects.find((p) => p.id === id),
  )
  if (r.status === 'ok') return { item: r.item }
  if (r.status === 'ambiguous') return { result: { ok: false, status: 'ambiguous', message: 'Mehrere Projekte passen – frag nach.', options: r.options.map((p) => ({ id: p.id, name: p.name, city: p.city })) } }
  return { result: { ok: false, status: 'not_found', message: `Kein Projekt „${text}“ gefunden.`, suggestions: r.suggestions.map((p) => ({ id: p.id, name: p.name, city: p.city })) } }
}

/** „Vorgang 5“, „Nr. 12“, „#3“ oder eine nackte Zahl - dieselbe laufende Nummer wie in der Gantt-Spalte. */
const TASK_NUMBER_REF = /^(?:vorgang|aufgabe|task|nr\.?|nummer|position|pos\.?|#)?\s*#?\s*(\d{1,4})$/i

export function findTask(ctx: ToolCtx, bundle: ProjectBundle, ref: unknown): Found<Task> {
  const text = str(ref)
  if (!text) {
    const selected = ctx.context.task_id ? bundle.tasks.find((t) => t.id === ctx.context.task_id) : undefined
    if (selected) return { item: selected }
    return { result: { ok: false, status: 'invalid', message: 'Kein Vorgang angegeben – frag, welcher gemeint ist.' } }
  }
  const flat = flattenTree(bundle.tasks)
  const numberById = new Map(flat.map((f, i) => [f.task.id, i + 1]))
  const numMatch = TASK_NUMBER_REF.exec(text)
  if (numMatch) {
    const n = Number(numMatch[1])
    const found = flat[n - 1]?.task
    if (found) return { item: found }
    return { result: { ok: false, status: 'not_found', message: `Vorgang Nr. ${n} gibt es in „${bundle.project.name}“ nicht.` } }
  }
  const byId = new Map(bundle.tasks.map((t) => [t.id, t]))
  const parentName = (t: Task) => (t.parent_id ? byId.get(t.parent_id)?.name ?? '' : '')
  const r = resolveOne(
    text,
    bundle.tasks.map((t) => ({ item: t, text: t.name, extra: [`${parentName(t)} ${t.name}`], boost: t.id === ctx.context.task_id ? 0.15 : 0 })),
    (id) => byId.get(id),
  )
  if (r.status === 'ok') return { item: r.item }
  if (r.status === 'ambiguous') {
    return {
      result: {
        ok: false, status: 'ambiguous', message: 'Mehrere Vorgänge passen – frag nach, am besten mit der Vorgangsnummer (number).',
        options: r.options.map((t) => ({ number: numberById.get(t.id), id: t.id, name: t.name, phase: parentName(t), start: shortDate(t.start_date), end: shortDate(t.end_date) })),
      },
    }
  }
  return {
    result: {
      ok: false, status: 'not_found', message: `Kein Vorgang „${text}“ im Projekt „${bundle.project.name}“ gefunden.`,
      suggestions: r.suggestions.map((t) => ({ number: numberById.get(t.id), id: t.id, name: t.name, phase: parentName(t) })),
    },
  }
}

/** „Vorgänge 3 bis 7“, „3-7“, „#3–#7“ - dieselbe laufende Nummer wie in der Gantt-Spalte. */
const TASK_RANGE_REF = /^(?:vorgänge|vorgang|aufgaben)?\s*#?\s*(\d{1,4})\s*(?:bis|-|–|to)\s*#?\s*(\d{1,4})$/i

/**
 * Löst mehrere Vorgänge auf einmal auf: einzelne IDs/Nummern/Namen ODER ein Nummernbereich
 * („Vorgänge 3 bis 7“) in einem einzigen Eintrag. Bricht beim ersten Fehler ab.
 */
export function findTasks(ctx: ToolCtx, bundle: ProjectBundle, refs: unknown[]): Found<Task[]> {
  const flat = flattenTree(bundle.tasks)
  const found: Task[] = []
  const seen = new Set<string>()
  const add = (t: Task) => {
    if (!seen.has(t.id)) {
      seen.add(t.id)
      found.push(t)
    }
  }
  for (const ref of refs) {
    const text = str(ref)
    const range = text ? TASK_RANGE_REF.exec(text) : null
    if (range) {
      const from = Number(range[1])
      const to = Number(range[2])
      const [lo, hi] = from <= to ? [from, to] : [to, from]
      for (let n = lo; n <= hi; n++) {
        const t = flat[n - 1]?.task
        if (!t) return { result: { ok: false, status: 'not_found', message: `Vorgang Nr. ${n} gibt es in „${bundle.project.name}“ nicht.` } }
        add(t)
      }
      continue
    }
    const r = findTask(ctx, bundle, ref)
    if (r.result) return { result: r.result }
    add(r.item)
  }
  return { item: found }
}

export type Person = OrganizationMember & { user: User }

export async function findPerson(ctx: ToolCtx, ref: unknown): Promise<Found<Person>> {
  const text = str(ref)
  if (!text) return { result: { ok: false, status: 'invalid', message: 'Keine Person angegeben.' } }
  const members = (await new Repo(ctx.db).members(ctx.session.org.id)).filter((m): m is Person => !!m.user)
  if (/^(mich|mir|ich|selbst)$/i.test(text)) {
    const me = members.find((m) => m.user_id === ctx.session.user.id)
    if (me) return { item: me }
  }
  const r = resolveOne(
    text,
    members.map((m) => ({ item: m, text: m.user.name, extra: [m.user.email, m.user.email.split('@')[0]!] })),
    (id) => members.find((m) => m.user_id === id),
  )
  if (r.status === 'ok') return { item: r.item }
  if (r.status === 'ambiguous') return { result: { ok: false, status: 'ambiguous', message: 'Mehrere Personen passen – frag nach.', options: r.options.map((m) => ({ id: m.user_id, name: m.user.name, role: m.role })) } }
  return { result: { ok: false, status: 'not_found', message: `Keine Person „${text}“ im Team gefunden.`, suggestions: r.suggestions.map((m) => ({ id: m.user_id, name: m.user.name })) } }
}

export async function findCompany(ctx: ToolCtx, ref: unknown): Promise<Found<Company>> {
  const text = str(ref)
  if (!text) return { result: { ok: false, status: 'invalid', message: 'Keine Firma angegeben.' } }
  const companies = await new Repo(ctx.db).companies(ctx.session.org.id)
  const r = resolveOne(text, companies.map((c) => ({ item: c, text: c.name, extra: [c.contact_name].filter(Boolean) })), (id) => companies.find((c) => c.id === id))
  if (r.status === 'ok') return { item: r.item }
  if (r.status === 'ambiguous') return { result: { ok: false, status: 'ambiguous', message: 'Mehrere Firmen passen – frag nach.', options: r.options.map((c) => ({ id: c.id, name: c.name })) } }
  return { result: { ok: false, status: 'not_found', message: `Keine Firma „${text}“ gefunden.`, suggestions: r.suggestions.map((c) => ({ id: c.id, name: c.name })) } }
}

// ---------------------------------------------------------------- Planung

export function projectCalendar(bundle: ProjectBundle): WorkCalendar {
  return resolveCalendars({
    calendars: bundle.calendars,
    exceptions: bundle.exceptions,
    projectId: bundle.project.id,
    projectCalendarId: bundle.project.calendar_id,
    holidayRegion: bundle.project.holiday_region,
    resources: bundle.resources,
  }).base
}

export function planContextFor(ctx: ToolCtx, bundle: ProjectBundle): PlanContext {
  return { ...new ProjectService(ctx.db).planContext(bundle, ctx.today), today: ctx.today }
}

export function taskView(t: Task) {
  return {
    id: t.id,
    name: t.name,
    type: t.type,
    start: t.start_date,
    end: t.end_date,
    start_text: spokenDate(t.start_date),
    end_text: spokenDate(t.end_date),
    duration_workdays: t.duration,
    status: t.status,
    progress: t.progress,
  }
}

export interface ImpactSummary {
  moved: number
  project_end_old: ISODate
  project_end_new: ISODate
  project_end_shift_workdays: number
  milestones_moved: { name: string; old: ISODate; new: ISODate }[]
  rows: JarvisImpactRow[]
}

export function summarizeImpact(bundle: ProjectBundle, before: PlanState, after: PlanState, pctx: PlanContext, ignore: string[] = []): ImpactSummary {
  const impact = analyzeImpact(before, after, pctx, ignore)
  const cal = projectCalendar(bundle)
  const a = toDayNumber(impact.oldProjectEnd)
  const b = toDayNumber(impact.newProjectEnd)
  const shift = a === b ? 0 : b > a ? cal.countWorkdays(a + 1, b) : -cal.countWorkdays(b + 1, a)
  const types = new Map(bundle.tasks.map((t) => [t.id, t.type]))
  return {
    moved: impact.affected.length,
    project_end_old: impact.oldProjectEnd,
    project_end_new: impact.newProjectEnd,
    project_end_shift_workdays: shift,
    milestones_moved: impact.affected.filter((x) => types.get(x.id) === 'milestone').map((x) => ({ name: x.name, old: x.oldStart, new: x.newStart })),
    rows: impact.affected.slice(0, 12).map((x) => ({ name: x.name, old_start: x.oldStart, old_end: x.oldEnd, new_start: x.newStart, new_end: x.newEnd })),
  }
}

export async function fingerprint(parts: unknown): Promise<string> {
  return (await sha256Hex(JSON.stringify(parts))).slice(0, 24)
}

/**
 * Schreibt einen neuen Planstand mit Versionsschutz, legt die Rückgängig-Daten ab und zeigt die
 * Änderung im Gantt (neu laden + hervorheben). Gibt die neue Version zurück.
 */
export async function commitPlan(
  ctx: ToolCtx,
  bundle: ProjectBundle,
  before: PlanState,
  after: PlanState,
  opts: { tool: string; args: Args; reason: string; summary: string; highlight: string[] },
): Promise<{ version: number; action_id: string }> {
  const svc = new ProjectService(ctx.db)
  const res = await svc.savePlan(ctx.session, bundle.project.id, {
    expected_version: bundle.project.version,
    tasks: after.tasks,
    dependencies: after.dependencies,
    reason: `Jarvis: ${opts.reason}`,
    source: 'FUTURE_AI',
  })
  ctx.writes.count++
  const saved = { tasks: res.tasks, dependencies: after.dependencies }
  const action_id = await recordAction(ctx.db, ctx.session, {
    conversation_id: ctx.conversationId,
    project_id: bundle.project.id,
    tool: opts.tool,
    args: opts.args,
    status: 'done',
    summary: opts.summary,
    version_after: res.version,
    undo: planDiff(before, saved),
  })
  ctx.emit({ type: 'ui', action: 'reload_project', project_id: bundle.project.id, version: res.version })
  if (opts.highlight.length) ctx.emit({ type: 'ui', action: 'highlight', project_id: bundle.project.id, task_ids: opts.highlight.slice(0, 30) })
  return { version: res.version, action_id }
}

/** Legt eine vom Nutzer zu bestätigende Aktion an und zeigt die Bestätigungskarte. */
export async function requestConfirmation(
  ctx: ToolCtx,
  opts: { project_id: string | null; tool: string; args: Args; title: string; lines: string[]; impact: ImpactSummary | null; fingerprint: string | null; summary: string },
): Promise<ToolResult> {
  const expires_at = new Date(Date.now() + 10 * 60_000).toISOString()
  const action_id = await recordAction(ctx.db, ctx.session, {
    conversation_id: ctx.conversationId,
    project_id: opts.project_id,
    tool: opts.tool,
    args: opts.args,
    status: 'pending',
    summary: opts.summary,
    fingerprint: opts.fingerprint,
    expires_at,
  })
  ctx.emit({
    type: 'confirm',
    action_id,
    title: opts.title,
    lines: opts.lines,
    impact: opts.impact ? { old_end: opts.impact.project_end_old, new_end: opts.impact.project_end_new, affected: opts.impact.rows } : null,
    expires_at,
  })
  return {
    ok: false,
    status: 'needs_confirmation',
    action_id,
    summary: 'Wartet auf Bestätigung',
    message: `Bestätigung nötig: ${opts.summary}. Sag in einem Satz, was passiert, und frag „Soll ich?“. Nur der Nutzer kann bestätigen.`,
  }
}

/** Führt `fn` aus und wiederholt einmal, wenn zwischendurch jemand anderes gespeichert hat. */
export async function withConflictRetry<T>(fn: (attempt: number) => Promise<T>): Promise<T> {
  try {
    return await fn(0)
  } catch (e) {
    if (e instanceof HttpError && e.status === 409) return fn(1)
    throw e
  }
}

export function projectPath(projectId: string, sub = ''): string {
  return sub ? `/projects/${projectId}/${sub}` : `/projects/${projectId}`
}

export type { JarvisUndo }
