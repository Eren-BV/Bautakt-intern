/**
 * Kategorienansicht des Projekts: Übersicht je Kategorie (Vorgänge, erster/letzter Einsatz,
 * Fortschritt, Risiken, Firma) → intelligenter Kategorieplan (VOR DIR / DEINE ARBEIT /
 * NACH DIR / MEILENSTEINE) mit Relevanzstufen, PDF-Export und sicheren Share-Links.
 */

import { useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import { ArrowLeft, FileText, Link2, Copy, Ban, ChevronRight, Flag, AlertTriangle } from 'lucide-react'
import { useProject } from '../store/project'
import { useOrg } from '../store/org'
import { useToast } from '../store/toast'
import { useRoute, navigate } from '../lib/router'
import { api } from '../lib/api'
import { ProjectHeader } from '../components/ProjectHeader'
import { Badge, Button, Card, EmptyState, Field, Input, Modal, ProgressBar, Select, Spinner, StatusBadge, Tabs } from '../components/ui'
import { buildTradePlan, type TradePlanTask } from '../../shared/engine/tradePlan'
import { taskReadiness } from '../../shared/engine/readiness'
import { formatDate, fromDayNumber, toDayNumber } from '../../shared/engine/dates'
import type { ShareLink, ShareRelevance } from '../../shared/types'

export function TradesPage() {
  const p = useProject()
  const org = useOrg()
  const toast = useToast()
  const { query } = useRoute()
  const [tradeId, setTradeId] = useState<string | null>(query.get('trade'))
  const [relevance, setRelevance] = useState<ShareRelevance>('standard')
  const [links, setLinks] = useState<ShareLink[]>([])
  const [shareDialog, setShareDialog] = useState(false)
  const [created, setCreated] = useState<string | null>(null)
  const [expiresDays, setExpiresDays] = useState<string>('90')
  const [label, setLabel] = useState('')

  const loadLinks = () => api.share.list(p.projectId).then(setLinks).catch(() => {})
  useEffect(() => {
    void loadLinks()
  }, [p.projectId]) // eslint-disable-line react-hooks/exhaustive-deps

  const overview = useMemo(() => {
    if (!p.analysis) return []
    const sched = p.analysis.current
    const todayDay = toDayNumber(p.today)
    return org.trades
      .map((tr) => {
        const own = p.plan.tasks.filter((t) => t.trade_id === tr.id && sched.tasks.get(t.id)?.isLeaf)
        if (own.length === 0) return null
        const starts = own.map((t) => sched.tasks.get(t.id)!.start)
        const ends = own.map((t) => sched.tasks.get(t.id)!.end)
        const weight = own.reduce((s, t) => s + Math.max(1, sched.tasks.get(t.id)!.duration), 0)
        const done = own.reduce((s, t) => s + (Math.max(1, sched.tasks.get(t.id)!.duration) * (t.status === 'done' ? 100 : t.progress)) / 100, 0)
        const risks = own.filter((t) => t.status === 'delayed' || t.status === 'at_risk' || t.status === 'blocked' || (t.status !== 'done' && sched.tasks.get(t.id)!.end < todayDay)).length
        const critical = own.filter((t) => t.status !== 'done' && sched.tasks.get(t.id)!.isCritical).length
        const companies = [...new Set(own.map((t) => t.company_id).filter(Boolean))].map((id) => org.companyName(id))
        return { trade: tr, count: own.length, first: Math.min(...starts), last: Math.max(...ends), progress: weight ? Math.round((done / weight) * 100) : 0, risks, critical, companies }
      })
      .filter((x): x is NonNullable<typeof x> => !!x)
      .sort((a, b) => a.first - b.first)
  }, [p.analysis, p.plan.tasks, org, p.today])

  const plan = useMemo(() => (p.analysis && tradeId ? buildTradePlan(p.plan.tasks, p.plan.dependencies, p.analysis.current, { tradeId }, relevance, org.tradeName(tradeId)) : null), [p.analysis, p.plan, tradeId, relevance, org])

  if (!p.bundle || !p.analysis) return <Spinner />

  const createLink = async () => {
    try {
      const l = await api.share.create(p.projectId, { trade_id: tradeId, label: label || `Kategorieplan ${org.tradeName(tradeId)}`, relevance, expires_in_days: expiresDays ? Number(expiresDays) : null })
      setCreated(`${location.origin}${l.url}`)
      await loadLinks()
    } catch (e) {
      toast.push((e as Error).message, 'error')
    }
  }

  if (!tradeId || !plan) {
    return (
      <div>
        <ProjectHeader title="Kategorien" />
        <div className="mx-auto max-w-[1200px] p-4 sm:p-6">
          {overview.length === 0 ? <EmptyState title="Keine Kategorien zugeordnet" description="Ordnen Sie Vorgängen im Terminplan eine Kategorie zu." /> : (
            <Card padded={false}>
              <table className="data-table w-full text-sm">
                <thead><tr><th>Kategorie</th><th className="text-right">Vorgänge</th><th>Erster Einsatz</th><th>Letzter Einsatz</th><th className="w-40">Fortschritt</th><th>Risiken</th><th>Firma</th><th /></tr></thead>
                <tbody>
                  {overview.map((o) => (
                    <tr key={o.trade.id} className="cursor-pointer hover:bg-surface-2" onClick={() => setTradeId(o.trade.id)}>
                      <td><span className="mr-2 inline-block h-2.5 w-2.5 rounded-sm align-middle" style={{ background: o.trade.color }} /><span className="font-medium">{o.trade.name}</span></td>
                      <td className="text-right">{o.count}</td>
                      <td className="text-xs">{formatDate(fromDayNumber(o.first))}</td>
                      <td className="text-xs">{formatDate(fromDayNumber(o.last))}</td>
                      <td><div className="flex items-center gap-2"><ProgressBar value={o.progress} className="flex-1" /><span className="w-9 text-right text-xs">{o.progress} %</span></div></td>
                      <td>{o.risks > 0 ? <Badge tone="danger">{o.risks} Risiko{o.risks > 1 ? 's' : ''}</Badge> : o.critical > 0 ? <Badge tone="warn">{o.critical} kritisch</Badge> : <Badge tone="ok">im Plan</Badge>}</td>
                      <td className="text-xs text-ink-soft">{o.companies.join(', ') || '–'}</td>
                      <td className="text-right"><ChevronRight size={16} className="text-ink-faint" /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}
        </div>
      </div>
    )
  }

  const Section = ({ title, hint, items, own }: { title: string; hint: string; items: TradePlanTask[]; own?: boolean }) => (
    <Card title={<span>{title} <span className="ml-1 text-xs font-normal text-ink-faint">{hint}</span></span>} padded={false}>
      {items.length === 0 ? <div className="px-4 py-4 text-sm text-ink-faint">–</div> : (
        <ul className="divide-y divide-line">
          {items.map((x) => {
            const r = own ? taskReadiness(x.task, p.plan.tasks, p.plan.dependencies, p.bundle!.constraints) : null
            return (
              <li key={x.task.id} className={clsx('flex cursor-pointer items-center gap-3 px-4 py-2.5 hover:bg-surface-2', x.task.status === 'done' && 'opacity-60')} onClick={() => navigate(`/projects/${p.projectId}/gantt?task=${x.task.id}`)}>
                {x.task.type === 'milestone' ? <Flag size={15} className="shrink-0 text-milestone" /> : <span className="h-7 w-1 shrink-0 rounded-full" style={{ background: org.tradeColor(x.task.trade_id) }} />}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2"><span className="truncate text-sm font-medium">{x.task.name}</span>{x.isCritical && x.task.status !== 'done' && <Badge tone="danger">terminentscheidend</Badge>}{x.isDriving && !own && <Badge tone="brand">bestimmt Termin</Badge>}</div>
                  <div className="truncate text-xs text-ink-faint">{org.tradeName(x.task.trade_id)}{x.task.company_id ? ` · ${org.companyName(x.task.company_id)}` : ''}{x.relation ? ` · ${x.relation}` : ''}</div>
                </div>
                <div className="text-right text-xs"><div className="font-medium">{formatDate(fromDayNumber(x.start))}{x.task.type !== 'milestone' && ` – ${formatDate(fromDayNumber(x.end))}`}</div>{r && r.items.length > 0 && <div className={clsx(r.openCount ? 'text-warn' : 'text-ok')}>{r.openCount ? `${r.openCount} Voraussetzung${r.openCount > 1 ? 'en' : ''} offen` : r.status === 'done' ? '' : 'ausführungsbereit'}</div>}</div>
                <StatusBadge status={x.task.status} />
              </li>
            )
          })}
        </ul>
      )}
    </Card>
  )

  return (
    <div>
      <ProjectHeader title={`Kategorieplan ${org.tradeName(tradeId)}`} />
      <div className="mx-auto max-w-[1200px] space-y-5 p-4 sm:p-6">
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="ghost" onClick={() => setTradeId(null)}><ArrowLeft size={15} /> Alle Kategorien</Button>
          <Select value={tradeId} onChange={(e) => setTradeId(e.target.value)} className="w-52">{overview.map((o) => <option key={o.trade.id} value={o.trade.id}>{o.trade.name}</option>)}</Select>
          <Tabs value={relevance} onChange={setRelevance} items={[{ value: 'compact', label: 'Kompakt' }, { value: 'standard', label: 'Standard' }, { value: 'full', label: 'Vollständig' }]} />
          <div className="ml-auto flex gap-2">
            <Button onClick={() => api.reports.open(p.projectId, 'trade', { trade: tradeId, relevance }).catch((e) => toast.push(e.message, 'error'))}><FileText size={15} /> PDF exportieren</Button>
            {p.canEdit && <Button variant="primary" onClick={() => { setCreated(null); setLabel(`Kategorieplan ${org.tradeName(tradeId)}`); setShareDialog(true) }}><Link2 size={15} /> Sicheren Link teilen</Button>}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Card><div className="text-xs text-ink-faint">Erster Einsatz</div><div className="text-lg font-semibold">{plan.firstStart !== null ? formatDate(fromDayNumber(plan.firstStart)) : '–'}</div></Card>
          <Card><div className="text-xs text-ink-faint">Letzter Einsatz</div><div className="text-lg font-semibold">{plan.lastEnd !== null ? formatDate(fromDayNumber(plan.lastEnd)) : '–'}</div></Card>
          <Card><div className="text-xs text-ink-faint">Eigene Arbeiten</div><div className="text-lg font-semibold">{plan.own.length}</div></Card>
          <Card><div className="text-xs text-ink-faint">Fortschritt</div><div className="text-lg font-semibold">{plan.progress} %</div></Card>
        </div>
        <Section title="Vor dir" hint={relevance === 'compact' ? 'direkte Vorleistungen' : relevance === 'full' ? 'vollständige Kette' : 'relevante Vorleistungen'} items={plan.before} />
        <Section title="Deine Arbeit" hint="alle eigenen Arbeitsschritte" items={plan.own} own />
        <Section title="Nach dir" hint={relevance === 'compact' ? 'direkte Folgearbeiten' : 'relevante Folgearbeiten'} items={plan.after} />
        <Section title="Meilensteine" hint="betroffen durch deine Arbeit" items={plan.milestones} />
        {plan.criticalRelated.length > 0 && <p className="flex items-center gap-2 text-xs text-danger"><AlertTriangle size={14} /> {plan.criticalRelated.length} Vor-/Folgearbeiten liegen auf dem kritischen Pfad – Verzögerungen wirken direkt auf das Projektende.</p>}

        <Card title="Geteilte Links" padded={false}>
          {links.filter((l) => l.trade_id === tradeId).length === 0 ? <div className="px-4 py-4 text-sm text-ink-faint">Noch kein Link für diese Kategorie.</div> : (
            <table className="data-table w-full text-sm"><thead><tr><th>Bezeichnung</th><th>Relevanz</th><th>Läuft ab</th><th className="text-right">Aufrufe</th><th>Status</th><th /></tr></thead>
              <tbody>{links.filter((l) => l.trade_id === tradeId).map((l) => (
                <tr key={l.id}><td className="font-medium">{l.label || '–'}</td><td className="text-xs">{l.relevance}</td><td className="text-xs">{l.expires_at ? formatDate(l.expires_at.slice(0, 10)) : 'unbegrenzt'}</td><td className="text-right text-xs">{l.use_count}</td><td>{l.revoked_at ? <Badge tone="muted">widerrufen</Badge> : l.expires_at && l.expires_at < new Date().toISOString() ? <Badge tone="warn">abgelaufen</Badge> : <Badge tone="ok">aktiv</Badge>}</td>
                  <td className="text-right">{!l.revoked_at && p.canEdit && <Button size="sm" variant="ghost" className="text-danger" onClick={async () => { if (confirm('Link widerrufen? Der Empfänger kann den Plan dann nicht mehr öffnen.')) { await api.share.revoke(p.projectId, l.id); await loadLinks() } }}><Ban size={13} /> Widerrufen</Button>}</td></tr>
              ))}</tbody></table>
          )}
        </Card>
      </div>

      <Modal open={shareDialog} onClose={() => setShareDialog(false)} title="Sicheren Link teilen" width="sm" footer={<><Button variant="ghost" onClick={() => setShareDialog(false)}>Schließen</Button>{!created && <Button variant="primary" onClick={createLink}>Link erzeugen</Button>}</>}>
        {created ? (
          <div className="space-y-3">
            <p className="text-sm text-ink-soft">Der Link zeigt nur den freigegebenen Kategorieumfang (Nur-Lese, ohne Kosten oder interne Notizen). Der Empfänger kann Termine bestätigen oder einen späteren Termin melden – der Terminplan ändert sich dadurch nicht automatisch.</p>
            <div className="flex items-center gap-2 rounded-lg border border-line bg-surface-2 px-3 py-2 text-xs"><span className="min-w-0 flex-1 truncate">{created}</span><Button size="sm" onClick={() => { navigator.clipboard?.writeText(created); toast.push('Link kopiert.', 'success') }}><Copy size={13} /> Kopieren</Button></div>
            <p className="text-xs text-warn">Der Link wird nur jetzt angezeigt – bitte kopieren. Er ist jederzeit widerrufbar.</p>
          </div>
        ) : (
          <div className="space-y-3">
            <Field label="Bezeichnung"><Input value={label} onChange={(e) => setLabel(e.target.value)} /></Field>
            <Field label="Umfang"><Select value={relevance} onChange={(e) => setRelevance(e.target.value as ShareRelevance)}><option value="compact">Kompakt – direkte Vor-/Folgearbeiten</option><option value="standard">Standard – relevante Vor-/Folgearbeiten, Meilensteine</option><option value="full">Vollständig – gesamte Abhängigkeitskette</option></Select></Field>
            <Field label="Gültig für (Tage)" hint="leer = unbegrenzt"><Input type="number" min={1} value={expiresDays} onChange={(e) => setExpiresDays(e.target.value)} /></Field>
            <p className="text-xs text-ink-faint">Kryptografisch sicherer Token, nur gehasht gespeichert, widerrufbar.</p>
          </div>
        )}
      </Modal>
    </div>
  )
}
