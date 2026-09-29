/**
 * Unternehmensweiter Statusbericht: alle Projekte mit Ampel, Abweichung, Meilensteinen;
 * druckbar, CSV-Export. Projektberichte im Detail liegen im jeweiligen Projekt.
 */

import { useEffect, useState } from 'react'
import { Printer, Download } from 'lucide-react'
import { api } from '../lib/api'
import { navigate } from '../lib/router'
import { useAuth } from '../store/auth'
import { Button, Card, Delta, ErrorBox, HealthBadge, PageHeader, Spinner } from '../components/ui'
import type { CriticalEvent, ProjectSummary } from '../../shared/types'
import { formatDate, todayISO } from '../../shared/engine/dates'
import { HEALTH_LABELS } from '../../shared/labels'
import { downloadCsv } from '../lib/export'

export function OrgReportsPage() {
  const { session } = useAuth()
  const [data, setData] = useState<{ summaries: ProjectSummary[]; events: CriticalEvent[] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    api.projects.list().then(setData).catch((e) => setError(e.message))
  }, [])
  if (error) return <div className="p-6"><ErrorBox message={error} /></div>
  if (!data) return <Spinner />
  const active = data.summaries.filter((s) => s.project.state === 'active')
  const exportCsv = () => downloadCsv(`statusbericht-${todayISO()}.csv`, ['Projekt', 'Nummer', 'Status', 'Fortschritt', 'Start', 'Geplant', 'Prognose', 'Abweichung (AT)', 'Kritisch', 'Verzögert', 'Überfällig', 'Nächster Meilenstein', 'Datum', 'Projektleiter', 'Leitung vor Ort'],
    data.summaries.map((s) => [s.project.name, s.project.number, HEALTH_LABELS[s.health], String(s.progress), formatDate(s.project.start_date), formatDate(s.baseline_end ?? s.project.target_end_date), formatDate(s.forecast_end), String(s.variance_days), String(s.critical_count), String(s.delayed_count), String(s.overdue_count), s.next_milestone?.name ?? '', s.next_milestone ? formatDate(s.next_milestone.date) : '', s.project_manager_name, s.site_manager_name]))
  return (
    <div className="mx-auto max-w-[1100px] p-4 sm:p-6">
      <PageHeader title="Berichte" subtitle="Unternehmensweiter Statusbericht – Detailberichte je Projekt unter Projekt → Berichte" actions={<><Button onClick={exportCsv}><Download size={15} /> CSV</Button><Button variant="primary" onClick={() => window.print()}><Printer size={15} /> Drucken / PDF</Button></>} />
      <div className="print-page rounded-xl border border-line bg-surface p-8 print:border-0 print:p-0">
        <header className="mb-6 border-b border-line pb-4">
          <div className="text-xs font-semibold tracking-wide text-ink-faint uppercase">Statusbericht · {session?.org.name}</div>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">Projektportfolio</h1>
          <div className="mt-1 text-sm text-ink-soft">Stand {formatDate(todayISO(), 'long')} · {active.length} aktive Projekte · {active.filter((s) => s.health === 'red').length} verspätet · {active.filter((s) => s.health === 'yellow').length} gefährdet</div>
        </header>
        <table className="data-table w-full text-sm">
          <thead><tr><th>Projekt</th><th>Status</th><th className="text-right">Fortschritt</th><th>Geplant</th><th>Prognose</th><th className="text-right">Abw.</th><th>Nächster Meilenstein</th><th>Leitung vor Ort</th></tr></thead>
          <tbody>
            {data.summaries.map((s) => (
              <tr key={s.project.id} className="cursor-pointer hover:bg-surface-2" onClick={() => navigate(`/projects/${s.project.id}/reports`)}>
                <td><div className="font-medium">{s.project.name}</div><div className="text-xs text-ink-faint">{s.project.number} · {s.project.city}</div></td>
                <td><HealthBadge health={s.health} /></td>
                <td className="text-right">{s.progress} %</td>
                <td className="text-xs">{formatDate(s.baseline_end ?? s.project.target_end_date)}</td>
                <td className="text-xs">{formatDate(s.forecast_end)}</td>
                <td className="text-right"><Delta days={s.variance_days} /></td>
                <td className="text-xs">{s.next_milestone ? `${s.next_milestone.name} (${formatDate(s.next_milestone.date)})` : '–'}</td>
                <td className="text-xs">{s.site_manager_name}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {data.events.length > 0 && (
          <Card title="Kritische Ereignisse" className="mt-6 print:border-0" padded>
            <ul className="list-disc space-y-1 pl-5 text-sm">{data.events.map((e, i) => <li key={i}>{e.message} <span className="text-ink-faint">({e.project_name})</span></li>)}</ul>
          </Card>
        )}
      </div>
    </div>
  )
}
