/**
 * Lookahead-Ansicht (2/4/6/8 Wochen): nach Woche oder Tag, gruppiert nach Projekt → Gewerk
 * oder Gewerk → Projekt, mit Filtern (Projekt, Gewerk, Firma, Bauabschnitt, Verantwortlicher,
 * Status) und Voraussetzungen/Problemen je Vorgang. Druck-, PDF- und CSV-Export.
 */

import { useMemo, useState } from 'react'
import clsx from 'clsx'
import { Printer, Download, CheckCircle2, Circle, AlertTriangle, FileText } from 'lucide-react'
import type { Project, ProjectSection, Task, TaskConstraint, TaskDependency, TaskStatus } from '../../shared/types'
import type { ScheduleResult } from '../../shared/engine/schedule'
import { lookahead, type LookaheadItem } from '../../shared/engine/analysis'
import { taskReadiness } from '../../shared/engine/readiness'
import { formatDate, todayISO, addDays, toDayNumber, fromDayNumber, weekdayOf } from '../../shared/engine/dates'
import { Button, Tabs, StatusBadge, Badge, EmptyState, Select } from './ui'
import { useOrg } from '../store/org'
import { downloadCsv } from '../lib/export'
import { api } from '../lib/api'
import { TASK_STATUS_LABELS } from '../../shared/labels'

export interface LookaheadSource {
  project: Project
  tasks: Task[]
  dependencies: TaskDependency[]
  constraints: TaskConstraint[]
  sections: ProjectSection[]
  sched: ScheduleResult
}

const DAY_NAMES = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa']

export function LookaheadView({ sources, title, showProjectFilter }: { sources: LookaheadSource[]; title: string; showProjectFilter?: boolean }) {
  const org = useOrg()
  const [weeks, setWeeks] = useState<2 | 4 | 6 | 8>(4)
  const [group, setGroup] = useState<'project' | 'trade'>('project')
  const [mode, setMode] = useState<'week' | 'day'>('week')
  const [f, setF] = useState({ project: '', trade: '', company: '', section: '', responsible: '', status: '' as TaskStatus | '' })
  const today = todayISO()

  const items = useMemo(() => {
    const out: (LookaheadItem & { project: Project; src: LookaheadSource })[] = []
    for (const s of sources) {
      if (f.project && s.project.id !== f.project) continue
      for (const it of lookahead(s.tasks, s.sched, today, weeks)) {
        const t = it.task
        if (f.trade && t.trade_id !== f.trade) continue
        if (f.company && t.company_id !== f.company) continue
        if (f.section && t.section_id !== f.section) continue
        if (f.responsible && t.responsible_user_id !== f.responsible) continue
        if (f.status && t.status !== f.status) continue
        out.push({ ...it, project: s.project, src: s })
      }
    }
    return out
  }, [sources, weeks, today, f])

  const byBucket = useMemo(() => {
    const m = new Map<string, (LookaheadItem & { project: Project; src: LookaheadSource })[]>()
    if (mode === 'week') {
      for (const it of items) (m.get(it.week.monday) ?? m.set(it.week.monday, []).get(it.week.monday)!).push(it)
    } else {
      // Tagesansicht: jeder Vorgang an jedem Arbeitstag, an dem er läuft
      const seen = new Set<string>()
      for (const it of items) {
        const key = it.task.id
        if (seen.has(key)) continue
        seen.add(key)
        const from = Math.max(toDayNumber(it.start), toDayNumber(today))
        const to = Math.min(toDayNumber(it.end), toDayNumber(today) + weeks * 7 - 1)
        for (let d = from; d <= to; d++) {
          const wd = weekdayOf(d)
          if (wd === 0 || wd === 6) continue
          const iso = fromDayNumber(d)
          ;(m.get(iso) ?? m.set(iso, []).get(iso)!).push(it)
        }
      }
    }
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [items, mode, weeks, today])

  const sections = useMemo(() => sources.flatMap((s) => s.sections), [sources])
  const exportCsv = () =>
    downloadCsv(`lookahead-${today}.csv`, ['KW', 'Woche ab', 'Projekt', 'Gewerk', 'Vorgang', 'Firma', 'Verantwortlich', 'Start', 'Ende', 'Status', 'Soll %', 'Ist %', 'Kritisch', 'Voraussetzungen offen'],
      items.map((it) => { const r = taskReadiness(it.task, it.src.tasks, it.src.dependencies, it.src.constraints); return [String(it.week.week), formatDate(it.week.monday), it.project.name, org.tradeName(it.task.trade_id), it.task.name, org.companyName(it.task.company_id), org.userName(it.task.responsible_user_id), formatDate(it.start), formatDate(it.end), TASK_STATUS_LABELS[it.task.status], String(it.plannedProgress), String(it.task.progress), it.isCritical ? 'ja' : '', String(r.openCount)] }))

  return (
    <div className="print-page">
      <div className="no-print mb-3 flex flex-wrap items-center gap-2">
        <Tabs value={String(weeks)} onChange={(v) => setWeeks(Number(v) as 2)} items={[{ value: '2', label: '2 Wochen' }, { value: '4', label: '4 Wochen' }, { value: '6', label: '6 Wochen' }, { value: '8', label: '8 Wochen' }]} />
        <Tabs value={mode} onChange={setMode} items={[{ value: 'week', label: 'Nach Woche' }, { value: 'day', label: 'Nach Tag' }]} />
        <Tabs value={group} onChange={setGroup} items={[{ value: 'project', label: 'Projekt → Gewerk' }, { value: 'trade', label: 'Gewerk → Projekt' }]} />
        <div className="ml-auto flex gap-2">
          <Button size="sm" onClick={exportCsv}><Download size={14} /> CSV</Button>
          {sources.length === 1 && <Button size="sm" onClick={() => api.reports.open(sources[0].project.id, 'lookahead', { weeks: String(weeks) })}><FileText size={14} /> PDF</Button>}
          <Button size="sm" onClick={() => window.print()}><Printer size={14} /> Drucken</Button>
        </div>
      </div>
      <div className="no-print mb-4 flex flex-wrap items-center gap-2">
        {showProjectFilter && <Select value={f.project} onChange={(e) => setF({ ...f, project: e.target.value })} className="h-8 w-48 text-xs"><option value="">Alle Projekte</option>{sources.map((s) => <option key={s.project.id} value={s.project.id}>{s.project.name}</option>)}</Select>}
        <Select value={f.trade} onChange={(e) => setF({ ...f, trade: e.target.value })} className="h-8 w-40 text-xs"><option value="">Alle Gewerke</option>{org.trades.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select>
        <Select value={f.company} onChange={(e) => setF({ ...f, company: e.target.value })} className="h-8 w-44 text-xs"><option value="">Alle Firmen</option>{org.companies.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select>
        <Select value={f.section} onChange={(e) => setF({ ...f, section: e.target.value })} className="h-8 w-40 text-xs"><option value="">Alle Bauabschnitte</option>{sections.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select>
        <Select value={f.responsible} onChange={(e) => setF({ ...f, responsible: e.target.value })} className="h-8 w-40 text-xs"><option value="">Alle Verantwortlichen</option>{org.members.map((m) => <option key={m.user_id} value={m.user_id}>{m.user?.name}</option>)}</Select>
        <Select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value as TaskStatus | '' })} className="h-8 w-36 text-xs"><option value="">Alle Status</option>{(Object.keys(TASK_STATUS_LABELS) as TaskStatus[]).map((s) => <option key={s} value={s}>{TASK_STATUS_LABELS[s]}</option>)}</Select>
        <span className="text-xs text-ink-faint">{new Set(items.map((i) => i.task.id)).size} Vorgänge</span>
      </div>
      <div className="mb-4 hidden print:block">
        <h1 className="text-lg font-semibold">{title} – Lookahead {weeks} Wochen</h1>
        <p className="text-xs text-ink-soft">Stand {formatDate(today)} · {formatDate(today)} bis {formatDate(addDays(today, weeks * 7 - 1))}</p>
      </div>
      {byBucket.length === 0 && <EmptyState title="Keine Vorgänge im Zeitraum" description="In den gewählten Wochen sind keine offenen Vorgänge geplant (oder der Filter ist zu eng)." />}
      <div className="space-y-5">
        {byBucket.map(([key, list]) => {
          const groups = new Map<string, typeof list>()
          for (const it of list) {
            const k = group === 'project' ? `${it.project.name}|||${org.tradeName(it.task.trade_id)}` : `${org.tradeName(it.task.trade_id)}|||${it.project.name}`
            ;(groups.get(k) ?? groups.set(k, []).get(k)!).push(it)
          }
          const label = mode === 'week' ? `KW ${list[0].week.week}` : `${DAY_NAMES[weekdayOf(toDayNumber(key))]} ${formatDate(key)}`
          const sub = mode === 'week' ? `${formatDate(key)} – ${formatDate(addDays(key, 6))}` : key === today ? 'heute' : ''
          return (
            <section key={key} className="rounded-xl border border-line bg-surface">
              <header className="flex items-center gap-3 border-b border-line bg-surface-2 px-4 py-2 print:bg-white">
                <span className="text-sm font-semibold">{label}</span>
                <span className="text-xs text-ink-faint">{sub}</span>
                <Badge tone="neutral" className="ml-auto">{list.length} Vorgänge</Badge>
              </header>
              {[...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, glist]) => {
                const [primary, secondary] = k.split('|||')
                return (
                  <div key={k} className="border-b border-line last:border-b-0">
                    <div className="flex items-center gap-2 px-4 pt-2.5 pb-1 text-xs font-semibold text-ink-soft"><span>{primary}</span><span className="text-ink-faint">›</span><span className="font-normal">{secondary}</span></div>
                    <table className="w-full text-sm">
                      <tbody>
                        {glist.map((it) => {
                          const r = taskReadiness(it.task, it.src.tasks, it.src.dependencies, it.src.constraints)
                          const problems = r.items.filter((x) => x.state !== 'ok')
                          return (
                            <tr key={it.task.id + key} className="border-t border-line/60 align-top">
                              <td className="px-4 py-1.5"><span className="mr-2 inline-block h-2 w-2 rounded-sm align-middle" style={{ background: org.tradeColor(it.task.trade_id) }} />{it.task.name}{it.isCritical && <Badge tone="danger" className="ml-2">kritisch</Badge>}
                                {problems.length > 0 && <ul className="mt-0.5 space-y-0.5 text-[11px]">{problems.map((x) => <li key={x.id} className={clsx('flex items-center gap-1', x.state === 'warn' ? 'text-warn' : 'text-ink-faint')}>{x.state === 'warn' ? <AlertTriangle size={11} /> : <Circle size={11} />}{x.label} <span className="text-ink-faint">· {x.detail}</span></li>)}</ul>}
                                {problems.length === 0 && r.items.length > 0 && it.task.status !== 'done' && <div className="mt-0.5 flex items-center gap-1 text-[11px] text-ok"><CheckCircle2 size={11} /> ausführungsbereit</div>}
                              </td>
                              <td className="px-2 py-1.5 text-xs text-ink-soft">{org.companyName(it.task.company_id) !== '–' ? org.companyName(it.task.company_id) : org.userName(it.task.responsible_user_id)}</td>
                              <td className="whitespace-nowrap px-2 py-1.5 text-xs text-ink-soft">{formatDate(it.start, 'short')}–{formatDate(it.end, 'short')}</td>
                              <td className="px-2 py-1.5 text-xs text-ink-soft">{it.task.progress} % / Soll {it.plannedProgress} %</td>
                              <td className="px-4 py-1.5 text-right"><StatusBadge status={it.task.status} /></td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                )
              })}
            </section>
          )
        })}
      </div>
    </div>
  )
}
