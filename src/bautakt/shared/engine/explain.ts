/**
 * „Warum dieser Termin?“ - deterministische Erklärung aus den Plandaten in drei Tiefen:
 *   Level 1  eine Aussage            „Fliesen beginnen am 28. Mai.“
 *   Level 2  Erklärung in Sätzen     „Estrich endet am 18.05. Danach sind 7 Arbeitstage
 *                                    Trocknungszeit hinterlegt. Deshalb kann …“
 *   Level 3  Profiwerte              ES/EF/LS/LF/TF/FF, treibender Vorgänger, Beziehungstyp
 * Keine KI nötig - alles folgt aus Vorgängern, Lag, Kalender, Einschränkungen und Puffer.
 */

import type { ISODate, Task, TaskDependency } from '../types.ts'
import { formatDate, fromDayNumber } from './dates.ts'
import type { ScheduleResult, ScheduledTask } from './schedule.ts'

export interface ExplanationDriver {
  dependencyId: string
  predecessorId: string
  predecessorName: string
  type: TaskDependency['type']
  lag: number
  predecessorStart: ISODate
  predecessorEnd: ISODate
  isDriving: boolean
  sentence: string
}

export interface TaskExplanation {
  taskId: string
  name: string
  /** Level 1 */
  headline: string
  /** Level 2 */
  sentences: string[]
  drivers: ExplanationDriver[]
  constraintSentence: string | null
  earliestStart: ISODate
  latestStart: ISODate
  latestFinish: ISODate
  floatDays: number
  freeFloatDays: number
  isCritical: boolean
  floatSentence: string
  successors: { id: string; name: string; type: TaskDependency['type']; lag: number; isCritical: boolean }[]
  affectedSentence: string
  /** Level 3 */
  pro: {
    es: ISODate
    ef: ISODate
    ls: ISODate
    lf: ISODate
    tf: number
    ff: number
    drivingPredecessor: string | null
    drivingType: string | null
    calendar: string
    startDriver: ScheduledTask['startDriver']
  }
}

const TYPE_TEXT: Record<TaskDependency['type'], (pred: string, lag: number) => string> = {
  FS: (p, lag) => (lag > 0 ? `Danach sind ${lag} Arbeitstage Wartezeit hinterlegt.` : lag < 0 ? `Der Vorgang darf ${-lag} Arbeitstage vor dem Ende von „${p}“ beginnen (Überlappung).` : `Der Vorgang beginnt, sobald „${p}“ fertig ist.`),
  SS: (p, lag) => (lag > 0 ? `Der Vorgang beginnt ${lag} Arbeitstage nach dem Start von „${p}“.` : `Der Vorgang beginnt zusammen mit „${p}“.`),
  FF: (p, lag) => (lag > 0 ? `Der Vorgang endet ${lag} Arbeitstage nach „${p}“.` : `Der Vorgang endet zusammen mit „${p}“.`),
  SF: (p) => `Der Vorgang endet, wenn „${p}“ beginnt.`,
}

export function explainTask(taskId: string, tasks: Task[], deps: TaskDependency[], sched: ScheduleResult): TaskExplanation | null {
  const task = tasks.find((t) => t.id === taskId)
  const s = sched.tasks.get(taskId)
  if (!task || !s) return null
  const byId = new Map(tasks.map((t) => [t.id, t]))
  const isMs = task.type === 'milestone'
  const start = fromDayNumber(s.start)
  const end = fromDayNumber(s.end)

  // ---- Vorgänger
  const drivers: ExplanationDriver[] = deps
    .filter((d) => d.successor_id === taskId && byId.has(d.predecessor_id))
    .map((d) => {
      const p = byId.get(d.predecessor_id)!
      const ps = sched.tasks.get(p.id)!
      const isDriving = sched.drivingDependencyIds.has(d.id)
      const endTxt = p.type === 'milestone' ? `„${p.name}“ liegt am ${formatDate(fromDayNumber(ps.start))}.` : d.type === 'SS' || d.type === 'SF' ? `„${p.name}“ beginnt am ${formatDate(fromDayNumber(ps.start))}.` : `„${p.name}“ endet am ${formatDate(fromDayNumber(ps.end))}.`
      return {
        dependencyId: d.id,
        predecessorId: p.id,
        predecessorName: p.name,
        type: d.type,
        lag: d.lag_days,
        predecessorStart: fromDayNumber(ps.start),
        predecessorEnd: fromDayNumber(ps.end),
        isDriving,
        sentence: `${endTxt} ${TYPE_TEXT[d.type](p.name, d.lag_days)}`,
      }
    })
    .sort((a, b) => Number(b.isDriving) - Number(a.isDriving))

  const sentences: string[] = []
  const driving = drivers.find((d) => d.isDriving)
  if (s.startDriver === 'actual') sentences.push(`Der Vorgang wurde am ${formatDate(task.actual_start!)} tatsächlich begonnen – dieser Ist-Start ist fest.`)
  else if (s.startDriver === 'manual') sentences.push('Der Termin ist manuell fixiert und folgt nicht automatisch den Vorgängern.')
  if (driving) {
    sentences.push(driving.sentence)
    sentences.push(`Deshalb ${isMs ? 'liegt' : 'kann'} „${task.name}“ ${isMs ? 'am' : 'frühestens am'} ${formatDate(start)}${isMs ? '' : ' beginnen'}.`)
  } else if (s.startDriver === 'constraint') {
    sentences.push(`Für den Vorgang ist „nicht früher als ${formatDate(task.constraint_date!)}“ hinterlegt – das bestimmt den Start.`)
  } else if (s.startDriver === 'project_start' && drivers.length === 0) {
    sentences.push('Der Vorgang hat keine Vorgänger und beginnt mit dem Projektstart.')
  } else if (s.startDriver === 'project_start') {
    sentences.push('Alle Vorgänger sind früh genug fertig – der Vorgang beginnt zum frühestmöglichen Termin.')
  }
  const others = drivers.filter((d) => !d.isDriving)
  if (others.length) sentences.push(`Weitere Voraussetzung${others.length > 1 ? 'en' : ''}: ${others.map((d) => `„${d.predecessorName}“`).join(', ')} – ${others.length > 1 ? 'diese sind' : 'diese ist'} rechtzeitig fertig.`)
  if (s.hasConflict) sentences.push('Achtung: Ein Vorgänger endet nach dem geplanten Start – die Abhängigkeit ist verletzt.')

  let constraintSentence: string | null = null
  if (task.constraint_type === 'snet' && task.constraint_date) constraintSentence = `Nicht früher als ${formatDate(task.constraint_date)}`
  if (task.constraint_type === 'mso' && task.constraint_date) constraintSentence = `Muss beginnen am ${formatDate(task.constraint_date)}`
  if (task.constraint_type === 'fnlt' && task.constraint_date) constraintSentence = `Muss spätestens am ${formatDate(task.constraint_date)} enden`

  // ---- Nachfolger
  const successors = deps
    .filter((d) => d.predecessor_id === taskId && byId.has(d.successor_id))
    .map((d) => {
      const n = byId.get(d.successor_id)!
      return { id: n.id, name: n.name, type: d.type, lag: d.lag_days, isCritical: !!sched.tasks.get(n.id)?.isCritical }
    })

  const floatSentence = task.status === 'done'
    ? 'Der Vorgang ist erledigt.'
    : s.isCritical
      ? 'Terminentscheidend: Jede Verzögerung verschiebt das Projektende.'
      : `Spielraum: ${s.totalFloat} Arbeitstag${s.totalFloat === 1 ? '' : 'e'} – der Vorgang darf bis ${formatDate(fromDayNumber(s.ls))} beginnen, ohne das Projektende zu verschieben.`
  const affectedSentence = successors.length === 0
    ? 'Danach hängt kein weiterer Vorgang direkt an diesem Termin.'
    : `Danach betroffen: ${successors.slice(0, 4).map((x) => `„${x.name}“`).join(', ')}${successors.length > 4 ? ` und ${successors.length - 4} weitere` : ''}.`

  const headline = isMs
    ? `„${task.name}“ liegt am ${formatDate(start, 'long')}.`
    : `„${task.name}“ beginnt am ${formatDate(start, 'long')} und endet am ${formatDate(end, 'long')} (${s.duration} AT).`

  return {
    taskId,
    name: task.name,
    headline,
    sentences,
    drivers,
    constraintSentence,
    earliestStart: fromDayNumber(s.es),
    latestStart: fromDayNumber(s.ls),
    latestFinish: fromDayNumber(s.lf),
    floatDays: s.totalFloat,
    freeFloatDays: s.freeFloat,
    isCritical: s.isCritical,
    floatSentence,
    successors,
    affectedSentence,
    pro: {
      es: fromDayNumber(s.es),
      ef: fromDayNumber(s.ef),
      ls: fromDayNumber(s.ls),
      lf: fromDayNumber(s.lf),
      tf: s.totalFloat,
      ff: s.freeFloat,
      drivingPredecessor: driving?.predecessorName ?? null,
      drivingType: driving ? `${driving.type}${driving.lag ? (driving.lag > 0 ? '+' : '') + driving.lag + ' AT' : ''}` : null,
      calendar: s.calendar.name,
      startDriver: s.startDriver,
    },
  }
}

/** Kurzform für Listen: „Terminentscheidend“ oder „3 AT Spielraum“ */
export function floatLabel(s: ScheduledTask, status: Task['status']): string {
  if (status === 'done') return 'erledigt'
  if (s.isCritical) return 'terminentscheidend'
  return `${s.totalFloat} AT Spielraum`
}
