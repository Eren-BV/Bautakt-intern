/**
 * Gantt-Container: ein Scrollbereich, links die Tabelle (sticky), rechts die Timeline.
 * Virtualisiert die Zeilen, orchestriert Drag & Drop (verschieben - auch mehrere -,
 * Kanten ziehen, verknüpfen), Spaltenteiler und Tastaturnavigation.
 * Fachlogik bleibt außerhalb (Callbacks).
 */

import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import clsx from 'clsx'
import { GanttTableRow } from './GanttTableRow'
import { GanttTimeline } from './GanttTimeline'
import { headerTicks } from './scale'
import { isVirtualId } from './rows'
import { HEADER_H, type DragMode, type DragState, type GanttChartProps } from './types'
import { buildCalendar, dayKindLabel, nonWorkingDaysBetween, weekdayLong } from '../../../shared/engine/calendar'
import { formatDate, fromDayNumber, toDayNumber } from '../../../shared/engine/dates'

const BUFFER = 8

export function GanttChart(props: GanttChartProps) {
  const { rows, sched, scale, dependencies, selectedIds, primaryId, readOnly, tableWidth, columns, lookups } = props
  const containerRef = useRef<HTMLDivElement>(null)
  const [viewport, setViewport] = useState({ top: 0, height: 600 })
  const [drag, setDrag] = useState<DragState | null>(null)
  const dragRef = useRef<DragState | null>(null)
  const colsWidth = columns.reduce((s, c) => s + c.width, 0)

  // ---- Virtualisierung
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const update = () => setViewport({ top: el.scrollTop, height: el.clientHeight })
    update()
    el.addEventListener('scroll', update, { passive: true })
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => {
      el.removeEventListener('scroll', update)
      ro.disconnect()
    }
  }, [])
  const ROW_H = props.rowH
  const from = Math.max(0, Math.floor(viewport.top / ROW_H) - BUFFER)
  const to = Math.min(rows.length - 1, Math.ceil((viewport.top + viewport.height) / ROW_H) + BUFFER)
  const visible = rows.slice(from, to + 1)

  const ticks = useMemo(() => headerTicks(scale), [scale])
  // Projektkalender (inkl. gesetzlicher Feiertage der Projektregion) für Raster und Kopfzeile
  const baseCalendar = useMemo(() => sched.calendar ?? buildCalendar(null, []), [sched])
  const holidayMarks = useMemo(() => (scale.pxPerDay >= 6 ? nonWorkingDaysBetween(baseCalendar, scale.startDay, scale.endDay, false) : []), [baseCalendar, scale])

  const numberById = useMemo(() => new Map(rows.map((r) => [r.task.id, r.number])), [rows])
  const predsByTask = useMemo(() => {
    const m = new Map<string, (typeof dependencies[number] & { number: number })[]>()
    for (const d of dependencies) {
      const n = numberById.get(d.predecessor_id)
      if (n === undefined) continue
      ;(m.get(d.successor_id) ?? m.set(d.successor_id, []).get(d.successor_id)!).push({ ...d, number: n })
    }
    return m
  }, [dependencies, numberById])

  // ---- Drag & Drop
  const timelineLeft = useCallback(() => {
    const el = containerRef.current
    if (!el) return { x: 0, y: 0 }
    const r = el.getBoundingClientRect()
    return { x: r.left - el.scrollLeft + tableWidth, y: r.top - el.scrollTop + HEADER_H }
  }, [tableWidth])

  const onBarPointerDown = useCallback(
    (e: ReactPointerEvent, id: string, mode: DragMode) => {
      if (e.button !== 0) return
      e.stopPropagation()
      e.preventDefault()
      const origin = timelineLeft()
      // Mehrfachauswahl: alle ausgewählten Blätter bewegen sich mit
      const ids = mode === 'move' && selectedIds.has(id) ? new Set([...selectedIds].filter((x) => !isVirtualId(x))) : new Set([id])
      const state: DragState = { mode, id, ids, originX: e.clientX, originY: e.clientY, deltaDays: 0, pointer: { x: e.clientX - origin.x, y: e.clientY - origin.y }, targetId: null }
      dragRef.current = state
      setDrag(state)
      if (!selectedIds.has(id)) props.onSelect(id, { ctrl: false, shift: false })
      const move = (ev: PointerEvent) => {
        const cur = dragRef.current
        if (!cur) return
        const o = timelineLeft()
        const next: DragState = { ...cur, deltaDays: Math.round((ev.clientX - cur.originX) / scale.pxPerDay), pointer: { x: ev.clientX - o.x, y: ev.clientY - o.y }, targetId: cur.targetId }
        if (cur.mode === 'link') {
          const el = document.elementFromPoint(ev.clientX, ev.clientY) as Element | null
          const target = el?.closest('[data-task-id]')?.getAttribute('data-task-id') ?? null
          next.targetId = target && target !== cur.id ? target : null
        }
        dragRef.current = next
        setDrag(next)
      }
      const up = () => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        const cur = dragRef.current
        dragRef.current = null
        setDrag(null)
        if (!cur) return
        const s = sched.tasks.get(cur.id)
        if (!s) return
        if (cur.mode === 'link') {
          if (cur.targetId) props.onLink(cur.id, cur.targetId)
          return
        }
        if (cur.deltaDays === 0) return
        const cal = s.calendar
        if (cur.mode === 'move') {
          const target = cur.deltaDays > 0 ? cal.nextWorkday(s.start + cur.deltaDays) : cal.prevWorkday(s.start + cur.deltaDays)
          if (target === s.start) return
          if (cur.ids.size > 1) {
            const shift = cal.countWorkdays(Math.min(s.start, target), Math.max(s.start, target)) - 1
            props.onMoveMany([...cur.ids], target > s.start ? shift : -shift)
          } else props.onMove(cur.id, fromDayNumber(target))
        } else if (cur.mode === 'end') {
          const target = cal.prevWorkday(Math.max(s.start, s.end + cur.deltaDays))
          if (target !== s.end) props.onResizeEnd(cur.id, fromDayNumber(target))
        } else if (cur.mode === 'start') {
          const target = cal.nextWorkday(Math.min(s.end, s.start + cur.deltaDays))
          if (target !== s.start) props.onResizeStart(cur.id, fromDayNumber(target))
        }
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    },
    [props, scale.pxPerDay, sched, timelineLeft, selectedIds],
  )

  // ---- Spaltenteiler
  const onSplitterDown = (e: ReactPointerEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = tableWidth
    const move = (ev: PointerEvent) => props.onTableWidth(Math.max(200, Math.min(1200, startW + ev.clientX - startX)))
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  // ---- Kalender schieben (Ziehen auf Leerfläche / Fußleiste)
  const [panning, setPanning] = useState(false)
  const panMovedRef = useRef(false)
  const panStart = useCallback((e: ReactPointerEvent) => {
    if (e.button !== 0) return
    const el = containerRef.current
    if (!el) return
    e.preventDefault()
    const sx = e.clientX, sy = e.clientY, sl = el.scrollLeft, st = el.scrollTop
    setPanning(true)
    const move = (ev: PointerEvent) => {
      if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) > 3) panMovedRef.current = true
      if (!panMovedRef.current) return
      el.scrollLeft = sl - (ev.clientX - sx)
      el.scrollTop = st - (ev.clientY - sy)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setPanning(false)
      // Klick nach einem Schieben unterdrücken (sonst würde die Auswahl aufgehoben)
      setTimeout(() => { panMovedRef.current = false }, 0)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }, [])

  // ---- Datums-Cursor (nur am Griff in der Fußleiste)
  const cursorDragStart = useCallback((e: ReactPointerEvent) => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    const strip = (e.currentTarget as HTMLElement).parentElement!
    const rect = strip.getBoundingClientRect()
    const dayAt = (clientX: number) => Math.max(scale.startDay, Math.min(scale.endDay, scale.dayAt(clientX - rect.left)))
    props.onCursorDay(dayAt(e.clientX))
    const move = (ev: PointerEvent) => props.onCursorDay(dayAt(ev.clientX))
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }, [props, scale])

  // ---- Ausgewählten Vorgang sichtbar machen
  useEffect(() => {
    if (!primaryId) return
    const el = containerRef.current
    const row = rows.find((r) => r.task.id === primaryId)
    if (!el || !row) return
    const y = row.index * ROW_H
    if (y < el.scrollTop || y + ROW_H > el.scrollTop + el.clientHeight - HEADER_H) el.scrollTo({ top: Math.max(0, y - el.clientHeight / 2), behavior: 'smooth' })
  }, [primaryId]) // eslint-disable-line react-hooks/exhaustive-deps

  // ---- Jarvis: Vorgang anspringen - senkrecht ins obere Drittel, waagerecht zum Balkenanfang
  const focusDone = useRef(0)
  useEffect(() => {
    const f = props.focus
    const el = containerRef.current
    if (!f || !el || focusDone.current === f.nonce) return
    const row = rows.find((r) => r.task.id === f.taskId)
    if (!row) return
    focusDone.current = f.nonce
    const s = sched.tasks.get(f.taskId)
    const barX = s ? scale.x(s.start) : null
    const timelineW = el.clientWidth - tableWidth
    const barVisible = barX !== null && barX >= el.scrollLeft && barX <= el.scrollLeft + timelineW - 40
    // Senkrecht: in den freien Bereich - also oberhalb eines offenen Jarvis-Fensters, wenn dort Platz ist
    const box = el.getBoundingClientRect()
    const bandTop = box.top + HEADER_H
    let bandBottom = box.bottom - 24
    const panel = document.querySelector('[data-jarvis-panel]')?.getBoundingClientRect()
    if (panel && panel.left < box.right && panel.right > box.left && panel.top < bandBottom && panel.top - bandTop >= ROW_H * 3) bandBottom = panel.top - 8
    const offset = Math.max(0, (bandBottom - bandTop) / 2 - ROW_H / 2)
    el.scrollTo({
      top: Math.max(0, row.index * ROW_H - offset),
      left: barX === null || barVisible ? el.scrollLeft : Math.max(0, barX - timelineW / 3),
      behavior: 'smooth',
    })
  }, [props.focus, rows]) // eslint-disable-line react-hooks/exhaustive-deps

  const todayDay = toDayNumber(props.today)
  const scrollToToday = useCallback(() => {
    const el = containerRef.current
    if (!el) return
    el.scrollTo({ left: Math.max(0, scale.x(todayDay) - (el.clientWidth - tableWidth) / 3), behavior: 'smooth' })
  }, [scale, todayDay, tableWidth])
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    el.scrollLeft = Math.max(0, scale.x(todayDay) - (el.clientWidth - tableWidth) / 3)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      className={clsx('relative h-full w-full overflow-auto bg-surface outline-none', drag && 'gantt-nosel')}
      style={{ cursor: drag?.mode === 'move' ? 'grabbing' : drag?.mode === 'link' ? 'crosshair' : drag ? 'ew-resize' : undefined }}
    >
      <div style={{ width: tableWidth + scale.width, minHeight: '100%' }}>
        {/* Kopfzeile */}
        <div className="sticky top-0 z-20 flex" style={{ height: HEADER_H }}>
          <div className="sticky left-0 z-30 flex shrink-0 items-end overflow-hidden border-r border-b border-line bg-surface-2" style={{ width: tableWidth, height: HEADER_H }}>
            <div className="flex" style={{ width: colsWidth }}>
              {columns.map((c) => (
                <div key={c.key} style={{ width: c.width, minWidth: c.width }} className={clsx('truncate border-r border-line/70 px-2 py-1.5 text-[11px] font-semibold tracking-wide text-ink-faint uppercase', c.align === 'right' && 'text-right')}>
                  {c.label}
                </div>
              ))}
            </div>
            <div className="absolute top-0 right-0 z-40 h-full w-1.5 cursor-col-resize hover:bg-brand/30" onPointerDown={onSplitterDown} title="Spaltenbreite ändern" />
          </div>
          <div className="relative shrink-0 border-b border-line bg-surface-2" style={{ width: scale.width, height: HEADER_H }}>
            <div className="absolute top-0 left-0 h-7 w-full border-b border-line">
              {ticks.top.map((t) => (
                <div key={t.key} className="absolute top-0 flex h-7 items-center truncate border-r border-line px-2 text-[11px] font-semibold text-ink-soft" style={{ left: t.x, width: t.width }}>
                  {t.width > 60 ? t.label : ''}
                </div>
              ))}
            </div>
            <div className="absolute top-7 left-0 h-7 w-full">
              {ticks.bottom.map((t) => (
                <div key={t.key} className={clsx('absolute top-0 flex h-7 items-center justify-center truncate border-r border-line/70 text-[10px] tabular-nums', t.minor ? 'bg-surface-3 text-ink-faint' : 'text-ink-soft')} style={{ left: t.x, width: t.width }}>
                  {t.width >= 18 ? t.label : ''}
                </div>
              ))}
            </div>
            {holidayMarks.map((h) => (
              <div key={h.day} className="absolute top-7 h-7" style={{ left: scale.x(h.day), width: scale.pxPerDay }} title={`${h.name}\n${weekdayLong(h.day)}, ${formatDate(h.date, 'long')}\n${dayKindLabel(h.kind)} – arbeitsfreier Tag`}>
                <div className={clsx('absolute inset-x-0 bottom-0 h-1', h.kind === 'holiday' ? 'bg-warn' : 'bg-ink-faint/60')} />
              </div>
            ))}
            {todayDay >= scale.startDay && todayDay <= scale.endDay && (
              <button type="button" onClick={scrollToToday} className="absolute top-0.5 z-10 -translate-x-1/2 rounded bg-danger px-1.5 py-px text-[10px] font-semibold text-white" style={{ left: scale.x(todayDay) + scale.pxPerDay / 2 }}>
                Heute
              </button>
            )}
          </div>
        </div>

        {/* Körper */}
        <div className="relative flex" style={{ height: Math.max(rows.length * ROW_H, 200) }}
          onContextMenu={(e) => {
            // Rechtsklick auf Leerfläche (auch bei leerem Plan): Anlegen-Menü
            if ((e.target as Element).closest('[data-task-id],[data-row-id]')) return
            e.preventDefault()
            props.onContextMenu(null, e.clientX, e.clientY)
          }}>
          <div className="sticky left-0 z-10 shrink-0 overflow-hidden border-r border-line bg-surface" style={{ width: tableWidth, height: Math.max(rows.length * ROW_H, 200) }}>
            <div className="relative" style={{ width: Math.max(colsWidth, tableWidth), height: rows.length * ROW_H }}>
              {visible.map((r) => {
                const s = r.virtual ? null : sched.tasks.get(r.task.id)
                return (
                  <GanttTableRow
                    key={r.task.id}
                    row={r}
                    columns={columns}
                    rowH={ROW_H}
                    selected={selectedIds.has(r.task.id)}
                    primary={primaryId === r.task.id}
                    readOnly={readOnly}
                    isCritical={r.virtual ? r.virtual.isCritical : !!s?.isCritical}
                    hasConflict={!!s?.hasConflict}
                    floatLabel={r.virtual ? '' : props.floatLabel(r.task.id)}
                    predecessors={predsByTask.get(r.task.id) ?? []}
                    lookups={lookups}
                    flash={props.flashIds?.has(r.task.id)}
                    onSelect={props.onSelect}
                    onToggle={props.onToggleCollapse}
                    onOpen={props.onOpen}
                    onContextMenu={props.onContextMenu}
                    onInlineEdit={props.onInlineEdit}
                  />
                )
              })}
              {rows.length === 0 && <div className="p-6 text-sm text-ink-faint">Keine Vorgänge – Rechtsklick oder „+ Vorgang“ oben.</div>}
            </div>
          </div>
          <div
            className="relative shrink-0"
            style={{ width: scale.width, cursor: panning ? 'grabbing' : 'grab' }}
            onPointerDown={panStart}
            onContextMenu={(e) => {
              if ((e.target as Element).closest('[data-task-id]')) return
              e.preventDefault()
              props.onContextMenu(null, e.clientX, e.clientY)
            }}
            onClick={(e) => {
              if (panMovedRef.current) return
              if (!(e.target as Element).closest('[data-task-id]')) props.onSelect(null, { ctrl: false, shift: false })
            }}
          >
            <GanttTimeline
              rows={rows}
              from={from}
              to={to}
              sched={sched}
              scale={scale}
              dependencies={dependencies}
              baselineTasks={props.baselineTasks}
              showBaseline={props.showBaseline}
              today={props.today}
              selectedIds={selectedIds}
              primaryId={primaryId}
              drag={drag}
              readOnly={readOnly}
              calendar={baseCalendar}
              lookups={lookups}
              rowH={ROW_H}
              cursorDay={props.cursorDay}
              flashIds={props.flashIds}
              onBarPointerDown={onBarPointerDown}
              onSelect={props.onSelect}
              onOpen={props.onOpen}
              onContextMenu={props.onContextMenu}
            />
          </div>
        </div>
        {/* Fußleiste mit verschiebbarem Datums-Cursor */}
        <div className="sticky bottom-0 z-20 flex h-6 border-t border-line bg-surface-2/95 backdrop-blur" style={{ width: tableWidth + scale.width }}>
          <div className="sticky left-0 z-30 flex shrink-0 items-center gap-2 border-r border-line bg-surface-2 px-2 text-[10px] text-ink-faint" style={{ width: tableWidth }}>
            <span>Cursor</span>
            {props.cursorDay !== null && <span className="font-medium text-ink-soft tabular-nums">{formatDate(fromDayNumber(props.cursorDay))}</span>}
            <button type="button" className="ml-auto rounded px-1 hover:bg-surface-3" onClick={() => props.onCursorDay(props.cursorDay === null ? toDayNumber(props.today) : null)}>{props.cursorDay === null ? 'einblenden' : 'ausblenden'}</button>
          </div>
          <div
            className="relative shrink-0"
            style={{ width: scale.width, cursor: panning ? 'grabbing' : 'grab' }}
            onPointerDown={panStart}
            title="Kalender schieben"
          >
            {props.cursorDay !== null && props.cursorDay >= scale.startDay && props.cursorDay <= scale.endDay && (
              <div className="absolute top-0 h-full -translate-x-1/2" style={{ left: scale.x(props.cursorDay) + scale.pxPerDay / 2 }}>
                <div className="mx-auto h-full w-0.5 bg-brand" />
                <div
                  className="absolute -top-0.5 left-1/2 h-3 w-3 -translate-x-1/2 cursor-col-resize rounded-full border-2 border-white bg-brand shadow"
                  onPointerDown={cursorDragStart}
                  title="Cursor ziehen"
                />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
