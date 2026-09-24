/**
 * Planoperationen: verändern Vorgänge/Abhängigkeiten und rechnen den Plan neu.
 * Jede Operation ist eine reine Funktion (alte Daten rein, neue Daten raus) - damit
 * funktionieren Undo/Redo (Snapshots), Vorschau ("Was passiert, wenn…") und
 * Szenarien mit derselben Logik.
 */

import type { ISODate, Task, TaskDependency, DependencyType, TaskType } from '../types.ts'
import { fromDayNumber, toDayNumber } from './dates.ts'
import { applyScheduleToDependencies, applyScheduleToTasks, computeSchedule, wouldCreateCycle, type ScheduleInput, type ScheduleResult } from './schedule.ts'
import { newDependency, newTask } from './defaults.ts'

export interface PlanState {
  tasks: Task[]
  dependencies: TaskDependency[]
}

export type PlanContext = Omit<ScheduleInput, 'tasks' | 'dependencies'> & { today?: ISODate }

export function recompute(state: PlanState, ctx: PlanContext): { state: PlanState; result: ScheduleResult } {
  const result = computeSchedule({ ...ctx, tasks: state.tasks, dependencies: state.dependencies }, { today: ctx.today })
  return { state: { tasks: applyScheduleToTasks(state.tasks, result), dependencies: applyScheduleToDependencies(state.dependencies, result) }, result }
}

export interface ImpactAnalysis {
  affected: { id: string; name: string; oldStart: ISODate; oldEnd: ISODate; newStart: ISODate; newEnd: ISODate; shiftDays: number }[]
  oldProjectEnd: ISODate
  newProjectEnd: ISODate
  projectEndShiftDays: number
}

/** Vergleicht zwei Zustände und listet alle Vorgänge mit geänderten Terminen */
export function analyzeImpact(before: PlanState, after: PlanState, ctx: PlanContext, ignoreIds: string[] = []): ImpactAnalysis {
  const a = recompute(before, ctx)
  const b = recompute(after, ctx)
  const ignore = new Set(ignoreIds)
  const affected: ImpactAnalysis['affected'] = []
  for (const t of b.state.tasks) {
    if (ignore.has(t.id)) continue
    const old = a.state.tasks.find((x) => x.id === t.id)
    if (!old) continue
    if (old.start_date !== t.start_date || old.end_date !== t.end_date) {
      affected.push({
        id: t.id,
        name: t.name,
        oldStart: old.start_date,
        oldEnd: old.end_date,
        newStart: t.start_date,
        newEnd: t.end_date,
        shiftDays: toDayNumber(t.end_date) - toDayNumber(old.end_date),
      })
    }
  }
  return {
    affected,
    oldProjectEnd: fromDayNumber(a.result.projectEnd),
    newProjectEnd: fromDayNumber(b.result.projectEnd),
    projectEndShiftDays: b.result.projectEnd - a.result.projectEnd,
  }
}

function replaceTask(state: PlanState, id: string, patch: Partial<Task>): PlanState {
  return { ...state, tasks: state.tasks.map((t) => (t.id === id ? { ...t, ...patch } : t)) }
}

/**
 * Verschiebt einen Vorgang auf einen neuen Start. Automatisch geplante Vorgänge erhalten
 * eine SNET-Einschränkung (wie MS Project); manuelle behalten ihre Dauer und bekommen
 * den neuen Start direkt. Bei `cascade=false` werden alle Vorgänge, die sich dadurch
 * verschieben würden, auf "manuell" mit ihren bisherigen Terminen fixiert - der Nutzer
 * hat bewusst nur diesen einen Vorgang geändert.
 */
export function moveTask(state: PlanState, ctx: PlanContext, id: string, newStart: ISODate, cascade: boolean): PlanState {
  const task = state.tasks.find((t) => t.id === id)
  if (!task) return state
  const moved = moveTaskRaw(state, ctx, task, newStart)
  if (cascade) return recompute(moved, ctx).state
  return pinOthers(state, moved, ctx, [id])
}

function moveTaskRaw(state: PlanState, ctx: PlanContext, task: Task, newStart: ISODate): PlanState {
  const hasChildren = state.tasks.some((t) => t.parent_id === task.id)
  if (hasChildren && task.type !== 'milestone') {
    // Sammelvorgang verschieben = alle Blätter darunter um dieselbe Anzahl Arbeitstage verschieben
    const before = recompute(state, ctx)
    const sched = before.result.tasks.get(task.id)!
    const cal = sched.calendar
    const target = cal.nextWorkday(toDayNumber(newStart))
    const shift = cal.countWorkdays(Math.min(sched.start, target), Math.max(sched.start, target)) - 1
    const signed = target >= sched.start ? shift : -shift
    if (signed === 0) return state
    const descendants = collectDescendants(state.tasks, task.id).filter((d) => !state.tasks.some((t) => t.parent_id === d.id))
    let next = state
    for (const d of descendants) {
      const ds = before.result.tasks.get(d.id)
      if (!ds || d.status === 'done') continue
      const nd = fromDayNumber(ds.calendar.addWorkdays(ds.start, signed))
      next = moveTaskRaw(next, ctx, d, nd)
    }
    return next
  }
  if (task.actual_start) {
    return replaceTask(state, task.id, { actual_start: newStart, start_date: newStart })
  }
  if (task.scheduling_mode === 'manual') {
    const before = recompute(state, ctx).result.tasks.get(task.id)!
    const cal = before.calendar
    const s = cal.nextWorkday(toDayNumber(newStart))
    const e = task.type === 'milestone' ? s : cal.addWorkdays(s, Math.max(0, before.duration - 1))
    return replaceTask(state, task.id, { start_date: fromDayNumber(s), end_date: fromDayNumber(e) })
  }
  // Vom Anwender gesetzter Start gilt exakt ("Muss beginnen am") - auch parallel zu anderen
  // Vorgängen am selben Tag. Vorgänger verschieben ihn nicht mehr nach hinten.
  // Das Enddatum wird um dieselbe Anzahl Arbeitstage mitgenommen, damit die Dauer gleich bleibt.
  const before = recompute(state, ctx).result.tasks.get(task.id)!
  const cal = before.calendar
  const s = cal.nextWorkday(toDayNumber(newStart))
  const e = task.type === 'milestone' ? s : cal.addWorkdays(s, Math.max(0, before.duration - 1))
  return replaceTask(state, task.id, { constraint_type: 'mso', constraint_date: fromDayNumber(s), start_date: fromDayNumber(s), end_date: fromDayNumber(e) })
}

/** Mehrere Vorgänge gemeinsam um dieselbe Anzahl Arbeitstage verschieben (Mehrfachauswahl) */
export function moveTasks(state: PlanState, ctx: PlanContext, ids: string[], shiftWorkdays: number, cascade: boolean): PlanState {
  if (!shiftWorkdays || ids.length === 0) return state
  const before = recompute(state, ctx)
  const set = new Set(ids)
  // nur oberste ausgewählte Knoten verschieben (Kinder folgen über moveTaskRaw)
  const tops = state.tasks.filter((t) => set.has(t.id) && !hasSelectedAncestor(state.tasks, t, set))
  let next = state
  for (const t of tops) {
    const s = before.result.tasks.get(t.id)
    if (!s || t.status === 'done') continue
    next = moveTaskRaw(next, ctx, t, fromDayNumber(s.calendar.addWorkdays(s.start, shiftWorkdays)))
  }
  if (cascade) return recompute(next, ctx).state
  return pinOthers(state, next, ctx, [...collectWithDescendants(state.tasks, tops.map((t) => t.id))])
}

/**
 * Projektstart verschoben: automatisch geplante Vorgänge folgen dem neuen Start von selbst;
 * feste Termine (manuell geplant, Einschränkungsdaten) werden um `shiftWorkdays` mitgenommen,
 * damit der ganze Plan zusammenbleibt. Ist-Termine bleiben unverändert.
 */
export function shiftFixedDates(state: PlanState, ctx: PlanContext, shiftWorkdays: number): PlanState {
  if (!shiftWorkdays) return recompute(state, ctx).state
  const before = recompute(state, ctx)
  const tasks = state.tasks.map((t) => {
    const s = before.result.tasks.get(t.id)
    if (!s || t.status === 'done' || t.actual_start) return t
    const next = { ...t }
    if (t.constraint_date) next.constraint_date = fromDayNumber(s.calendar.addWorkdays(toDayNumber(t.constraint_date), shiftWorkdays))
    if (t.scheduling_mode === 'manual') {
      next.start_date = fromDayNumber(s.calendar.addWorkdays(toDayNumber(t.start_date), shiftWorkdays))
      next.end_date = fromDayNumber(s.calendar.addWorkdays(toDayNumber(t.end_date), shiftWorkdays))
    }
    return next
  })
  return recompute({ ...state, tasks }, ctx).state
}

function hasSelectedAncestor(tasks: Task[], t: Task, set: Set<string>): boolean {
  const byId = new Map(tasks.map((x) => [x.id, x]))
  let p = t.parent_id
  while (p) {
    if (set.has(p)) return true
    p = byId.get(p)?.parent_id ?? null
  }
  return false
}

function collectWithDescendants(tasks: Task[], ids: string[]): string[] {
  const out = new Set(ids)
  for (const id of ids) for (const d of collectDescendants(tasks, id)) out.add(d.id)
  return [...out]
}

/** Fixiert alle Vorgänge außer `keepIds`, die sich durch die Änderung verschoben hätten */
function pinOthers(before: PlanState, after: PlanState, ctx: PlanContext, keepIds: string[]): PlanState {
  const impact = analyzeImpact(before, after, ctx, keepIds)
  const oldById = new Map(recompute(before, ctx).state.tasks.map((t) => [t.id, t]))
  let next = after
  for (const a of impact.affected) {
    const old = oldById.get(a.id)!
    const hasChildren = before.tasks.some((t) => t.parent_id === a.id)
    if (hasChildren) continue // Sammelvorgänge folgen ihren Kindern
    next = replaceTask(next, a.id, { scheduling_mode: 'manual', start_date: old.start_date, end_date: old.end_date })
  }
  return recompute(next, ctx).state
}

/** Ändert die Dauer (Balken-Ende ziehen oder Dauer-Spalte editieren) */
export function setDuration(state: PlanState, ctx: PlanContext, id: string, duration: number, cascade = true): PlanState {
  const task = state.tasks.find((t) => t.id === id)
  if (!task || task.type === 'milestone') return state
  const d = Math.max(1, Math.round(duration))
  const patch: Record<string, unknown> = { duration: d, remaining_duration: null }
  // Bei fest terminierten Vorgängen (manuell geplant oder "Muss beginnen am") gewinnt das
  // gespeicherte Enddatum über die Dauer. Deshalb Ende aus Start + Dauer neu berechnen,
  // sonst bliebe eine geänderte Dauer (z. B. 1 AT) wirkungslos.
  const sched = recompute(state, ctx).result.tasks.get(id)
  if (sched) {
    const startDay = sched.calendar.nextWorkday(toDayNumber(task.start_date || fromDayNumber(sched.start)))
    patch.end_date = fromDayNumber(sched.calendar.addWorkdays(startDay, d - 1))
  }
  const changed = replaceTask(state, id, patch as Partial<Task>)
  if (cascade) return recompute(changed, ctx).state
  return pinOthers(state, changed, ctx, [id])
}

/** Setzt das Ende direkt (Dauer wird aus Start/Ende berechnet). Das gewählte Ende gilt exakt -
 *  einzige Grenze: nicht vor dem Start. Der Start bleibt dabei stehen (Start = Ende ist erlaubt). */
export function setEndDate(state: PlanState, ctx: PlanContext, id: string, end: ISODate, cascade = true): PlanState {
  const sched = recompute(state, ctx).result.tasks.get(id)
  if (!sched) return state
  const cal = sched.calendar
  const task = state.tasks.find((t) => t.id === id)!
  // Anker ist der aktuell angezeigte Start des Vorgangs - nicht der rechnerische Plananfang,
  // damit der Start beim Enddatum-Setzen nicht nach vorn rutscht.
  const startDay = toDayNumber(task.start_date)
  const raw = toDayNumber(end)
  // Fällt das gewählte Ende auf einen freien Tag, zählt der letzte Arbeitstag davor
  let e = cal.isWorkday(raw) ? raw : cal.prevWorkday(raw)
  if (e < startDay) e = startDay
  const dur = Math.max(task.type === 'milestone' ? 0 : 1, cal.countWorkdays(startDay, e))
  const startIso = fromDayNumber(startDay)
  if (task.scheduling_mode === 'manual' || task.actual_start) {
    const changed = replaceTask(state, id, { end_date: fromDayNumber(e), duration: dur })
    return recompute(changed, ctx).state
  }
  // Start festhalten, damit das gewählte Ende nicht durch Vorgänger verschoben wird
  const pinned = replaceTask(state, id, {
    duration: dur,
    remaining_duration: null,
    constraint_type: 'mso',
    constraint_date: startIso,
    start_date: startIso,
    end_date: fromDayNumber(e),
  })
  if (cascade) return recompute(pinned, ctx).state
  return pinOthers(state, pinned, ctx, [id])
}


export function setStartDate(state: PlanState, ctx: PlanContext, id: string, start: ISODate, cascade = true): PlanState {
  return moveTask(state, ctx, id, start, cascade)
}

/** Vorgang wieder automatisch planen (Einschränkung/manuellen Modus entfernen) */
export function releaseConstraint(state: PlanState, ctx: PlanContext, id: string): PlanState {
  return recompute(replaceTask(state, id, { constraint_type: 'asap', constraint_date: null, scheduling_mode: 'auto' }), ctx).state
}

/**
 * Ein Nachfolger, der eine Abhängigkeit bekommt, soll wieder automatisch geplant werden:
 * Start = nächstmöglicher Arbeitstag nach dem spätesten maßgeblichen Vorgängerende.
 * Bereits begonnene Vorgänge (actual_start) bleiben unangetastet.
 */
function unpinSuccessor(state: PlanState, id: string): PlanState {
  const t = state.tasks.find((x) => x.id === id)
  if (!t || t.actual_start) return state
  if (t.scheduling_mode === 'auto' && (t.constraint_type === 'asap' || !t.constraint_type)) return state
  return replaceTask(state, id, { scheduling_mode: 'auto', constraint_type: 'asap', constraint_date: null })
}

export function addDependency(
  state: PlanState,
  ctx: PlanContext,
  dep: { id: string; predecessor_id: string; successor_id: string; type: DependencyType; lag_days: number },
): { state: PlanState; error?: string } {
  if (state.dependencies.some((d) => d.predecessor_id === dep.predecessor_id && d.successor_id === dep.successor_id)) {
    return { state, error: 'Diese Abhängigkeit existiert bereits.' }
  }
  if (wouldCreateCycle(state.tasks, state.dependencies, dep.predecessor_id, dep.successor_id)) {
    return { state, error: 'Diese Verbindung würde einen Zyklus erzeugen.' }
  }
  const base = unpinSuccessor(state, dep.successor_id)
  const next: PlanState = {
    ...base,
    dependencies: [...base.dependencies, newDependency({ ...dep, project_id: ctx.projectId })],
  }
  return { state: recompute(next, ctx).state }
}

export function updateDependency(state: PlanState, ctx: PlanContext, id: string, patch: Partial<Pick<TaskDependency, 'type' | 'lag_days'>>): PlanState {
  const dep = state.dependencies.find((d) => d.id === id)
  const base = dep ? unpinSuccessor(state, dep.successor_id) : state
  const next = { ...base, dependencies: base.dependencies.map((d) => (d.id === id ? { ...d, ...patch } : d)) }
  return recompute(next, ctx).state
}


export function removeDependency(state: PlanState, ctx: PlanContext, id: string): PlanState {
  return recompute({ ...state, dependencies: state.dependencies.filter((d) => d.id !== id) }, ctx).state
}

export function updateTaskFields(state: PlanState, ctx: PlanContext, id: string, patch: Partial<Task>): PlanState {
  const t = state.tasks.find((x) => x.id === id)
  if (!t) return state
  const next: Partial<Task> = { ...patch }
  if (patch.type === 'milestone') next.duration = 0
  if (patch.status === 'done') {
    next.progress = 100
    if (!t.actual_finish && !patch.actual_finish) next.actual_finish = t.end_date
    if (!t.actual_start && !patch.actual_start) next.actual_start = t.start_date
    // Ist-Dauer für die lernfähige Datenbasis festhalten
    const sched = recompute(state, ctx).result.tasks.get(id)
    if (sched) {
      const s = toDayNumber(next.actual_start ?? t.actual_start ?? t.start_date)
      const e = toDayNumber(next.actual_finish ?? t.actual_finish ?? t.end_date)
      next.actual_duration = t.type === 'milestone' ? 0 : Math.max(1, sched.calendar.countWorkdays(s, e))
    }
  } else if (patch.status === 'in_progress' && !t.actual_start && !patch.actual_start) {
    next.actual_start = t.start_date
  } else if (patch.status === 'not_started') {
    next.actual_start = null
    next.actual_finish = null
    if (patch.progress === undefined) next.progress = 0
  }
  if (patch.progress !== undefined && patch.progress >= 100 && patch.status === undefined) {
    next.status = 'done'
    if (!t.actual_finish) next.actual_finish = t.end_date
    if (!t.actual_start) next.actual_start = t.start_date
  }
  return recompute(replaceTask(state, id, next), ctx).state
}

export interface NewTaskInput {
  id: string
  name: string
  type: TaskType
  parent_id: string | null
  /** Einfügen nach diesem Geschwister (null = ans Ende) */
  after_id?: string | null
  duration?: number
  start_date?: ISODate
  trade_id?: string | null
  responsible_user_id?: string | null
  company_id?: string | null
  section_id?: string | null
}

export function createTask(state: PlanState, ctx: PlanContext, input: NewTaskInput): PlanState {
  const siblings = state.tasks.filter((t) => t.parent_id === input.parent_id).sort((a, b) => a.sort_order - b.sort_order)
  let insertIndex = siblings.length
  if (input.after_id) {
    const idx = siblings.findIndex((s) => s.id === input.after_id)
    if (idx >= 0) insertIndex = idx + 1
  }
  const start = input.start_date ?? ctx.projectStart
  const task: Task = newTask({
    id: input.id,
    project_id: ctx.projectId,
    parent_id: input.parent_id,
    name: input.name,
    type: input.type,
    start,
    duration: input.duration,
    trade_id: input.trade_id ?? null,
    responsible_user_id: input.responsible_user_id ?? null,
    company_id: input.company_id ?? null,
    section_id: input.section_id ?? null,
    constraint_type: input.start_date ? 'mso' : 'asap',
    constraint_date: input.start_date ?? null,
  })
  const reordered = [...siblings.slice(0, insertIndex), task, ...siblings.slice(insertIndex)].map((t, i) => ({ ...t, sort_order: i }))
  const others = state.tasks.filter((t) => t.parent_id !== input.parent_id)
  return recompute({ ...state, tasks: [...others, ...reordered] }, ctx).state
}

export function collectDescendants(tasks: Task[], id: string): Task[] {
  const out: Task[] = []
  const walk = (pid: string) => {
    for (const t of tasks) {
      if (t.parent_id === pid) {
        out.push(t)
        walk(t.id)
      }
    }
  }
  walk(id)
  return out
}

export function deleteTasks(state: PlanState, ctx: PlanContext, ids: string[]): PlanState {
  const remove = new Set<string>()
  for (const id of ids) {
    remove.add(id)
    for (const d of collectDescendants(state.tasks, id)) remove.add(d.id)
  }
  return recompute(
    {
      tasks: state.tasks.filter((t) => !remove.has(t.id)),
      dependencies: state.dependencies.filter((d) => !remove.has(d.predecessor_id) && !remove.has(d.successor_id)),
    },
    ctx,
  ).state
}

export function duplicateTask(state: PlanState, ctx: PlanContext, id: string, newId: () => string): PlanState {
  const src = state.tasks.find((t) => t.id === id)
  if (!src) return state
  const idMap = new Map<string, string>()
  const copies: Task[] = []
  const copy = (t: Task, parent: string | null) => {
    const nid = newId()
    idMap.set(t.id, nid)
    copies.push({ ...t, id: nid, parent_id: parent, name: t === src ? `${t.name} (Kopie)` : t.name, actual_start: null, actual_finish: null, progress: 0, status: 'not_started' })
    for (const c of state.tasks.filter((x) => x.parent_id === t.id)) copy(c, nid)
  }
  copy(src, src.parent_id)
  // Geschwister-Reihenfolge: Kopie direkt hinter Original
  const siblings = state.tasks.filter((t) => t.parent_id === src.parent_id).sort((a, b) => a.sort_order - b.sort_order)
  const idx = siblings.findIndex((s) => s.id === src.id)
  const root = copies[0]
  const reordered = [...siblings.slice(0, idx + 1), root, ...siblings.slice(idx + 1)].map((t, i) => ({ ...t, sort_order: i }))
  const others = state.tasks.filter((t) => t.parent_id !== src.parent_id)
  // interne Abhängigkeiten mitkopieren
  const newDeps: TaskDependency[] = []
  for (const d of state.dependencies) {
    const p = idMap.get(d.predecessor_id)
    const s = idMap.get(d.successor_id)
    if (p && s) newDeps.push({ ...d, id: newId(), predecessor_id: p, successor_id: s })
  }
  return recompute(
    { tasks: [...others, ...reordered, ...copies.slice(1)], dependencies: [...state.dependencies, ...newDeps] },
    ctx,
  ).state
}

/** Einrücken: Vorgang wird Kind des vorherigen Geschwisters */
export function indentTask(state: PlanState, ctx: PlanContext, id: string): PlanState {
  const t = state.tasks.find((x) => x.id === id)
  if (!t) return state
  const siblings = state.tasks.filter((x) => x.parent_id === t.parent_id).sort((a, b) => a.sort_order - b.sort_order)
  const idx = siblings.findIndex((s) => s.id === id)
  if (idx <= 0) return state
  const newParent = siblings[idx - 1]
  if (newParent.type === 'milestone') return state
  const newSiblings = state.tasks.filter((x) => x.parent_id === newParent.id)
  const tasks = state.tasks.map((x) => (x.id === id ? { ...x, parent_id: newParent.id, sort_order: newSiblings.length } : x))
  // Abhängigkeit zwischen neuem Elternteil und Kind wäre ungültig
  const dependencies = state.dependencies.filter(
    (d) => !((d.predecessor_id === newParent.id && d.successor_id === id) || (d.successor_id === newParent.id && d.predecessor_id === id)),
  )
  return recompute(normalizeOrder({ tasks, dependencies }), ctx).state
}

/** Ausrücken: Vorgang wird Geschwister seines Elternteils (dahinter eingefügt) */
export function outdentTask(state: PlanState, ctx: PlanContext, id: string): PlanState {
  const t = state.tasks.find((x) => x.id === id)
  if (!t || !t.parent_id) return state
  const parent = state.tasks.find((x) => x.id === t.parent_id)!
  const grandSiblings = state.tasks.filter((x) => x.parent_id === parent.parent_id).sort((a, b) => a.sort_order - b.sort_order)
  const pIdx = grandSiblings.findIndex((s) => s.id === parent.id)
  const tasks = state.tasks.map((x) => (x.id === id ? { ...x, parent_id: parent.parent_id, sort_order: pIdx + 0.5 } : x))
  return recompute(normalizeOrder({ tasks, dependencies: state.dependencies }), ctx).state
}

export function moveTaskInTree(state: PlanState, ctx: PlanContext, id: string, direction: 'up' | 'down'): PlanState {
  const t = state.tasks.find((x) => x.id === id)
  if (!t) return state
  const siblings = state.tasks.filter((x) => x.parent_id === t.parent_id).sort((a, b) => a.sort_order - b.sort_order)
  const idx = siblings.findIndex((s) => s.id === id)
  const swap = direction === 'up' ? idx - 1 : idx + 1
  if (swap < 0 || swap >= siblings.length) return state
  const a = siblings[idx], b = siblings[swap]
  const tasks = state.tasks.map((x) => (x.id === a.id ? { ...x, sort_order: b.sort_order } : x.id === b.id ? { ...x, sort_order: a.sort_order } : x))
  return recompute(normalizeOrder({ tasks, dependencies: state.dependencies }), ctx).state
}

/** Ordnet sort_order pro Elternteil neu als 0..n */
export function normalizeOrder(state: PlanState): PlanState {
  const groups = new Map<string | null, Task[]>()
  for (const t of state.tasks) (groups.get(t.parent_id) ?? groups.set(t.parent_id, []).get(t.parent_id)!).push(t)
  const tasks: Task[] = []
  for (const list of groups.values()) {
    list.sort((a, b) => a.sort_order - b.sort_order)
    list.forEach((t, i) => tasks.push(t.sort_order === i ? t : { ...t, sort_order: i }))
  }
  return { ...state, tasks }
}

/** Flache, sortierte Reihenfolge des Baums (Tiefensuche) */
export function flattenTree(tasks: Task[]): { task: Task; depth: number; hasChildren: boolean }[] {
  const children = new Map<string | null, Task[]>()
  for (const t of tasks) (children.get(t.parent_id) ?? children.set(t.parent_id, []).get(t.parent_id)!).push(t)
  for (const list of children.values()) list.sort((a, b) => a.sort_order - b.sort_order || a.id.localeCompare(b.id))
  const out: { task: Task; depth: number; hasChildren: boolean }[] = []
  const known = new Set(tasks.map((t) => t.id))
  const walk = (pid: string | null, depth: number) => {
    for (const t of children.get(pid) ?? []) {
      const ch = children.get(t.id) ?? []
      out.push({ task: t, depth, hasChildren: ch.length > 0 })
      walk(t.id, depth + 1)
    }
  }
  walk(null, 0)
  // verwaiste Vorgänge (Elternteil fehlt) trotzdem anzeigen
  for (const t of tasks) if (t.parent_id && !known.has(t.parent_id) && !out.some((o) => o.task.id === t.id)) out.push({ task: t, depth: 0, hasChildren: false })
  return out
}
