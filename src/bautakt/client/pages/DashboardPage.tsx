/**
 * Unternehmensdashboard: Kennzahlen, Projektampel, kritische Ereignisse, kommende
 * Meilensteine. Alle Zahlen kommen vorberechnet vom Server (shared engine).
 */

import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Flag, Plus, Inbox, Rows3 } from 'lucide-react'
import type { ChangeProposal } from '../../shared/types'
import { api } from '../lib/api'
import * as jarvisBus from '../jarvis/bus'
import { Link, navigate } from '../lib/router'
import { Badge, Button, Card, Delta, EmptyState, ErrorBox, HealthBadge, HealthDot, KpiTile, PageHeader, ProgressBar, Spinner } from '../components/ui'
import type { CriticalEvent, ProjectSummary } from '../../shared/types'
import { formatDate, diffDays, todayISO } from '../../shared/engine/dates'
import { useAuth } from '../store/auth'

export function DashboardPage() {
  const { can } = useAuth()
  const [data, setData] = useState<{ summaries: ProjectSummary[]; events: CriticalEvent[] } | null>(null)
  const [proposals, setProposals] = useState<(ChangeProposal & { project_name: string; task_name: string })[]>([])
  const [error, setError] = useState<string | null>(null)
  const load = () => Promise.all([api.projects.list().then(setData), api.proposals.open().then(setProposals).catch(() => {})]).catch((e) => setError(e.message))
  useEffect(() => {
    void load()
    // Jarvis hat ein Projekt angelegt oder entfernt → Liste sofort aktualisieren
    return jarvisBus.on('data-changed', (e) => {
      if (e.scope === 'projects') void load()
    })
  }, [])

  const kpi = useMemo(() => {
    const s = data?.summaries ?? []
    const active = s.filter((p) => p.project.state === 'active')
    return {
      active: active.length,
      green: active.filter((p) => p.health === 'green').length,
      yellow: active.filter((p) => p.health === 'yellow').length,
      red: active.filter((p) => p.health === 'red').length,
      milestones: active.filter((p) => p.next_milestone && diffDays(todayISO(), p.next_milestone.date) <= 14 && diffDays(todayISO(), p.next_milestone.date) >= 0).length,
      critical: active.reduce((n, p) => n + p.critical_count, 0),
    }
  }, [data])

  const upcoming = useMemo(() => {
    const out: { project: ProjectSummary; name: string; date: string; id: string }[] = []
    for (const p of data?.summaries ?? []) {
      if (p.project.state !== 'active' || !p.next_milestone) continue
      out.push({ project: p, name: p.next_milestone.name, date: p.next_milestone.date, id: p.next_milestone.id })
    }
    return out.sort((a, b) => a.date.localeCompare(b.date)).slice(0, 8)
  }, [data])

  if (error) return <div className="p-6"><ErrorBox message={error} onRetry={load} /></div>
  if (!data) return <Spinner />

  const sorted = [...data.summaries].sort((a, b) => rank(b) - rank(a) || a.project.name.localeCompare(b.project.name))

  return (
    <div className="mx-auto max-w-[1440px] p-4 sm:p-6">
      <PageHeader
        title="Übersicht"
        subtitle={`Stand ${formatDate(todayISO(), 'long')} · ${kpi.active} aktive Projekte`}
        actions={<><Button onClick={() => navigate('/portfolio')}><Rows3 size={15} /> Portfolio-Timeline</Button>{can('project.create') && <Button variant="primary" onClick={() => navigate('/projects/new')}><Plus size={16} /> Neues Projekt</Button>}</>}
      />

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <KpiTile label="Aktive Projekte" value={kpi.active} onClick={() => navigate('/projects')} />
        <KpiTile label="Im Plan" value={kpi.green} tone="ok" />
        <KpiTile label="Gefährdet" value={kpi.yellow} tone={kpi.yellow ? 'warn' : 'neutral'} />
        <KpiTile label="Verspätet" value={kpi.red} tone={kpi.red ? 'danger' : 'neutral'} />
        <KpiTile label="Meilensteine (14 Tage)" value={kpi.milestones} tone="brand" onClick={() => navigate('/milestones')} />
        <KpiTile label="Kritische Vorgänge" value={kpi.critical} hint="auf dem kritischen Pfad" />
      </div>

      <div className="mt-6 grid gap-6 xl:grid-cols-[1fr_360px]">
        <Card title="Projektübersicht" padded={false} actions={<Link href="/portfolio" className="text-xs text-brand hover:underline">Portfolio-Timeline</Link>}>
          {sorted.length === 0 ? (
            <div className="p-4">
              <EmptyState title="Noch keine Projekte" description="Legen Sie Ihr erstes Bauprojekt an – mit Vorlage in unter einer Minute." action={can('project.create') && <Button variant="primary" onClick={() => navigate('/projects/new')}>Projekt anlegen</Button>} />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table w-full min-w-[900px] text-sm">
                <thead>
                  <tr>
                    <th>Projekt</th>
                    <th>Bauleiter</th>
                    <th>Start</th>
                    <th>Geplant</th>
                    <th>Prognose</th>
                    <th>Abw.</th>
                    <th className="w-36">Fortschritt</th>
                    <th>Nächster Meilenstein</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((p) => (
                    <tr key={p.project.id} className="cursor-pointer hover:bg-surface-2" onClick={() => navigate(`/projects/${p.project.id}`)}>
                      <td>
                        <div className="flex items-center gap-2">
                          <HealthDot health={p.health} />
                          <div>
                            <div className="font-medium text-ink">{p.project.name}</div>
                            <div className="text-xs text-ink-faint">{p.project.city || p.project.address} · {p.project.number}</div>
                          </div>
                        </div>
                      </td>
                      <td className="text-ink-soft">{p.site_manager_name || '–'}</td>
                      <td className="whitespace-nowrap">{formatDate(p.project.start_date)}</td>
                      <td className="whitespace-nowrap">{formatDate(p.baseline_end ?? p.project.target_end_date)}</td>
                      <td className="whitespace-nowrap">{formatDate(p.forecast_end)}</td>
                      <td><Delta days={p.variance_days} /></td>
                      <td>
                        <div className="flex items-center gap-2">
                          <ProgressBar value={p.progress} className="flex-1" tone={p.health === 'red' ? 'danger' : 'brand'} />
                          <span className="w-9 text-right text-xs text-ink-soft">{p.progress} %</span>
                        </div>
                      </td>
                      <td className="text-xs">
                        {p.next_milestone ? (
                          <span><span className="font-medium text-ink">{p.next_milestone.name}</span> <span className="text-ink-faint">{formatDate(p.next_milestone.date)}</span></span>
                        ) : (
                          <span className="text-ink-faint">–</span>
                        )}
                      </td>
                      <td><HealthBadge health={p.health} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <div className="space-y-6">
          <Card title="Was braucht Aufmerksamkeit?" padded={false}>
            {proposals.length > 0 && (
              <ul className="divide-y divide-line border-b border-line bg-warn-soft/40">
                {proposals.slice(0, 4).map((pr) => (
                  <li key={pr.id}><button type="button" onClick={() => navigate(`/projects/${pr.project_id}/proposals`)} className="flex w-full items-start gap-2.5 px-4 py-2.5 text-left hover:bg-warn-soft"><Inbox size={15} className="mt-0.5 text-warn" /><div className="min-w-0"><div className="text-sm text-ink">Terminvorschlag: {pr.task_name} – {pr.submitted_by_name}{pr.proposed_start ? ` (ab ${formatDate(pr.proposed_start)})` : ''}</div><div className="text-xs text-ink-faint">{pr.project_name} · Entscheidung offen</div></div></button></li>
                ))}
              </ul>
            )}
            {data.events.length === 0 && proposals.length === 0 ? (
              <div className="px-4 py-6 text-center text-sm text-ink-faint">Nichts Dringendes – alle Projekte im Plan.</div>
            ) : (
              <ul className="divide-y divide-line">
                {data.events.slice(0, 8).map((e, i) => (
                  <li key={i}>
                    <button type="button" onClick={() => navigate(`/projects/${e.project_id}${e.task_id ? `/gantt?task=${e.task_id}` : ''}`)} className="flex w-full items-start gap-2.5 px-4 py-2.5 text-left hover:bg-surface-2">
                      <AlertTriangle size={15} className={e.severity === 'critical' ? 'mt-0.5 text-danger' : e.severity === 'warning' ? 'mt-0.5 text-warn' : 'mt-0.5 text-brand'} />
                      <div className="min-w-0">
                        <div className="text-sm text-ink">{e.message}</div>
                        <div className="text-xs text-ink-faint">{e.project_name}</div>
                      </div>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <Card title="Kommende Meilensteine" padded={false} actions={<Link href="/milestones" className="text-xs text-brand hover:underline">Alle</Link>}>
            {upcoming.length === 0 ? (
              <div className="px-4 py-6 text-center text-sm text-ink-faint">Keine anstehenden Meilensteine.</div>
            ) : (
              <ul className="divide-y divide-line">
                {upcoming.map((m) => {
                  const d = diffDays(todayISO(), m.date)
                  return (
                    <li key={m.id}>
                      <button type="button" onClick={() => navigate(`/projects/${m.project.project.id}/milestones`)} className="flex w-full items-center gap-2.5 px-4 py-2.5 text-left hover:bg-surface-2">
                        <Flag size={15} className="text-milestone" />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium text-ink">{m.name}</div>
                          <div className="truncate text-xs text-ink-faint">{m.project.project.name}</div>
                        </div>
                        <div className="text-right">
                          <div className="text-xs text-ink">{formatDate(m.date)}</div>
                          <Badge tone={d < 0 ? 'danger' : d <= 7 ? 'warn' : 'neutral'}>{d < 0 ? `${-d} T überfällig` : d === 0 ? 'heute' : `in ${d} T`}</Badge>
                        </div>
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </div>
  )
}

function rank(p: ProjectSummary): number {
  if (p.project.state !== 'active') return 0
  return p.health === 'red' ? 3 : p.health === 'yellow' ? 2 : 1
}
