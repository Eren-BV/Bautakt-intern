/**
 * Soll-Ist: Baselines verwalten, Abweichung auf Projektebene, je Vorgang und je Phase.
 */

import { useMemo, useState } from 'react'
import { Save, Check, Trash2, Download } from 'lucide-react'
import { useProject } from '../store/project'
import { useOrg } from '../store/org'
import { useToast } from '../store/toast'
import { navigate } from '../lib/router'
import { api } from '../lib/api'
import { ProjectHeader } from '../components/ProjectHeader'
import { Badge, Button, Card, Delta, EmptyState, Field, Input, KpiTile, Modal, Spinner, Tabs } from '../components/ui'
import { formatDate, formatDateTime, fromDayNumber, toDayNumber } from '../../shared/engine/dates'
import { flattenTree } from '../../shared/engine/operations'
import { downloadCsv } from '../lib/export'

export function BaselinePage() {
  const p = useProject()
  const org = useOrg()
  const toast = useToast()
  const [dialog, setDialog] = useState(false)
  const [name, setName] = useState('')
  const [scope, setScope] = useState<'deviating' | 'all'>('deviating')

  const rows = useMemo(() => {
    if (!p.analysis) return []
    const sched = p.analysis.current
    return flattenTree(p.plan.tasks)
      .map((f) => {
        const s = sched.tasks.get(f.task.id)!
        const bl = p.analysis!.baselineTasks.get(f.task.id)
        return { ...f, s, bl, delta: bl ? s.end - toDayNumber(bl.end_date) : null, deltaStart: bl ? s.start - toDayNumber(bl.start_date) : null }
      })
      .filter((r) => scope === 'all' || (r.delta !== null && r.delta !== 0) || r.bl === undefined)
  }, [p.analysis, p.plan.tasks, scope])

  if (!p.bundle || !p.analysis) return <Spinner />
  const a = p.analysis
  const bl = a.activeBaseline
  const project = p.bundle.project

  const save = async () => {
    try {
      await p.saveBaseline(name)
      toast.push('Baseline gespeichert.', 'success')
      setDialog(false)
    } catch (e) {
      toast.push((e as Error).message, 'error')
    }
  }

  const exportCsv = () =>
    downloadCsv(`soll-ist-${project.number || p.projectId}.csv`, ['Vorgang', 'Ebene', 'Baseline Start', 'Baseline Ende', 'Aktuell Start', 'Aktuell Ende', 'Abw. Start (T)', 'Abw. Ende (T)', 'Status'],
      rows.map((r) => [r.task.name, String(r.depth), r.bl ? formatDate(r.bl.start_date) : '', r.bl ? formatDate(r.bl.end_date) : '', formatDate(fromDayNumber(r.s.start)), formatDate(fromDayNumber(r.s.end)), r.deltaStart === null ? '' : String(r.deltaStart), r.delta === null ? '' : String(r.delta), r.task.status]))

  return (
    <div>
      <ProjectHeader title="Soll-Ist / Baseline" actions={p.canEdit && <Button variant="primary" onClick={() => { setName(`Baseline ${formatDate(p.today)}`); setDialog(true) }}><Save size={15} /> Baseline speichern</Button>} />
      <div className="mx-auto max-w-[1440px] space-y-6 p-4 sm:p-6">
        {!bl ? (
          <EmptyState title="Noch keine Baseline" description="Frieren Sie den fertigen Bauzeitenplan als Baseline ein. Danach werden alle Terminänderungen als Abweichung gegen diesen Soll-Plan ausgewiesen." action={p.canEdit && <Button variant="primary" onClick={() => { setName(`Baseline ${formatDate(p.today)}`); setDialog(true) }}>Baseline jetzt speichern</Button>} />
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <KpiTile label="Ursprüngliche Fertigstellung" value={formatDate(bl.project_end)} hint={`${bl.name} · ${formatDateTime(bl.created_at)}`} />
              <KpiTile label="Aktueller Plan" value={formatDate(a.planned_end)} hint="ohne Prognose-Korrektur" />
              <KpiTile label="Aktuelle Prognose" value={formatDate(a.forecast_end)} hint="inkl. überfälliger Restarbeiten" tone={a.variance_days > 0 ? 'danger' : 'ok'} />
              <KpiTile label="Abweichung" value={<Delta days={a.variance_days} suffix=" AT" />} hint="Arbeitstage gegenüber Baseline" />
            </div>
            <Card title="Abweichungen je Vorgang" padded={false} actions={<><Tabs value={scope} onChange={setScope} items={[{ value: 'deviating', label: 'Nur Abweichungen' }, { value: 'all', label: 'Alle' }]} /><Button size="sm" onClick={exportCsv}><Download size={14} /> CSV</Button></>}>
              <div className="overflow-x-auto">
                <table className="data-table w-full min-w-[900px] text-sm">
                  <thead><tr><th>Vorgang</th><th>Gewerk</th><th>Baseline</th><th>Aktuell</th><th className="text-right">Start</th><th className="text-right">Ende</th><th>Status</th></tr></thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.task.id} className="cursor-pointer hover:bg-surface-2" onClick={() => navigate(`/projects/${p.projectId}/gantt?task=${r.task.id}`)}>
                        <td style={{ paddingLeft: 12 + r.depth * 16 }} className={r.hasChildren ? 'font-semibold' : ''}>{r.task.name}{r.bl === undefined && <Badge tone="brand" className="ml-2">neu</Badge>}</td>
                        <td className="text-xs text-ink-soft">{org.tradeName(r.task.trade_id)}</td>
                        <td className="whitespace-nowrap text-xs text-ink-soft">{r.bl ? `${formatDate(r.bl.start_date, 'short')} – ${formatDate(r.bl.end_date, 'short')}` : '–'}</td>
                        <td className="whitespace-nowrap text-xs">{formatDate(fromDayNumber(r.s.start), 'short')} – {formatDate(fromDayNumber(r.s.end), 'short')}</td>
                        <td className="text-right text-xs">{r.deltaStart !== null && <Delta days={r.deltaStart} suffix="" />}</td>
                        <td className="text-right text-xs">{r.delta !== null && <Delta days={r.delta} suffix="" />}</td>
                        <td className="text-xs">{r.task.status === 'done' ? <Badge tone="ok">erledigt</Badge> : r.s.isCritical ? <Badge tone="danger">kritisch</Badge> : ''}</td>
                      </tr>
                    ))}
                    {rows.length === 0 && <tr><td colSpan={7} className="py-8 text-center text-ink-faint">Keine Abweichungen zur Baseline.</td></tr>}
                  </tbody>
                </table>
              </div>
            </Card>
          </>
        )}

        {p.bundle.baselines.length > 0 && (
          <Card title="Gespeicherte Baselines" padded={false}>
            <table className="data-table w-full text-sm">
              <thead><tr><th>Name</th><th>Gespeichert</th><th>Von</th><th>Projektende</th><th></th></tr></thead>
              <tbody>
                {p.bundle.baselines.map((b) => (
                  <tr key={b.id}>
                    <td className="font-medium">{b.name}{b.is_active && <Badge tone="brand" className="ml-2">aktiv</Badge>}</td>
                    <td className="text-xs text-ink-soft">{formatDateTime(b.created_at)}</td>
                    <td className="text-xs text-ink-soft">{org.userName(b.created_by)}</td>
                    <td className="text-xs">{formatDate(b.project_end)}</td>
                    <td className="text-right">
                      {p.canEdit && !b.is_active && <Button size="sm" variant="ghost" onClick={async () => { await api.projects.activateBaseline(p.projectId, b.id); await p.reload() }}><Check size={13} /> Aktivieren</Button>}
                      {p.canEdit && <Button size="sm" variant="ghost" className="text-danger" onClick={async () => { if (confirm('Baseline löschen?')) { await api.projects.removeBaseline(p.projectId, b.id); await p.reload() } }}><Trash2 size={13} /></Button>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        )}
      </div>
      <Modal open={dialog} onClose={() => setDialog(false)} title="Baseline speichern" width="sm" footer={<><Button variant="ghost" onClick={() => setDialog(false)}>Abbrechen</Button><Button variant="primary" onClick={save}>Einfrieren</Button></>}>
        <p className="mb-3 text-sm text-ink-soft">Der aktuelle Plan wird als Soll-Plan eingefroren. Bestehende Baselines bleiben erhalten; die neue wird aktiv.</p>
        <Field label="Bezeichnung"><Input value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
      </Modal>
    </div>
  )
}
