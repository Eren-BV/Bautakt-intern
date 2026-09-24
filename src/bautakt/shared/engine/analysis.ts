/**
 * Auswertungen auf Basis des berechneten Plans: Projektstatus (Ampel), Soll-Ist,
 * kritische Ereignisse, Lookahead, Ressourcenkonflikte. Wird vom Dashboard,
 * den Berichten und der Benachrichtigungs-Erzeugung genutzt.
 */

import type {
  Baseline,
  BaselineTask,
  CriticalEvent,
  HealthStatus,
  ISODate,
  Project,
  ProjectBundle,
  Resource,
  ResourceAssignment,
  Task,
  Trade,
} from '../types.ts'
import { fromDayNumber, isoWeek, startOfWeek, toDayNumber, todayISO, formatDate } from './dates.ts'
import { computeSchedule, type ScheduleResult } from './schedule.ts'

export interface ProjectAnalysis {
  health: HealthStatus
  progress: number
  planned_end: ISODate
  baseline_end: ISODate | null
  forecast_end: ISODate
  variance_days: number
  next_milestone: { id: string; name: string; date: ISODate } | null
  critical_count: number
  delayed_count: number
  overdue_count: number
  task_count: number
  done_count: number
  current: ScheduleResult
  forecast: ScheduleResult
  activeBaseline: Baseline | null
  baselineTasks: Map<string, BaselineTask>
}

export function analyzeProject(bundle: ProjectBundle, today: ISODate = todayISO()): ProjectAnalysis {
  const input = {
    projectId: bundle.project.id,
    projectStart: bundle.project.start_date,
    projectCalendarId: bundle.project.calendar_id,
    tasks: bundle.tasks,
    dependencies: bundle.dependencies,
    calendars: bundle.calendars,
    exceptions: bundle.exceptions,
    holidayRegion: bundle.project.holiday_region,
    resources: bundle.resources,
  }
  const current = computeSchedule(input, { today })
  const forecast = computeSchedule(input, { today, forecast: true })
  const activeBaseline = bundle.baselines.find((b) => b.is_active) ?? null
  const baselineTasks = new Map<string, BaselineTask>()
  if (activeBaseline) for (const bt of bundle.baseline_tasks) if (bt.baseline_id === activeBaseline.id) baselineTasks.set(bt.task_id, bt)

  const leaves = bundle.tasks.filter((t) => current.tasks.get(t.id)?.isLeaf)
  const todayDay = toDayNumber(today)
  const cal = current.calendar

  // Fortschritt: dauer-gewichtet über Blätter
  let weight = 0
  let doneWeight = 0
  for (const t of leaves) {
    const s = current.tasks.get(t.id)!
    const w = Math.max(1, s.duration)
    weight += w
    doneWeight += (w * (t.status === 'done' ? 100 : t.progress)) / 100
  }
  const progress = weight ? Math.round((doneWeight / weight) * 100) : 0

  const planned_end = fromDayNumber(current.projectEnd)
  const forecast_end = fromDayNumber(forecast.projectEnd)
  const baseline_end = activeBaseline?.project_end ?? null
  const reference = baseline_end ?? bundle.project.target_end_date
  const variance_days = cal.countWorkdays(Math.min(toDayNumber(reference), forecast.projectEnd), Math.max(toDayNumber(reference), forecast.projectEnd)) - 1
  const signedVariance = forecast.projectEnd >= toDayNumber(reference) ? Math.max(0, variance_days) : -Math.max(0, variance_days)

  const milestones = bundle.tasks
    .filter((t) => t.type === 'milestone' && t.status !== 'done')
    .map((t) => ({ id: t.id, name: t.name, date: fromDayNumber(current.tasks.get(t.id)!.start) }))
    .sort((a, b) => a.date.localeCompare(b.date))
  const next_milestone = milestones.find((m) => m.date >= today) ?? milestones[0] ?? null

  const critical_count = leaves.filter((t) => current.tasks.get(t.id)!.isCritical).length
  const delayed_count = leaves.filter((t) => t.status === 'delayed').length
  const overdue_count = leaves.filter((t) => t.status !== 'done' && current.tasks.get(t.id)!.end < todayDay).length
  const atRisk = leaves.filter((t) => t.status === 'blocked' || (t.status === 'in_progress' && current.tasks.get(t.id)!.plannedProgress - t.progress > 25))
  const overdueCritical = leaves.some((t) => t.status !== 'done' && current.tasks.get(t.id)!.isCritical && current.tasks.get(t.id)!.end < todayDay)

  let health: HealthStatus
  if (bundle.project.state === 'paused') health = 'grey'
  else if (bundle.project.state === 'completed') health = 'green'
  else if (signedVariance > 0 || delayed_count > 0 || overdueCritical) health = 'red'
  else if (overdue_count > 0 || atRisk.length > 0) health = 'yellow'
  else health = 'green'

  return {
    health,
    progress,
    planned_end,
    baseline_end,
    forecast_end,
    variance_days: signedVariance,
    next_milestone,
    critical_count,
    delayed_count,
    overdue_count,
    task_count: leaves.length,
    done_count: leaves.filter((t) => t.status === 'done').length,
    current,
    forecast,
    activeBaseline,
    baselineTasks,
  }
}

/** Soll-Ist je Vorgang gegen aktive Baseline (in Kalendertagen, Ende zu Ende) */
export function baselineVariance(task: Task, sched: ScheduleResult, baselineTasks: Map<string, BaselineTask>): number | null {
  const bt = baselineTasks.get(task.id)
  const s = sched.tasks.get(task.id)
  if (!bt || !s) return null
  return s.end - toDayNumber(bt.end_date)
}

export function criticalEvents(project: Project, bundle: ProjectBundle, analysis: ProjectAnalysis, today: ISODate = todayISO()): CriticalEvent[] {
  const out: CriticalEvent[] = []
  const todayDay = toDayNumber(today)
  const cal = analysis.current.calendar
  for (const t of bundle.tasks) {
    const s = analysis.current.tasks.get(t.id)
    if (!s || !s.isLeaf) continue
    if (t.status === 'done') continue
    if (t.type === 'milestone') {
      const diff = s.start - todayDay
      if (diff >= 0 && diff <= 10) {
        out.push({ project_id: project.id, project_name: project.name, task_id: t.id, severity: 'info', message: `${t.name} in ${diff === 0 ? 'heute' : `${diff} Tagen`} (${formatDate(fromDayNumber(s.start))}).`, date: fromDayNumber(s.start) })
      } else if (diff < 0) {
        out.push({ project_id: project.id, project_name: project.name, task_id: t.id, severity: 'critical', message: `Meilenstein ${t.name} ist ${-diff} Tage überfällig.`, date: fromDayNumber(s.start) })
      }
      continue
    }
    if (t.status === 'delayed') {
      const bt = analysis.baselineTasks.get(t.id)
      const days = bt ? cal.countWorkdays(toDayNumber(bt.end_date), s.end) - 1 : null
      out.push({
        project_id: project.id,
        project_name: project.name,
        task_id: t.id,
        severity: 'critical',
        message: days && days > 0 ? `${t.name} ${days} Tage verspätet.` : `${t.name} als verzögert gemeldet.`,
        date: fromDayNumber(s.end),
      })
    } else if (s.end < todayDay) {
      out.push({ project_id: project.id, project_name: project.name, task_id: t.id, severity: 'warning', message: `${t.name} ist überfällig (Ende ${formatDate(fromDayNumber(s.end))}).`, date: fromDayNumber(s.end) })
    } else if (t.status === 'blocked') {
      out.push({ project_id: project.id, project_name: project.name, task_id: t.id, severity: 'warning', message: `${t.name} ist blockiert.`, date: fromDayNumber(s.start) })
    } else if (t.status === 'in_progress' && s.plannedProgress - t.progress > 25) {
      out.push({ project_id: project.id, project_name: project.name, task_id: t.id, severity: 'warning', message: `${t.name} liegt hinter Plan (${t.progress} % statt ${s.plannedProgress} %).`, date: today })
    }
  }
  if (analysis.variance_days > 0) {
    out.unshift({ project_id: project.id, project_name: project.name, task_id: null, severity: 'critical', message: `Fertigstellung ${project.name} verschiebt sich um ${analysis.variance_days} Arbeitstage auf ${formatDate(analysis.forecast_end)}.`, date: analysis.forecast_end })
  }
  return out
}

// ---------------------------------------------------------------- Lookahead

export interface LookaheadItem {
  task: Task
  start: ISODate
  end: ISODate
  isCritical: boolean
  plannedProgress: number
  week: { year: number; week: number; monday: ISODate }
}

export function lookahead(tasks: Task[], sched: ScheduleResult, fromDate: ISODate, weeks: number): LookaheadItem[] {
  const from = toDayNumber(startOfWeek(fromDate))
  const to = from + weeks * 7 - 1
  const out: LookaheadItem[] = []
  for (const t of tasks) {
    const s = sched.tasks.get(t.id)
    if (!s || !s.isLeaf || t.status === 'done') continue
    if (s.end < from || s.start > to) continue
    // Ein Vorgang erscheint in jeder Woche, in der er läuft
    let weekStart = toDayNumber(startOfWeek(fromDayNumber(Math.max(s.start, from))))
    while (weekStart <= Math.min(s.end, to)) {
      const monday = fromDayNumber(weekStart)
      const w = isoWeek(monday)
      out.push({ task: t, start: fromDayNumber(s.start), end: fromDayNumber(s.end), isCritical: s.isCritical, plannedProgress: s.plannedProgress, week: { ...w, monday } })
      weekStart += 7
    }
  }
  return out.sort((a, b) => a.week.monday.localeCompare(b.week.monday) || a.start.localeCompare(b.start))
}

/** Vorgänge, die an einem Stichtag laufen (Baustellen-Ansicht "HEUTE") */
export function tasksOnDate(tasks: Task[], sched: ScheduleResult, date: ISODate): Task[] {
  const d = toDayNumber(date)
  return tasks
    .filter((t) => {
      const s = sched.tasks.get(t.id)
      if (!s || !s.isLeaf) return false
      if (t.status === 'done') return false
      return s.start <= d && s.end >= d || (s.end < d) // laufend oder überfällig
    })
    .sort((a, b) => (sched.tasks.get(a.id)!.start - sched.tasks.get(b.id)!.start))
}

// ---------------------------------------------------------------- Ressourcen

export interface ResourceConflict {
  resource: Resource
  week: { year: number; week: number; monday: ISODate }
  projects: { project_id: string; project_name: string; tasks: string[] }[]
  load: number
}

/**
 * Findet Wochen, in denen eine Ressource (Team/Person/Gerät) gleichzeitig auf mehreren
 * Projekten oder über Kapazität eingeplant ist.
 */
export function resourceConflicts(
  resources: Resource[],
  bundles: { project: Project; tasks: Task[]; sched: ScheduleResult; assignments: ResourceAssignment[] }[],
): ResourceConflict[] {
  const out: ResourceConflict[] = []
  for (const r of resources) {
    const perWeek = new Map<string, { monday: ISODate; projects: Map<string, { name: string; tasks: string[] }>; load: number }>()
    for (const b of bundles) {
      for (const t of b.tasks) {
        const s = b.sched.tasks.get(t.id)
        if (!s || !s.isLeaf || t.status === 'done') continue
        const direct = t.resource_id === r.id
        const assigned = b.assignments.filter((a) => a.task_id === t.id && a.resource_id === r.id)
        if (!direct && !assigned.length) continue
        const units = assigned.reduce((sum, a) => sum + a.units, 0) || 1
        let ws = toDayNumber(startOfWeek(fromDayNumber(s.start)))
        while (ws <= s.end) {
          const monday = fromDayNumber(ws)
          const entry = perWeek.get(monday) ?? { monday, projects: new Map(), load: 0 }
          const p = entry.projects.get(b.project.id) ?? { name: b.project.name, tasks: [] }
          p.tasks.push(t.name)
          entry.projects.set(b.project.id, p)
          entry.load += units
          perWeek.set(monday, entry)
          ws += 7
        }
      }
    }
    for (const e of perWeek.values()) {
      if (e.projects.size > 1 || e.load > Math.max(1, r.capacity)) {
        out.push({
          resource: r,
          week: { ...isoWeek(e.monday), monday: e.monday },
          projects: [...e.projects.entries()].map(([project_id, p]) => ({ project_id, project_name: p.name, tasks: p.tasks })),
          load: e.load,
        })
      }
    }
  }
  return out.sort((a, b) => a.week.monday.localeCompare(b.week.monday))
}

export function tradeName(trades: Trade[], id: string | null): string {
  return trades.find((t) => t.id === id)?.name ?? '–'
}
