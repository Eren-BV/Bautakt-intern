/**
 * Change-Proposal-Schicht: wendet die Operationen eines Vorschlags deterministisch auf
 * eine KOPIE des Plans an. Wer den Vorschlag erzeugt hat (Nachunternehmer, E-Mail-Analyse,
 * BuildFlow-Abgleich, später KI) spielt hier keine Rolle - die Scheduling Engine rechnet,
 * der Mensch entscheidet, `ProjectService.savePlan` schreibt.
 */

import type { ChangeProposal, ProposalOperation, TaskConstraint, TaskDependency, Trade } from '../types.ts'
import {
  addDependency,
  createTask,
  deleteTasks,
  moveTask,
  recompute,
  removeDependency,
  setDuration,
  setEndDate,
  updateDependency,
  updateTaskFields,
  type PlanContext,
  type PlanState,
} from './operations.ts'

export interface ApplyOptions {
  newId: (prefix: string) => string
  trades?: Trade[]
}

export type NewConstraint = Pick<TaskConstraint, 'task_id' | 'type' | 'title' | 'due_date'>

export interface ApplyResult {
  state: PlanState
  constraints: NewConstraint[]
  /** Operationen, die nicht (mehr) anwendbar waren - z. B. Vorgang inzwischen gelöscht */
  warnings: string[]
  /** Zuordnung add_task.key → neue Task-ID */
  keyToId: Map<string, string>
}

/** Einfache Vorschläge (ein Vorgang, neuer Start/Ende) in Operationen übersetzen */
export function proposalOperations(p: Pick<ChangeProposal, 'task_id' | 'proposed_start' | 'proposed_end' | 'operations'>): ProposalOperation[] {
  if (p.operations?.length) return p.operations
  const ops: ProposalOperation[] = []
  if (p.task_id && p.proposed_start) ops.push({ op: 'move_task', task_id: p.task_id, new_start: p.proposed_start, cascade: true })
  if (p.task_id && p.proposed_end) ops.push({ op: 'set_end', task_id: p.task_id, new_end: p.proposed_end })
  return ops
}

export function applyOperations(state: PlanState, ctx: PlanContext, ops: ProposalOperation[], opts: ApplyOptions): ApplyResult {
  let next = state
  const warnings: string[] = []
  const constraints: NewConstraint[] = []
  const keyToId = new Map<string, string>()
  const tradeByName = new Map((opts.trades ?? []).map((t) => [t.name.toLowerCase(), t.id]))
  const resolve = (ref: string): string | null => keyToId.get(ref) ?? (next.tasks.some((t) => t.id === ref) ? ref : null)
  const has = (id: string | null | undefined) => !!id && next.tasks.some((t) => t.id === id)

  for (const op of ops) {
    switch (op.op) {
      case 'move_task': {
        if (!has(op.task_id)) { warnings.push(`Vorgang ${op.task_id} nicht mehr vorhanden.`); break }
        next = moveTask(next, ctx, op.task_id, op.new_start, op.cascade ?? true)
        break
      }
      case 'set_end': {
        if (!has(op.task_id)) { warnings.push(`Vorgang ${op.task_id} nicht mehr vorhanden.`); break }
        next = setEndDate(next, ctx, op.task_id, op.new_end, true)
        break
      }
      case 'set_duration': {
        if (!has(op.task_id)) { warnings.push(`Vorgang ${op.task_id} nicht mehr vorhanden.`); break }
        next = setDuration(next, ctx, op.task_id, Math.max(1, op.duration | 0))
        break
      }
      case 'add_task': {
        const parent = op.parent_key ? (keyToId.get(op.parent_key) ?? null) : (op.parent_id && has(op.parent_id) ? op.parent_id : null)
        const id = opts.newId('t')
        keyToId.set(op.key, id)
        next = createTask(next, ctx, {
          id, name: op.name, type: op.type, parent_id: parent, duration: op.type === 'milestone' ? 0 : Math.max(1, op.duration | 0),
          after_id: op.after_task_id && has(op.after_task_id) ? op.after_task_id : null,
          trade_id: op.trade_name ? (tradeByName.get(op.trade_name.toLowerCase()) ?? null) : null,
        })
        if (op.notes) next = { ...next, tasks: next.tasks.map((t) => (t.id === id ? { ...t, notes: op.notes ?? '' } : t)) }
        break
      }
      case 'update_task': {
        const id = resolve(op.task_id)
        if (!id) { warnings.push(`Vorgang ${op.task_id} nicht mehr vorhanden.`); break }
        next = updateTaskFields(next, ctx, id, op.fields)
        break
      }
      case 'remove_task': {
        const id = resolve(op.task_id)
        if (!id) { warnings.push(`Vorgang ${op.task_id} war bereits entfernt.`); break }
        next = deleteTasks(next, ctx, [id])
        break
      }
      case 'add_dependency': {
        const pred = resolve(op.predecessor)
        const succ = resolve(op.successor)
        if (!pred || !succ) { warnings.push('Abhängigkeit übersprungen: Vorgang nicht vorhanden.'); break }
        const r = addDependency(next, ctx, { id: opts.newId('dep'), predecessor_id: pred, successor_id: succ, type: op.type, lag_days: op.lag_days | 0 })
        if (r.error) warnings.push(`Abhängigkeit übersprungen: ${r.error}`)
        next = r.state
        break
      }
      case 'update_dependency': {
        if (!next.dependencies.some((d) => d.id === op.dependency_id)) { warnings.push('Abhängigkeit nicht mehr vorhanden.'); break }
        const patch: Partial<Pick<TaskDependency, 'type' | 'lag_days'>> = {}
        if (op.type) patch.type = op.type
        if (op.lag_days !== undefined) patch.lag_days = op.lag_days
        next = updateDependency(next, ctx, op.dependency_id, patch)
        break
      }
      case 'remove_dependency': {
        if (!next.dependencies.some((d) => d.id === op.dependency_id)) { warnings.push('Abhängigkeit war bereits entfernt.'); break }
        next = removeDependency(next, ctx, op.dependency_id)
        break
      }
      case 'add_constraint': {
        const id = op.task_key ? (keyToId.get(op.task_key) ?? null) : (op.task_id ? resolve(op.task_id) : null)
        if (!id) { warnings.push(`Voraussetzung „${op.title}“ übersprungen: Vorgang nicht vorhanden.`); break }
        constraints.push({ task_id: id, type: op.type, title: op.title, due_date: op.due_date ?? null })
        break
      }
    }
  }
  return { state: recompute(next, ctx).state, constraints, warnings, keyToId }
}

/** Lesbare Kurzbeschreibung einer Operation (für Listen, Historie, E-Mail-Vorschau) */
export function describeOperation(op: ProposalOperation, taskName: (id: string) => string): string {
  switch (op.op) {
    case 'move_task': return `${taskName(op.task_id)} → neuer Start ${fmt(op.new_start)}${op.cascade === false ? ' (nur dieser Vorgang)' : ''}`
    case 'set_end': return `${taskName(op.task_id)} → neues Ende ${fmt(op.new_end)}`
    case 'set_duration': return `${taskName(op.task_id)} → Dauer ${op.duration} AT`
    case 'add_task': return `Neu: ${op.name}${op.type === 'milestone' ? ' (Meilenstein)' : op.type === 'task' ? ` (${op.duration} AT)` : ''}`
    case 'update_task': return `${taskName(op.task_id)} → ${Object.entries(op.fields).map(([k, v]) => (k === 'duration' ? `Dauer ${String(v)} AT` : k === 'name' ? `Bezeichnung „${String(v)}“` : `${FIELD_LABELS[k] ?? k}: ${String(v ?? '–')}`)).join(', ')}`
    case 'remove_task': return `Entfernen: ${taskName(op.task_id)}`
    case 'add_dependency': return `Abhängigkeit ${taskName(op.predecessor)} → ${taskName(op.successor)} (${op.type}${op.lag_days ? (op.lag_days > 0 ? '+' : '') + op.lag_days : ''})`
    case 'update_dependency': return `Abhängigkeit ändern (${op.type ?? ''}${op.lag_days !== undefined ? ` Lag ${op.lag_days}` : ''})`
    case 'remove_dependency': return 'Abhängigkeit entfernen'
    case 'add_constraint': return `Voraussetzung: ${op.title}${op.due_date ? ` (bis ${fmt(op.due_date)})` : ''}`
  }
}

/** Grobe Klassifikation für die UI: hinzugefügt / geändert / entfernt */
export function operationKind(op: ProposalOperation): 'added' | 'changed' | 'removed' {
  if (op.op === 'add_task' || op.op === 'add_dependency' || op.op === 'add_constraint') return 'added'
  if (op.op === 'remove_task' || op.op === 'remove_dependency') return 'removed'
  return 'changed'
}

const FIELD_LABELS: Record<string, string> = { notes: 'Notiz', description: 'Beschreibung', trade_id: 'Kategorie', responsible_user_id: 'Verantwortlicher', resource_id: 'Ressource', company_id: 'Firma', constraint_type: 'Einschränkung', constraint_date: 'Einschränkungsdatum' }

function fmt(iso: string): string {
  return `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`
}
