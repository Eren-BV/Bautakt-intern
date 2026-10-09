/**
 * Rechte Seite: SVG mit Raster (Wochenenden/Feiertage), Heute-Linie, Balken, Meilenstein-
 * Rauten, Baseline-Schatten, Fortschritt, kritischer Pfad und Abhängigkeitslinien.
 * Rendert nur den sichtbaren Zeilenbereich (Virtualisierung).
 */

import { memo, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { BaselineTask, TaskDependency } from '../../../shared/types'
import type { ScheduleResult } from '../../../shared/engine/schedule'
import type { WorkCalendar } from '../../../shared/engine/calendar'
import { fromDayNumber, toDayNumber, formatDate } from '../../../shared/engine/dates'
import { dayKindLabel, weekdayLong, type DayKind } from '../../../shared/engine/calendar'
import type { GanttRow } from './rows'
import { isVirtualId } from './rows'
import type { TimeScale } from './scale'
import type { DragMode, DragState, GanttLookups } from './types'

interface Props {
  rows: GanttRow[]
  from: number
  to: number
  sched: ScheduleResult
  scale: TimeScale
  dependencies: TaskDependency[]
  baselineTasks: Map<string, BaselineTask>
  showBaseline: boolean
  today: string
  selectedIds: Set<string>
  primaryId: string | null
  drag: DragState | null
  readOnly: boolean
  calendar: WorkCalendar
  lookups: GanttLookups
  rowH: number
  cursorDay: number | null
  /** Von Jarvis geänderte Vorgänge - leuchten kurz auf */
  flashIds?: Set<string>
  onBarPointerDown(e: ReactPointerEvent, id: string, mode: DragMode): void
  onSelect(id: string | null, e: { ctrl: boolean; shift: boolean }): void
  onOpen(id: string): void
  onContextMenu(id: string | null, x: number, y: number): void
}

const BAR_H = 18
const PARENT_H = 8

export const GanttTimeline = memo(function GanttTimeline(p: Props) {
  const { rows, from, to, sched, scale, dependencies, baselineTasks, showBaseline, today, selectedIds, drag, readOnly, calendar, lookups } = p
  const ROW_H = p.rowH
  // Anfasser zum Strecken/Stauchen erst bei Bedarf zeigen (Hover/Auswahl),
  // damit schmale Balken (z. B. 1 AT) komplett greifbar bleiben.
  const [hoverId, setHoverId] = useState<string | null>(null)
  const sel = (e: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }) => ({ ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey })
  const height = Math.max(1, rows.length) * ROW_H
  const rowIndex = new Map<string, number>()
  rows.forEach((r) => rowIndex.set(r.task.id, r.index))
  const todayDay = toDayNumber(today)
  const visibleRows = rows.slice(from, to + 1)
  const yTop = from * ROW_H
  const yBottom = (to + 1) * ROW_H

  // ---- Balkengeometrie (inkl. Drag-Vorschau)
  const geom = (id: string): { x1: number; x2: number; y: number; isMs: boolean; startDay: number; endDay: number } | null => {
    const idx = rowIndex.get(id)
    if (idx === undefined) return null
    const v = rows[idx].virtual
    const s = v ? { start: v.start, end: v.end, duration: 1 } : sched.tasks.get(id)
    if (!s) return null
    let startDay = s.start
    let endDay = s.end
    if (drag && drag.mode !== 'link' && (drag.id === id || (drag.mode === 'move' && drag.ids.has(id)))) {
      if (drag.mode === 'move') {
        startDay += drag.deltaDays
        endDay += drag.deltaDays
      } else if (drag.mode === 'end') endDay = Math.max(startDay, endDay + drag.deltaDays)
      else if (drag.mode === 'start') startDay = Math.min(endDay, startDay + drag.deltaDays)
    }
    const isMs = !v && s.duration === 0 && rows[idx].task.type === 'milestone'
    return { x1: scale.x(startDay), x2: scale.x(endDay + 1), y: idx * ROW_H, isMs, startDay, endDay }
  }

  // ---- Raster: arbeitsfreie Tage (Wochenende dezent, Feiertag/Betriebsurlaub/Schließtag mit Tooltip), nur bei ausreichender Breite
  const shading: { x: number; w: number; kind: DayKind; title: string | null }[] = []
  if (scale.pxPerDay >= 4) {
    const dFrom = Math.max(scale.startDay, scale.dayAt(0))
    for (let d = dFrom; d <= scale.endDay; d++) {
      if (calendar.isWorkday(d)) continue
      const kind = calendar.dayKind(d)
      const name = calendar.exceptionName(d)
      shading.push({ x: scale.x(d), w: scale.pxPerDay, kind, title: kind === 'weekend' ? null : `${name ?? dayKindLabel(kind)}\n${weekdayLong(d)}, ${formatDate(fromDayNumber(d), 'long')}\n${dayKindLabel(kind)} – arbeitsfreier Tag` })
    }
  }
  const SHADE: Record<DayKind, { fill: string; opacity: number }> = { working: { fill: 'none', opacity: 0 }, weekend: { fill: '#eef0f3', opacity: 0.7 }, holiday: { fill: '#fde68a', opacity: 0.45 }, vacation: { fill: '#c7d2fe', opacity: 0.4 }, closed: { fill: '#fecaca', opacity: 0.35 } }
  // Wochen-/Monatslinien
  const gridLines: number[] = []
  const step = scale.pxPerDay >= 20 ? 1 : scale.pxPerDay >= 5 ? 7 : 0
  if (step) {
    const first = scale.startDay
    for (let d = first; d <= scale.endDay; d++) {
      if (step === 1 || (d - toDayNumber('2024-01-01')) % 7 === 0) gridLines.push(scale.x(d))
    }
  }

  // ---- Abhängigkeitslinien
  const depPaths: { d: string; critical: boolean; key: string }[] = []
  for (const dep of dependencies) {
    const a = geom(dep.predecessor_id)
    const b = geom(dep.successor_id)
    if (!a || !b) continue
    const ia = rowIndex.get(dep.predecessor_id)!
    const ib = rowIndex.get(dep.successor_id)!
    if ((ia < from - 40 && ib < from - 40) || (ia > to + 40 && ib > to + 40)) continue
    const fromX = dep.type === 'SS' || dep.type === 'SF' ? a.x1 : a.x2
    const toX = dep.type === 'FF' || dep.type === 'SF' ? b.x2 : b.x1
    const ay = a.y + ROW_H / 2
    const by = b.y + ROW_H / 2
    const enterFromLeft = dep.type === 'FS' || dep.type === 'SS'
    const path = routeDependency(fromX, ay, toX, by, dep.type === 'SS' || dep.type === 'SF', enterFromLeft, ROW_H)
    const critical = !!sched.tasks.get(dep.predecessor_id)?.isCritical && !!sched.tasks.get(dep.successor_id)?.isCritical
    depPaths.push({ d: path, critical, key: dep.id })
  }

  return (
    <svg width={scale.width} height={height} className="block select-none" style={{ fontFamily: 'inherit' }}>
      <defs>
        <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="#8b93a1" />
        </marker>
        <marker id="arrow-critical" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="#dc2626" />
        </marker>
        <pattern id="conflict" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="3" height="6" fill="#f59e0b" opacity="0.35" />
        </pattern>
      </defs>

      {/* Hintergrund nur für sichtbaren Bereich */}
      <g>
        {shading.map((s, i) => (
          <rect key={i} x={s.x} y={yTop} width={s.w} height={yBottom - yTop} fill={SHADE[s.kind].fill} opacity={SHADE[s.kind].opacity}>
            {s.title && <title>{s.title}</title>}
          </rect>
        ))}
        {gridLines.map((x, i) => (
          <line key={i} x1={x} x2={x} y1={yTop} y2={yBottom} stroke="#e3e6eb" strokeWidth={1} />
        ))}
        {visibleRows.map((r) => (
          <g key={r.task.id}>
            <line x1={0} x2={scale.width} y1={r.index * ROW_H + ROW_H} y2={r.index * ROW_H + ROW_H} stroke="#e3e6eb" strokeWidth={1} />
            {selectedIds.has(r.task.id) && <rect x={0} y={r.index * ROW_H} width={scale.width} height={ROW_H} fill="#2453d6" opacity={p.primaryId === r.task.id ? 0.08 : 0.05} />}
            {p.flashIds?.has(r.task.id) && <rect className="jarvis-flash-bar" x={0} y={r.index * ROW_H} width={scale.width} height={ROW_H} fill="#facc15" pointerEvents="none" />}
            <rect
              x={0}
              y={r.index * ROW_H}
              width={scale.width}
              height={ROW_H}
              fill="transparent"
              data-task-id={isVirtualId(r.task.id) ? undefined : r.task.id}
              onClick={(e) => p.onSelect(r.task.id, sel(e))}
              onDoubleClick={() => !isVirtualId(r.task.id) && p.onOpen(r.task.id)}
              onContextMenu={(e) => {
                e.preventDefault()
                if (isVirtualId(r.task.id)) return
                if (!selectedIds.has(r.task.id)) p.onSelect(r.task.id, { ctrl: false, shift: false })
                p.onContextMenu(r.task.id, e.clientX, e.clientY)
              }}
            />
          </g>
        ))}
      </g>

      {/* Heute */}
      {todayDay >= scale.startDay && todayDay <= scale.endDay && (
        <line x1={scale.x(todayDay) + scale.pxPerDay / 2} x2={scale.x(todayDay) + scale.pxPerDay / 2} y1={yTop} y2={yBottom} stroke="#dc2626" strokeWidth={1.5} strokeDasharray="4 3" opacity={0.8} />
      )}

      {/* Datums-Cursor (verschiebbar über den Griff am unteren Rand) */}
      {p.cursorDay !== null && p.cursorDay >= scale.startDay && p.cursorDay <= scale.endDay && (
        <line x1={scale.x(p.cursorDay) + scale.pxPerDay / 2} x2={scale.x(p.cursorDay) + scale.pxPerDay / 2} y1={yTop} y2={yBottom} stroke="#2453d6" strokeWidth={1.5} opacity={0.8} />
      )}

      {/* Abhängigkeiten */}
      <g fill="none">
        {depPaths.map((d) => (
          <path key={d.key} d={d.d} stroke={d.critical ? '#dc2626' : '#8b93a1'} strokeWidth={d.critical ? 1.6 : 1.2} markerEnd={`url(#${d.critical ? 'arrow-critical' : 'arrow'})`} opacity={0.9} />
        ))}
      </g>

      {/* Balken */}
      {visibleRows.map((r) => {
        const g = geom(r.task.id)
        const s = r.virtual
          ? { isCritical: r.virtual.isCritical, hasConflict: false, isOverdue: false, plannedProgress: 0 }
          : sched.tasks.get(r.task.id)
        if (!g || !s) return null
        const t = r.task
        const isParent = r.hasChildren
        const cy = g.y + ROW_H / 2
        const selected = selectedIds.has(t.id)
        const virtual = !!r.virtual
        const bl = showBaseline ? baselineTasks.get(t.id) : undefined
        const labelX = g.isMs ? g.x1 + scale.pxPerDay / 2 + 12 : g.x2 + 6
        const dragging = !!drag && drag.mode !== 'link' && (drag.id === t.id || (drag.mode === 'move' && drag.ids.has(t.id)))
        const interactive = !readOnly && !isParent && !virtual
        const cursor = interactive ? 'grab' : 'default'
        const docs = lookups.docCount(t.id)

        return (
          <g key={t.id} data-task-id={t.id} opacity={t.status === 'done' ? 0.55 : 1}>
            {bl && !g.isMs && (
              <rect x={scale.x(toDayNumber(bl.start_date))} y={cy + BAR_H / 2 - 1} width={Math.max(2, (toDayNumber(bl.end_date) - toDayNumber(bl.start_date) + 1) * scale.pxPerDay)} height={5} rx={1.5} fill="#b9c0cc" />
            )}
            {bl && g.isMs && (
              <path d={diamond(scale.x(toDayNumber(bl.start_date)) + scale.pxPerDay / 2, cy + 11, 5)} fill="#b9c0cc" />
            )}
            {isParent ? (
              <g
                onClick={(e) => p.onSelect(t.id, sel(e))}
                onDoubleClick={() => !virtual && p.onOpen(t.id)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  if (virtual) return
                  if (!selected) p.onSelect(t.id, { ctrl: false, shift: false })
                  p.onContextMenu(t.id, e.clientX, e.clientY)
                }}
                onPointerDown={(e) => !readOnly && !virtual && p.onBarPointerDown(e, t.id, 'move')}
                style={{ cursor: readOnly || virtual ? 'default' : 'grab' }}
              >
                <rect x={g.x1} y={cy - PARENT_H / 2} width={Math.max(2, g.x2 - g.x1)} height={PARENT_H} rx={2} fill={s.isCritical ? '#b91c1c' : '#1e293b'} />
                <path d={`M ${g.x1} ${cy + PARENT_H / 2} l 0 6 l 6 -6 z`} fill={s.isCritical ? '#b91c1c' : '#1e293b'} />
                <path d={`M ${g.x2} ${cy + PARENT_H / 2} l 0 6 l -6 -6 z`} fill={s.isCritical ? '#b91c1c' : '#1e293b'} />
                {(virtual ? r.virtual!.progress : t.progress) > 0 && <rect x={g.x1} y={cy - PARENT_H / 2} width={Math.max(0, (g.x2 - g.x1) * ((virtual ? r.virtual!.progress : t.progress) / 100))} height={PARENT_H} rx={2} fill="#64748b" opacity={0.6} />}
                <text x={g.x2 + 6} y={cy + 4} fontSize={11} fill="#525a66" fontWeight={600}>
                  {t.name}
                </text>
                {docs > 0 && <DocMark x={g.x1 - 12} y={cy} count={docs} />}
              </g>
            ) : g.isMs ? (
              <g
                onClick={(e) => p.onSelect(t.id, sel(e))}
                onDoubleClick={() => p.onOpen(t.id)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  if (!selected) p.onSelect(t.id, { ctrl: false, shift: false })
                  p.onContextMenu(t.id, e.clientX, e.clientY)
                }}
                onPointerDown={(e) => interactive && p.onBarPointerDown(e, t.id, 'move')}
                style={{ cursor }}
              >
                <path
                  d={diamond(g.x1 + scale.pxPerDay / 2, cy, 9)}
                  fill={t.status === 'done' ? '#16a34a' : s.isCritical ? '#dc2626' : '#1e293b'}
                  stroke={selected ? '#2453d6' : 'white'}
                  strokeWidth={selected ? 2 : 1.5}
                />
                {docs > 0 && <DocMark x={g.x1 + scale.pxPerDay / 2 - 20} y={cy} count={docs} />}
                <text x={labelX} y={cy + 4} fontSize={11} fill={s.isCritical ? '#b91c1c' : '#14171c'} fontWeight={500}>
                  {t.name}
                </text>
                {!readOnly && (selected || dragging) && <LinkHandle x={g.x1 + scale.pxPerDay / 2 + 12} y={cy} onPointerDown={(e) => p.onBarPointerDown(e, t.id, 'link')} />}
              </g>
            ) : (
              <g
                onClick={(e) => p.onSelect(t.id, sel(e))}
                onDoubleClick={() => p.onOpen(t.id)}
                onContextMenu={(e) => {
                  e.preventDefault()
                  if (!selected) p.onSelect(t.id, { ctrl: false, shift: false })
                  p.onContextMenu(t.id, e.clientX, e.clientY)
                }}
                onPointerEnter={() => setHoverId(t.id)}
                onPointerLeave={() => setHoverId((h) => (h === t.id ? null : h))}
              >
                <rect
                  x={g.x1}
                  y={cy - BAR_H / 2}
                  width={Math.max(3, g.x2 - g.x1)}
                  height={BAR_H}
                  rx={3}
                  fill={barFill(t.status, lookups.tradeColor(t.trade_id))}
                  stroke={selected ? '#2453d6' : s.isCritical ? '#dc2626' : 'none'}
                  strokeWidth={selected ? 2 : 1.5}
                  onPointerDown={(e) => interactive && p.onBarPointerDown(e, t.id, 'move')}
                  style={{ cursor }}
                />
                {t.progress > 0 && (
                  <rect x={g.x1} y={cy - BAR_H / 2} width={Math.max(0, (g.x2 - g.x1) * (Math.min(100, t.progress) / 100))} height={BAR_H} rx={3} fill="black" opacity={0.28} pointerEvents="none" />
                )}
                {s.hasConflict && <rect x={g.x1} y={cy - BAR_H / 2} width={Math.max(3, g.x2 - g.x1)} height={BAR_H} rx={3} fill="url(#conflict)" pointerEvents="none" />}
                {s.isOverdue && t.status !== 'done' && <rect x={g.x1} y={cy - BAR_H / 2 - 2} width={Math.max(3, g.x2 - g.x1)} height={2} fill="#dc2626" pointerEvents="none" />}
                {g.x2 - g.x1 > 40 && (
                  <text x={g.x1 + 6} y={cy + 4} fontSize={11} fill="white" fontWeight={500} pointerEvents="none" clipPath={`inset(0 0 0 0)`}>
                    {truncate(t.name, (g.x2 - g.x1 - 10) / 6.2)}
                  </text>
                )}
                {g.x2 - g.x1 <= 40 && (
                  <text x={labelX} y={cy + 4} fontSize={11} fill={s.isCritical ? '#b91c1c' : '#525a66'} pointerEvents="none">
                    {t.name}
                  </text>
                )}
                {docs > 0 && (g.x2 - g.x1 > 34 ? <DocMark x={g.x2 - 11} y={cy} count={docs} light /> : <DocMark x={g.x1 - 12} y={cy} count={docs} />)}
                {interactive && (selected || dragging || hoverId === t.id) && (
                  <>
                    <rect x={g.x1 - 3} y={cy - BAR_H / 2} width={7} height={BAR_H} fill="transparent" style={{ cursor: 'ew-resize' }} onPointerDown={(e) => p.onBarPointerDown(e, t.id, 'start')} />
                    <rect x={g.x2 - 4} y={cy - BAR_H / 2} width={7} height={BAR_H} fill="transparent" style={{ cursor: 'ew-resize' }} onPointerDown={(e) => p.onBarPointerDown(e, t.id, 'end')} />
                    {(selected || dragging) && <LinkHandle x={g.x2 + 10} y={cy} onPointerDown={(e) => p.onBarPointerDown(e, t.id, 'link')} />}
                  </>
                )}
              </g>
            )}
            {dragging && (
              <g pointerEvents="none">
                <rect x={g.x1} y={g.y + 2} width={Math.max(60, 120)} height={0} fill="none" />
                <foreignObject x={Math.max(0, g.x1)} y={g.y - 22} width={200} height={22}>
                  <div className="inline-block rounded bg-ink px-1.5 py-0.5 text-[11px] text-white shadow">
                    {formatDate(fromDayNumber(g.startDay))}
                    {!g.isMs && ` – ${formatDate(fromDayNumber(g.endDay))}`}
                  </div>
                </foreignObject>
              </g>
            )}
          </g>
        )
      })}

      {/* Verbindungslinie beim Verknüpfen */}
      {drag && drag.mode === 'link' && (() => {
        const g = geom(drag.id)
        if (!g) return null
        const x0 = g.isMs ? g.x1 + scale.pxPerDay / 2 : g.x2
        return (
          <g pointerEvents="none">
            <line x1={x0} y1={g.y + ROW_H / 2} x2={drag.pointer.x} y2={drag.pointer.y} stroke="#2453d6" strokeWidth={1.5} strokeDasharray="5 3" />
            <circle cx={drag.pointer.x} cy={drag.pointer.y} r={4} fill={drag.targetId ? '#16a34a' : '#2453d6'} />
          </g>
        )
      })()}
    </svg>
  )
})

function LinkHandle({ x, y, onPointerDown }: { x: number; y: number; onPointerDown: (e: ReactPointerEvent) => void }) {
  return <circle cx={x} cy={y} r={5} fill="white" stroke="#2453d6" strokeWidth={1.5} style={{ cursor: 'crosshair' }} onPointerDown={onPointerDown} />
}

/** Büroklammer: am Vorgang hängen Dokumente (z. B. Angebote). */
function DocMark({ x, y, count, light }: { x: number; y: number; count: number; light?: boolean }) {
  return (
    <g pointerEvents="none" transform={`translate(${x - 6} ${y - 6}) scale(0.5)`}>
      <title>{count === 1 ? '1 Dokument' : `${count} Dokumente`}</title>
      <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" fill="none" stroke={light ? 'white' : '#475569'} strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" />
    </g>
  )
}

function diamond(cx: number, cy: number, r: number): string {
  return `M ${cx} ${cy - r} L ${cx + r} ${cy} L ${cx} ${cy + r} L ${cx - r} ${cy} Z`
}

function barFill(status: string, tradeColor: string): string {
  if (status === 'done') return '#9ca3af'
  if (status === 'delayed') return '#dc2626'
  if (status === 'blocked') return '#d97706'
  return tradeColor
}

function truncate(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s
  return s.slice(0, Math.max(0, Math.floor(maxChars) - 1)) + '…'
}

/** Orthogonale Linie Vorgänger → Nachfolger, wie in klassischen Planungstools */
function routeDependency(x1: number, y1: number, x2: number, y2: number, fromStart: boolean, enterFromLeft: boolean, rowH: number): string {
  const gap = 10
  const dir = fromStart ? -1 : 1
  const exitX = x1 + dir * gap
  if (enterFromLeft) {
    if (exitX < x2 - gap) {
      // genug Platz: rechts raus, runter, rein
      const midX = exitX
      return `M ${x1} ${y1} H ${midX} V ${y2} H ${x2}`
    }
    // Nachfolger beginnt vor Ende des Vorgängers: Umweg über Zwischenzeile
    const midY = y1 < y2 ? y1 + rowH / 2 : y1 - rowH / 2
    return `M ${x1} ${y1} H ${exitX} V ${midY} H ${x2 - gap} V ${y2} H ${x2}`
  }
  // Einlauf von rechts (FF/SF)
  const entryX = Math.max(exitX, x2 + gap)
  return `M ${x1} ${y1} H ${entryX} V ${y2} H ${x2}`
}
