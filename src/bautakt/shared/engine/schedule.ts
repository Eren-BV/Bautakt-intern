/**
 * Scheduling Engine - Herzstück der Terminberechnung.
 *
 * Reine Funktion: Vorgänge + Abhängigkeiten + Kalender rein, berechneter Terminplan raus.
 * Kein UI, kein I/O. Läuft identisch im Browser (sofortige Gantt-Reaktion, Vorschau
 * "Diese Änderung beeinflusst 8 Vorgänge") und auf dem Server (Persistenz des kritischen
 * Pfads, Vor-Ort-Updates, Dashboard-Kennzahlen).
 *
 * Semantik (angelehnt an MS Project / Primavera):
 *  - Automatisch geplante Vorgänge liegen immer so früh wie möglich, begrenzt durch
 *    Projektstart, Vorgänger (FS/SS/FF/SF + Lag) und Einschränkung (SNET/MSO).
 *  - Manuell geplante Vorgänge behalten ihre Termine; verletzte Abhängigkeiten werden
 *    als Konflikt markiert statt stillschweigend verschoben.
 *  - Ein begonnener Vorgang (actual_start) hat einen festen Start.
 *  - Sammelvorgänge (Phase, Kategorie-Gruppe, Vorgang mit Untervorgängen) werden aus
 *    ihren Kindern gebildet. Abhängigkeiten auf Sammelvorgänge sind erlaubt.
 *  - Rückwärtsrechnung liefert Late Start/Finish, Total Float, Free Float, kritischer Pfad.
 *
 * Berechnung in topologischer Reihenfolge (ein Vorwärts-, ein Rückwärtsdurchlauf), damit
 * auch 500+ Vorgänge mit langen Ketten in wenigen Millisekunden gerechnet sind.
 * Zyklen werden erkannt und gemeldet; betroffene Vorgänge behalten ihre Termine.
 */

import type { ISODate, Task, TaskDependency, ProjectCalendar, CalendarException, Resource } from '../types.ts'
import { fromDayNumber, toDayNumber } from './dates.ts'
import { endFromDuration, resolveCalendars, type WorkCalendar } from './calendar.ts'

export interface ScheduledTask {
  id: string
  start: number
  end: number
  duration: number
  es: number
  ef: number
  ls: number
  lf: number
  totalFloat: number
  freeFloat: number
  isCritical: boolean
  hasConflict: boolean
  isLeaf: boolean
  depth: number
  calendar: WorkCalendar
  /** Soll-Fortschritt in % zum Stichtag */
  plannedProgress: number
  isOverdue: boolean
  /** Abhängigkeit, die den Start tatsächlich bestimmt (null = Projektstart/Einschränkung) */
  drivingDependencyId: string | null
  drivingPredecessorId: string | null
  /** Was den Start bestimmt hat */
  startDriver: 'dependency' | 'constraint' | 'project_start' | 'manual' | 'actual'
}

export interface ScheduleResult {
  tasks: Map<string, ScheduledTask>
  projectStart: number
  projectEnd: number
  /** IDs der Vorgänge, die in einem Abhängigkeitszyklus stecken */
  cycleTaskIds: string[]
  childrenOf: Map<string | null, string[]>
  order: string[]
  /** IDs der Abhängigkeiten, die einen Nachfolger tatsächlich treiben */
  drivingDependencyIds: Set<string>
  /** Projektkalender (Basis-Schicht inkl. Feiertage der Projektregion) */
  calendar: WorkCalendar
}

export interface ScheduleOptions {
  today?: ISODate
  /**
   * Prognose-Modus: unerledigte Vorgänge, deren Ende in der Vergangenheit liegt, werden
   * mit ihrer Restdauer ab heute weitergerechnet (inkl. Kaskade) - liefert die
   * "prognostizierte Fertigstellung" für Dashboard und Soll-Ist.
   */
  forecast?: boolean
}

export interface ScheduleInput {
  projectId: string
  projectStart: ISODate
  projectCalendarId: string | null
  tasks: Task[]
  dependencies: TaskDependency[]
  calendars: ProjectCalendar[]
  exceptions: CalendarException[]
  /** Feiertagsregion des Projekts (z. B. "DE-BY") - gesetzliche Feiertage werden berechnet */
  holidayRegion?: string | null
  /** Für Ressourcenkalender (resource.calendar_id) */
  resources?: Resource[]
}

interface Edge {
  id: string
  pred: string
  succ: string
  type: TaskDependency['type']
  lag: number
}

interface Node {
  task: Task
  cal: WorkCalendar
  isLeaf: boolean
  children: string[]
  depth: number
  fixedStart: number | null
  manual: boolean
  floorStart: number
  start: number
  end: number
  duration: number
  ls: number
  lf: number
  hasConflict: boolean
  drivingEdge: Edge | null
  startDriver: ScheduledTask['startDriver']
}

export function computeSchedule(input: ScheduleInput, options: ScheduleOptions = {}): ScheduleResult {
  const { tasks, dependencies } = input
  const today = options.today ? toDayNumber(options.today) : toDayNumber(new Date().toISOString().slice(0, 10))
  const cals = resolveCalendars({ calendars: input.calendars, exceptions: input.exceptions, projectId: input.projectId, projectCalendarId: input.projectCalendarId, holidayRegion: input.holidayRegion ?? null, resources: input.resources })
  const projectStartDay = cals.base.nextWorkday(toDayNumber(input.projectStart))

  // ---- Baum aufbauen
  const byId = new Map<string, Task>()
  const childrenOf = new Map<string | null, string[]>()
  for (const t of tasks) byId.set(t.id, t)
  for (const t of tasks) {
    const parent = t.parent_id && byId.has(t.parent_id) ? t.parent_id : null
    const list = childrenOf.get(parent) ?? []
    list.push(t.id)
    childrenOf.set(parent, list)
  }
  for (const list of childrenOf.values()) {
    list.sort((a, b) => (byId.get(a)!.sort_order - byId.get(b)!.sort_order) || a.localeCompare(b))
  }

  const nodes = new Map<string, Node>()
  const order: string[] = []
  const walk = (parent: string | null, depth: number) => {
    for (const id of childrenOf.get(parent) ?? []) {
      const task = byId.get(id)!
      const children = childrenOf.get(id) ?? []
      const cal = cals.forTask(task)
      const isLeaf = children.length === 0 || task.type === 'milestone'
      const duration = task.type === 'milestone' ? 0 : Math.max(isLeaf ? 1 : 0, task.duration | 0)
      const started = !!task.actual_start
      const fixedStart = started ? cal.nextWorkday(toDayNumber(task.actual_start!)) : null
      const manual = task.scheduling_mode === 'manual' || task.constraint_type === 'mso'
      let floorStart = projectStartDay
      if (task.constraint_type === 'snet' && task.constraint_date) {
        floorStart = Math.max(floorStart, cal.nextWorkday(toDayNumber(task.constraint_date)))
      }
      if (task.constraint_type === 'mso' && task.constraint_date) {
        floorStart = cal.nextWorkday(toDayNumber(task.constraint_date))
      }
      nodes.set(id, {
        task,
        cal,
        isLeaf,
        children,
        depth,
        fixedStart,
        manual,
        floorStart,
        start: 0,
        end: 0,
        duration,
        ls: 0,
        lf: 0,
        hasConflict: false,
        drivingEdge: null,
        startDriver: fixedStart !== null ? 'actual' : manual ? 'manual' : task.constraint_type === 'snet' && task.constraint_date ? 'constraint' : 'project_start',
      })
      order.push(id)
      walk(id, depth + 1)
    }
  }
  walk(null, 0)

  // ---- Abhängigkeiten auf Blätter der Nachfolger auflösen
  const leavesOf = (id: string): string[] => {
    const n = nodes.get(id)
    if (!n) return []
    if (n.isLeaf) return [id]
    return n.children.flatMap(leavesOf)
  }
  const edges: Edge[] = []
  const succsOfLeaf = new Map<string, Edge[]>()
  const predsOfLeaf = new Map<string, Edge[]>()
  for (const d of dependencies) {
    if (!nodes.has(d.predecessor_id) || !nodes.has(d.successor_id)) continue
    for (const leaf of leavesOf(d.successor_id)) {
      const e: Edge = { id: d.id, pred: d.predecessor_id, succ: leaf, type: d.type, lag: d.lag_days | 0 }
      edges.push(e)
      ;(predsOfLeaf.get(leaf) ?? predsOfLeaf.set(leaf, []).get(leaf)!).push(e)
      for (const pl of leavesOf(d.predecessor_id)) {
        ;(succsOfLeaf.get(pl) ?? succsOfLeaf.set(pl, []).get(pl)!).push(e)
      }
    }
  }

  // ---- Zyklen erkennen (auf Blattebene, Sammelvorgänge als Blattmengen expandiert)
  const cycleTaskIds = detectCycles(nodes, edges, leavesOf)
  const cyclic = new Set(cycleTaskIds)

  const initLeaf = (n: Node) => {
    const t = n.task
    if (n.fixedStart !== null) {
      n.start = n.fixedStart
    } else if (n.manual) {
      n.start = n.cal.nextWorkday(toDayNumber(t.start_date || input.projectStart))
    } else {
      n.start = n.floorStart
    }
    if (t.status === 'done' && t.actual_finish) {
      n.end = Math.max(n.start, n.cal.prevWorkday(toDayNumber(t.actual_finish)))
      n.duration = t.type === 'milestone' ? 0 : n.cal.countWorkdays(n.start, n.end)
    } else if (n.manual && n.fixedStart === null && t.end_date) {
      n.end = Math.max(n.start, n.cal.prevWorkday(toDayNumber(t.end_date)))
      n.duration = t.type === 'milestone' ? 0 : Math.max(1, n.cal.countWorkdays(n.start, n.end))
    } else {
      if (options.forecast && t.status !== 'done') {
        // Prognose: unerledigte Restarbeit kann frühestens heute stattfinden
        const remaining = remainingDuration(t, n.duration)
        const plannedEnd = endFromDuration(n.cal, n.start, n.duration)
        if (plannedEnd < today || (n.fixedStart !== null && n.start < today)) {
          const forecastEnd = t.type === 'milestone'
            ? Math.max(plannedEnd, n.cal.nextWorkday(today))
            : Math.max(plannedEnd, endFromDuration(n.cal, n.cal.nextWorkday(today), Math.max(1, remaining)))
          if (n.fixedStart === null && t.status === 'not_started') n.start = n.cal.nextWorkday(Math.max(n.start, today))
          n.end = t.type === 'milestone' ? forecastEnd : Math.max(forecastEnd, endFromDuration(n.cal, n.start, n.duration))
          n.duration = t.type === 'milestone' ? 0 : n.cal.countWorkdays(n.start, n.end)
          return
        }
      }
      n.end = endFromDuration(n.cal, n.start, n.duration)
    }
  }

  const rollup = (n: Node): boolean => {
    let s = Infinity
    let e = -Infinity
    for (const cid of n.children) {
      const c = nodes.get(cid)!
      if (c.start < s) s = c.start
      if (c.end > e) e = c.end
    }
    if (s === Infinity) {
      s = n.start
      e = n.end
    }
    const changed = s !== n.start || e !== n.end
    n.start = s
    n.end = e
    n.duration = n.cal.countWorkdays(s, e)
    return changed
  }
  const rollupAll = (): boolean => {
    let changed = false
    for (let i = order.length - 1; i >= 0; i--) {
      const n = nodes.get(order[i])!
      if (!n.isLeaf) changed = rollup(n) || changed
    }
    return changed
  }

  /** Frühester Start des Nachfolgers, den die Kante erzwingt */
  const requiredStart = (e: Edge, succ: Node, pred: { start: number; end: number }): number => {
    const sc = succ.cal
    const isMs = succ.duration === 0
    switch (e.type) {
      case 'FS':
        // erst auf den nächsten Arbeitstag nach dem Vorgängerende, dann Lag/Lead in Arbeitstagen
        return isMs ? sc.addWorkdays(pred.end, e.lag) : sc.addWorkdays(sc.nextWorkday(pred.end + 1), e.lag)
      case 'SS':
        return sc.addWorkdays(pred.start, e.lag)
      case 'FF': {
        const reqEnd = sc.addWorkdays(pred.end, e.lag)
        return isMs ? reqEnd : sc.addWorkdays(reqEnd, -(succ.duration - 1))
      }
      case 'SF': {
        const reqEnd = sc.addWorkdays(sc.prevWorkday(pred.start - 1), e.lag)
        return isMs ? reqEnd : sc.addWorkdays(reqEnd, -(succ.duration - 1))
      }
    }
  }

  // ---- Topologische Reihenfolge der Blätter (Kahn). Kanten von/zu Sammelvorgängen sind
  // auf deren Blätter expandiert, so dass ein Sammelvorgang als Vorgänger erst dann
  // abgefragt wird, wenn alle seine Blätter endgültig terminiert sind.
  const leafIds = order.filter((id) => nodes.get(id)!.isLeaf)
  const adj = new Map<string, string[]>()
  const indeg = new Map<string, number>()
  for (const id of leafIds) indeg.set(id, 0)
  for (const e of edges) {
    if (cyclic.has(e.succ) || cyclic.has(e.pred)) continue
    for (const pl of leavesOf(e.pred)) {
      if (cyclic.has(pl)) continue
      ;(adj.get(pl) ?? adj.set(pl, []).get(pl)!).push(e.succ)
      indeg.set(e.succ, (indeg.get(e.succ) ?? 0) + 1)
    }
  }
  const topo: string[] = []
  const queue: string[] = leafIds.filter((id) => (indeg.get(id) ?? 0) === 0)
  while (queue.length) {
    const u = queue.shift()!
    topo.push(u)
    for (const v of adj.get(u) ?? []) {
      const d = (indeg.get(v) ?? 0) - 1
      indeg.set(v, d)
      if (d === 0) queue.push(v)
    }
  }
  // Blätter in Zyklen (oder unerreichbar) hinten anhängen - sie behalten ihre Initialtermine
  const inTopo = new Set(topo)
  for (const id of leafIds) if (!inTopo.has(id)) topo.push(id)

  // Termine eines Knotens als Vorgänger: Blätter direkt, Sammelvorgänge aus ihren Blättern
  const predDates = (id: string): { start: number; end: number } => {
    const n = nodes.get(id)!
    if (n.isLeaf) return n
    let s = Infinity, e = -Infinity
    for (const l of leavesOf(id)) {
      const ln = nodes.get(l)!
      if (ln.start < s) s = ln.start
      if (ln.end > e) e = ln.end
    }
    return s === Infinity ? n : { start: s, end: e }
  }

  // ---- Vorwärtsrechnung: ein Durchlauf in topologischer Reihenfolge
  for (const n of nodes.values()) if (n.isLeaf) initLeaf(n)
  for (const id of topo) {
    const succ = nodes.get(id)!
    if (cyclic.has(id)) continue
    for (const e of predsOfLeaf.get(id) ?? []) {
      if (cyclic.has(e.pred)) continue
      const req = requiredStart(e, succ, predDates(e.pred))
      if (succ.manual || succ.fixedStart !== null) {
        if (req > succ.start) succ.hasConflict = true
        continue
      }
      if (req > succ.start) {
        succ.start = req
        succ.end = succ.task.status === 'done' && succ.task.actual_finish
          ? Math.max(succ.start, succ.end)
          : endFromDuration(succ.cal, succ.start, succ.duration)
        succ.drivingEdge = e
        succ.startDriver = 'dependency'
      } else if (req === succ.start && succ.drivingEdge === null && succ.startDriver === 'project_start') {
        // Vorgänger endet genau vor dem Projektstart-Termin: fachlich treibt er trotzdem
        succ.drivingEdge = e
        succ.startDriver = 'dependency'
      }
    }
  }
  rollupAll()
  const drivingDependencyIds = new Set<string>()
  for (const n of nodes.values()) if (n.drivingEdge) drivingDependencyIds.add(n.drivingEdge.id)

  let projectEnd = projectStartDay
  for (const n of nodes.values()) if (n.isLeaf && n.end > projectEnd) projectEnd = n.end

  // ---- Rückwärtsrechnung (Late Dates)
  for (const n of nodes.values()) {
    n.lf = projectEnd
    if (n.task.constraint_type === 'fnlt' && n.task.constraint_date) {
      const fnlt = n.cal.prevWorkday(toDayNumber(n.task.constraint_date))
      if (fnlt < n.lf) n.lf = fnlt
      if (n.end > fnlt) n.hasConflict = true
    }
    n.ls = n.duration === 0 ? n.lf : n.cal.addWorkdays(n.lf, -(n.duration - 1))
  }
  const setLf = (n: Node, lf: number): boolean => {
    if (lf >= n.lf) return false
    n.lf = lf
    n.ls = n.duration === 0 ? n.lf : n.cal.addWorkdays(n.lf, -(n.duration - 1))
    return true
  }
  const setLs = (n: Node, ls: number): boolean => {
    if (ls >= n.ls) return false
    n.ls = ls
    n.lf = n.duration === 0 ? n.ls : n.cal.addWorkdays(n.ls, n.duration - 1)
    return true
  }
  // Rückwärts in umgekehrter topologischer Reihenfolge: jeder Nachfolger ist bereits final
  for (let i = topo.length - 1; i >= 0; i--) {
    const pl = topo[i]
    if (cyclic.has(pl)) continue
    const pred = nodes.get(pl)!
    const pc = pred.cal
    for (const e of succsOfLeaf.get(pl) ?? []) {
      if (cyclic.has(e.succ) || cyclic.has(e.pred)) continue
      const succ = nodes.get(e.succ)!
      const sc = succ.cal
      const isMs = succ.duration === 0
      switch (e.type) {
        case 'FS': {
          const lim = isMs ? sc.addWorkdays(succ.ls, -e.lag) : sc.addWorkdays(succ.ls, -e.lag) - 1
          setLf(pred, pc.prevWorkday(lim))
          break
        }
        case 'SS':
          setLs(pred, pc.prevWorkday(sc.addWorkdays(succ.ls, -e.lag)))
          break
        case 'FF':
          setLf(pred, pc.prevWorkday(sc.addWorkdays(succ.lf, -e.lag)))
          break
        case 'SF':
          setLs(pred, pc.nextWorkday(sc.addWorkdays(succ.lf, -e.lag) + 1))
          break
      }
    }
  }
  // Late Dates der Sammelvorgänge aus Kindern
  for (let i = order.length - 1; i >= 0; i--) {
    const n = nodes.get(order[i])!
    if (n.isLeaf) continue
    let ls = Infinity
    let lf = -Infinity
    for (const cid of n.children) {
      const c = nodes.get(cid)!
      ls = Math.min(ls, c.ls)
      lf = Math.max(lf, c.lf)
    }
    if (ls !== Infinity) {
      n.ls = ls
      n.lf = lf
    }
  }

  // ---- Puffer, kritischer Pfad, Fortschritt
  const result = new Map<string, ScheduledTask>()
  for (const id of order) {
    const n = nodes.get(id)!
    const t = n.task
    const totalFloat = n.cal.countWorkdays(n.start, n.ls) - (n.duration === 0 && n.start === n.ls ? 0 : 1)
    let freeFloat: number
    const succs = succsOfLeaf.get(id) ?? []
    if (n.isLeaf && succs.length) {
      freeFloat = Infinity
      for (const e of succs) {
        const s = nodes.get(e.succ)!
        const req = requiredStart(e, s, predDates(e.pred))
        const slack = s.cal.countWorkdays(req, s.start) - 1
        if (slack < freeFloat) freeFloat = slack
      }
      if (freeFloat === Infinity) freeFloat = totalFloat
    } else {
      freeFloat = n.cal.countWorkdays(n.end, projectEnd) - 1
    }
    const done = t.status === 'done'
    const isCritical = !done && Math.max(0, totalFloat) <= 0 && !cyclic.has(id)
    const plannedProgress = plannedProgressFor(n, today)
    result.set(id, {
      id,
      start: n.start,
      end: n.end,
      duration: n.duration,
      es: n.start,
      ef: n.end,
      ls: n.ls,
      lf: n.lf,
      totalFloat: Math.max(0, totalFloat),
      freeFloat: Math.max(0, Math.min(freeFloat, Math.max(0, totalFloat))),
      isCritical,
      hasConflict: n.hasConflict,
      isLeaf: n.isLeaf,
      depth: n.depth,
      calendar: n.cal,
      plannedProgress,
      isOverdue: !done && n.end < today,
      drivingDependencyId: n.drivingEdge?.id ?? null,
      drivingPredecessorId: n.drivingEdge?.pred ?? null,
      startDriver: n.startDriver,
    })
  }
  // Sammelvorgänge sind kritisch, wenn ein Kind kritisch ist
  for (let i = order.length - 1; i >= 0; i--) {
    const n = nodes.get(order[i])!
    if (n.isLeaf) continue
    const r = result.get(n.task.id)!
    r.isCritical = n.children.some((c) => result.get(c)?.isCritical)
  }

  return { tasks: result, projectStart: projectStartDay, projectEnd, cycleTaskIds, childrenOf, order, drivingDependencyIds, calendar: cals.base }
}

function remainingDuration(t: Task, duration: number): number {
  if (t.remaining_duration !== null && t.remaining_duration !== undefined) return Math.max(0, t.remaining_duration)
  if (t.type === 'milestone') return 0
  return Math.max(1, Math.round(duration * (1 - (t.progress || 0) / 100)))
}

function plannedProgressFor(n: Node, today: number): number {
  if (n.duration === 0) return today >= n.start ? 100 : 0
  if (today < n.start) return 0
  if (today > n.end) return 100
  const elapsed = n.cal.countWorkdays(n.start, today)
  return Math.round((elapsed / n.duration) * 100)
}

/** DFS-Zyklensuche auf der Blattebene; liefert alle Vorgänge in Zyklen */
function detectCycles(
  nodes: Map<string, Node>,
  edges: { pred: string; succ: string }[],
  leavesOf: (id: string) => string[],
): string[] {
  const adj = new Map<string, Set<string>>()
  for (const e of edges) {
    for (const pl of leavesOf(e.pred)) {
      ;(adj.get(pl) ?? adj.set(pl, new Set()).get(pl)!).add(e.succ)
    }
  }
  const WHITE = 0, GRAY = 1, BLACK = 2
  const color = new Map<string, number>()
  const inCycle = new Set<string>()
  const stack: string[] = []
  const visit = (u: string) => {
    color.set(u, GRAY)
    stack.push(u)
    for (const v of adj.get(u) ?? []) {
      const c = color.get(v) ?? WHITE
      if (c === WHITE) visit(v)
      else if (c === GRAY) {
        for (let i = stack.length - 1; i >= 0; i--) {
          inCycle.add(stack[i])
          if (stack[i] === v) break
        }
      }
    }
    stack.pop()
    color.set(u, BLACK)
  }
  for (const id of nodes.keys()) if ((color.get(id) ?? WHITE) === WHITE) visit(id)
  return [...inCycle]
}

/**
 * Würde das Hinzufügen der Kante pred→succ einen Zyklus erzeugen?
 * Wird beim Verbinden im Gantt und serverseitig bei der Validierung genutzt.
 */
export function wouldCreateCycle(
  tasks: Task[],
  dependencies: TaskDependency[],
  predecessorId: string,
  successorId: string,
): boolean {
  if (predecessorId === successorId) return true
  const parentOf = new Map(tasks.map((t) => [t.id, t.parent_id]))
  // Vorgänger/Nachfolger dürfen nicht im selben Ast (Eltern/Kind) liegen
  const isAncestor = (a: string, b: string) => {
    let p = parentOf.get(b) ?? null
    while (p) {
      if (p === a) return true
      p = parentOf.get(p) ?? null
    }
    return false
  }
  if (isAncestor(predecessorId, successorId) || isAncestor(successorId, predecessorId)) return true
  const childrenOf = new Map<string, string[]>()
  for (const t of tasks) if (t.parent_id) (childrenOf.get(t.parent_id) ?? childrenOf.set(t.parent_id, []).get(t.parent_id)!).push(t.id)
  const leaves = (id: string): string[] => {
    const ch = childrenOf.get(id)
    return ch?.length ? ch.flatMap(leaves) : [id]
  }
  const adj = new Map<string, Set<string>>()
  const add = (p: string, s: string) => {
    for (const pl of leaves(p)) for (const sl of leaves(s)) (adj.get(pl) ?? adj.set(pl, new Set()).get(pl)!).add(sl)
  }
  for (const d of dependencies) add(d.predecessor_id, d.successor_id)
  add(predecessorId, successorId)
  // Erreicht man von succ aus pred?
  const targets = new Set(leaves(predecessorId))
  const seen = new Set<string>()
  const stack = leaves(successorId)
  while (stack.length) {
    const u = stack.pop()!
    if (targets.has(u)) return true
    if (seen.has(u)) continue
    seen.add(u)
    for (const v of adj.get(u) ?? []) stack.push(v)
  }
  return false
}

/** Markiert treibende Beziehungen in den Abhängigkeits-Datensätzen */
export function applyScheduleToDependencies(deps: TaskDependency[], result: ScheduleResult): TaskDependency[] {
  return deps.map((d) => {
    const driving = result.drivingDependencyIds.has(d.id)
    return d.is_driving === driving ? d : { ...d, is_driving: driving }
  })
}

/**
 * Schreibt die berechneten Termine in die Vorgangs-Datensätze zurück, so dass
 * gespeicherte Daten immer dem berechneten Plan entsprechen (Listen, Server, Export).
 */
export function applyScheduleToTasks(tasks: Task[], result: ScheduleResult): Task[] {
  return tasks.map((t) => {
    const s = result.tasks.get(t.id)
    if (!s) return t
    const start = fromDayNumber(s.start)
    const end = fromDayNumber(s.end)
    const next: Task = {
      ...t,
      start_date: start,
      end_date: end,
      duration: s.duration,
      is_critical: s.isCritical,
      total_float: s.totalFloat,
      free_float: s.freeFloat,
      early_start: fromDayNumber(s.es),
      early_finish: fromDayNumber(s.ef),
      late_start: fromDayNumber(s.ls),
      late_finish: fromDayNumber(s.lf),
      has_conflict: s.hasConflict,
    }
    // Nur neues Objekt liefern, wenn sich wirklich etwas geändert hat (weniger Re-Renders)
    for (const k of Object.keys(next) as (keyof Task)[]) {
      if (next[k] !== t[k]) return next
    }
    return t
  })
}
