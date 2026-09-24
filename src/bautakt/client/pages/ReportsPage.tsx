/**
 * Projektbericht: druckfähiges Dokument (PDF über Browser-Druck) mit wählbaren
 * Abschnitten, jede Tabelle zusätzlich als CSV.
 */

import { useEffect, useMemo, useState } from 'react'
import { Printer, Download, FileText } from 'lucide-react'
import { useToast } from '../store/toast'
import { useProject } from '../store/project'
import { useOrg } from '../store/org'
import { useAuth } from '../store/auth'
import { api } from '../lib/api'
import { navigate } from '../lib/router'
import { ProjectHeader } from '../components/ProjectHeader'
import { Button, Checkbox, Delta, Spinner, Badge } from '../components/ui'
import { criticalEvents, lookahead } from '../../shared/engine/analysis'
import { formatDate, fromDayNumber, toDayNumber, todayISO } from '../../shared/engine/dates'
import { DELAY_REASON_LABELS, HEALTH_LABELS, TASK_STATUS_LABELS } from '../../shared/labels'
import type { DelayEvent, DelayReason } from '../../shared/types'
import { downloadCsv } from '../lib/export'

const SECTIONS = [
  ['progress', 'Projektfortschritt'],
  ['variance', 'Terminabweichungen'],
  ['critical', 'Kritische Vorgänge'],
  ['late', 'Verspätete Vorgänge'],
  ['milestones', 'Meilensteine'],
  ['reasons', 'Änderungsursachen'],
  ['lookahead', 'Lookahead (4 Wochen)'],
] as const
type SectionKey = (typeof SECTIONS)[number][0]

export function ReportsPage() {
  const p = useProject()
  const org = useOrg()
  const { session } = useAuth()
  const toast = useToast()
  const [enabled, setEnabled] = useState<Set<SectionKey>>(new Set(SECTIONS.map((s) => s[0])))
  const [delays, setDelays] = useState<DelayEvent[]>([])
  useEffect(() => {
    api.projects.history(p.projectId).then((d) => setDelays(d.delays)).catch(() => {})
  }, [p.projectId])

  const data = useMemo(() => {
    if (!p.analysis || !p.bundle) return null
    const a = p.analysis
    const sched = a.current
    const todayDay = toDayNumber(p.today)
    const leaves = p.plan.tasks.filter((t) => sched.tasks.get(t.id)?.isLeaf)
    const phases = p.plan.tasks.filter((t) => t.type === 'phase' && !t.parent_id).sort((x, y) => x.sort_order - y.sort_order).map((ph) => {
      const kids = p.plan.tasks.filter((t) => t.parent_id === ph.id)
      const prog = kids.length ? Math.round(kids.reduce((s, t) => s + (t.status === 'done' ? 100 : t.progress), 0) / kids.length) : 0
      const s = sched.tasks.get(ph.id)!
      const bl = a.baselineTasks.get(ph.id)
      return { ph, prog, s, bl, delta: bl ? s.end - toDayNumber(bl.end_date) : null }
    })
    const variance = leaves.map((t) => ({ t, s: sched.tasks.get(t.id)!, bl: a.baselineTasks.get(t.id) })).filter((x) => x.bl && x.s.end !== toDayNumber(x.bl.end_date)).map((x) => ({ ...x, delta: x.s.end - toDayNumber(x.bl!.end_date) })).sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta))
    const critical = leaves.filter((t) => sched.tasks.get(t.id)!.isCritical && t.status !== 'done').map((t) => ({ t, s: sched.tasks.get(t.id)! }))
    const late = leaves.filter((t) => t.status === 'delayed' || (t.status !== 'done' && sched.tasks.get(t.id)!.end < todayDay)).map((t) => ({ t, s: sched.tasks.get(t.id)! }))
    const milestones = p.plan.tasks.filter((t) => t.type === 'milestone').map((t) => ({ t, s: sched.tasks.get(t.id)!, bl: a.baselineTasks.get(t.id) })).sort((x, y) => x.s.start - y.s.start)
    const reasons = new Map<DelayReason, { count: number; days: number }>()
    for (const d of delays) {
      const r = reasons.get(d.reason) ?? { count: 0, days: 0 }
      r.count++
      r.days += d.days
      reasons.set(d.reason, r)
    }
    const la = lookahead(p.plan.tasks, sched, p.today, 4).filter((x, i, arr) => arr.findIndex((y) => y.task.id === x.task.id) === i)
    const events = criticalEvents(p.bundle.project, { ...p.bundle, tasks: p.plan.tasks, dependencies: p.plan.dependencies }, a, p.today)
    return { a, phases, variance, critical, late, milestones, reasons: [...reasons.entries()].sort((x, y) => y[1].days - x[1].days), la, events }
  }, [p.analysis, p.bundle, p.plan, p.today, delays])

  if (!p.bundle || !data) return <Spinner />
  const { a } = data
  const project = p.bundle.project
  const toggle = (k: SectionKey) => setEnabled((s) => { const n = new Set(s); if (n.has(k)) n.delete(k); else n.add(k); return n })
  const show = (k: SectionKey) => enabled.has(k)

  return (
    <div>
      <ProjectHeader title="Berichte" />
      <div className="no-print mx-auto max-w-[1000px] px-4 pt-4 sm:px-6">
        <div className="rounded-xl border border-line bg-surface p-4">
          <div className="mb-2 text-sm font-semibold">PDF-Berichte (kundentauglich, serverseitig erzeugt)</div>
          <div className="flex flex-wrap gap-2">
            {([['status', 'Projektstatusbericht'], ['schedule', 'Gesamtterminplan (Gantt)'], ['milestones', 'Meilensteinplan'], ['variance', 'Terminabweichungsbericht'], ['lookahead', 'Lookahead 4 Wochen']] as const).map(([k, l]) => (
              <Button key={k} onClick={() => api.reports.open(p.projectId, k).catch((e) => toast.push(e.message, 'error'))}><FileText size={15} /> {l}</Button>
            ))}
            <Button onClick={() => navigate(`/projects/${p.projectId}/trades`)}><FileText size={15} /> Gewerkeplan (je Gewerk)</Button>
          </div>
        </div>
      </div>
      <div className="no-print mx-auto flex max-w-[1000px] flex-wrap items-center gap-3 px-4 pt-4 sm:px-6">
        {SECTIONS.map(([k, label]) => <Checkbox key={k} label={label} checked={enabled.has(k)} onChange={() => toggle(k)} />)}
        <Button variant="primary" className="ml-auto" onClick={() => window.print()}><Printer size={15} /> Drucken / als PDF speichern</Button>
      </div>

      <article className="print-page mx-auto max-w-[1000px] p-4 sm:p-6">
        <div className="rounded-xl border border-line bg-surface p-8 print:border-0 print:p-0">
          <header className="mb-6 border-b border-line pb-4">
            <div className="text-xs font-semibold tracking-wide text-ink-faint uppercase">Projektbericht · {session?.org.name}</div>
            <h1 className="mt-1 text-2xl font-semibold tracking-tight">{project.name}</h1>
            <div className="mt-1 text-sm text-ink-soft">{project.number} · {project.address}{project.city ? `, ${project.city}` : ''} · Bauherr: {project.customer || '–'} · Stand {formatDate(todayISO(), 'long')}</div>
            <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm">
              <span>Status: <b>{HEALTH_LABELS[a.health]}</b></span>
              <span>Fortschritt: <b>{a.progress} %</b></span>
              <span>{a.baseline_end ? 'Ursprüngliche Fertigstellung' : 'Zieltermin'}: <b>{formatDate(a.baseline_end ?? project.target_end_date)}</b></span>
              <span>Prognose: <b>{formatDate(a.forecast_end)}</b></span>
              <span>Abweichung: <Delta days={a.variance_days} suffix=" AT" /></span>
              <span>Projektleitung: <b>{org.userName(project.project_manager_id)}</b> · Bauleitung: <b>{org.userName(project.site_manager_id)}</b></span>
            </div>
          </header>

          {show('progress') && (
            <Section title="Projektfortschritt" onCsv={() => downloadCsv('fortschritt.csv', ['Phase', 'Start', 'Ende', 'Fortschritt', 'Abweichung'], data.phases.map((x) => [x.ph.name, formatDate(fromDayNumber(x.s.start)), formatDate(fromDayNumber(x.s.end)), String(x.prog), x.delta === null ? '' : String(x.delta)]))}>
              <table className="data-table w-full text-sm"><thead><tr><th>Bauphase</th><th>Zeitraum</th><th className="w-48">Fortschritt</th><th className="text-right">Abw. Ende</th></tr></thead>
                <tbody>{data.phases.map((x) => (
                  <tr key={x.ph.id}><td className="font-medium">{x.ph.name}</td><td className="text-xs">{formatDate(fromDayNumber(x.s.start))} – {formatDate(fromDayNumber(x.s.end))}</td>
                    <td><div className="flex items-center gap-2"><div className="h-2 flex-1 overflow-hidden rounded-full bg-surface-3 print:border print:border-line"><div className="h-full bg-brand" style={{ width: `${x.prog}%` }} /></div><span className="w-9 text-right text-xs">{x.prog} %</span></div></td>
                    <td className="text-right text-xs">{x.delta === null ? '–' : <Delta days={x.delta} suffix=" T" />}</td></tr>
                ))}</tbody></table>
              {data.events.length > 0 && <ul className="mt-3 list-disc space-y-0.5 pl-5 text-sm">{data.events.slice(0, 6).map((e, i) => <li key={i}>{e.message}</li>)}</ul>}
            </Section>
          )}
          {show('variance') && (
            <Section title="Terminabweichungen gegenüber Baseline" onCsv={() => downloadCsv('abweichungen.csv', ['Vorgang', 'Baseline Ende', 'Aktuell Ende', 'Abweichung'], data.variance.map((x) => [x.t.name, formatDate(x.bl!.end_date), formatDate(fromDayNumber(x.s.end)), String(x.delta)]))}>
              {!a.activeBaseline ? <p className="text-sm text-ink-faint">Keine Baseline gespeichert.</p> : data.variance.length === 0 ? <p className="text-sm text-ink-faint">Keine Abweichungen.</p> : (
                <table className="data-table w-full text-sm"><thead><tr><th>Vorgang</th><th>Gewerk</th><th>Baseline</th><th>Aktuell</th><th className="text-right">Abw.</th></tr></thead>
                  <tbody>{data.variance.slice(0, 40).map((x) => <tr key={x.t.id}><td className="font-medium">{x.t.name}</td><td className="text-xs">{org.tradeName(x.t.trade_id)}</td><td className="text-xs">{formatDate(x.bl!.start_date, 'short')} – {formatDate(x.bl!.end_date, 'short')}</td><td className="text-xs">{formatDate(fromDayNumber(x.s.start), 'short')} – {formatDate(fromDayNumber(x.s.end), 'short')}</td><td className="text-right text-xs"><Delta days={x.delta} suffix=" T" /></td></tr>)}</tbody></table>
              )}
            </Section>
          )}
          {show('critical') && (
            <Section title="Kritische Vorgänge (Puffer 0)" onCsv={() => downloadCsv('kritisch.csv', ['Vorgang', 'Gewerk', 'Start', 'Ende', 'Status'], data.critical.map((x) => [x.t.name, org.tradeName(x.t.trade_id), formatDate(fromDayNumber(x.s.start)), formatDate(fromDayNumber(x.s.end)), TASK_STATUS_LABELS[x.t.status]]))}>
              <SimpleTaskTable rows={data.critical} org={org} />
            </Section>
          )}
          {show('late') && (
            <Section title="Verspätete und überfällige Vorgänge" onCsv={() => downloadCsv('verspaetet.csv', ['Vorgang', 'Gewerk', 'Start', 'Ende', 'Status'], data.late.map((x) => [x.t.name, org.tradeName(x.t.trade_id), formatDate(fromDayNumber(x.s.start)), formatDate(fromDayNumber(x.s.end)), TASK_STATUS_LABELS[x.t.status]]))}>
              <SimpleTaskTable rows={data.late} org={org} />
            </Section>
          )}
          {show('milestones') && (
            <Section title="Meilensteine" onCsv={() => downloadCsv('meilensteine.csv', ['Meilenstein', 'Termin', 'Baseline', 'Abweichung', 'Status'], data.milestones.map((x) => [x.t.name, formatDate(fromDayNumber(x.s.start)), x.bl ? formatDate(x.bl.start_date) : '', x.bl ? String(x.s.start - toDayNumber(x.bl.start_date)) : '', x.t.status === 'done' ? 'erreicht' : 'offen']))}>
              <table className="data-table w-full text-sm"><thead><tr><th>Meilenstein</th><th>Termin</th><th>Baseline</th><th className="text-right">Abw.</th><th>Status</th></tr></thead>
                <tbody>{data.milestones.map((x) => <tr key={x.t.id}><td className="font-medium">{x.t.name}</td><td className="text-xs">{formatDate(fromDayNumber(x.s.start))}</td><td className="text-xs">{x.bl ? formatDate(x.bl.start_date) : '–'}</td><td className="text-right text-xs">{x.bl ? <Delta days={x.s.start - toDayNumber(x.bl.start_date)} suffix=" T" /> : ''}</td><td>{x.t.status === 'done' ? <Badge tone="ok">erreicht</Badge> : x.s.isCritical ? <Badge tone="danger">kritisch</Badge> : <Badge tone="neutral">offen</Badge>}</td></tr>)}</tbody></table>
            </Section>
          )}
          {show('reasons') && (
            <Section title="Änderungsursachen" onCsv={() => downloadCsv('ursachen.csv', ['Grund', 'Anzahl', 'Tage'], data.reasons.map(([r, v]) => [DELAY_REASON_LABELS[r], String(v.count), String(v.days)]))}>
              {data.reasons.length === 0 ? <p className="text-sm text-ink-faint">Keine Verzögerungsereignisse erfasst.</p> : (
                <table className="data-table w-full text-sm"><thead><tr><th>Ursache</th><th className="text-right">Ereignisse</th><th className="text-right">Verlorene Arbeitstage</th></tr></thead>
                  <tbody>{data.reasons.map(([r, v]) => <tr key={r}><td className="font-medium">{DELAY_REASON_LABELS[r]}</td><td className="text-right">{v.count}</td><td className="text-right">{v.days}</td></tr>)}</tbody></table>
              )}
              {delays.length > 0 && <ul className="mt-3 space-y-1 text-xs text-ink-soft">{delays.slice(0, 10).map((d) => <li key={d.id}>{formatDate(d.created_at.slice(0, 10))}: <b>{p.plan.tasks.find((t) => t.id === d.task_id)?.name ?? '–'}</b> – {DELAY_REASON_LABELS[d.reason]}{d.days ? ` (+${d.days} AT)` : ''}{d.comment ? `: ${d.comment}` : ''}</li>)}</ul>}
            </Section>
          )}
          {show('lookahead') && (
            <Section title="Lookahead – nächste 4 Wochen" onCsv={() => downloadCsv('lookahead.csv', ['KW', 'Vorgang', 'Gewerk', 'Firma', 'Start', 'Ende', 'Status'], data.la.map((x) => [String(x.week.week), x.task.name, org.tradeName(x.task.trade_id), org.companyName(x.task.company_id), formatDate(x.start), formatDate(x.end), TASK_STATUS_LABELS[x.task.status]]))}>
              {data.la.length === 0 ? <p className="text-sm text-ink-faint">Keine Vorgänge in den nächsten vier Wochen.</p> : (
                <table className="data-table w-full text-sm"><thead><tr><th>KW</th><th>Vorgang</th><th>Gewerk / Firma</th><th>Zeitraum</th><th>Status</th></tr></thead>
                  <tbody>{data.la.map((x) => <tr key={x.task.id}><td className="text-xs">KW {x.week.week}</td><td className="font-medium">{x.task.name}</td><td className="text-xs">{org.tradeName(x.task.trade_id)}{x.task.company_id ? ` · ${org.companyName(x.task.company_id)}` : ''}</td><td className="text-xs">{formatDate(x.start, 'short')} – {formatDate(x.end, 'short')}</td><td className="text-xs">{TASK_STATUS_LABELS[x.task.status]}</td></tr>)}</tbody></table>
              )}
            </Section>
          )}
          <footer className="mt-8 border-t border-line pt-3 text-[11px] text-ink-faint">Erstellt mit BauTakt am {formatDate(todayISO())} · Termine in Arbeitstagen nach Projektkalender · Prognose berücksichtigt überfällige Restarbeiten.</footer>
        </div>
      </article>
    </div>
  )
}

function Section({ title, children, onCsv }: { title: string; children: React.ReactNode; onCsv?: () => void }) {
  return (
    <section className="mb-7 break-inside-avoid">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-base font-semibold">{title}</h2>
        {onCsv && <Button size="sm" variant="ghost" className="no-print" onClick={onCsv}><Download size={13} /> CSV</Button>}
      </div>
      {children}
    </section>
  )
}

function SimpleTaskTable({ rows, org }: { rows: { t: import('../../shared/types').Task; s: import('../../shared/engine/schedule').ScheduledTask }[]; org: ReturnType<typeof useOrg> }) {
  if (rows.length === 0) return <p className="text-sm text-ink-faint">Keine Vorgänge.</p>
  return (
    <table className="data-table w-full text-sm"><thead><tr><th>Vorgang</th><th>Gewerk / Firma</th><th>Zeitraum</th><th className="text-right">Ist / Soll</th><th>Status</th></tr></thead>
      <tbody>{rows.map((x) => <tr key={x.t.id}><td className="font-medium">{x.t.name}</td><td className="text-xs">{org.tradeName(x.t.trade_id)}{x.t.company_id ? ` · ${org.companyName(x.t.company_id)}` : ''}</td><td className="text-xs">{formatDate(fromDayNumber(x.s.start), 'short')} – {formatDate(fromDayNumber(x.s.end), 'short')}</td><td className="text-right text-xs">{x.t.progress} / {x.s.plannedProgress} %</td><td className="text-xs">{TASK_STATUS_LABELS[x.t.status]}</td></tr>)}</tbody></table>
  )
}
