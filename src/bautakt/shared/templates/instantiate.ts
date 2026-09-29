/**
 * Vorlage → konkreter Plan (und zurück). Termine werden nicht in der Vorlage
 * gespeichert, sondern beim Anlegen durch die Engine aus Dauer + Abhängigkeiten
 * + Projektkalender berechnet.
 */

import type { ProjectSection, Task, TaskConstraint, TaskDependency, TemplateTask, Trade } from '../types.ts'
import type { PlanContext, PlanState } from '../engine/operations.ts'
import { normalizeOrder, recompute } from '../engine/operations.ts'
import { parseDeps, type BuiltinTemplate } from './builtin.ts'
import { newDependency, newTask } from '../engine/defaults.ts'

export interface GraftOptions {
  /** Bestehender Vorgang, unter den die neuen Wurzelvorgänge gehängt werden (null = oberste Ebene) */
  parent_id: string | null
  /** Neue Wurzelvorgänge direkt hinter diesem bestehenden Geschwister einfügen (null = ans Ende) */
  after_id: string | null
}

/**
 * Fügt einen fertig instanzierten Plan (Ergebnis von instantiateTemplate) an einer gewählten
 * Stelle in einen bestehenden Plan ein - statt ihn immer als neue Phase(n) ans Ende zu hängen.
 * `parent_id` gesetzt: der Zielvorgang bekommt die neuen Wurzelvorgänge als Kinder (wird damit
 * inhaltlich zur Phase - hatte er noch keine Kinder und war ein einfacher Vorgang, wird sein
 * `type` auf "phase" umgestellt; die Engine selbst behandelt jeden Knoten mit Kindern ohnehin
 * wie eine Phase, das ist nur für die Anzeige). `after_id` gesetzt: die neuen Wurzelvorgänge
 * kommen direkt hinter diesem Geschwister (gleiche Elternebene) zu stehen, sonst ans Ende.
 */
export function graftInstantiatedPlan(base: PlanState, ctx: PlanContext, added: { tasks: Task[]; dependencies: TaskDependency[] }, opts: GraftOptions): PlanState {
  const roots = added.tasks.filter((t) => !t.parent_id)
  const rootIds = new Set(roots.map((t) => t.id))
  const parentHasChildren = opts.parent_id ? base.tasks.some((t) => t.parent_id === opts.parent_id) : false

  const siblings = base.tasks.filter((t) => t.parent_id === opts.parent_id).sort((a, b) => a.sort_order - b.sort_order)
  let insertIndex = siblings.length
  if (opts.after_id) {
    const idx = siblings.findIndex((s) => s.id === opts.after_id)
    if (idx >= 0) insertIndex = idx + 1
  }

  const grafted = added.tasks.map((t) => (rootIds.has(t.id) ? { ...t, parent_id: opts.parent_id, sort_order: insertIndex + t.sort_order } : t))
  const shifted = base.tasks.map((t) => {
    if (t.parent_id === opts.parent_id && t.sort_order >= insertIndex) return { ...t, sort_order: t.sort_order + roots.length }
    // Erstes Kind eines bisherigen "task"-Vorgangs: der wird nun inhaltlich zur Phase
    if (opts.parent_id && t.id === opts.parent_id && !parentHasChildren && t.type === 'task') return { ...t, type: 'phase' as const }
    return t
  })

  const next = normalizeOrder({ tasks: [...shifted, ...grafted], dependencies: [...base.dependencies, ...added.dependencies] })
  return recompute(next, ctx).state
}

/**
 * Ordnet Geschwister-Vorgänge (gleicher parent_key) so um, dass ein Vorgänger immer vor seinem
 * Nachfolger steht - unabhängig davon, ob sich das später zeitlich auch so ergibt (Start/Ende
 * werden separat von der Engine berechnet und können durch Kalender/Parallelität abweichen; die
 * Anzeige im Terminplan soll trotzdem die logische Abfolge zeigen). Stabil: wo keine Abhängigkeit
 * etwas vorschreibt, bleibt die ursprüngliche Reihenfolge (z. B. der KI) erhalten. Abhängigkeiten
 * über Phasengrenzen hinweg wirken auf die Reihenfolge der obersten Ebene (Phase B nach Phase A).
 */
export function orderByDependencies(templateTasks: TemplateTask[]): TemplateTask[] {
  const byKey = new Map(templateTasks.map((t) => [t.key, t]))
  const topAncestorCache = new Map<string, string>()
  const topAncestor = (key: string): string => {
    const cached = topAncestorCache.get(key)
    if (cached) return cached
    const t = byKey.get(key)
    const top = !t?.parent_key || !byKey.has(t.parent_key) ? key : topAncestor(t.parent_key)
    topAncestorCache.set(key, top)
    return top
  }

  // Kanten je Geschwistergruppe (gleicher parent_key) und separat für die oberste Ebene sammeln.
  const edgesByParent = new Map<string | null, [string, string][]>()
  const addEdge = (parent: string | null, pred: string, succ: string) => {
    const arr = edgesByParent.get(parent) ?? []
    arr.push([pred, succ])
    edgesByParent.set(parent, arr)
  }
  for (const t of templateTasks) {
    for (const d of t.dependencies) {
      const pred = byKey.get(d.predecessor_key)
      if (!pred) continue
      if (pred.parent_key === t.parent_key) addEdge(t.parent_key, pred.key, t.key)
      else {
        const pa = topAncestor(pred.key)
        const sa = topAncestor(t.key)
        if (pa !== sa) addEdge(null, pa, sa)
      }
    }
  }

  /** Kahn-Algorithmus, stabil nach ursprünglichem Index; bei einem Zyklus wird er an der Stelle einfach durchbrochen. */
  const stableTopoOrder = (items: TemplateTask[], edges: [string, string][]): TemplateTask[] => {
    if (items.length <= 1) return items
    const index = new Map(items.map((t, i) => [t.key, i]))
    const indeg = new Map(items.map((t) => [t.key, 0]))
    const adj = new Map<string, string[]>()
    for (const [a, b] of edges) {
      if (!index.has(a) || !index.has(b) || a === b) continue
      const list = adj.get(a) ?? []
      list.push(b)
      adj.set(a, list)
      indeg.set(b, (indeg.get(b) ?? 0) + 1)
    }
    const remaining = new Set(items.map((t) => t.key))
    const out: TemplateTask[] = []
    while (remaining.size) {
      let best: string | null = null
      for (const k of remaining) {
        const ready = (indeg.get(k) ?? 0) === 0
        if (ready && (best === null || index.get(k)! < index.get(best)!)) best = k
      }
      if (best === null) for (const k of remaining) if (best === null || index.get(k)! < index.get(best)!) best = k
      remaining.delete(best!)
      out.push(byKey.get(best!)!)
      for (const nb of adj.get(best!) ?? []) indeg.set(nb, (indeg.get(nb) ?? 0) - 1)
    }
    return out
  }

  const childrenOf = new Map<string | null, TemplateTask[]>()
  for (const t of templateTasks) (childrenOf.get(t.parent_key) ?? childrenOf.set(t.parent_key, []).get(t.parent_key)!).push(t)

  const build = (parent: string | null): TemplateTask[] => {
    const siblings = stableTopoOrder(childrenOf.get(parent) ?? [], edgesByParent.get(parent) ?? [])
    const out: TemplateTask[] = []
    for (const s of siblings) {
      out.push(s)
      out.push(...build(s.key))
    }
    return out
  }
  return build(null).map((t, i) => ({ ...t, sort_order: i }))
}

export function builtinToTemplateTasks(tpl: BuiltinTemplate): TemplateTask[] {
  return tpl.rows.map((r, i) => ({
    id: `${tpl.id}_${r[0]}`,
    template_id: tpl.id,
    key: r[0],
    parent_key: r[1],
    name: r[2],
    type: r[3],
    duration: r[4],
    trade_name: r[5],
    section_name: r[7] ?? null,
    sort_order: i,
    dependencies: parseDeps(r[6]),
    constraints: r[8] ?? [],
  }))
}

export function instantiateTemplate(
  rawTemplateTasks: TemplateTask[],
  ctx: PlanContext,
  trades: Trade[],
  newId: () => string,
  sectionByName?: Map<string, string>,
): { tasks: Task[]; dependencies: TaskDependency[]; constraints: Omit<TaskConstraint, 'id' | 'created_at' | 'updated_at'>[] } {
  // Zeigt Abhängige im Terminplan von Anfang an nacheinander an (siehe orderByDependencies).
  const templateTasks = orderByDependencies(rawTemplateTasks)
  const idByKey = new Map<string, string>()
  for (const tt of templateTasks) idByKey.set(tt.key, newId())
  const tradeByName = new Map(trades.map((t) => [t.name.toLowerCase(), t.id]))
  const orderWithinParent = new Map<string | null, number>()
  const tasks: Task[] = templateTasks
    .slice()
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((tt) => {
      const so = orderWithinParent.get(tt.parent_key) ?? 0
      orderWithinParent.set(tt.parent_key, so + 1)
      return newTask({
        id: idByKey.get(tt.key)!,
        project_id: ctx.projectId,
        parent_id: tt.parent_key ? idByKey.get(tt.parent_key) ?? null : null,
        name: tt.name,
        type: tt.type,
        sort_order: so,
        start: ctx.projectStart,
        duration: tt.duration,
        trade_id: tt.trade_name ? tradeByName.get(tt.trade_name.toLowerCase()) ?? null : null,
        section_id: tt.section_name && sectionByName ? sectionByName.get(tt.section_name.toLowerCase()) ?? null : null,
        notes: tt.notes ?? '',
      })
    })
  const dependencies: TaskDependency[] = []
  for (const tt of templateTasks) {
    for (const d of tt.dependencies) {
      const p = idByKey.get(d.predecessor_key)
      const s = idByKey.get(tt.key)
      if (!p || !s) continue
      dependencies.push(newDependency({ id: newId(), project_id: ctx.projectId, predecessor_id: p, successor_id: s, type: d.type, lag_days: d.lag_days }))
    }
  }
  const constraints = templateTasks.flatMap((tt) => (tt.constraints ?? []).map((c) => ({ project_id: ctx.projectId, task_id: idByKey.get(tt.key)!, type: c.type, title: c.title, status: 'open' as const, due_date: null, responsible_user_id: null, note: '' })))
  return { ...recompute({ tasks, dependencies }, ctx).state, constraints }
}

/** Projektstruktur als Vorlage einfrieren (Termine/Fortschritt werden verworfen) */
export function planToTemplateTasks(templateId: string, tasks: Task[], dependencies: TaskDependency[], trades: Trade[], newId: () => string, sections?: ProjectSection[], constraints?: TaskConstraint[]): TemplateTask[] {
  const keyById = new Map<string, string>()
  tasks.forEach((t, i) => keyById.set(t.id, `t${i + 1}`))
  const tradeName = (id: string | null) => trades.find((t) => t.id === id)?.name ?? null
  const sorted = tasks.slice().sort((a, b) => a.sort_order - b.sort_order)
  // Reihenfolge: Eltern vor Kindern (Tiefensuche)
  const out: TemplateTask[] = []
  const walk = (pid: string | null) => {
    for (const t of sorted.filter((x) => x.parent_id === pid)) {
      out.push({
        id: newId(),
        template_id: templateId,
        key: keyById.get(t.id)!,
        parent_key: t.parent_id ? keyById.get(t.parent_id) ?? null : null,
        name: t.name,
        type: t.type,
        duration: t.duration,
        trade_name: tradeName(t.trade_id),
        section_name: sections?.find((s) => s.id === t.section_id)?.name ?? null,
        sort_order: out.length,
        constraints: (constraints ?? []).filter((c) => c.task_id === t.id).map((c) => ({ type: c.type, title: c.title })),
        dependencies: dependencies
          .filter((d) => d.successor_id === t.id && keyById.has(d.predecessor_id))
          .map((d) => ({ predecessor_key: keyById.get(d.predecessor_id)!, type: d.type, lag_days: d.lag_days })),
      })
      walk(t.id)
    }
  }
  walk(null)
  return out
}
