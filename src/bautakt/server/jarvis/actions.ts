/**
 * Jarvis-Aktionen: vorgemerkte (vom Nutzer zu bestätigende) und ausgeführte Änderungen.
 * Ausgeführte Planänderungen speichern ein Diff zum Rückgängigmachen - eine Ebene, und nur
 * solange seitdem niemand weiter geändert hat (Projektversion unverändert).
 */

import type { Db } from '../db.ts'
import { newId, nowISO } from '../db.ts'
import type { Session, Task, TaskDependency } from '../../shared/types.ts'

export type JarvisUndo =
  | { kind: 'plan'; tasks_before: Task[]; tasks_created: string[]; deps_before: TaskDependency[]; deps_created: string[] }
  | { kind: 'delete_project'; project_id: string }

export interface JarvisAction {
  id: string
  org_id: string
  user_id: string
  conversation_id: string | null
  project_id: string | null
  tool: string
  args: Record<string, unknown>
  status: 'pending' | 'executing' | 'done' | 'undone' | 'cancelled' | 'superseded' | 'failed'
  summary: string
  fingerprint: string | null
  version_after: number | null
  undo: JarvisUndo | null
  created_at: string
  expires_at: string | null
}

type PlanState = { tasks: Task[]; dependencies: TaskDependency[] }

/** Felder, die eine inhaltliche Änderung eines Vorgangs ausmachen (berechnete Felder ausgenommen). */
const TASK_FIELDS: (keyof Task)[] = [
  'name', 'type', 'parent_id', 'sort_order', 'start_date', 'end_date', 'duration', 'progress', 'status',
  'trade_id', 'responsible_user_id', 'responsible_user_ids', 'responsible_name', 'company_id', 'actual_start',
  'actual_finish', 'remaining_duration', 'constraint_type', 'constraint_date', 'scheduling_mode', 'notes', 'section_id',
]

const taskKey = (t: Task) => JSON.stringify(TASK_FIELDS.map((k) => t[k] ?? null))
const depKey = (d: TaskDependency) => `${d.predecessor_id}>${d.successor_id}:${d.type}:${d.lag_days}`

export function planDiff(before: PlanState, after: PlanState): JarvisUndo {
  const afterTasks = new Map(after.tasks.map((t) => [t.id, t]))
  const beforeTaskIds = new Set(before.tasks.map((t) => t.id))
  const afterDeps = new Map(after.dependencies.map((d) => [d.id, d]))
  const beforeDepIds = new Set(before.dependencies.map((d) => d.id))
  return {
    kind: 'plan',
    tasks_before: before.tasks.filter((t) => {
      const a = afterTasks.get(t.id)
      return !a || taskKey(a) !== taskKey(t)
    }),
    tasks_created: after.tasks.filter((t) => !beforeTaskIds.has(t.id)).map((t) => t.id),
    deps_before: before.dependencies.filter((d) => {
      const a = afterDeps.get(d.id)
      return !a || depKey(a) !== depKey(d)
    }),
    deps_created: after.dependencies.filter((d) => !beforeDepIds.has(d.id)).map((d) => d.id),
  }
}

export function applyPlanUndo(current: PlanState, undo: Extract<JarvisUndo, { kind: 'plan' }>): PlanState {
  const createdTasks = new Set(undo.tasks_created)
  const restoreTasks = new Map(undo.tasks_before.map((t) => [t.id, t]))
  const tasks = current.tasks.filter((t) => !createdTasks.has(t.id)).map((t) => restoreTasks.get(t.id) ?? t)
  for (const t of undo.tasks_before) if (!tasks.some((x) => x.id === t.id)) tasks.push(t)
  const createdDeps = new Set(undo.deps_created)
  const restoreDeps = new Map(undo.deps_before.map((d) => [d.id, d]))
  const dependencies = current.dependencies.filter((d) => !createdDeps.has(d.id)).map((d) => restoreDeps.get(d.id) ?? d)
  for (const d of undo.deps_before) if (!dependencies.some((x) => x.id === d.id)) dependencies.push(d)
  return { tasks, dependencies }
}

function mapRow(r: Record<string, unknown>): JarvisAction {
  const parse = <T>(v: unknown, fallback: T): T => {
    if (typeof v !== 'string' || !v) return fallback
    try {
      return JSON.parse(v) as T
    } catch {
      return fallback
    }
  }
  return {
    id: String(r.id),
    org_id: String(r.org_id),
    user_id: String(r.user_id),
    conversation_id: (r.conversation_id as string | null) ?? null,
    project_id: (r.project_id as string | null) ?? null,
    tool: String(r.tool),
    args: parse<Record<string, unknown>>(r.args, {}),
    status: r.status as JarvisAction['status'],
    summary: String(r.summary ?? ''),
    fingerprint: (r.fingerprint as string | null) ?? null,
    version_after: r.version_after === null || r.version_after === undefined ? null : Number(r.version_after),
    undo: parse<JarvisUndo | null>(r.undo, null),
    created_at: String(r.created_at),
    expires_at: (r.expires_at as string | null) ?? null,
  }
}

export async function recordAction(
  db: Db,
  session: Session,
  a: { conversation_id: string | null; project_id: string | null; tool: string; args: Record<string, unknown>; status: 'pending' | 'done'; summary: string; fingerprint?: string | null; version_after?: number | null; undo?: JarvisUndo | null; expires_at?: string | null },
): Promise<string> {
  const id = newId('ja')
  await db.insert('jarvis_actions', {
    id,
    org_id: session.org.id,
    user_id: session.user.id,
    conversation_id: a.conversation_id,
    project_id: a.project_id,
    tool: a.tool,
    args: JSON.stringify(a.args),
    status: a.status,
    summary: a.summary,
    fingerprint: a.fingerprint ?? null,
    version_after: a.version_after ?? null,
    undo: a.undo ? JSON.stringify(a.undo) : null,
    created_at: nowISO(),
    expires_at: a.expires_at ?? null,
    decided_at: null,
  })
  // Aufräumen: Aktionen dieses Nutzers älter als 7 Tage
  const cutoff = new Date(Date.now() - 7 * 86400_000).toISOString()
  await db.run('DELETE FROM jarvis_actions WHERE org_id = ? AND user_id = ? AND created_at < ?', session.org.id, session.user.id, cutoff)
  return id
}

/** Atomar übernehmen: nur eine Bestätigung kann eine vorgemerkte Aktion ausführen. */
export async function claimPending(db: Db, session: Session, id: string): Promise<JarvisAction | null> {
  const n = await db.run(
    "UPDATE jarvis_actions SET status = 'executing', decided_at = ? WHERE id = ? AND org_id = ? AND user_id = ? AND status = 'pending' AND expires_at > ?",
    nowISO(), id, session.org.id, session.user.id, nowISO(),
  )
  if (n !== 1) return null
  const row = await db.get<Record<string, unknown>>('SELECT * FROM jarvis_actions WHERE id = ?', id)
  return row ? mapRow(row) : null
}

export async function cancelPending(db: Db, session: Session, id: string): Promise<boolean> {
  const n = await db.run("UPDATE jarvis_actions SET status = 'cancelled', decided_at = ? WHERE id = ? AND org_id = ? AND user_id = ? AND status = 'pending'", nowISO(), id, session.org.id, session.user.id)
  return n === 1
}

export async function finishAction(db: Db, id: string, patch: { status: JarvisAction['status']; version_after?: number | null; undo?: JarvisUndo | null; summary?: string }): Promise<void> {
  const fields: Record<string, unknown> = { status: patch.status }
  if (patch.version_after !== undefined) fields.version_after = patch.version_after
  if (patch.undo !== undefined) fields.undo = patch.undo ? JSON.stringify(patch.undo) : null
  if (patch.summary !== undefined) fields.summary = patch.summary
  await db.update('jarvis_actions', id, fields)
}

export async function getAction(db: Db, session: Session, id: string): Promise<JarvisAction | null> {
  const row = await db.get<Record<string, unknown>>('SELECT * FROM jarvis_actions WHERE id = ? AND org_id = ? AND user_id = ?', id, session.org.id, session.user.id)
  return row ? mapRow(row) : null
}

/**
 * Letzte rückgängig machbare Aktion dieses Nutzers (höchstens 2 Stunden alt). `sameConversation`
 * sagt, ob sie aus dem laufenden Gespräch stammt - sonst wird vor dem Rückgängigmachen nachgefragt.
 */
export async function latestUndoable(db: Db, session: Session, projectId: string | null, conversationId: string | null): Promise<{ action: JarvisAction; sameConversation: boolean } | null> {
  const since = new Date(Date.now() - 2 * 3600_000).toISOString()
  const where = ["org_id = ?", 'user_id = ?', "status = 'done'", 'undo IS NOT NULL', 'created_at > ?']
  const params: string[] = [session.org.id, session.user.id, since]
  if (projectId) {
    where.push('project_id = ?')
    params.push(projectId)
  }
  const pick = async (extra: string, extraParams: string[]) => {
    const row = await db.get<Record<string, unknown>>(`SELECT * FROM jarvis_actions WHERE ${[...where, extra].join(' AND ')} ORDER BY created_at DESC LIMIT 1`, ...params, ...extraParams)
    return row ? mapRow(row) : null
  }
  if (conversationId) {
    const own = await pick('conversation_id = ?', [conversationId])
    if (own) return { action: own, sameConversation: true }
  }
  const any = await pick('1 = 1', [])
  return any ? { action: any, sameConversation: false } : null
}

/**
 * Kette der letzten (bis zu `maxSteps`) rückgängig machbaren Planänderungen dieses Nutzers im
 * selben Projekt - vom neuesten Schritt an rückwärts, solange die Versionsnummern lückenlos
 * aufeinander folgen (sonst hat zwischendurch jemand anders gespeichert, dort bricht die Kette ab).
 * Ein „delete_project“-Schritt steht immer allein.
 */
export async function latestUndoableChain(db: Db, session: Session, projectId: string, maxSteps: number): Promise<JarvisAction[]> {
  const since = new Date(Date.now() - 2 * 3600_000).toISOString()
  const rows = await db.all<Record<string, unknown>>(
    "SELECT * FROM jarvis_actions WHERE org_id = ? AND user_id = ? AND project_id = ? AND status = 'done' AND undo IS NOT NULL AND created_at > ? ORDER BY created_at DESC LIMIT ?",
    session.org.id, session.user.id, projectId, since, Math.max(1, maxSteps) * 3,
  )
  const actions = rows.map(mapRow)
  const chain: JarvisAction[] = []
  for (const action of actions) {
    if (chain.length >= maxSteps) break
    if (!action.undo) break
    if (chain.length === 0) {
      chain.push(action)
      if (action.undo.kind === 'delete_project') break
      continue
    }
    const prev = chain[chain.length - 1]!
    if (action.undo.kind !== 'plan' || prev.undo!.kind !== 'plan') break
    if (action.version_after === null || prev.version_after === null || action.version_after + 1 !== prev.version_after) break
    chain.push(action)
  }
  return chain
}
