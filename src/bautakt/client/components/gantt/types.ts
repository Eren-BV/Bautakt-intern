import type { ISODate, Task, TaskDependency, BaselineTask } from '../../../shared/types'
import type { ScheduleResult } from '../../../shared/engine/schedule'
import type { GanttRow } from './rows'
import type { TimeScale } from './scale'
import type { Column } from './GanttTableRow'

/** Standard-Zeilenhöhe; tatsächliche Höhe kommt als `rowH` (Zeilen vergrößern/verkleinern) */
export const ROW_H = 36
export const ROW_HEIGHTS = [28, 36, 44, 56, 72] as const
export const HEADER_H = 56

export interface GanttLookups {
  tradeName(id: string | null): string
  tradeColor(id: string | null): string
  userName(id: string | null): string
  companyName(id: string | null): string
  sectionName(id: string | null): string
}

export type DragMode = 'move' | 'start' | 'end' | 'link'

export interface DragState {
  mode: DragMode
  id: string
  /** alle mitbewegten Vorgänge (Mehrfachauswahl) */
  ids: Set<string>
  originX: number
  originY: number
  /** aktuelle Verschiebung in Kalendertagen (move/start/end) */
  deltaDays: number
  /** Zeiger-Position (link) relativ zur Timeline */
  pointer: { x: number; y: number }
  targetId: string | null
}

export interface SelectEvent {
  ctrl: boolean
  shift: boolean
}

export interface GanttChartProps {
  rows: GanttRow[]
  sched: ScheduleResult
  dependencies: TaskDependency[]
  baselineTasks: Map<string, BaselineTask>
  showBaseline: boolean
  scale: TimeScale
  today: ISODate
  selectedIds: Set<string>
  primaryId: string | null
  readOnly: boolean
  lookups: GanttLookups
  tableWidth: number
  columns: Column[]
  rowH: number
  /** verschiebbarer Datums-Cursor am unteren Rand (Tagnummer) */
  cursorDay: number | null
  onCursorDay(day: number | null): void
  floatLabel(id: string): string
  onTableWidth(w: number): void
  onSelect(id: string | null, e: SelectEvent): void
  onToggleCollapse(id: string): void
  onOpen(id: string): void
  onContextMenu(id: string | null, x: number, y: number): void
  onMove(id: string, newStart: ISODate): void
  onMoveMany(ids: string[], shiftWorkdays: number): void
  onResizeStart(id: string, newStart: ISODate): void
  onResizeEnd(id: string, newEnd: ISODate): void
  onLink(predId: string, succId: string): void
  onInlineEdit(task: Task, field: 'name' | 'duration' | 'start_date' | 'end_date' | 'progress' | 'responsible', value: string): void
}
