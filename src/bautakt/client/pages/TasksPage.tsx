/**
 * Vorgangsliste: flache, filterbare Tabelle aller Vorgänge mit Soll-Ist und
 * Schnellbearbeitung von Status/Fortschritt.
 */

import { useMemo, useState } from 'react'
import { Search, Download } from 'lucide-react'
import { useProject } from '../store/project'
import { useOrg } from '../store/org'
import { navigate } from '../lib/router'
import { ProjectHeader } from '../components/ProjectHeader'
import { Badge, Button, Card, Delta, Input, Select, Spinner, Tabs } from '../components/ui'
import { formatDate, fromDayNumber, toDayNumber } from '../../shared/engine/dates'
import { TASK_STATUS_LABELS } from '../../shared/labels'
import type { TaskStatus } from '../../shared/types'
import { flattenTree } from '../../shared/engine/operations'
import { downloadCsv } from '../lib/export'

export function TasksPage() {
  const p = useProject()
  const org = useOrg()
  const [q, setQ] = useState('')
  const [status, setStatus] = useState<TaskStatus | ''>('')
  const [trade, setTrade] = useState('')
  const [scope, setScope] = useState<'open' | 'all' | 'critical' | 'late'>('open')

  const rows = useMemo(() => {
    if (!p.analysis) return []
    const sched = p.analysis.current
    const todayDay = toDayNumber(p.today)
    const flat = flattenTree(p.plan.tasks)
    const s = q.trim().toLowerCase()
    return flat
      .filter((f) => !f.hasChildren)
      .map((f) => ({ ...f, s: sched.tasks.get(f.task.id)!, bl: p.analysis!.baselineTasks.get(f.task.id), phase: p.plan.tasks.find((x) => x.id === f.task.parent_id)?.name ?? '' }))
      .filter((r) => !s || r.task.name.toLowerCase().includes(s) || r.phase.toLowerCase().includes(s))
      .filter((r) => !status || r.task.status === status)
      .filter((r) => !trade || r.task.trade_id === trade)
      .filter((r) => {
        if (scope === 'open') return r.task.status !== 'done'
        if (scope === 'critical') return r.s.isCritical && r.task.status !== 'done'
        if (scope === 'late') return r.task.status === 'delayed' || (r.task.status !== 'done' && r.s.end < todayDay)
        return true
      })
  }, [p.analysis, p.plan.tasks, p.today, q, status, trade, scope])

  if (!p.bundle || !p.analysis) return <Spinner />

  const exportCsv = () =>
    downloadCsv(`vorgaenge-${p.bundle!.project.number || p.projectId}.csv`, ['Phase', 'Vorgang', 'Kategorie', 'Firma', 'Verantwortlich', 'Dauer', 'Start', 'Ende', 'Fortschritt', 'Soll', 'Status', 'Kritisch', 'Puffer', 'Baseline Ende', 'Abweichung'],
      rows.map((r) => [r.phase, r.task.name, org.tradeName(r.task.trade_id), org.companyName(r.task.company_id), org.userName(r.task.responsible_user_id), String(r.task.duration), formatDate(r.task.start_date), formatDate(r.task.end_date), String(r.task.progress), String(r.s.plannedProgress), TASK_STATUS_LABELS[r.task.status], r.s.isCritical ? 'ja' : '', String(r.s.totalFloat), r.bl ? formatDate(r.bl.end_date) : '', r.bl ? String(r.s.end - toDayNumber(r.bl.end_date)) : '']))

  return (
    <div>
      <ProjectHeader title="Vorgänge" />
      <div className="mx-auto max-w-[1440px] p-4 sm:p-6">
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <Tabs value={scope} onChange={setScope} items={[{ value: 'open', label: 'Offen' }, { value: 'critical', label: 'Kritisch' }, { value: 'late', label: 'Verspätet' }, { value: 'all', label: 'Alle' }]} />
          <div className="relative"><Search size={14} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-ink-faint" /><Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Suchen …" className="w-56 pl-8" /></div>
          <Select value={status} onChange={(e) => setStatus(e.target.value as TaskStatus | '')} className="w-40"><option value="">Alle Status</option>{(Object.keys(TASK_STATUS_LABELS) as TaskStatus[]).map((s) => <option key={s} value={s}>{TASK_STATUS_LABELS[s]}</option>)}</Select>
          <Select value={trade} onChange={(e) => setTrade(e.target.value)} className="w-44"><option value="">Alle Kategorien</option>{org.trades.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select>
          <span className="text-xs text-ink-faint">{rows.length} Vorgänge</span>
          <Button size="sm" className="ml-auto" onClick={exportCsv}><Download size={14} /> CSV</Button>
        </div>
        <Card padded={false}>
          <div className="overflow-x-auto">
            <table className="data-table w-full min-w-[1000px] text-sm">
              <thead><tr><th>Vorgang</th><th>Kategorie / Firma</th><th>Verantw.</th><th>Termine</th><th className="text-right">Dauer</th><th className="w-40">Ist / Soll</th><th>Status</th><th>Puffer</th><th>Soll-Ist</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.task.id} className="cursor-pointer hover:bg-surface-2" onClick={() => navigate(`/projects/${p.projectId}/gantt?task=${r.task.id}`)}>
                    <td><div className="font-medium">{r.task.name}</div><div className="text-xs text-ink-faint">{r.phase}</div></td>
                    <td className="text-xs text-ink-soft"><span className="mr-1.5 inline-block h-2 w-2 rounded-sm align-middle" style={{ background: org.tradeColor(r.task.trade_id) }} />{org.tradeName(r.task.trade_id)}{r.task.company_id ? <div className="pl-3.5">{org.companyName(r.task.company_id)}</div> : null}</td>
                    <td className="text-xs text-ink-soft">{[
                      ...(r.task.responsible_user_ids ?? []).map((id) => org.userName(id)),
                      ...(r.task.responsible_user_id && !(r.task.responsible_user_ids ?? []).includes(r.task.responsible_user_id) ? [org.userName(r.task.responsible_user_id)] : []),
                      ...(r.task.responsible_name ? [r.task.responsible_name] : []),
                    ].filter((n) => n && n !== '–').join(', ')}</td>
                    <td className="whitespace-nowrap text-xs">{formatDate(fromDayNumber(r.s.start))}{r.task.type !== 'milestone' && ` – ${formatDate(fromDayNumber(r.s.end))}`}</td>
                    <td className="text-right text-xs">{r.task.type === 'milestone' ? '–' : `${r.task.duration} AT`}</td>
                    <td>
                      {r.task.type !== 'milestone' && (
                        <div className="flex items-center gap-2">
                          <div className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-surface-3"><div className="h-full rounded-full bg-brand" style={{ width: `${r.task.progress}%` }} /><div className="absolute top-0 h-full w-0.5 bg-ink/60" style={{ left: `${r.s.plannedProgress}%` }} /></div>
                          <span className="w-16 text-right text-xs tabular-nums">{r.task.progress} / {r.s.plannedProgress}</span>
                        </div>
                      )}
                    </td>
                    <td>
                      {p.canEdit ? (
                        <select value={r.task.status} onClick={(e) => e.stopPropagation()} onChange={(e) => p.updateTask(r.task.id, { status: e.target.value as TaskStatus }, 'Status geändert')} className="h-7 rounded-md border border-line bg-surface px-1 text-xs">
                          {(Object.keys(TASK_STATUS_LABELS) as TaskStatus[]).map((s) => <option key={s} value={s}>{TASK_STATUS_LABELS[s]}</option>)}
                        </select>
                      ) : TASK_STATUS_LABELS[r.task.status]}
                    </td>
                    <td className="text-xs">{r.s.isCritical ? <Badge tone="danger">kritisch</Badge> : `${r.s.totalFloat} AT`}</td>
                    <td className="text-xs">{r.bl ? <Delta days={r.s.end - toDayNumber(r.bl.end_date)} suffix=" T" /> : <span className="text-ink-faint">–</span>}</td>
                  </tr>
                ))}
                {rows.length === 0 && <tr><td colSpan={9} className="py-8 text-center text-ink-faint">Keine Vorgänge für diese Auswahl.</td></tr>}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </div>
  )
}
