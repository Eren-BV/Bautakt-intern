/** Vollständige Datensätze mit Standardwerten - einzige Stelle, die alle Task-Felder kennt. */

import type { DependencyType, ISODate, Task, TaskDependency, TaskType } from '../types.ts'

export function newTask(input: { id: string; project_id: string; name: string; type?: TaskType; parent_id?: string | null; start?: ISODate; duration?: number } & Partial<Task>): Task {
  const { id, project_id, name, type = 'task', parent_id = null, start = '2026-01-01', duration, ...rest } = input
  return {
    id,
    project_id,
    parent_id,
    name,
    description: '',
    type,
    sort_order: 0,
    start_date: start,
    end_date: start,
    duration: type === 'milestone' ? 0 : Math.max(1, duration ?? 5),
    progress: 0,
    status: 'not_started',
    trade_id: null,
    responsible_user_id: null,
    responsible_user_ids: [],
    responsible_name: '',
    company_id: null,
    resource_id: null,
    actual_start: null,
    actual_finish: null,
    remaining_duration: null,
    constraint_type: 'asap',
    constraint_date: null,
    scheduling_mode: 'auto',
    calendar_id: null,
    is_critical: false,
    total_float: 0,
    free_float: 0,
    early_start: null,
    early_finish: null,
    late_start: null,
    late_finish: null,
    has_conflict: false,
    notes: '',
    section_id: null,
    start_time: null,
    end_time: null,
    duration_hours: null,
    quantity: null,
    unit: null,
    productivity_rate: null,
    crew_size: null,
    actual_duration: null,
    source_excerpt: null,
    ...rest,
  }
}

export function newDependency(input: { id: string; project_id: string; predecessor_id: string; successor_id: string; type?: DependencyType; lag_days?: number } & Partial<TaskDependency>): TaskDependency {
  return { lag_unit: 'workdays', is_driving: false, type: 'FS', lag_days: 0, ...input }
}

/**
 * Dauervorschlag aus Menge und Leistungswert: Menge ÷ (Leistungswert × Teams), aufgerundet.
 * Beispiel: 1.040 m² Innenputz bei 110 m²/AT und 1 Team → 9,45 → 10 AT.
 */
export function suggestDuration(quantity: number | null, productivityRate: number | null, crewSize: number | null): { exact: number; suggested: number } | null {
  if (!quantity || !productivityRate || productivityRate <= 0) return null
  const crews = crewSize && crewSize > 0 ? crewSize : 1
  const exact = quantity / (productivityRate * crews)
  return { exact: Math.round(exact * 100) / 100, suggested: Math.max(1, Math.ceil(exact - 0.05)) }
}
