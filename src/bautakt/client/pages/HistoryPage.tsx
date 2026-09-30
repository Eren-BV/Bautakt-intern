/**
 * Änderungshistorie, Verzögerungsereignisse und Vor-Ort-Meldungen des Projekts.
 */

import { useEffect, useMemo, useState } from 'react'
import { Download, Search } from 'lucide-react'
import { useProject } from '../store/project'
import { useOrg } from '../store/org'
import { api } from '../lib/api'
import { ProjectHeader } from '../components/ProjectHeader'
import { Badge, Button, Card, ErrorBox, Input, Spinner, Tabs } from '../components/ui'
import type { ChangeHistoryEntry, DelayEvent, ProgressUpdate } from '../../shared/types'
import { formatDateTime, formatDate } from '../../shared/engine/dates'
import { DELAY_REASON_LABELS, SITE_FLAG_LABELS, CHANGE_SOURCE_LABELS } from '../../shared/labels'
import { downloadCsv } from '../lib/export'

export function HistoryPage() {
  const p = useProject()
  const org = useOrg()
  const [data, setData] = useState<{ history: ChangeHistoryEntry[]; delays: DelayEvent[]; updates: ProgressUpdate[] } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<'history' | 'delays' | 'updates'>('history')
  const [q, setQ] = useState('')
  useEffect(() => {
    api.projects.history(p.projectId).then(setData).catch((e) => setError(e.message))
  }, [p.projectId, p.bundle?.project.version])

  const history = useMemo(() => {
    const s = q.trim().toLowerCase()
    return (data?.history ?? []).filter((h) => !s || [h.task_name, h.field, h.reason, h.user_name, h.old_value, h.new_value].some((x) => (x ?? '').toLowerCase().includes(s)))
  }, [data, q])

  if (error) return <div className="p-6"><ErrorBox message={error} /></div>
  if (!data || !p.bundle) return <Spinner />
  const taskName = (id: string) => p.plan.tasks.find((t) => t.id === id)?.name ?? '(gelöscht)'

  return (
    <div>
      <ProjectHeader title="Änderungshistorie" />
      <div className="mx-auto max-w-[1200px] p-4 sm:p-6">
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <Tabs value={tab} onChange={setTab} items={[{ value: 'history', label: `Änderungen (${data.history.length})` }, { value: 'delays', label: `Verzögerungen (${data.delays.length})` }, { value: 'updates', label: `Vor-Ort-Meldungen (${data.updates.length})` }]} />
          {tab === 'history' && <div className="relative"><Search size={14} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-ink-faint" /><Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Vorgang, Grund, Benutzer …" className="w-64 pl-8" /></div>}
          <Button size="sm" className="ml-auto" onClick={() => downloadCsv(`historie-${p.projectId}.csv`, ['Zeitpunkt', 'Benutzer', 'Quelle', 'Vorgang', 'Feld', 'Alt', 'Neu', 'Grund'], history.map((h) => [formatDateTime(h.created_at), h.user_name, h.source, h.task_name, h.field, h.old_value ?? '', h.new_value ?? '', h.reason]))}><Download size={14} /> CSV</Button>
        </div>
        {tab === 'history' && (
          <Card padded={false}>
            <table className="data-table w-full text-sm">
              <thead><tr><th>Zeitpunkt</th><th>Benutzer</th><th>Quelle</th><th>Vorgang</th><th>Änderung</th><th>Grund</th></tr></thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h.id}>
                    <td className="whitespace-nowrap text-xs text-ink-soft">{formatDateTime(h.created_at)}</td>
                    <td className="text-xs">{h.user_name}</td>
                    <td><Badge tone={h.source === 'MANUAL' ? 'neutral' : h.source === 'SITE_UPDATE' ? 'brand' : 'warn'}>{CHANGE_SOURCE_LABELS[h.source] ?? h.source}</Badge></td>
                    <td className="font-medium">{h.task_name || <span className="text-ink-faint">Projekt</span>}</td>
                    <td className="text-xs">
                      <span className="mr-1.5 font-medium text-ink-soft">{labelField(h.field)}</span>
                      {h.field === 'created' ? <Badge tone="ok">angelegt</Badge> : h.field === 'deleted' ? <Badge tone="danger">gelöscht</Badge> : (
                        <>{h.old_value !== null && <span className="text-ink-faint line-through">{h.old_value}</span>} {h.old_value !== null && h.new_value !== null && '→ '}<span className="text-ink">{h.new_value ?? '–'}</span></>
                      )}
                    </td>
                    <td className="text-xs text-ink-soft">{h.reason}</td>
                  </tr>
                ))}
                {history.length === 0 && <tr><td colSpan={6} className="py-8 text-center text-ink-faint">Keine Änderungen protokolliert.</td></tr>}
              </tbody>
            </table>
          </Card>
        )}
        {tab === 'delays' && (
          <Card padded={false}>
            <table className="data-table w-full text-sm">
              <thead><tr><th>Zeitpunkt</th><th>Vorgang</th><th>Grund</th><th className="text-right">Tage</th><th>Kommentar</th><th>Gemeldet von</th></tr></thead>
              <tbody>
                {data.delays.map((d) => (
                  <tr key={d.id}>
                    <td className="whitespace-nowrap text-xs text-ink-soft">{formatDateTime(d.created_at)}</td>
                    <td className="font-medium">{taskName(d.task_id)}</td>
                    <td><Badge tone="danger">{DELAY_REASON_LABELS[d.reason]}</Badge></td>
                    <td className="text-right">{d.days ? `+${d.days} AT` : '–'}</td>
                    <td className="text-xs text-ink-soft">{d.comment}</td>
                    <td className="text-xs">{org.userName(d.user_id)}</td>
                  </tr>
                ))}
                {data.delays.length === 0 && <tr><td colSpan={6} className="py-8 text-center text-ink-faint">Keine Verzögerungen gemeldet.</td></tr>}
              </tbody>
            </table>
          </Card>
        )}
        {tab === 'updates' && (
          <Card padded={false}>
            <table className="data-table w-full text-sm">
              <thead><tr><th>Zeitpunkt</th><th>Vorgang</th><th>Meldung</th><th className="text-right">Fortschritt</th><th>Grund</th><th>Neue Prognose</th><th>Kommentar</th><th>Von</th></tr></thead>
              <tbody>
                {data.updates.map((u) => (
                  <tr key={u.id}>
                    <td className="whitespace-nowrap text-xs text-ink-soft">{formatDateTime(u.created_at)}</td>
                    <td className="font-medium">{taskName(u.task_id)}</td>
                    <td><Badge tone={u.flag === 'delayed' ? 'danger' : u.flag === 'at_risk' ? 'warn' : u.flag === 'done' ? 'ok' : 'brand'}>{SITE_FLAG_LABELS[u.flag]}</Badge></td>
                    <td className="text-right">{u.progress} %</td>
                    <td className="text-xs">{u.delay_reason ? DELAY_REASON_LABELS[u.delay_reason] : ''}</td>
                    <td className="text-xs">{u.new_forecast_end ? formatDate(u.new_forecast_end) : ''}</td>
                    <td className="text-xs text-ink-soft">{u.comment}</td>
                    <td className="text-xs">{org.userName(u.user_id)}</td>
                  </tr>
                ))}
                {data.updates.length === 0 && <tr><td colSpan={8} className="py-8 text-center text-ink-faint">Noch keine Vor-Ort-Meldungen.</td></tr>}
              </tbody>
            </table>
          </Card>
        )}
      </div>
    </div>
  )
}

function labelField(f: string): string {
  const map: Record<string, string> = { created: '', deleted: '', baseline: 'Baseline', plan: 'Plan', Termin: 'Termin', ki_anfrage: 'KI-Anfrage' }
  return map[f] ?? f
}
