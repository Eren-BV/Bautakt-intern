/**
 * PDF-Berichte (§36): Gesamtterminplan, Kategorieplan, Lookahead, Meilensteinplan,
 * Terminabweichungsbericht, Projektstatusbericht. Kundentaugliche Dokumente aus pdf-lib.
 */

import { Hono } from 'hono'
import { HttpError, type AppEnv } from '../auth.ts'
import { Repo } from '../repo.ts'
import { PdfDoc, C, hexToRgb, sanitize } from '../services/pdf.ts'
import { analyzeProject, criticalEvents, lookahead } from '../../shared/engine/analysis.ts'
import { buildTradePlan } from '../../shared/engine/tradePlan.ts'
import { taskReadiness } from '../../shared/engine/readiness.ts'
import { flattenTree } from '../../shared/engine/operations.ts'
import { formatDate, fromDayNumber, toDayNumber, todayISO, addDays } from '../../shared/engine/dates.ts'
import { HEALTH_LABELS, TASK_STATUS_LABELS, DELAY_REASON_LABELS } from '../../shared/labels.ts'
import type { ProjectBundle, Task, DelayEvent } from '../../shared/types.ts'
import type { ProjectAnalysis } from '../../shared/engine/analysis.ts'

export const reportRoutes = new Hono<AppEnv>()

async function load(c: { get: (k: 'db' | 'session') => unknown }, projectId: string) {
  const db = c.get('db') as AppEnv['Variables']['db']
  const s = c.get('session') as AppEnv['Variables']['session']
  const repo = new Repo(db)
  const bundle = await repo.bundle(s.org.id, projectId)
  if (!bundle) throw new HttpError(404, 'Projekt nicht gefunden.')
  const a = analyzeProject(bundle)
  const trades = await repo.trades(s.org.id)
  const companies = await repo.companies(s.org.id)
  const tradeName = (id: string | null) => trades.find((t) => t.id === id)?.name ?? ''
  const tradeColor = (id: string | null) => hexToRgb(trades.find((t) => t.id === id)?.color ?? '#64748b')
  const companyName = (id: string | null) => companies.find((t) => t.id === id)?.name ?? ''
  const userNames = new Map<string, string>()
  for (const id of [bundle.project.project_manager_id, bundle.project.site_manager_id]) {
    if (id && !userNames.has(id)) userNames.set(id, await repo.userName(id))
  }
  const userName = (id: string | null) => (id ? userNames.get(id) ?? '' : '')
  return { db, repo, session: s, bundle, a, trades, companies, tradeName, tradeColor, companyName, userName }
}

const pdfResponse = async (doc: PdfDoc, filename: string) => {
  const bytes = await doc.bytes()
  return new Response(new Uint8Array(bytes), { headers: { 'content-type': 'application/pdf', 'content-disposition': `inline; filename="${filename}"` } })
}

const ganttRows = (a: ProjectAnalysis, tasks: Task[], tradeColor: (id: string | null) => ReturnType<typeof hexToRgb>, tradeName: (id: string | null) => string) =>
  flattenTree(tasks).map((f) => {
    const s = a.current.tasks.get(f.task.id)!
    const bl = a.baselineTasks.get(f.task.id)
    return {
      cells: [f.task.name, tradeName(f.task.trade_id), f.task.type === 'milestone' ? '' : `${s.duration}`, formatDate(fromDayNumber(s.start), 'short'), f.task.type === 'milestone' ? '' : formatDate(fromDayNumber(s.end), 'short'), f.task.type === 'milestone' ? '' : `${f.task.progress}`],
      depth: f.depth,
      isParent: f.hasChildren,
      isMilestone: f.task.type === 'milestone',
      start: fromDayNumber(s.start),
      end: fromDayNumber(s.end),
      progress: f.task.progress,
      color: tradeColor(f.task.trade_id),
      critical: s.isCritical,
      baseline: bl ? { start: bl.start_date, end: bl.end_date } : null,
      done: f.task.status === 'done',
    }
  })

function projectHeader(doc: PdfDoc, bundle: ProjectBundle, a: ProjectAnalysis, userName: (id: string | null) => string) {
  const p = bundle.project
  doc.text(`${p.number} · ${p.address}${p.city ? `, ${p.city}` : ''} · Bauherr: ${p.customer || '–'} · PL: ${userName(p.project_manager_id) || '–'} · BL: ${userName(p.site_manager_id) || '–'}`, { size: 8.5, color: C.soft })
  doc.kv([
    ['Status', HEALTH_LABELS[a.health]],
    ['Fortschritt', `${a.progress} %`],
    [a.baseline_end ? 'Ursprüngliche Fertigstellung' : 'Zieltermin', formatDate(a.baseline_end ?? p.target_end_date)],
    ['Aktuelle Prognose', formatDate(a.forecast_end)],
    ['Abweichung', `${a.variance_days > 0 ? '+' : ''}${a.variance_days} AT`],
    ['Kritische Vorgänge', String(a.critical_count)],
  ])
}

// ---- Gesamtterminplan (Querformat, Gantt)
reportRoutes.get('/projects/:id/reports/schedule.pdf', async (c) => {
  const { bundle, a, session, tradeColor, tradeName, userName } = await load(c, c.req.param('id'))
  const doc = await PdfDoc.create({ title: `Gesamtterminplan – ${bundle.project.name}`, org: session.org.name, landscape: true })
  doc.h1(`Gesamtterminplan ${bundle.project.name}`)
  projectHeader(doc, bundle, a, userName)
  doc.gantt(ganttRows(a, bundle.tasks, tradeColor, tradeName), [{ label: 'Vorgang', width: 150 }, { label: 'Kategorie', width: 58 }, { label: 'AT', width: 20, align: 'right' }, { label: 'Start', width: 34 }, { label: 'Ende', width: 34 }, { label: '%', width: 20, align: 'right' }], { start: fromDayNumber(a.current.projectStart), end: fromDayNumber(a.current.projectEnd) })
  doc.text('Rot umrandet = terminentscheidend (kritischer Pfad) · grauer Strich unter dem Balken = Baseline · gestrichelte Linie = heute', { size: 7, color: C.faint })
  return pdfResponse(doc, `Terminplan_${bundle.project.number || bundle.project.id}.pdf`)
})

// ---- Projektstatusbericht
reportRoutes.get('/projects/:id/reports/status.pdf', async (c) => {
  const { bundle, a, session, repo, tradeName, companyName, userName } = await load(c, c.req.param('id'))
  const doc = await PdfDoc.create({ title: `Projektstatusbericht – ${bundle.project.name}`, org: session.org.name })
  doc.h1(`Projektstatusbericht ${bundle.project.name}`)
  projectHeader(doc, bundle, a, userName)
  const events = criticalEvents(bundle.project, bundle, a)
  doc.h2('Was braucht Aufmerksamkeit?')
  if (events.length === 0) doc.text('Keine kritischen Ereignisse – das Projekt läuft im Plan.', { color: C.ok })
  for (const e of events.slice(0, 8)) doc.bullet(e.message, e.severity === 'critical' ? C.danger : e.severity === 'warning' ? C.warn : C.brand)
  doc.h2('Phasen')
  const phases = bundle.tasks.filter((t) => t.type === 'phase' && !t.parent_id).sort((x, y) => x.sort_order - y.sort_order)
  doc.table(
    [{ label: 'Phase', width: 190, bold: true }, { label: 'Start', width: 60 }, { label: 'Ende', width: 60 }, { label: 'Fortschritt', width: 60, align: 'right' }, { label: 'Abw. Ende', width: 60, align: 'right' }, { label: 'Status', width: 85 }],
    phases.map((ph) => {
      const s = a.current.tasks.get(ph.id)!
      const kids = bundle.tasks.filter((t) => t.parent_id === ph.id)
      const prog = kids.length ? Math.round(kids.reduce((x, t) => x + (t.status === 'done' ? 100 : t.progress), 0) / kids.length) : 0
      const bl = a.baselineTasks.get(ph.id)
      const delta = bl ? s.end - toDayNumber(bl.end_date) : null
      return [ph.name, formatDate(fromDayNumber(s.start)), formatDate(fromDayNumber(s.end)), `${prog} %`, { text: delta === null ? '–' : `${delta > 0 ? '+' : ''}${delta} T`, color: delta && delta > 0 ? C.danger : C.ok }, kids.every((t) => t.status === 'done') ? 'abgeschlossen' : s.start > toDayNumber(todayISO()) ? 'geplant' : 'läuft']
    }),
  )
  doc.h2('Meilensteine')
  doc.table(
    [{ label: 'Meilenstein', width: 200, bold: true }, { label: 'Termin', width: 70 }, { label: 'Baseline', width: 70 }, { label: 'Abw.', width: 50, align: 'right' }, { label: 'Status', width: 90 }],
    bundle.tasks.filter((t) => t.type === 'milestone').map((t) => ({ t, s: a.current.tasks.get(t.id)!, bl: a.baselineTasks.get(t.id) })).sort((x, y) => x.s.start - y.s.start)
      .map(({ t, s, bl }) => [t.name, formatDate(fromDayNumber(s.start)), bl ? formatDate(bl.start_date) : '–', bl ? { text: `${s.start - toDayNumber(bl.start_date) > 0 ? '+' : ''}${s.start - toDayNumber(bl.start_date)} T`, color: s.start - toDayNumber(bl.start_date) > 0 ? C.danger : C.ok } : '', t.status === 'done' ? { text: 'erreicht', color: C.ok } : s.isCritical ? { text: 'kritisch', color: C.danger } : 'offen']),
  )
  const delays = await repo.delays(bundle.project.id)
  if (delays.length) {
    doc.h2('Verzögerungsursachen')
    const byReason = new Map<string, { n: number; days: number }>()
    for (const d of delays) {
      const e = byReason.get(d.reason) ?? { n: 0, days: 0 }
      e.n++
      e.days += d.days
      byReason.set(d.reason, e)
    }
    doc.table([{ label: 'Ursache', width: 200 }, { label: 'Ereignisse', width: 80, align: 'right' }, { label: 'Verlorene AT', width: 80, align: 'right' }], [...byReason.entries()].map(([r, v]) => [DELAY_REASON_LABELS[r as DelayEvent['reason']] ?? r, String(v.n), String(v.days)]))
    for (const d of delays.slice(0, 6)) doc.bullet(`${formatDate(d.created_at.slice(0, 10))}: ${bundle.tasks.find((t) => t.id === d.task_id)?.name ?? '–'} – ${DELAY_REASON_LABELS[d.reason]}${d.days ? ` (+${d.days} AT)` : ''}${d.comment ? `: ${d.comment}` : ''}`, C.soft)
  }
  doc.h2('Laufende Arbeiten')
  const running = bundle.tasks.filter((t) => t.status !== 'done' && a.current.tasks.get(t.id)?.isLeaf && a.current.tasks.get(t.id)!.start <= toDayNumber(todayISO())).slice(0, 15)
  doc.table([{ label: 'Vorgang', width: 170, bold: true }, { label: 'Kategorie / Firma', width: 130 }, { label: 'Zeitraum', width: 95 }, { label: 'Ist / Soll', width: 60, align: 'right' }, { label: 'Status', width: 60 }],
    running.map((t) => { const s = a.current.tasks.get(t.id)!; return [t.name, `${tradeName(t.trade_id)}${t.company_id ? ` · ${companyName(t.company_id)}` : ''}`, `${formatDate(fromDayNumber(s.start), 'short')} – ${formatDate(fromDayNumber(s.end), 'short')}`, `${t.progress} / ${s.plannedProgress} %`, { text: TASK_STATUS_LABELS[t.status], color: t.status === 'delayed' ? C.danger : t.status === 'at_risk' ? C.warn : C.ink }] }))
  return pdfResponse(doc, `Statusbericht_${bundle.project.number || bundle.project.id}.pdf`)
})

// ---- Meilensteinplan
reportRoutes.get('/projects/:id/reports/milestones.pdf', async (c) => {
  const { bundle, a, session, userName } = await load(c, c.req.param('id'))
  const doc = await PdfDoc.create({ title: `Meilensteinplan – ${bundle.project.name}`, org: session.org.name })
  doc.h1(`Meilensteinplan ${bundle.project.name}`)
  projectHeader(doc, bundle, a, userName)
  const list = bundle.tasks.filter((t) => t.type === 'milestone').map((t) => ({ t, s: a.current.tasks.get(t.id)!, bl: a.baselineTasks.get(t.id) })).sort((x, y) => x.s.start - y.s.start)
  doc.table([{ label: 'Meilenstein', width: 190, bold: true }, { label: 'Phase', width: 120 }, { label: 'Termin', width: 65 }, { label: 'Baseline', width: 65 }, { label: 'Abw.', width: 40, align: 'right' }, { label: 'Status', width: 60 }],
    list.map(({ t, s, bl }) => [t.name, bundle.tasks.find((x) => x.id === t.parent_id)?.name ?? '', formatDate(fromDayNumber(s.start)), bl ? formatDate(bl.start_date) : '–', bl ? `${s.start - toDayNumber(bl.start_date) > 0 ? '+' : ''}${s.start - toDayNumber(bl.start_date)}` : '', t.status === 'done' ? { text: 'erreicht', color: C.ok } : s.isCritical ? { text: 'kritisch', color: C.danger } : 'offen']), { rowHeight: 18 })
  return pdfResponse(doc, `Meilensteine_${bundle.project.number || bundle.project.id}.pdf`)
})

// ---- Terminabweichungsbericht
reportRoutes.get('/projects/:id/reports/variance.pdf', async (c) => {
  const { bundle, a, session, tradeName, userName } = await load(c, c.req.param('id'))
  const doc = await PdfDoc.create({ title: `Terminabweichungsbericht – ${bundle.project.name}`, org: session.org.name })
  doc.h1(`Terminabweichungsbericht ${bundle.project.name}`)
  projectHeader(doc, bundle, a, userName)
  if (!a.activeBaseline) doc.text('Keine Baseline gespeichert – Abweichungen beziehen sich auf den Zieltermin.', { color: C.warn })
  else doc.text(`Baseline: ${a.activeBaseline.name} vom ${formatDate(a.activeBaseline.created_at.slice(0, 10))} · ursprüngliches Projektende ${formatDate(a.activeBaseline.project_end)}`, { size: 8.5, color: C.soft })
  const rows = flattenTree(bundle.tasks).map((f) => ({ f, s: a.current.tasks.get(f.task.id)!, bl: a.baselineTasks.get(f.task.id) })).filter((x) => x.bl && x.s.end !== toDayNumber(x.bl.end_date))
  doc.h2(`Vorgänge mit Abweichung (${rows.length})`)
  doc.table([{ label: 'Vorgang', width: 180, bold: true }, { label: 'Kategorie', width: 70 }, { label: 'Baseline', width: 95 }, { label: 'Aktuell', width: 95 }, { label: 'Abw.', width: 45, align: 'right' }, { label: 'Status', width: 55 }],
    rows.map(({ f, s, bl }) => { const d = s.end - toDayNumber(bl!.end_date); return [{ text: f.task.name, bold: f.hasChildren }, tradeName(f.task.trade_id), `${formatDate(bl!.start_date, 'short')} – ${formatDate(bl!.end_date, 'short')}`, `${formatDate(fromDayNumber(s.start), 'short')} – ${formatDate(fromDayNumber(s.end), 'short')}`, { text: `${d > 0 ? '+' : ''}${d} T`, color: d > 0 ? C.danger : C.ok }, TASK_STATUS_LABELS[f.task.status]] }))
  return pdfResponse(doc, `Abweichungen_${bundle.project.number || bundle.project.id}.pdf`)
})

// ---- Lookahead
reportRoutes.get('/projects/:id/reports/lookahead.pdf', async (c) => {
  const { bundle, a, session, tradeName, companyName, userName } = await load(c, c.req.param('id'))
  const weeks = Math.max(2, Math.min(8, Number(c.req.query('weeks') ?? 4)))
  const doc = await PdfDoc.create({ title: `Lookahead ${weeks} Wochen – ${bundle.project.name}`, org: session.org.name })
  doc.h1(`Lookahead ${weeks} Wochen – ${bundle.project.name}`)
  doc.text(`${formatDate(todayISO())} bis ${formatDate(addDays(todayISO(), weeks * 7 - 1))} · Leitung vor Ort: ${userName(bundle.project.site_manager_id) || '–'}`, { size: 8.5, color: C.soft })
  const items = lookahead(bundle.tasks, a.current, todayISO(), weeks)
  const byWeek = new Map<string, typeof items>()
  for (const it of items) (byWeek.get(it.week.monday) ?? byWeek.set(it.week.monday, []).get(it.week.monday)!).push(it)
  for (const [monday, list] of [...byWeek.entries()].sort()) {
    doc.h2(`KW ${list[0].week.week} · ${formatDate(monday)} – ${formatDate(addDays(monday, 6))}`)
    doc.table([{ label: 'Vorgang', width: 165, bold: true }, { label: 'Kategorie / Firma', width: 125 }, { label: 'Zeitraum', width: 80 }, { label: 'Ist/Soll', width: 45, align: 'right' }, { label: 'Voraussetzungen', width: 100 }],
      list.map((it) => { const r = taskReadiness(it.task, bundle.tasks, bundle.dependencies, bundle.constraints); return [it.task.name + (it.isCritical ? ' *' : ''), `${tradeName(it.task.trade_id)}${it.task.company_id ? ` · ${companyName(it.task.company_id)}` : ''}`, `${formatDate(it.start, 'short')} – ${formatDate(it.end, 'short')}`, `${it.task.progress}/${it.plannedProgress} %`, { text: r.openCount ? `${r.openCount} offen` : r.status === 'done' ? 'fertig' : 'bereit', color: r.openCount ? C.warn : C.ok }] }))
  }
  if (byWeek.size === 0) doc.text('Keine Vorgänge im Zeitraum.', { color: C.faint })
  doc.text('* = terminentscheidend', { size: 7, color: C.faint })
  return pdfResponse(doc, `Lookahead_${bundle.project.number || bundle.project.id}.pdf`)
})

// ---- Kategorieplan
reportRoutes.get('/projects/:id/reports/trade.pdf', async (c) => {
  const { bundle, a, session, trades, companies, tradeColor, tradeName, companyName, userName } = await load(c, c.req.param('id'))
  const tradeId = c.req.query('trade') || null
  const companyId = c.req.query('company') || null
  const relevance = (c.req.query('relevance') as 'compact' | 'standard' | 'full') || 'standard'
  if (!tradeId && !companyId) throw new HttpError(400, 'Kategorie oder Firma angeben.')
  const label = companyId ? companies.find((x) => x.id === companyId)?.name ?? '' : trades.find((x) => x.id === tradeId)?.name ?? ''
  const plan = buildTradePlan(bundle.tasks, bundle.dependencies, a.current, { tradeId, companyId }, relevance, label)
  const doc = await PdfDoc.create({ title: `Kategorieplan ${label} – ${bundle.project.name}`, org: session.org.name, landscape: true })
  doc.h1(`Kategorieplan ${label}`)
  doc.text(`${bundle.project.name} · ${bundle.project.address}${bundle.project.city ? `, ${bundle.project.city}` : ''} · Leitung vor Ort: ${userName(bundle.project.site_manager_id) || '–'} · Relevanz: ${relevance === 'compact' ? 'kompakt' : relevance === 'full' ? 'vollständig' : 'standard'}`, { size: 8.5, color: C.soft })
  doc.kv([
    ['Erster Einsatz', plan.firstStart !== null ? formatDate(fromDayNumber(plan.firstStart)) : '–'],
    ['Letzter Einsatz', plan.lastEnd !== null ? formatDate(fromDayNumber(plan.lastEnd)) : '–'],
    ['Eigene Arbeiten', String(plan.own.length)],
    ['Fortschritt', `${plan.progress} %`],
  ], 4)
  const section = (title: string, list: typeof plan.own, showRel: boolean) => {
    doc.h2(title)
    if (list.length === 0) return doc.text('–', { color: C.faint })
    doc.table([{ label: 'Vorgang', width: 220, bold: true }, { label: 'Kategorie / Firma', width: 160 }, { label: 'Start', width: 60 }, { label: 'Ende', width: 60 }, { label: 'Status', width: 80 }, { label: showRel ? 'Beziehung' : 'Bereitschaft', width: 180 }],
      list.map((x) => { const r = taskReadiness(x.task, bundle.tasks, bundle.dependencies, bundle.constraints); return [x.task.name + (x.isCritical ? ' *' : ''), `${tradeName(x.task.trade_id)}${x.task.company_id ? ` · ${companyName(x.task.company_id)}` : ''}`, formatDate(fromDayNumber(x.start)), x.task.type === 'milestone' ? '' : formatDate(fromDayNumber(x.end)), TASK_STATUS_LABELS[x.task.status], showRel ? x.relation : { text: r.label + (r.openCount ? ` (${r.openCount} offen)` : ''), color: r.status === 'not_ready' ? C.warn : C.ok }] }))
  }
  section('Vor dir – Vorleistungen', plan.before, true)
  section('Deine Arbeit', plan.own, false)
  section('Nach dir – Folgearbeiten', plan.after, true)
  section('Betroffene Meilensteine', plan.milestones, false)
  const all = [...plan.before, ...plan.own, ...plan.after, ...plan.milestones].sort((x, y) => x.start - y.start)
  if (all.length) {
    doc.h2('Zeitplan')
    doc.gantt(all.map((x) => ({ cells: [x.task.name, tradeName(x.task.trade_id), formatDate(fromDayNumber(x.start), 'short'), x.task.type === 'milestone' ? '' : formatDate(fromDayNumber(x.end), 'short')], depth: 0, isParent: false, isMilestone: x.task.type === 'milestone', start: fromDayNumber(x.start), end: fromDayNumber(x.end), progress: x.task.progress, color: x.distance === 0 ? tradeColor(x.task.trade_id) : C.baseline, critical: x.isCritical, done: x.task.status === 'done' })),
      [{ label: 'Vorgang', width: 170 }, { label: 'Kategorie', width: 60 }, { label: 'Start', width: 36 }, { label: 'Ende', width: 36 }], { start: fromDayNumber(Math.min(...all.map((x) => x.start))), end: fromDayNumber(Math.max(...all.map((x) => x.end))) })
    doc.text('Farbig = eigene Arbeiten · grau = Vor-/Folgearbeiten · * = terminentscheidend', { size: 7, color: C.faint })
  }
  doc.text(sanitize('Änderungen bitte über den Share-Link oder direkt an die Projektleitung melden – der Terminplan wird nicht automatisch geändert.'), { size: 7.5, color: C.faint })
  return pdfResponse(doc, `Kategorieplan_${label.replace(/[^\w]+/g, '_')}_${bundle.project.number || bundle.project.id}.pdf`)
})
