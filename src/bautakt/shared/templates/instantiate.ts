/**
 * Vorlage → konkreter Plan (und zurück). Termine werden nicht in der Vorlage
 * gespeichert, sondern beim Anlegen durch die Engine aus Dauer + Abhängigkeiten
 * + Projektkalender berechnet.
 */

import type { ProjectSection, Task, TaskConstraint, TaskDependency, TemplateTask, Trade } from '../types.ts'
import type { PlanContext } from '../engine/operations.ts'
import { recompute } from '../engine/operations.ts'
import { parseDeps, type BuiltinTemplate } from './builtin.ts'
import { newDependency, newTask } from '../engine/defaults.ts'

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
  templateTasks: TemplateTask[],
  ctx: PlanContext,
  trades: Trade[],
  newId: () => string,
  sectionByName?: Map<string, string>,
): { tasks: Task[]; dependencies: TaskDependency[]; constraints: Omit<TaskConstraint, 'id' | 'created_at' | 'updated_at'>[] } {
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
