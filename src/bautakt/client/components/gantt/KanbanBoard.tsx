/**
 * Kanban-Ansicht derselben Vorgänge wie im Gantt: eine Spalte je Status, Karten per
 * Drag & Drop zwischen Spalten verschiebbar (ändert task.status). Keine eigene Datenquelle -
 * nur eine andere Darstellung von p.plan.tasks, gefiltert wie im Gantt.
 */

import { useState } from 'react'
import clsx from 'clsx'
import { AlertTriangle, Flag } from 'lucide-react'
import { Badge, STATUS_TONE } from '../ui'
import { TASK_STATUS_LABELS } from '../../../shared/labels'
import { formatDate } from '../../../shared/engine/dates'
import type { Task, TaskStatus } from '../../../shared/types'

const COLUMNS = Object.keys(TASK_STATUS_LABELS) as TaskStatus[]

interface Lookups {
  tradeName(id: string | null): string
  tradeColor(id: string | null): string
  companyName(id: string | null): string
}

export function KanbanBoard({
  tasks,
  selectedIds,
  primaryId,
  readOnly,
  lookups,
  onSelect,
  onOpen,
  onStatusChange,
  onContextMenu,
}: {
  tasks: Task[]
  selectedIds: Set<string>
  primaryId: string | null
  readOnly: boolean
  lookups: Lookups
  onSelect: (id: string | null, e: { ctrl: boolean; shift: boolean }) => void
  onOpen: (id: string) => void
  onStatusChange: (id: string, status: TaskStatus) => void
  onContextMenu: (id: string, x: number, y: number) => void
}) {
  const [dragId, setDragId] = useState<string | null>(null)
  const [overCol, setOverCol] = useState<TaskStatus | null>(null)
  const byStatus = new Map<TaskStatus, Task[]>(COLUMNS.map((s) => [s, []]))
  for (const t of tasks) byStatus.get(t.status)?.push(t)

  return (
    <div className="flex h-full min-w-0 flex-1 gap-3 overflow-x-auto p-3">
      {COLUMNS.map((status) => {
        const list = byStatus.get(status) ?? []
        return (
          <div
            key={status}
            className={clsx(
              'flex w-72 shrink-0 flex-col rounded-xl border bg-surface-2 transition-colors',
              overCol === status ? 'border-brand bg-brand-soft/30' : 'border-line',
            )}
            onDragOver={(e) => { if (dragId) { e.preventDefault(); setOverCol(status) } }}
            onDragLeave={() => setOverCol((c) => (c === status ? null : c))}
            onDrop={(e) => {
              e.preventDefault()
              setOverCol(null)
              const id = e.dataTransfer.getData('text/plain') || dragId
              if (id) onStatusChange(id, status)
              setDragId(null)
            }}
          >
            <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2.5">
              <span className="flex items-center gap-2 text-sm font-semibold text-ink">
                <Badge tone={STATUS_TONE[status]} dot>{TASK_STATUS_LABELS[status]}</Badge>
              </span>
              <span className="text-xs text-ink-faint">{list.length}</span>
            </div>
            <div className="flex-1 space-y-2 overflow-y-auto p-2">
              {list.length === 0 && <p className="px-2 py-6 text-center text-xs text-ink-faint">–</p>}
              {list.map((t) => (
                <article
                  key={t.id}
                  draggable={!readOnly}
                  onDragStart={(e) => { setDragId(t.id); e.dataTransfer.setData('text/plain', t.id); e.dataTransfer.effectAllowed = 'move' }}
                  onDragEnd={() => { setDragId(null); setOverCol(null) }}
                  onClick={(e) => { onSelect(t.id, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey }); onOpen(t.id) }}
                  onContextMenu={(e) => { e.preventDefault(); onSelect(t.id, { ctrl: false, shift: false }); onContextMenu(t.id, e.clientX, e.clientY) }}
                  className={clsx(
                    'cursor-pointer rounded-lg border bg-surface p-2.5 shadow-[0_1px_2px_rgba(16,24,40,0.04)] transition hover:border-line-strong',
                    selectedIds.has(t.id) || primaryId === t.id ? 'border-brand ring-1 ring-brand/30' : 'border-line',
                    dragId === t.id && 'opacity-40',
                    !readOnly && 'active:cursor-grabbing',
                  )}
                >
                  <div className="flex items-start gap-2">
                    {t.type === 'milestone' ? <Flag size={14} className="mt-0.5 shrink-0 text-milestone" /> : <span className="mt-1 h-2 w-2 shrink-0 rounded-sm" style={{ background: lookups.tradeColor(t.trade_id) }} />}
                    <span className="min-w-0 flex-1 text-sm leading-snug font-medium text-ink">{t.name}</span>
                    {t.is_critical && <span title="kritischer Pfad"><AlertTriangle size={13} className="mt-0.5 shrink-0 text-danger" /></span>}
                  </div>
                  <div className="mt-1.5 truncate text-xs text-ink-faint">{lookups.tradeName(t.trade_id)}{t.company_id ? ` · ${lookups.companyName(t.company_id)}` : ''}</div>
                  <div className="mt-1 flex items-center justify-between text-[11px] text-ink-faint">
                    <span>{formatDate(t.start_date, 'short')}{t.type !== 'milestone' ? ` – ${formatDate(t.end_date, 'short')}` : ''}</span>
                    {t.type !== 'milestone' && <span>{t.progress} %</span>}
                  </div>
                  {t.type !== 'milestone' && (
                    <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-surface-3">
                      <div className={clsx('h-full rounded-full', t.status === 'done' ? 'bg-ok' : t.status === 'delayed' || t.status === 'blocked' ? 'bg-danger' : 'bg-brand')} style={{ width: `${Math.max(0, Math.min(100, t.progress))}%` }} />
                    </div>
                  )}
                </article>
              ))}
            </div>
          </div>
        )
      })}
    </div>
  )
}
