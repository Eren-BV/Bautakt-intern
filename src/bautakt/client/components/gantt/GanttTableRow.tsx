/**
 * Eine Zeile der linken Tabelle. Memoisiert - nur die eigene Zeile rendert neu.
 * Inline-Bearbeitung per Einfachklick auf Name, Dauer, Start, Ende, Fortschritt, Verantwortlicher
 * (Strg/Shift-Klick wählt nur aus). Verantwortlicher steht klein unter dem Vorgangsnamen.
 * Standardspalten: Vorgang, Start, Ende, Dauer - weitere zuschaltbar.
 */

import { memo, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import clsx from 'clsx'
import { ChevronDown, ChevronRight, Diamond, Lock, AlertTriangle, Layers, Paperclip } from 'lucide-react'
import type { Task, TaskDependency } from '../../../shared/types'
import type { GanttRow } from './rows'
import { isVirtualId } from './rows'
import type { GanttLookups } from './types'
import { formatDate } from '../../../shared/engine/dates'
import { TASK_STATUS_LABELS } from '../../../shared/labels'

export type ColumnKey = 'number' | 'name' | 'start' | 'end' | 'duration' | 'trade' | 'company' | 'responsible' | 'progress' | 'status' | 'predecessors' | 'float' | 'actual_start' | 'actual_finish' | 'section'

export interface Column {
  key: ColumnKey
  label: string
  width: number
  align?: 'right' | 'center'
}

export const ALL_COLUMNS: Column[] = [
  { key: 'number', label: '#', width: 36, align: 'right' },
  { key: 'name', label: 'Vorgang', width: 260 },
  { key: 'start', label: 'Start', width: 84 },
  { key: 'end', label: 'Ende', width: 84 },
  { key: 'duration', label: 'Dauer', width: 56, align: 'right' },
  { key: 'trade', label: 'Kategorie', width: 110 },
  { key: 'company', label: 'Firma', width: 120 },
  { key: 'responsible', label: 'Verantw.', width: 110 },
  { key: 'section', label: 'Abschnitt', width: 80 },
  { key: 'progress', label: '%', width: 48, align: 'right' },
  { key: 'status', label: 'Status', width: 100 },
  { key: 'predecessors', label: 'Vorgänger', width: 100 },
  { key: 'float', label: 'Spielraum', width: 110 },
  { key: 'actual_start', label: 'Ist-Start', width: 84 },
  { key: 'actual_finish', label: 'Ist-Ende', width: 84 },
]
export const DEFAULT_COLUMNS: ColumnKey[] = ['number', 'name', 'company', 'start', 'end', 'duration']
export const OPTIONAL_COLUMNS: ColumnKey[] = ['trade', 'company', 'responsible', 'section', 'progress', 'status', 'predecessors', 'float', 'actual_start', 'actual_finish']

type EditField = 'name' | 'duration' | 'start_date' | 'end_date' | 'progress' | 'responsible'

interface Props {
  row: GanttRow
  columns: Column[]
  rowH: number
  selected: boolean
  primary: boolean
  readOnly: boolean
  isCritical: boolean
  hasConflict: boolean
  floatLabel: string
  predecessors: (TaskDependency & { number: number })[]
  lookups: GanttLookups
  /** Von Jarvis geändert - Zeile leuchtet kurz auf */
  flash?: boolean
  onSelect(id: string, e: { ctrl: boolean; shift: boolean }): void
  onToggle(id: string): void
  onOpen(id: string): void
  onContextMenu(id: string, x: number, y: number): void
  onInlineEdit(task: Task, field: EditField, value: string): void
}

const short = (iso: string | null) => (iso ? formatDate(iso, 'short') + iso.slice(2, 4) : '')

export const GanttTableRow = memo(function GanttTableRow({ row, columns, rowH, selected, primary, readOnly, isCritical, hasConflict, floatLabel, predecessors, lookups, flash, onSelect, onToggle, onOpen, onContextMenu, onInlineEdit }: Props) {
  const t = row.task
  const ROW_H = rowH
  const [edit, setEdit] = useState<EditField | null>(null)
  const isParent = row.hasChildren
  const isMs = t.type === 'milestone'
  const virtual = isVirtualId(t.id)
  const responsible = virtual ? '' : [
    ...(t.responsible_user_ids ?? []).map((id) => lookups.userName(id)),
    ...(t.responsible_user_id && !(t.responsible_user_ids ?? []).includes(t.responsible_user_id) ? [lookups.userName(t.responsible_user_id)] : []),
    ...(t.responsible_name ? [t.responsible_name] : []),
  ].filter((n) => n && n !== '–').join(', ')
  const showSub = rowH >= 36

  const startEdit = (f: EditField, e?: MouseEvent) => {
    if (readOnly || virtual) return
    if (e && (e.ctrlKey || e.metaKey || e.shiftKey)) return
    if (isParent && f !== 'name' && f !== 'responsible') return
    if (isMs && (f === 'duration' || f === 'end_date' || f === 'progress')) return
    setEdit(f)
  }
  const select = (e: MouseEvent) => onSelect(t.id, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey })

  return (
    <div
      className={clsx(
        'group flex items-center border-b border-line text-[13px]',
        selected ? (primary ? 'bg-brand-soft/80' : 'bg-brand-soft/45') : 'hover:bg-surface-2',
        t.status === 'done' && 'text-ink-faint',
        virtual && 'bg-surface-2/70',
        flash && 'jarvis-flash',
      )}
      style={{ height: ROW_H, top: row.index * ROW_H, position: 'absolute', left: 0, right: 0 }}
      onClick={select}
      onDoubleClick={(e) => {
        if ((e.target as HTMLElement).closest('[data-cell]') || virtual) return
        onOpen(t.id)
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        if (virtual) return
        if (!selected) onSelect(t.id, { ctrl: false, shift: false })
        onContextMenu(t.id, e.clientX, e.clientY)
      }}
      data-row-id={t.id}
    >
      {columns.map((c) => {
        const style = { width: c.width, minWidth: c.width }
        const cls = clsx('h-full shrink-0 truncate border-r border-line/70 px-2', c.align === 'right' && 'text-right', c.align === 'center' && 'text-center')
        const lh = { lineHeight: `${ROW_H}px` }
        switch (c.key) {
          case 'number':
            return <div key={c.key} style={{ ...style, ...lh }} className={clsx(cls, 'text-ink-faint tabular-nums')}>{virtual ? '' : row.number}</div>
          case 'name':
            return (
              <div key={c.key} style={{ ...style, paddingLeft: 8 + row.depth * 16 }} className={clsx(cls, 'flex items-center gap-1 pr-2')} data-cell onClick={(e) => { if (!(e.target as HTMLElement).closest('[data-sub]')) startEdit('name', e) }}>
                {isParent ? (
                  <button type="button" className="-ml-1 flex h-5 w-5 shrink-0 items-center justify-center rounded text-ink-faint hover:bg-surface-3 hover:text-ink" onClick={(e) => { e.stopPropagation(); onToggle(t.id) }} aria-label={row.collapsed ? 'Aufklappen' : 'Zuklappen'}>
                    {row.collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                  </button>
                ) : (
                  <span className="w-4 shrink-0" />
                )}
                {isMs && <Diamond size={11} className="shrink-0 fill-milestone text-milestone" />}
                {virtual && <Layers size={12} className="shrink-0 text-ink-faint" />}
                {edit === 'name' ? (
                  <InlineInput value={t.name} onCommit={(v) => onInlineEdit(t, 'name', v)} onDone={() => setEdit(null)} />
                ) : (
                  <span className="flex min-w-0 flex-col justify-center" style={{ lineHeight: showSub && responsible ? '15px' : `${ROW_H}px` }}>
                    <span className={clsx('truncate', isParent && 'font-semibold text-ink', isCritical && !isParent && 'text-critical', t.status === 'done' && 'line-through decoration-ink-faint/60')} title={t.name}>
                      {t.name}
                      {!virtual && lookups.docCount(t.id) > 0 && <Paperclip size={12} className="ml-1.5 inline-block align-[-1px] text-ink-faint" aria-label="Dokumente vorhanden" />}
                      {virtual && row.virtual && <span className="ml-1.5 font-normal text-ink-faint">({row.virtual.count})</span>}
                    </span>
                    {showSub && !virtual && (edit === 'responsible' ? (
                      <span data-sub className="block" onClick={(e) => e.stopPropagation()}><InlineInput value={t.responsible_name || responsible} onCommit={(v) => onInlineEdit(t, 'responsible', v)} onDone={() => setEdit(null)} small /></span>
                    ) : responsible ? (
                      <span data-sub className="truncate text-[10px] font-normal text-ink-faint hover:text-ink-soft" title="Verantwortlicher – klicken zum Ändern" onClick={(e) => { e.stopPropagation(); startEdit('responsible', e) }}>{responsible}</span>
                    ) : null)}
                  </span>
                )}
                {t.scheduling_mode === 'manual' && <Lock size={11} className="ml-1 shrink-0 text-ink-faint" aria-label="Manuell geplant" />}
                {hasConflict && <AlertTriangle size={12} className="ml-1 shrink-0 text-warn" aria-label="Abhängigkeit verletzt" />}
              </div>
            )
          case 'trade':
            return (
              <div key={c.key} style={{ ...style, ...lh }} className={clsx(cls, 'text-ink-soft')}>
                {t.trade_id && !virtual && <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: lookups.tradeColor(t.trade_id) }} /><span className="truncate">{lookups.tradeName(t.trade_id)}</span></span>}
              </div>
            )
          case 'company':
            return <div key={c.key} style={{ ...style, ...lh }} className={clsx(cls, 'text-ink-soft')}>{t.company_id ? lookups.companyName(t.company_id) : ''}</div>
          case 'responsible':
            return (
              <div key={c.key} style={{ ...style, ...lh }} className={clsx(cls, 'text-ink-soft')} data-cell onClick={(e) => startEdit('responsible', e)}>
                {edit === 'responsible' ? <InlineInput value={t.responsible_name || responsible} onCommit={(v) => onInlineEdit(t, 'responsible', v)} onDone={() => setEdit(null)} /> : responsible}
              </div>
            )
          case 'section':
            return <div key={c.key} style={{ ...style, ...lh }} className={clsx(cls, 'text-ink-soft')}>{t.section_id && !virtual ? lookups.sectionName(t.section_id) : ''}</div>
          case 'duration':
            return (
              <div key={c.key} style={{ ...style, ...lh }} className={clsx(cls, 'tabular-nums')} data-cell onClick={(e) => startEdit('duration', e)}>
                {edit === 'duration' ? <InlineInput type="number" value={String(t.duration)} onCommit={(v) => onInlineEdit(t, 'duration', v)} onDone={() => setEdit(null)} /> : isMs ? '–' : virtual ? '' : `${t.duration} AT`}
              </div>
            )
          case 'start':
            return (
              <div key={c.key} style={{ ...style, ...lh }} className={clsx(cls, 'tabular-nums')} data-cell onClick={(e) => startEdit('start_date', e)}>
                {edit === 'start_date' ? <InlineInput type="date" value={t.start_date} onCommit={(v) => onInlineEdit(t, 'start_date', v)} onDone={() => setEdit(null)} /> : virtual ? '' : short(t.start_date)}
              </div>
            )
          case 'end':
            return (
              <div key={c.key} style={{ ...style, ...lh }} className={clsx(cls, 'tabular-nums')} data-cell onClick={(e) => startEdit('end_date', e)}>
                {edit === 'end_date' ? <InlineInput type="date" value={t.end_date} onCommit={(v) => onInlineEdit(t, 'end_date', v)} onDone={() => setEdit(null)} /> : isMs || virtual ? '' : short(t.end_date)}
              </div>
            )
          case 'progress':
            return (
              <div key={c.key} style={{ ...style, ...lh }} className={clsx(cls, 'tabular-nums')} data-cell onClick={(e) => startEdit('progress', e)}>
                {edit === 'progress' ? <InlineInput type="number" value={String(t.progress)} onCommit={(v) => onInlineEdit(t, 'progress', v)} onDone={() => setEdit(null)} /> : isMs ? '' : virtual ? `${row.virtual?.progress ?? 0}` : `${t.progress}`}
              </div>
            )
          case 'predecessors':
            return (
              <div key={c.key} style={{ ...style, ...lh }} className={clsx(cls, 'text-ink-soft tabular-nums')} title={predecessors.map((p) => `${p.number}${p.type}${p.lag_days ? (p.lag_days > 0 ? '+' : '') + p.lag_days : ''}`).join(', ')}>
                {predecessors.map((p) => `${p.number}${p.type === 'FS' ? '' : p.type}${p.lag_days ? (p.lag_days > 0 ? '+' : '') + p.lag_days : ''}`).join(', ')}
              </div>
            )
          case 'float':
            return <div key={c.key} style={{ ...style, ...lh }} className={clsx(cls, 'text-xs', isCritical && !isParent ? 'font-medium text-critical' : 'text-ink-soft')}>{isParent || virtual ? '' : floatLabel}</div>
          case 'actual_start':
            return <div key={c.key} style={{ ...style, ...lh }} className={clsx(cls, 'tabular-nums text-ink-soft')}>{short(t.actual_start)}</div>
          case 'actual_finish':
            return <div key={c.key} style={{ ...style, ...lh }} className={clsx(cls, 'tabular-nums text-ink-soft')}>{short(t.actual_finish)}</div>
          case 'status':
            return (
              <div key={c.key} style={{ ...style, ...lh }} className={cls}>
                {!isParent && (
                  <span className={clsx('inline-block rounded-full px-1.5 py-px text-[10px] font-medium leading-4', t.status === 'done' && 'bg-ok-soft text-ok', t.status === 'in_progress' && 'bg-brand-soft text-brand', t.status === 'at_risk' && 'bg-warn-soft text-warn', t.status === 'blocked' && 'bg-warn-soft text-warn', t.status === 'delayed' && 'bg-danger-soft text-danger', t.status === 'not_started' && 'bg-surface-3 text-ink-soft')}>
                    {TASK_STATUS_LABELS[t.status]}
                  </span>
                )}
              </div>
            )
        }
      })}
    </div>
  )
})

function InlineInput({ value, type = 'text', onCommit, onDone, small }: { value: string; type?: 'text' | 'number' | 'date'; onCommit: (v: string) => void; onDone: () => void; small?: boolean }) {
  const [v, setV] = useState(value)
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [])
  const commit = () => {
    if (v !== value) onCommit(v)
    onDone()
  }
  const key = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') commit()
    if (e.key === 'Escape') onDone()
    e.stopPropagation()
  }
  return <input ref={ref} type={type} value={v} placeholder={small ? 'Verantwortlicher' : undefined} onChange={(e) => setV(e.target.value)} onBlur={commit} onKeyDown={key} onClick={(e) => e.stopPropagation()} className={clsx('w-full min-w-0 rounded border border-brand bg-surface px-1 outline-none', small ? 'h-4 text-[10px] leading-4' : 'h-6 text-[13px] leading-6')} />
}
