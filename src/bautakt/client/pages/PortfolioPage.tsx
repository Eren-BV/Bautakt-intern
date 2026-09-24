/**
 * Portfolio: alle Projekte auf einer gemeinsamen Timeline (Projektbalken, Phasen,
 * Meilensteine, Heute) plus Ressourcenüberschneidungen.
 */

import { useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import { ChevronDown, ChevronRight, AlertTriangle } from 'lucide-react'
import { api, type PortfolioEntry } from '../lib/api'
import { navigate } from '../lib/router'
import { Badge, Card, ErrorBox, HealthBadge, PageHeader, Spinner, Tabs } from '../components/ui'
import { buildScale, headerTicks, VIEW_PX, type ViewMode } from '../components/gantt/scale'
import { formatDate, toDayNumber, todayISO } from '../../shared/engine/dates'
import type { ResourceConflict } from '../../shared/engine/analysis'

const ROW = 34

export function PortfolioPage() {
  const [data, setData] = useState<PortfolioEntry[] | null>(null)
  const [conflicts, setConflicts] = useState<ResourceConflict[]>([])
  const [error, setError] = useState<string | null>(null)
  const [view, setView] = useState<ViewMode>('month')
  const [open, setOpen] = useState<Set<string>>(new Set())
  useEffect(() => {
    api.portfolio().then(setData).catch((e) => setError(e.message))
    api.resources.conflicts().then(setConflicts).catch(() => {})
  }, [])

  const today = todayISO()
  const scale = useMemo(() => {
    if (!data || data.length === 0) return null
    let min = Infinity, max = -Infinity
    for (const e of data) {
      min = Math.min(min, toDayNumber(e.project.start_date))
      max = Math.max(max, toDayNumber(e.forecast_end), toDayNumber(e.project.target_end_date))
    }
    return buildScale(min - 14, max + 30, VIEW_PX[view])
  }, [data, view])

  if (error) return <div className="p-6"><ErrorBox message={error} /></div>
  if (!data || !scale) return <Spinner />
  const ticks = headerTicks(scale)
  const sorted = [...data].sort((a, b) => a.project.start_date.localeCompare(b.project.start_date))
  const rows: { kind: 'project' | 'phase'; entry: PortfolioEntry; phase?: PortfolioEntry['phases'][number] }[] = []
  for (const e of sorted) {
    rows.push({ kind: 'project', entry: e })
    if (open.has(e.project.id)) for (const ph of e.phases) rows.push({ kind: 'phase', entry: e, phase: ph })
  }
  const LEFT = 300
  const todayX = scale.x(toDayNumber(today)) + scale.pxPerDay / 2
  const healthColor = (h: PortfolioEntry['health']) => (h === 'red' ? '#dc2626' : h === 'yellow' ? '#d97706' : h === 'grey' ? '#9ca3af' : '#16a34a')

  return (
    <div className="mx-auto max-w-[1600px] p-4 sm:p-6">
      <PageHeader title="Portfolio" subtitle={`${data.filter((e) => e.project.state === 'active').length} aktive Projekte auf einer Timeline`} actions={<Tabs value={view} onChange={setView} items={[{ value: 'week', label: 'Woche' }, { value: 'month', label: 'Monat' }, { value: 'quarter', label: 'Quartal' }]} />} />
      <Card padded={false} className="overflow-hidden">
        <div className="overflow-auto">
          <div style={{ width: LEFT + scale.width }}>
            <div className="sticky top-0 z-10 flex border-b border-line bg-surface-2" style={{ height: 52 }}>
              <div className="sticky left-0 z-20 flex shrink-0 items-end border-r border-line bg-surface-2 px-3 pb-1.5 text-[11px] font-semibold tracking-wide text-ink-faint uppercase" style={{ width: LEFT }}>Projekt</div>
              <div className="relative shrink-0" style={{ width: scale.width }}>
                {ticks.top.map((t) => <div key={t.key} className="absolute top-0 flex h-6 items-center truncate border-r border-line px-2 text-[11px] font-semibold text-ink-soft" style={{ left: t.x, width: t.width }}>{t.width > 50 ? t.label : ''}</div>)}
                {ticks.bottom.map((t) => <div key={t.key} className="absolute top-6 flex h-6 items-center justify-center truncate border-r border-line/70 text-[10px] text-ink-soft" style={{ left: t.x, width: t.width }}>{t.width >= 18 ? t.label : ''}</div>)}
              </div>
            </div>
            <div className="relative flex">
              <div className="sticky left-0 z-10 shrink-0 border-r border-line bg-surface" style={{ width: LEFT }}>
                {rows.map((r, i) => (
                  <div key={i} className={clsx('flex items-center gap-2 border-b border-line px-3 text-sm', r.kind === 'phase' && 'pl-9 text-xs text-ink-soft')} style={{ height: ROW }}>
                    {r.kind === 'project' ? (
                      <>
                        <button type="button" className="text-ink-faint hover:text-ink" onClick={() => setOpen((s) => { const n = new Set(s); if (n.has(r.entry.project.id)) n.delete(r.entry.project.id); else n.add(r.entry.project.id); return n })}>{open.has(r.entry.project.id) ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button>
                        <button type="button" className="min-w-0 flex-1 truncate text-left font-medium hover:underline" onClick={() => navigate(`/projects/${r.entry.project.id}`)}>{r.entry.project.name}</button>
                        <HealthBadge health={r.entry.health} />
                      </>
                    ) : (
                      <span className="truncate">{r.phase!.name}</span>
                    )}
                  </div>
                ))}
              </div>
              <svg width={scale.width} height={rows.length * ROW} className="shrink-0">
                {ticks.bottom.map((t) => <line key={t.key} x1={t.x} x2={t.x} y1={0} y2={rows.length * ROW} stroke="#e3e6eb" />)}
                {rows.map((_, i) => <line key={i} x1={0} x2={scale.width} y1={(i + 1) * ROW} y2={(i + 1) * ROW} stroke="#e3e6eb" />)}
                <line x1={todayX} x2={todayX} y1={0} y2={rows.length * ROW} stroke="#dc2626" strokeDasharray="4 3" strokeWidth={1.5} />
                {rows.map((r, i) => {
                  const cy = i * ROW + ROW / 2
                  if (r.kind === 'project') {
                    const e = r.entry
                    const x1 = scale.x(toDayNumber(e.project.start_date))
                    const x2 = scale.x(toDayNumber(e.forecast_end) + 1)
                    const xt = scale.x(toDayNumber(e.baseline_end ?? e.project.target_end_date) + 1)
                    return (
                      <g key={i} className="cursor-pointer" onClick={() => navigate(`/projects/${e.project.id}`)}>
                        <rect x={x1} y={cy - 9} width={Math.max(2, x2 - x1)} height={18} rx={4} fill={healthColor(e.health)} opacity={e.project.state === 'active' ? 0.9 : 0.5} />
                        <rect x={x1} y={cy - 9} width={Math.max(0, (x2 - x1) * (e.progress / 100))} height={18} rx={4} fill="black" opacity={0.25} />
                        {xt < x2 && <line x1={xt} x2={xt} y1={cy - 12} y2={cy + 12} stroke="#14171c" strokeWidth={2} />}
                        {e.milestones.map((m) => <path key={m.id} d={diamond(scale.x(toDayNumber(m.date)) + scale.pxPerDay / 2, cy + 13, 4)} fill={m.done ? '#16a34a' : '#1e293b'} />)}
                        <text x={x2 + 6} y={cy + 4} fontSize={11} fill="#525a66">{formatDate(e.forecast_end)}{e.variance_days ? ` (${e.variance_days > 0 ? '+' : ''}${e.variance_days} AT)` : ''}</text>
                      </g>
                    )
                  }
                  const ph = r.phase!
                  const x1 = scale.x(toDayNumber(ph.start))
                  const x2 = scale.x(toDayNumber(ph.end) + 1)
                  return (
                    <g key={i}>
                      <rect x={x1} y={cy - 6} width={Math.max(2, x2 - x1)} height={12} rx={3} fill={ph.is_critical ? '#b91c1c' : '#64748b'} opacity={0.8} />
                      <rect x={x1} y={cy - 6} width={Math.max(0, (x2 - x1) * (ph.progress / 100))} height={12} rx={3} fill="black" opacity={0.25} />
                    </g>
                  )
                })}
              </svg>
            </div>
          </div>
        </div>
        <div className="flex flex-wrap gap-4 border-t border-line px-3 py-2 text-[11px] text-ink-faint">
          <span><span className="mr-1 inline-block h-2.5 w-4 rounded-sm bg-ok align-middle" />Im Plan</span><span><span className="mr-1 inline-block h-2.5 w-4 rounded-sm bg-warn align-middle" />Gefährdet</span><span><span className="mr-1 inline-block h-2.5 w-4 rounded-sm bg-danger align-middle" />Verspätet</span><span><span className="mr-1 inline-block h-2.5 w-4 rounded-sm bg-muted align-middle" />Pausiert</span><span><span className="mr-1 inline-block h-3 w-0.5 bg-ink align-middle" />Ursprünglicher Endtermin</span><span>◆ Meilenstein</span>
        </div>
      </Card>

      <Card title="Ressourcenüberschneidungen" className="mt-6" padded={false}>
        {conflicts.length === 0 ? <div className="px-4 py-6 text-center text-sm text-ink-faint">Keine Überschneidungen zwischen Projekten.</div> : (
          <ul className="divide-y divide-line">
            {conflicts.slice(0, 20).map((c, i) => (
              <li key={i} className="flex items-start gap-3 px-4 py-2.5 text-sm">
                <AlertTriangle size={15} className="mt-0.5 shrink-0 text-warn" />
                <div><b>{c.resource.name}</b> ist in KW {c.week.week} ({formatDate(c.week.monday)}) gleichzeitig auf {c.projects.length} Projekten eingeplant: {c.projects.map((p) => p.project_name).join(', ')}.<Badge tone="warn" className="ml-2">Last {c.load}</Badge></div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}

function diamond(cx: number, cy: number, r: number): string {
  return `M ${cx} ${cy - r} L ${cx + r} ${cy} L ${cx} ${cy + r} L ${cx - r} ${cy} Z`
}
