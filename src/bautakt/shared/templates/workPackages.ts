/**
 * Arbeitspakete: Teilstrukturen (Bad komplett, Rohbau Geschoss, …) mit Abhängigkeiten und
 * Voraussetzungen, die in ein bestehendes Projekt eingefügt werden. Die Terminierung
 * übernimmt die Engine ab dem gewünschten Starttermin.
 */

import type { ISODate, Task, TaskConstraint, TaskDependency, Trade, WorkPackageTask } from '../types.ts'
import type { PlanContext, PlanState } from '../engine/operations.ts'
import { normalizeOrder, recompute } from '../engine/operations.ts'
import { newDependency, newTask } from '../engine/defaults.ts'
import { parseDeps } from './builtin.ts'
import { BUILTIN_WORK_PACKAGES } from './dhh.ts'

export function builtinToWorkPackageTasks(id: string): WorkPackageTask[] {
  const wp = BUILTIN_WORK_PACKAGES.find((w) => w.id === id)
  if (!wp) return []
  return wp.rows.map((r, i) => ({
    id: `${wp.id}_${r[0]}`,
    package_id: wp.id,
    key: r[0],
    parent_key: r[1],
    name: r[2],
    type: r[3],
    duration: r[4],
    trade_name: r[5],
    sort_order: i,
    dependencies: parseDeps(r[6]),
    constraints: r[8] ?? [],
  }))
}

export interface InsertOptions {
  /** Elternknoten im Projekt (null = oberste Ebene) */
  parent_id: string | null
  /** Einfügen nach diesem Geschwister (null = ans Ende) */
  after_id: string | null
  /** Frühester Start des Pakets (SNET auf die Startvorgänge); leer = Projektstart */
  start_date?: ISODate | null
  section_id?: string | null
  /** Optional: Vorgänger im Projekt, an den die Startvorgänge des Pakets FS angehängt werden */
  predecessor_id?: string | null
  /** Umbenennung des Paket-Wurzelknotens (z. B. „Bad OG“) */
  root_name?: string
}

export function insertWorkPackage(
  state: PlanState,
  ctx: PlanContext,
  pkgTasks: WorkPackageTask[],
  opts: InsertOptions,
  trades: Trade[],
  newId: () => string,
): { state: PlanState; insertedIds: string[]; constraints: Omit<TaskConstraint, 'id' | 'created_at' | 'updated_at'>[] } {
  const idByKey = new Map<string, string>()
  for (const t of pkgTasks) idByKey.set(t.key, newId())
  const tradeByName = new Map(trades.map((t) => [t.name.toLowerCase(), t.id]))
  const rootKeys = pkgTasks.filter((t) => !t.parent_key).map((t) => t.key)
  const hasPredInPkg = new Set(pkgTasks.filter((t) => t.dependencies.length).map((t) => t.key))

  const siblings = state.tasks.filter((t) => t.parent_id === opts.parent_id).sort((a, b) => a.sort_order - b.sort_order)
  let insertIndex = siblings.length
  if (opts.after_id) {
    const idx = siblings.findIndex((s) => s.id === opts.after_id)
    if (idx >= 0) insertIndex = idx + 1
  }
  const order = new Map<string | null, number>()
  const created: Task[] = pkgTasks
    .slice()
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((tt) => {
      const so = order.get(tt.parent_key) ?? 0
      order.set(tt.parent_key, so + 1)
      const isRoot = !tt.parent_key
      const startLeaf = !hasPredInPkg.has(tt.key) && tt.type !== 'group' && tt.type !== 'phase'
      return newTask({
        id: idByKey.get(tt.key)!,
        project_id: ctx.projectId,
        parent_id: isRoot ? opts.parent_id : idByKey.get(tt.parent_key!) ?? opts.parent_id,
        name: isRoot && opts.root_name ? opts.root_name : tt.name,
        type: tt.type,
        sort_order: isRoot ? insertIndex + so : so,
        start: opts.start_date ?? ctx.projectStart,
        duration: tt.duration,
        trade_id: tt.trade_name ? tradeByName.get(tt.trade_name.toLowerCase()) ?? null : null,
        section_id: opts.section_id ?? null,
        constraint_type: opts.start_date && startLeaf && !opts.predecessor_id ? 'snet' : 'asap',
        constraint_date: opts.start_date && startLeaf && !opts.predecessor_id ? opts.start_date : null,
      })
    })
  const deps: TaskDependency[] = []
  for (const tt of pkgTasks) {
    for (const d of tt.dependencies) {
      const p = idByKey.get(d.predecessor_key)
      if (!p) continue
      deps.push(newDependency({ id: newId(), project_id: ctx.projectId, predecessor_id: p, successor_id: idByKey.get(tt.key)!, type: d.type, lag_days: d.lag_days }))
    }
  }
  if (opts.predecessor_id) {
    // Startvorgänge (ohne paketinterne Vorgänger) hängen FS am gewählten Projektvorgang
    for (const tt of pkgTasks) {
      if (hasPredInPkg.has(tt.key) || tt.type === 'group' || tt.type === 'phase') continue
      deps.push(newDependency({ id: newId(), project_id: ctx.projectId, predecessor_id: opts.predecessor_id, successor_id: idByKey.get(tt.key)! }))
    }
  }
  const constraints = pkgTasks.flatMap((tt) => tt.constraints.map((c) => ({ project_id: ctx.projectId, task_id: idByKey.get(tt.key)!, type: c.type, title: c.title, status: 'open' as const, due_date: null, responsible_user_id: null, note: '' })))

  // Geschwister hinter der Einfügeposition nach hinten schieben
  const shifted = state.tasks.map((t) => (t.parent_id === opts.parent_id && t.sort_order >= insertIndex ? { ...t, sort_order: t.sort_order + rootKeys.length } : t))
  const next = normalizeOrder({ tasks: [...shifted, ...created], dependencies: [...state.dependencies, ...deps] })
  return { state: recompute(next, ctx).state, insertedIds: created.map((t) => t.id), constraints }
}
