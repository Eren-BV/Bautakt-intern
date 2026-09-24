/**
 * Ausführungsbereitschaft: Voraussetzungen (task_constraints) + Status der Vorgänger.
 * Bewusst getrennt von der Terminrechnung - eine offene Materialfreigabe verschiebt keinen
 * Termin, sie macht den Vorgang „noch nicht ausführungsbereit“.
 */

import type { Task, TaskConstraint, TaskDependency } from '../types.ts'
import { CONSTRAINT_KIND_LABELS } from '../labels.ts'

export type ReadinessState = 'ok' | 'warn' | 'open'

export interface ReadinessItem {
  kind: 'predecessor' | 'constraint'
  id: string
  label: string
  detail: string
  state: ReadinessState
}

export interface Readiness {
  status: 'ready' | 'not_ready' | 'in_progress' | 'done'
  label: string
  items: ReadinessItem[]
  openCount: number
}

export function taskReadiness(task: Task, tasks: Task[], deps: TaskDependency[], constraints: TaskConstraint[]): Readiness {
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const items: ReadinessItem[] = []
  for (const d of deps) {
    if (d.successor_id !== task.id) continue
    const p = byId.get(d.predecessor_id)
    if (!p) continue
    const done = p.status === 'done'
    const partial = d.type === 'SS' || d.type === 'SF' ? p.status !== 'not_started' : false
    items.push({
      kind: 'predecessor',
      id: d.id,
      label: p.name,
      detail: done ? 'fertig' : partial ? 'begonnen' : p.status === 'in_progress' ? `in Arbeit (${p.progress} %)` : p.status === 'delayed' ? 'verzögert' : p.status === 'at_risk' ? 'gefährdet' : p.status === 'blocked' ? 'blockiert' : 'noch nicht begonnen',
      state: done || partial ? 'ok' : p.status === 'in_progress' ? 'warn' : 'open',
    })
  }
  for (const c of constraints) {
    if (c.task_id !== task.id) continue
    items.push({
      kind: 'constraint',
      id: c.id,
      label: c.title,
      detail: CONSTRAINT_KIND_LABELS[c.type] + (c.status === 'blocked' ? ' – blockiert' : c.status === 'fulfilled' ? ' – erfüllt' : c.due_date ? ` – fällig ${c.due_date}` : ' – offen'),
      state: c.status === 'fulfilled' ? 'ok' : c.status === 'blocked' ? 'warn' : 'open',
    })
  }
  const openCount = items.filter((i) => i.state !== 'ok').length
  if (task.status === 'done') return { status: 'done', label: 'Fertig', items, openCount }
  if (task.status === 'in_progress') return { status: 'in_progress', label: 'In Arbeit', items, openCount }
  if (openCount === 0) return { status: 'ready', label: 'Ausführungsbereit', items, openCount }
  return { status: 'not_ready', label: 'Noch nicht ausführungsbereit', items, openCount }
}
