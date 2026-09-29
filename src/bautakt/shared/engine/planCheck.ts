/**
 * Regelbasierte Planprüfung (deterministisch, keine KI). Liefert Findings als
 * Empfehlungen - nie automatische Änderungen. Dieselbe Struktur wird später auch von
 * KI-Prüfungen (`list_findings`) verwendet.
 */

import type { ISODate, Task, TaskDependency, ResourceAssignment, Resource } from '../types.ts'
import { toDayNumber, formatDate, fromDayNumber } from './dates.ts'
import type { ScheduleResult } from './schedule.ts'
import { suggestDuration } from './defaults.ts'

export interface PlanFinding {
  id: string
  severity: 'info' | 'warning' | 'critical'
  rule: string
  taskId: string | null
  message: string
  recommendation: string
}

export function checkPlan(
  tasks: Task[],
  deps: TaskDependency[],
  sched: ScheduleResult,
  today: ISODate,
  extra: { resources?: Resource[]; assignments?: ResourceAssignment[] } = {},
): PlanFinding[] {
  const out: PlanFinding[] = []
  const todayDay = toDayNumber(today)
  const hasPred = new Set(deps.map((d) => d.successor_id))
  const hasSucc = new Set(deps.map((d) => d.predecessor_id))
  const parentOf = new Map(tasks.map((t) => [t.id, t.parent_id]))
  const inherits = (id: string, set: Set<string>) => {
    let p: string | null | undefined = id
    while (p) {
      if (set.has(p)) return true
      p = parentOf.get(p) ?? null
    }
    return false
  }
  const leaves = tasks.filter((t) => sched.tasks.get(t.id)?.isLeaf)
  const first = Math.min(...leaves.map((t) => sched.tasks.get(t.id)!.start))
  const last = Math.max(...leaves.map((t) => sched.tasks.get(t.id)!.end))
  let n = 0
  const push = (severity: PlanFinding['severity'], rule: string, taskId: string | null, message: string, recommendation: string) =>
    out.push({ id: `f${++n}`, severity, rule, taskId, message, recommendation })

  for (const t of leaves) {
    const s = sched.tasks.get(t.id)!
    if (!inherits(t.id, hasPred) && s.start > first && t.status === 'not_started') push('warning', 'no_predecessor', t.id, `„${t.name}“ hat keinen Vorgänger.`, 'Abhängigkeit ergänzen, sonst verschiebt sich der Vorgang bei Verzögerungen davor nicht mit.')
    if (!inherits(t.id, hasSucc) && s.end < last && t.type !== 'milestone' && t.status !== 'done') push('info', 'no_successor', t.id, `„${t.name}“ hat keinen Nachfolger.`, 'Prüfen, ob eine Folgearbeit fehlt – sonst wirkt eine Verzögerung hier nicht auf das Projektende.')
    if (s.hasConflict) push('critical', 'conflict', t.id, `„${t.name}“ beginnt vor dem Ende eines Vorgängers (Abhängigkeit verletzt).`, 'Automatische Planung wiederherstellen oder Termine anpassen.')
    if (t.scheduling_mode === 'manual' && t.status === 'not_started') push('info', 'manual', t.id, `„${t.name}“ ist manuell fixiert.`, 'Fixierte Termine folgen Verschiebungen davor nicht automatisch.')
    if (t.status !== 'done' && s.end < todayDay) push('warning', 'overdue', t.id, `„${t.name}“ ist überfällig (Ende ${formatDate(fromDayNumber(s.end))}).`, 'Status melden: erledigt, verzögert oder neue Prognose erfassen.')
    if (t.status === 'in_progress' && s.plannedProgress - t.progress > 25) push('warning', 'behind', t.id, `„${t.name}“ liegt hinter Plan (${t.progress} % statt ${s.plannedProgress} %).`, 'Restdauer prüfen und ggf. Prognose anpassen.')
    const sug = suggestDuration(t.quantity, t.productivity_rate, t.crew_size)
    if (sug && t.type !== 'milestone' && Math.abs(sug.suggested - t.duration) / Math.max(1, sug.suggested) > 0.3) {
      push('warning', 'duration_vs_quantity', t.id, `${t.duration} AT für „${t.name}“ erscheinen bei ${t.quantity} ${t.unit ?? ''} und ${t.productivity_rate} ${t.unit ?? ''}/AT unrealistisch (rechnerisch ${sug.suggested} AT).`, `Dauer auf ${sug.suggested} AT prüfen.`)
    }
    if (t.type === 'milestone' && s.isCritical && t.status !== 'done') push('info', 'critical_milestone', t.id, `Meilenstein „${t.name}“ liegt auf dem kritischen Pfad.`, 'Vorgelagerte Arbeiten eng begleiten.')
  }
  // Trocknungszeiten: FS-Beziehung von Estrich/Putz zu Folgearbeiten mit Lag < 5 AT
  for (const d of deps) {
    const p = tasks.find((t) => t.id === d.predecessor_id)
    const s = tasks.find((t) => t.id === d.successor_id)
    if (!p || !s) continue
    const dryingPred = /estrich einbringen|estrich$|innenputz|putz\b/i.test(p.name) && !/trocknung/i.test(p.name)
    const needsDry = /fliesen|boden|parkett|maler|belag/i.test(s.name)
    if (dryingPred && needsDry && d.type === 'FS' && d.lag_days < 5) {
      const viaDrying = deps.some((x) => x.successor_id === s.id && /trocknung/i.test(tasks.find((t) => t.id === x.predecessor_id)?.name ?? ''))
      if (!viaDrying) push('warning', 'drying_time', s.id, `Zwischen „${p.name}“ und „${s.name}“ ist keine Trocknungszeit hinterlegt (Lag ${d.lag_days} AT).`, 'Lag erhöhen oder Vorgang „Trocknung“ einfügen.')
    }
  }
  // Doppelt eingeplante Ressourcen innerhalb des Projekts
  if (extra.resources) {
    const byRes = new Map<string, { t: Task; start: number; end: number }[]>()
    for (const t of leaves) {
      if (t.status === 'done') continue
      const s = sched.tasks.get(t.id)!
      const ids = new Set<string>()
      if (t.resource_id) ids.add(t.resource_id)
      for (const a of extra.assignments ?? []) if (a.task_id === t.id) ids.add(a.resource_id)
      for (const id of ids) (byRes.get(id) ?? byRes.set(id, []).get(id)!).push({ t, start: s.start, end: s.end })
    }
    for (const [rid, list] of byRes) {
      const r = extra.resources.find((x) => x.id === rid)
      if (!r) continue
      list.sort((a, b) => a.start - b.start)
      for (let i = 1; i < list.length; i++) {
        if (list[i].start <= list[i - 1].end && r.capacity <= 1) {
          push('warning', 'resource_overlap', list[i].t.id, `„${r.name}“ ist gleichzeitig auf „${list[i - 1].t.name}“ und „${list[i].t.name}“ eingeplant.`, 'Vorgänge entzerren oder zweites Team zuweisen.')
        }
      }
    }
  }
  return out.sort((a, b) => rank(b.severity) - rank(a.severity))
}

function rank(s: PlanFinding['severity']) {
  return s === 'critical' ? 2 : s === 'warning' ? 1 : 0
}
