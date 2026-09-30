/**
 * Neutrales Zwischenformat für importierte Pläne (Lucidchart-Diagramm oder KI-Analyse
 * eines Dokuments). Wird über `extractedToTemplateTasks` in Vorlagen-Vorgänge übersetzt
 * und danach wie jede Vorlage instanziiert – die Terminrechnung bleibt unverändert.
 */

import type { OrganizationMember, Task, TaskDependency, TaskType, TemplateTask } from '../../types.ts'

export type ExtractedSource = 'lucidchart' | 'document'

export interface ExtractedDependency {
  /** Schlüssel des Vorgängers innerhalb desselben Plans */
  predecessor_key: string
  type?: 'FS' | 'SS' | 'FF' | 'SF'
  lag_days?: number
}

export interface ExtractedTask {
  key: string
  name: string
  type: TaskType
  parent_key?: string | null
  /** Dauer in Arbeitstagen (Meilenstein = 0) */
  duration?: number
  /** Verantwortliche Person als Freitext (Name oder E-Mail) */
  responsible?: string | null
  notes?: string
  depends_on?: ExtractedDependency[]
}

export interface ExtractedPlan {
  source: ExtractedSource
  name: string
  /** Quellreferenz (Lucidchart-Dokument-ID bzw. Dateiname) */
  reference?: string | null
  tasks: ExtractedTask[]
  warnings?: string[]
}

const TYPES: TaskType[] = ['phase', 'group', 'task', 'milestone']

/** Prüft und normalisiert einen (z. B. von der KI gelieferten) Plan. */
export function normalizeExtractedPlan(raw: unknown, fallback: Partial<ExtractedPlan> = {}): ExtractedPlan {
  const obj = (raw ?? {}) as Record<string, unknown>
  const rawTasks = Array.isArray(obj.tasks) ? (obj.tasks as Record<string, unknown>[]) : []
  const seen = new Set<string>()
  const tasks: ExtractedTask[] = []
  rawTasks.forEach((t, i) => {
    const name = String(t.name ?? '').trim()
    if (!name) return
    let key = String(t.key ?? `k${i + 1}`).trim() || `k${i + 1}`
    while (seen.has(key)) key = `${key}_`
    seen.add(key)
    const type = TYPES.includes(t.type as TaskType) ? (t.type as TaskType) : 'task'
    const duration = type === 'milestone' ? 0 : Math.max(1, Math.round(Number(t.duration ?? 1) || 1))
    const deps = Array.isArray(t.depends_on) ? (t.depends_on as unknown[]) : []
    tasks.push({
      key,
      name,
      type,
      parent_key: t.parent_key ? String(t.parent_key) : null,
      duration,
      responsible: t.responsible ? String(t.responsible) : null,
      notes: t.notes ? String(t.notes) : '',
      depends_on: deps
        .map((d) => (typeof d === 'string' ? { predecessor_key: d } : (d as ExtractedDependency)))
        .filter((d) => d && typeof d.predecessor_key === 'string')
        .map((d) => ({ predecessor_key: String(d.predecessor_key), type: d.type ?? 'FS', lag_days: Number(d.lag_days ?? 0) || 0 })),
    })
  })
  const keys = new Set(tasks.map((t) => t.key))
  for (const t of tasks) {
    if (t.parent_key && !keys.has(t.parent_key)) t.parent_key = null
    t.depends_on = (t.depends_on ?? []).filter((d) => keys.has(d.predecessor_key) && d.predecessor_key !== t.key)
  }
  return {
    source: (obj.source as ExtractedSource) ?? fallback.source ?? 'document',
    name: String(obj.name ?? fallback.name ?? 'Importierter Plan').trim() || 'Importierter Plan',
    reference: (obj.reference as string) ?? fallback.reference ?? null,
    tasks,
    warnings: Array.isArray(obj.warnings) ? (obj.warnings as string[]) : (fallback.warnings ?? []),
  }
}

/** Kehrt extractedToTemplateTasks sinngemäß um: den aktuellen Terminplan als Entwurf aufbereiten,
 *  damit die KI ihn insgesamt überarbeiten kann (Schlüssel = echte Vorgangs-ID). */
export function tasksToExtractedPlan(tasks: Task[], dependencies: TaskDependency[], members: OrganizationMember[], name: string): ExtractedPlan {
  const ids = new Set(tasks.map((t) => t.id))
  const userById = new Map(members.filter((m) => m.user).map((m) => [m.user_id, m.user!]))
  const depsBySuccessor = new Map<string, TaskDependency[]>()
  for (const d of dependencies) {
    if (!depsBySuccessor.has(d.successor_id)) depsBySuccessor.set(d.successor_id, [])
    depsBySuccessor.get(d.successor_id)!.push(d)
  }
  return {
    source: 'document',
    name,
    tasks: tasks.map((t) => ({
      key: t.id,
      name: t.name,
      type: t.type,
      parent_key: t.parent_id && ids.has(t.parent_id) ? t.parent_id : null,
      duration: t.type === 'milestone' ? 0 : t.duration,
      responsible: t.responsible_user_id ? (userById.get(t.responsible_user_id)?.email ?? (t.responsible_name || null)) : (t.responsible_name || null),
      notes: t.notes || '',
      depends_on: (depsBySuccessor.get(t.id) ?? [])
        .filter((d) => ids.has(d.predecessor_id))
        .map((d) => ({ predecessor_key: d.predecessor_id, type: d.type, lag_days: d.lag_days })),
    })),
  }
}

/** Importierten Plan in Vorlagen-Vorgänge übersetzen (Wurzel = eine Phase mit dem Plannamen). */
export function extractedToTemplateTasks(plan: ExtractedPlan, keyPrefix = 'im'): { tasks: TemplateTask[]; responsibleByKey: Map<string, string> } {
  const k = (key: string) => `${keyPrefix}_${key}`
  const rootKey = `${keyPrefix}_root`
  const tasks: TemplateTask[] = [
    {
      id: rootKey, template_id: keyPrefix, key: rootKey, parent_key: null, name: plan.name, type: 'phase',
      duration: 1, trade_name: null, section_name: null, sort_order: 0, dependencies: [], constraints: [],
      notes: plan.reference ? `Quelle: ${plan.reference}` : '',
    },
  ]
  const responsibleByKey = new Map<string, string>()
  plan.tasks.forEach((t, i) => {
    if (t.responsible) responsibleByKey.set(k(t.key), t.responsible)
    tasks.push({
      id: k(t.key), template_id: keyPrefix, key: k(t.key),
      parent_key: t.parent_key ? k(t.parent_key) : rootKey,
      name: t.name, type: t.type, duration: t.type === 'milestone' ? 0 : (t.duration ?? 1),
      trade_name: null, section_name: null, sort_order: i + 1,
      dependencies: (t.depends_on ?? []).map((d) => ({ predecessor_key: k(d.predecessor_key), type: d.type ?? 'FS', lag_days: d.lag_days ?? 0 })),
      constraints: [],
      notes: [t.notes, t.responsible ? `Verantwortlich: ${t.responsible}` : ''].filter(Boolean).join('\n'),
    })
  })
  return { tasks, responsibleByKey }
}
