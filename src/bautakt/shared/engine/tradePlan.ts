/**
 * Intelligenter Kategorieplan: analysiert den Abhängigkeitsgraphen für eine Kategorie (oder eine
 * Firma) - nicht nur „alle Vorgänge mit trade_id“. Ergebnis: VOR DIR / DEINE ARBEIT /
 * NACH DIR / MEILENSTEINE in drei Relevanzstufen.
 *
 *   compact   direkte Vorgänger · eigene Arbeiten · direkte Nachfolger
 *   standard  Vorleistungen bis 2 Stufen · eigene Arbeiten · Folgearbeiten bis 2 Stufen ·
 *             kritische Beziehungen markiert · Meilensteine
 *   full      vollständige relevante Abhängigkeitskette in beide Richtungen
 */

import type { ShareRelevance, Task, TaskDependency } from '../types.ts'
import type { ScheduleResult } from './schedule.ts'

export interface TradePlanTask {
  task: Task
  start: number
  end: number
  isCritical: boolean
  /** Abstand im Graph zu den eigenen Arbeiten (0 = eigene) */
  distance: number
  /** Beziehung zur nächsten eigenen Arbeit, als Text („vor: Fliesen (FS+2)“) */
  relation: string
  isDriving: boolean
}

export interface TradePlan {
  scopeLabel: string
  own: TradePlanTask[]
  before: TradePlanTask[]
  after: TradePlanTask[]
  milestones: TradePlanTask[]
  criticalRelated: TradePlanTask[]
  firstStart: number | null
  lastEnd: number | null
  progress: number
}

export function buildTradePlan(
  tasks: Task[],
  deps: TaskDependency[],
  sched: ScheduleResult,
  scope: { tradeId?: string | null; companyId?: string | null },
  relevance: ShareRelevance = 'standard',
  scopeLabel = '',
): TradePlan {
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const isOwn = (t: Task) => (scope.companyId ? t.company_id === scope.companyId : scope.tradeId ? t.trade_id === scope.tradeId : false)
  const leaf = (id: string) => sched.tasks.get(id)?.isLeaf
  const own = tasks.filter((t) => leaf(t.id) && isOwn(t))
  const ownIds = new Set(own.map((t) => t.id))

  // Kanten auf Blattebene: Abhängigkeiten auf Sammelvorgänge werden auf deren Blätter aufgelöst
  const children = new Map<string, string[]>()
  for (const t of tasks) if (t.parent_id) (children.get(t.parent_id) ?? children.set(t.parent_id, []).get(t.parent_id)!).push(t.id)
  const leaves = (id: string): string[] => {
    const ch = children.get(id)
    return ch?.length ? ch.flatMap(leaves) : [id]
  }
  const preds = new Map<string, { id: string; dep: TaskDependency }[]>()
  const succs = new Map<string, { id: string; dep: TaskDependency }[]>()
  for (const d of deps) {
    if (!byId.has(d.predecessor_id) || !byId.has(d.successor_id)) continue
    for (const pl of leaves(d.predecessor_id)) {
      for (const sl of leaves(d.successor_id)) {
        ;(preds.get(sl) ?? preds.set(sl, []).get(sl)!).push({ id: pl, dep: d })
        ;(succs.get(pl) ?? succs.set(pl, []).get(pl)!).push({ id: sl, dep: d })
      }
    }
  }

  const maxDepth = relevance === 'compact' ? 1 : relevance === 'standard' ? 2 : 999
  const relText = (d: TaskDependency) => `${d.type}${d.lag_days ? (d.lag_days > 0 ? '+' : '') + d.lag_days : ''}`

  const walk = (dir: 'before' | 'after', depthLimit = maxDepth): TradePlanTask[] => {
    const adj = dir === 'before' ? preds : succs
    const found = new Map<string, TradePlanTask>()
    const queue: { id: string; depth: number; via: string; dep: TaskDependency }[] = []
    for (const o of own) for (const n of adj.get(o.id) ?? []) if (!ownIds.has(n.id)) queue.push({ id: n.id, depth: 1, via: o.name, dep: n.dep })
    while (queue.length) {
      const cur = queue.shift()!
      if (found.has(cur.id) || ownIds.has(cur.id)) continue
      const t = byId.get(cur.id)
      const s = sched.tasks.get(cur.id)
      if (!t || !s) continue
      const isDriving = sched.drivingDependencyIds.has(cur.dep.id)
      if (cur.depth > depthLimit) continue
      found.set(cur.id, {
        task: t,
        start: s.start,
        end: s.end,
        isCritical: s.isCritical,
        distance: cur.depth,
        relation: dir === 'before' ? `vor „${cur.via}“ (${relText(cur.dep)})` : `nach „${cur.via}“ (${relText(cur.dep)})`,
        isDriving,
      })
      for (const n of adj.get(cur.id) ?? []) if (!found.has(n.id)) queue.push({ id: n.id, depth: cur.depth + 1, via: t.name, dep: n.dep })
    }
    return [...found.values()].sort((a, b) => a.start - b.start)
  }

  const before = walk('before').filter((x) => x.task.type !== 'milestone')
  const afterAll = walk('after')
  const after = afterAll.filter((x) => x.task.type !== 'milestone')
  // Meilensteine, die von eigenen Arbeiten abhängen - unabhängig von der Relevanzstufe
  const milestoneIds = new Set(walk('after', 999).filter((x) => x.task.type === 'milestone').map((x) => x.task.id))
  const milestones = tasks
    .filter((t) => t.type === 'milestone' && (milestoneIds.has(t.id) || isOwn(t)))
    .map((t) => ({ task: t, start: sched.tasks.get(t.id)!.start, end: sched.tasks.get(t.id)!.end, isCritical: !!sched.tasks.get(t.id)?.isCritical, distance: 0, relation: '', isDriving: false }))
    .sort((a, b) => a.start - b.start)

  const ownPlan = own
    .map((t) => ({ task: t, start: sched.tasks.get(t.id)!.start, end: sched.tasks.get(t.id)!.end, isCritical: !!sched.tasks.get(t.id)?.isCritical, distance: 0, relation: '', isDriving: false }))
    .sort((a, b) => a.start - b.start)
  const criticalRelated = [...before, ...after].filter((x) => x.isCritical)
  const weight = ownPlan.reduce((s, x) => s + Math.max(1, x.end - x.start + 1), 0)
  const done = ownPlan.reduce((s, x) => s + (Math.max(1, x.end - x.start + 1) * (x.task.status === 'done' ? 100 : x.task.progress)) / 100, 0)

  return {
    scopeLabel,
    own: ownPlan,
    before,
    after,
    milestones,
    criticalRelated,
    firstStart: ownPlan.length ? Math.min(...ownPlan.map((x) => x.start)) : null,
    lastEnd: ownPlan.length ? Math.max(...ownPlan.map((x) => x.end)) : null,
    progress: weight ? Math.round((done / weight) * 100) : 0,
  }
}
