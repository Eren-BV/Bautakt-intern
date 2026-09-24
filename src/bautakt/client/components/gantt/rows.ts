/**
 * Sichtbare Gantt-Zeilen: Baum flach machen, Ein-/Ausklappen und Filter anwenden.
 * Ansichten: Gesamt (Hierarchie), Bauphasen (nur oberste Ebenen), Gewerke und
 * Bauabschnitte (virtuelle Gruppenzeilen; Abhängigkeiten bleiben auf Vorgangsebene).
 * Beim Filtern bleiben Elternknoten von Treffern erhalten.
 */

import type { ISODate, Task, TaskStatus } from '../../../shared/types'
import { flattenTree } from '../../../shared/engine/operations'
import type { ScheduleResult } from '../../../shared/engine/schedule'
import { toDayNumber } from '../../../shared/engine/dates'
import { newTask } from '../../../shared/engine/defaults'

export type GanttView = 'all' | 'phase' | 'trade' | 'section'

export interface GanttFilters {
  search: string
  trade: string
  company: string
  responsible: string
  section: string
  status: TaskStatus | ''
  from: ISODate | ''
  to: ISODate | ''
  criticalOnly: boolean
  delayedOnly: boolean
  milestonesOnly: boolean
}

export const EMPTY_FILTERS: GanttFilters = { search: '', trade: '', company: '', responsible: '', section: '', status: '', from: '', to: '', criticalOnly: false, delayedOnly: false, milestonesOnly: false }

export function hasActiveFilter(f: GanttFilters): boolean {
  return !!(f.search || f.trade || f.company || f.responsible || f.section || f.status || f.from || f.to || f.criticalOnly || f.delayedOnly || f.milestonesOnly)
}

export interface VirtualGeometry {
  start: number
  end: number
  isCritical: boolean
  progress: number
  count: number
}

export interface GanttRow {
  task: Task
  depth: number
  hasChildren: boolean
  index: number
  collapsed: boolean
  /** laufende Nummer im Gesamtplan (für Vorgänger-Spalte), 1-basiert */
  number: number
  /** Gruppenzeile der Gewerke-/Abschnittsansicht (kein echter Vorgang) */
  virtual?: VirtualGeometry
}

export const isVirtualId = (id: string) => id.startsWith('grp:')

export interface GroupSource {
  key: string
  name: string
  color?: string
}

export function buildRows(
  tasks: Task[],
  sched: ScheduleResult | null,
  collapsed: Set<string>,
  filters: GanttFilters,
  today: ISODate,
  view: GanttView = 'all',
  groups: { trades: GroupSource[]; sections: GroupSource[] } = { trades: [], sections: [] },
): GanttRow[] {
  const flat = flattenTree(tasks)
  const numberById = new Map<string, number>()
  flat.forEach((f, i) => numberById.set(f.task.id, i + 1))
  const active = hasActiveFilter(filters)
  const matches = matcher(filters, sched, today)

  if (view === 'trade' || view === 'section') {
    const sources = view === 'trade' ? groups.trades : groups.sections
    const keyOf = (t: Task) => (view === 'trade' ? t.trade_id : t.section_id) ?? ''
    const leaves = flat.filter((f) => !f.hasChildren).map((f) => f.task).filter((t) => !active || matches(t))
    const buckets = new Map<string, Task[]>()
    for (const t of leaves) (buckets.get(keyOf(t)) ?? buckets.set(keyOf(t), []).get(keyOf(t))!).push(t)
    const order = [...sources.map((s) => s.key), ...[...buckets.keys()].filter((k) => !sources.some((s) => s.key === k))]
    const rows: GanttRow[] = []
    for (const key of order) {
      const list = buckets.get(key)
      if (!list?.length) continue
      list.sort((a, b) => a.start_date.localeCompare(b.start_date) || a.name.localeCompare(b.name))
      const src = sources.find((s) => s.key === key)
      const id = `grp:${view}:${key || 'none'}`
      let start = Infinity, end = -Infinity, critical = false, weight = 0, done = 0
      for (const t of list) {
        const s = sched?.tasks.get(t.id)
        const a = s ? s.start : toDayNumber(t.start_date)
        const b = s ? s.end : toDayNumber(t.end_date)
        start = Math.min(start, a)
        end = Math.max(end, b)
        critical = critical || !!s?.isCritical
        const w = Math.max(1, b - a + 1)
        weight += w
        done += (w * (t.status === 'done' ? 100 : t.progress)) / 100
      }
      const isCollapsed = collapsed.has(id)
      rows.push({
        task: newTask({ id, project_id: tasks[0]?.project_id ?? '', name: src?.name ?? (view === 'trade' ? 'Ohne Gewerk' : 'Ohne Bauabschnitt'), type: 'group', trade_id: view === 'trade' && key ? key : null, section_id: view === 'section' && key ? key : null }),
        depth: 0,
        hasChildren: true,
        index: rows.length,
        collapsed: isCollapsed,
        number: 0,
        virtual: { start, end, isCritical: critical, progress: weight ? Math.round((done / weight) * 100) : 0, count: list.length },
      })
      if (isCollapsed) continue
      for (const t of list) rows.push({ task: t, depth: 1, hasChildren: false, index: rows.length, collapsed: false, number: numberById.get(t.id)! })
    }
    return rows
  }

  // Treffer + alle Vorfahren sichtbar halten
  let keep: Set<string> | null = null
  if (active) {
    keep = new Set()
    const parentOf = new Map(tasks.map((t) => [t.id, t.parent_id]))
    const q = filters.search.trim().toLowerCase()
    for (const f of flat) {
      if (f.hasChildren && !(q && f.task.name.toLowerCase().includes(q))) continue
      if (!matches(f.task)) continue
      let id: string | null = f.task.id
      while (id) {
        keep.add(id)
        id = parentOf.get(id) ?? null
      }
    }
  }

  const rows: GanttRow[] = []
  const hiddenDepth: number[] = []
  for (const f of flat) {
    while (hiddenDepth.length && f.depth <= hiddenDepth[hiddenDepth.length - 1]) hiddenDepth.pop()
    if (hiddenDepth.length) continue
    if (keep && !keep.has(f.task.id)) continue
    // Bauphasen-Ansicht: nur Phasen und deren direkte Kinder, Kinder zugeklappt
    const forceCollapse = view === 'phase' && f.depth >= 1 && f.hasChildren
    const isCollapsed = ((collapsed.has(f.task.id) && !active) || forceCollapse) && f.hasChildren
    rows.push({ task: f.task, depth: f.depth, hasChildren: f.hasChildren, index: rows.length, collapsed: isCollapsed, number: numberById.get(f.task.id)! })
    if (isCollapsed) hiddenDepth.push(f.depth)
  }
  return rows
}

function matcher(filters: GanttFilters, sched: ScheduleResult | null, today: ISODate) {
  const todayDay = toDayNumber(today)
  const q = filters.search.trim().toLowerCase()
  return (t: Task): boolean => {
    if (q && !t.name.toLowerCase().includes(q)) return false
    if (filters.trade && t.trade_id !== filters.trade) return false
    if (filters.company && t.company_id !== filters.company) return false
    if (filters.responsible && t.responsible_user_id !== filters.responsible) return false
    if (filters.section && t.section_id !== filters.section) return false
    if (filters.status && t.status !== filters.status) return false
    if (filters.from && t.end_date < filters.from) return false
    if (filters.to && t.start_date > filters.to) return false
    if (filters.criticalOnly && !t.is_critical) return false
    if (filters.milestonesOnly && t.type !== 'milestone') return false
    if (filters.delayedOnly) {
      const s = sched?.tasks.get(t.id)
      const overdue = t.status !== 'done' && (s ? s.end < todayDay : toDayNumber(t.end_date) < todayDay)
      if (!(t.status === 'delayed' || overdue)) return false
    }
    return true
  }
}
