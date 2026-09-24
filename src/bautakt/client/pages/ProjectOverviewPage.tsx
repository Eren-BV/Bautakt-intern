/**
 * Projektübersicht: "Wo steht mein Projekt?" in wenigen Sekunden - Ampel, Soll-Ist,
 * heute/diese Woche/als Nächstes, Phasenfortschritt, Probleme, Meilensteine.
 */

import { useEffect, useMemo, useState } from 'react'
import { api } from '../lib/api'
import type { ChangeHistoryEntry, ChangeProposal } from '../../shared/types'
import { buildCalendar } from '../../shared/engine/calendar'
import { formatDateTime } from '../../shared/engine/dates'
import { AlertTriangle, ArrowRight, Flag, Inbox, History } from 'lucide-react'
import { useProject } from '../store/project'
import { useOrg } from '../store/org'
import { Link, navigate } from '../lib/router'
import { ProjectHeader } from '../components/ProjectHeader'
import { Badge, Button, Card, Delta, ErrorBox, KpiTile, ProgressBar, Spinner, StatusBadge } from '../components/ui'
import { criticalEvents, lookahead, tasksOnDate } from '../../shared/engine/analysis'
import { formatDate, fromDayNumber, toDayNumber, addDays, startOfWeek } from '../../shared/engine/dates'
import { HEALTH_LABELS } from '../../shared/labels'

export function ProjectOverviewPage() {
  const p = useProject()
  const org = useOrg()
  const a = p.analysis
  const b = p.bundle
  const [history, setHistory] = useState<ChangeHistoryEntry[]>([])
  const [proposals, setProposals] = useState<ChangeProposal[]>([])
  useEffect(() => {
    api.projects.history(p.projectId).then((h) => setHistory(h.history.slice(0, 8))).catch(() => {})
    api.proposals.list(p.projectId).then((l) => setProposals(l.filter((x) => x.status === 'open'))).catch(() => {})
  }, [p.projectId, b?.project.version])
  // Verfügbarer Projektpuffer: Arbeitstage zwischen Prognose und Zieltermin (negativ = Zieltermin gerissen)
  const projectBuffer = useMemo(() => {
    if (!a || !b) return 0
    const cal = buildCalendar(null, [])
    const f = toDayNumber(a.forecast_end), t = toDayNumber(b.project.target_end_date)
    const d = cal.countWorkdays(Math.min(f, t), Math.max(f, t)) - 1
    return f <= t ? Math.max(0, d) : -Math.max(0, d)
  }, [a, b])

  const data = useMemo(() => {
    if (!a || !b) return null
    const sched = a.current
    const todayTasks = tasksOnDate(p.plan.tasks, sched, p.today)
    const weekEnd = addDays(startOfWeek(p.today), 6)
    const weekTasks = p.plan.tasks.filter((t) => {
      const s = sched.tasks.get(t.id)
      return s && s.isLeaf && t.status !== 'done' && s.start <= toDayNumber(weekEnd) && s.end >= toDayNumber(startOfWeek(p.today))
    })
    const next = lookahead(p.plan.tasks, sched, addDays(weekEnd, 1), 2).filter((x, i, arr) => arr.findIndex((y) => y.task.id === x.task.id) === i).slice(0, 6)
    const phases = p.plan.tasks.filter((t) => t.type === 'phase' && !t.parent_id).sort((x, y) => x.sort_order - y.sort_order)
    const milestones = p.plan.tasks.filter((t) => t.type === 'milestone').map((t) => ({ t, s: sched.tasks.get(t.id)! })).sort((x, y) => x.s.start - y.s.start)
    const events = criticalEvents(b.project, { ...b, tasks: p.plan.tasks, dependencies: p.plan.dependencies }, a, p.today)
    const critical = p.plan.tasks.filter((t) => sched.tasks.get(t.id)?.isCritical && sched.tasks.get(t.id)?.isLeaf && t.status !== 'done').slice(0, 8)
    return { todayTasks, weekTasks, next, phases, milestones, events, critical, sched }
  }, [a, b, p.plan, p.today])

  if (p.loading && !b) return <Spinner />
  if (p.error) return <div className="p-6"><ErrorBox message={p.error} onRetry={p.reload} /></div>
  if (!a || !b || !data) return null
  const { sched } = data

  return (
    <div>
      <ProjectHeader actions={<Button variant="primary" onClick={() => navigate(`/projects/${p.projectId}/gantt`)}>Bauzeitenplan öffnen <ArrowRight size={15} /></Button>} />
      <div className="mx-auto max-w-[1440px] space-y-6 p-4 sm:p-6">
        {proposals.length > 0 && (
          <button type="button" onClick={() => navigate(`/projects/${p.projectId}/proposals`)} className="flex w-full items-center gap-3 rounded-xl border border-warn/40 bg-warn-soft px-4 py-3 text-left text-sm hover:bg-warn-soft/70">
            <Inbox size={18} className="text-warn" /><span><b>{proposals.length} Terminvorschlag{proposals.length > 1 ? 'e' : ''}</b> von Nachunternehmern wartet auf Ihre Entscheidung.</span><ArrowRight size={15} className="ml-auto text-warn" />
          </button>
        )}
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          <KpiTile label="Projektstatus" value={HEALTH_LABELS[a.health]} tone={a.health === 'red' ? 'danger' : a.health === 'yellow' ? 'warn' : a.health === 'green' ? 'ok' : 'neutral'} />
          <KpiTile label="Fortschritt" value={`${a.progress} %`} hint={`${a.done_count} von ${a.task_count} Vorgängen erledigt`} />
          <KpiTile label={a.baseline_end ? 'Ursprüngliche Fertigstellung' : 'Zieltermin'} value={formatDate(a.baseline_end ?? b.project.target_end_date)} hint={a.activeBaseline ? a.activeBaseline.name : 'keine Baseline'} />
          <KpiTile label="Aktuelle Prognose" value={formatDate(a.forecast_end)} hint={<span>Abweichung <Delta days={a.variance_days} suffix=" AT" /></span>} tone={a.variance_days > 0 ? 'danger' : 'ok'} />
          <KpiTile label="Verfügbarer Projektpuffer" value={`${projectBuffer > 0 ? '+' : ''}${projectBuffer} AT`} hint={`bis Zieltermin ${formatDate(b.project.target_end_date)}`} tone={projectBuffer < 0 ? 'danger' : projectBuffer <= 3 ? 'warn' : 'ok'} />
          <KpiTile label="Kritische Vorgänge" value={a.critical_count} hint="terminentscheidend" onClick={() => navigate(`/projects/${p.projectId}/gantt`)} />
        </div>

        <div className="grid gap-6 xl:grid-cols-3">
          <Card title="Heute" padded={false}>
            <TaskList tasks={data.todayTasks} sched={sched} empty="Heute laufen keine Vorgänge." org={org} />
          </Card>
          <Card title="Diese Woche" padded={false}>
            <TaskList tasks={data.weekTasks} sched={sched} empty="Diese Woche stehen keine Vorgänge an." org={org} />
          </Card>
          <Card title="Als Nächstes (2 Wochen)" padded={false} actions={<Link href={`/projects/${p.projectId}/lookahead`} className="text-xs text-brand hover:underline">Lookahead</Link>}>
            <TaskList tasks={data.next.map((n) => n.task)} sched={sched} empty="Keine weiteren Vorgänge in den nächsten zwei Wochen." org={org} />
          </Card>
        </div>

        <div className="grid gap-6 xl:grid-cols-[1fr_380px]">
          <Card title="Bauphasen" padded={false}>
            <table className="data-table w-full text-sm">
              <thead><tr><th>Phase</th><th>Zeitraum</th><th className="w-48">Fortschritt</th><th>Status</th></tr></thead>
              <tbody>
                {data.phases.map((ph) => {
                  const s = sched.tasks.get(ph.id)!
                  const leaves = p.plan.tasks.filter((t) => t.parent_id === ph.id)
                  const prog = leaves.length ? Math.round(leaves.reduce((sum, t) => sum + (t.status === 'done' ? 100 : t.progress), 0) / leaves.length) : 0
                  const state = leaves.every((t) => t.status === 'done') ? 'Abgeschlossen' : s.start > toDayNumber(p.today) ? 'Geplant' : 'Läuft'
                  return (
                    <tr key={ph.id} className="cursor-pointer hover:bg-surface-2" onClick={() => navigate(`/projects/${p.projectId}/gantt?task=${ph.id}`)}>
                      <td className="font-medium">{ph.name}{s.isCritical && <Badge tone="danger" className="ml-2">kritisch</Badge>}</td>
                      <td className="whitespace-nowrap text-ink-soft">{formatDate(fromDayNumber(s.start), 'short')} – {formatDate(fromDayNumber(s.end), 'short')}{fromDayNumber(s.end).slice(2, 4)}</td>
                      <td><div className="flex items-center gap-2"><ProgressBar value={prog} className="flex-1" /><span className="w-8 text-right text-xs">{prog} %</span></div></td>
                      <td><Badge tone={state === 'Abgeschlossen' ? 'ok' : state === 'Läuft' ? 'brand' : 'neutral'}>{state}</Badge></td>
                    </tr>
                  )
                })}
                {data.phases.length === 0 && <tr><td colSpan={4} className="py-6 text-center text-ink-faint">Noch keine Bauphasen angelegt.</td></tr>}
              </tbody>
            </table>
          </Card>
          <div className="space-y-6">
            <Card title="Probleme & Auswirkungen" padded={false}>
              {data.events.length === 0 ? <div className="px-4 py-6 text-center text-sm text-ink-faint">Keine Probleme erkannt.</div> : (
                <ul className="divide-y divide-line">
                  {data.events.slice(0, 6).map((e, i) => (
                    <li key={i} className="flex items-start gap-2.5 px-4 py-2.5">
                      <AlertTriangle size={15} className={e.severity === 'critical' ? 'mt-0.5 shrink-0 text-danger' : e.severity === 'warning' ? 'mt-0.5 shrink-0 text-warn' : 'mt-0.5 shrink-0 text-brand'} />
                      <button type="button" className="text-left text-sm hover:underline" onClick={() => navigate(`/projects/${p.projectId}/gantt${e.task_id ? `?task=${e.task_id}` : ''}`)}>{e.message}</button>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Card title="Letzte Änderungen" padded={false} actions={<Link href={`/projects/${p.projectId}/history`} className="text-xs text-brand hover:underline">Historie</Link>}>
              {history.length === 0 ? <div className="px-4 py-4 text-sm text-ink-faint">Keine Änderungen.</div> : (
                <ul className="divide-y divide-line">
                  {history.map((h) => <li key={h.id} className="flex items-start gap-2.5 px-4 py-2 text-xs"><History size={13} className="mt-0.5 shrink-0 text-ink-faint" /><div className="min-w-0"><div className="truncate"><b>{h.task_name || 'Projekt'}</b> · {h.field}{h.new_value ? `: ${h.new_value}` : ''}</div><div className="text-ink-faint">{formatDateTime(h.created_at)} · {h.user_name}{h.reason ? ` · ${h.reason}` : ''}</div></div></li>)}
                </ul>
              )}
            </Card>
            <Card title="Meilensteine" padded={false} actions={<Link href={`/projects/${p.projectId}/milestones`} className="text-xs text-brand hover:underline">Alle</Link>}>
              <ul className="divide-y divide-line">
                {data.milestones.slice(0, 8).map(({ t, s }) => {
                  const bl = a.baselineTasks.get(t.id)
                  return (
                    <li key={t.id} className="flex items-center gap-2.5 px-4 py-2">
                      <Flag size={14} className={t.status === 'done' ? 'text-ok' : s.isCritical ? 'text-danger' : 'text-milestone'} />
                      <span className="min-w-0 flex-1 truncate text-sm">{t.name}</span>
                      <span className="text-xs text-ink-soft">{formatDate(fromDayNumber(s.start))}</span>
                      {bl && <Delta days={s.start - toDayNumber(bl.start_date)} suffix="" />}
                    </li>
                  )
                })}
              </ul>
            </Card>
          </div>
        </div>
      </div>
    </div>
  )
}

function TaskList({ tasks, sched, empty, org }: { tasks: import('../../shared/types').Task[]; sched: import('../../shared/engine/schedule').ScheduleResult; empty: string; org: ReturnType<typeof useOrg> }) {
  const p = useProject()
  if (tasks.length === 0) return <div className="px-4 py-6 text-center text-sm text-ink-faint">{empty}</div>
  return (
    <ul className="divide-y divide-line">
      {tasks.slice(0, 8).map((t) => {
        const s = sched.tasks.get(t.id)!
        return (
          <li key={t.id}>
            <button type="button" onClick={() => navigate(`/projects/${p.projectId}/gantt?task=${t.id}`)} className="flex w-full items-center gap-2.5 px-4 py-2 text-left hover:bg-surface-2">
              <span className="h-6 w-1 shrink-0 rounded-full" style={{ background: org.tradeColor(t.trade_id) }} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{t.name}</div>
                <div className="truncate text-xs text-ink-faint">{org.tradeName(t.trade_id)}{t.company_id ? ` · ${org.companyName(t.company_id)}` : ''} · {formatDate(fromDayNumber(s.start), 'short')}–{formatDate(fromDayNumber(s.end), 'short')}</div>
              </div>
              <StatusBadge status={t.status} />
            </button>
          </li>
        )
      })}
    </ul>
  )
}
