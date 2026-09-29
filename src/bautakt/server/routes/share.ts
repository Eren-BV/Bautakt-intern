/**
 * Öffentliche Share-Routen (ohne Login): Kategorieplan per Token, Terminbestätigung bzw.
 * Terminvorschlag durch die Partnerfirma. Token wird nur gehasht gespeichert; Link ist
 * widerrufbar, optional befristet; es wird ausschließlich der freigegebene Umfang geliefert.
 */

import { Hono } from 'hono'
import type { Db, Row } from '../db.ts'
import { newId, nowISO } from '../db.ts'
import { sha256Hex } from '../auth.ts'
import { Repo } from '../repo.ts'
import type { ShareLink, TradeConfirmation } from '../../shared/types.ts'
import { analyzeProject } from '../../shared/engine/analysis.ts'
import { buildTradePlan } from '../../shared/engine/tradePlan.ts'
import { taskReadiness } from '../../shared/engine/readiness.ts'
import { fromDayNumber, formatDate, todayISO } from '../../shared/engine/dates.ts'
import { pushNotification } from '../services/notificationService.ts'
import { broadcastProject } from '../services/realtime.ts'

export function shareRoutes(db: Db) {
  const app = new Hono()

  const resolve = async (token: string): Promise<(ShareLink & { org_id: string }) | null> => {
    const hash = await sha256Hex(token)
    const r = await db.get<Row>('SELECT * FROM share_links WHERE token_hash = ?', hash)
    if (!r) return null
    const link = r as unknown as ShareLink & { org_id: string }
    if (link.revoked_at) return null
    if (link.expires_at && link.expires_at < nowISO()) return null
    return link
  }

  app.get('/share/:token', async (c) => {
    const link = await resolve(c.req.param('token'))
    if (!link) return c.json({ error: 'Dieser Link ist ungültig, abgelaufen oder wurde widerrufen.' }, 404)
    await db.run('UPDATE share_links SET use_count = use_count + 1, last_used_at = ? WHERE id = ?', nowISO(), link.id)
    const repo = new Repo(db)
    const bundle = await repo.bundle(link.org_id, link.project_id)
    if (!bundle) return c.json({ error: 'Projekt nicht gefunden.' }, 404)
    const a = analyzeProject(bundle)
    const trades = await repo.trades(link.org_id)
    const companies = await repo.companies(link.org_id)
    const scopeLabel = link.company_id ? companies.find((x) => x.id === link.company_id)?.name ?? '' : trades.find((x) => x.id === link.trade_id)?.name ?? ''
    const plan = buildTradePlan(bundle.tasks, bundle.dependencies, a.current, { tradeId: link.trade_id, companyId: link.company_id }, link.relevance, scopeLabel)
    // Nur freigegebener Umfang: keine Kosten, keine internen Notizen, keine fremden Vorgänge außerhalb der Relevanz
    const slim = (x: (typeof plan.own)[number]) => ({
      id: x.task.id, name: x.task.name, start: fromDayNumber(x.start), end: fromDayNumber(x.end), status: x.task.status, progress: x.task.progress, is_critical: x.isCritical,
      trade: trades.find((t) => t.id === x.task.trade_id)?.name ?? null, distance: x.distance, relation: x.relation, type: x.task.type,
      readiness: x.distance === 0 ? taskReadiness(x.task, bundle.tasks, bundle.dependencies, bundle.constraints) : null,
    })
    const confirmations = await db.all<TradeConfirmation>('SELECT * FROM trade_confirmations WHERE share_link_id = ? ORDER BY created_at DESC', link.id)
    return c.json({
      project: { name: bundle.project.name, city: bundle.project.city, number: bundle.project.number },
      scope: scopeLabel,
      relevance: link.relevance,
      contact: { site_manager: await repo.userName(bundle.project.site_manager_id), project_manager: await repo.userName(bundle.project.project_manager_id) },
      own: plan.own.map(slim),
      before: plan.before.map(slim),
      after: plan.after.map(slim),
      milestones: plan.milestones.map(slim),
      next_start: plan.own.find((x) => x.task.status !== 'done') ? fromDayNumber(plan.own.find((x) => x.task.status !== 'done')!.start) : null,
      confirmations,
      generated_at: nowISO(),
    })
  })

  app.post('/share/:token/confirm', async (c) => {
    const link = await resolve(c.req.param('token'))
    if (!link) return c.json({ error: 'Dieser Link ist ungültig, abgelaufen oder wurde widerrufen.' }, 404)
    const body = await c.req.json<{ task_id: string; status: 'confirmed' | 'not_possible'; proposed_start?: string | null; comment?: string; contact_name?: string }>()
    if (!body.task_id || !['confirmed', 'not_possible'].includes(body.status)) return c.json({ error: 'Ungültige Angaben.' }, 400)
    const repo = new Repo(db)
    const bundle = await repo.bundle(link.org_id, link.project_id)
    const task = bundle?.tasks.find((t) => t.id === body.task_id)
    // Nur eigene Vorgänge des freigegebenen Umfangs dürfen bestätigt werden
    if (!bundle || !task || !(link.company_id ? task.company_id === link.company_id : task.trade_id === link.trade_id)) return c.json({ error: 'Vorgang nicht im freigegebenen Umfang.' }, 403)
    const conf: TradeConfirmation = { id: newId('tc'), project_id: bundle.project.id, share_link_id: link.id, task_id: task.id, status: body.status, proposed_start: body.proposed_start ?? null, comment: (body.comment ?? '').slice(0, 1000), contact_name: (body.contact_name ?? '').slice(0, 120), created_at: nowISO() }
    await db.insert('trade_confirmations', conf)
    const from = conf.contact_name || link.label || 'Nachunternehmer'
    if (body.status === 'not_possible') {
      // Masterplan wird NICHT verändert - nur ein Vorschlag für den Projektleiter
      await db.insert('change_proposals', {
        id: newId('cp'), project_id: bundle.project.id, task_id: task.id, source: 'SUBCONTRACTOR_PROPOSAL', status: 'open', title: `${task.name}: ${body.proposed_start ? `Start ${formatDate(body.proposed_start)}` : 'Termin nicht möglich'}`, proposed_start: body.proposed_start ?? null, proposed_end: null, operations: [],
        reason: 'subcontractor', comment: conf.comment, submitted_by_name: from, submitted_by_user_id: null, share_link_id: link.id, origin_kind: 'share_link', origin_ref: null, created_at: nowISO(), decided_at: null, decided_by: null, decision_note: '',
      })
      await broadcastProject(link.org_id, bundle.project.id, 'proposal')
      pushNotification(db, { org_id: link.org_id, project_id: bundle.project.id, type: 'info', severity: 'warning', title: `Terminvorschlag von ${from}`, message: `${bundle.project.name}: „${task.name}“ – ${body.proposed_start ? `Start ${formatDate(body.proposed_start)} vorgeschlagen (geplant ${formatDate(task.start_date)})` : 'Termin nicht möglich'}${conf.comment ? ` – ${conf.comment}` : ''}` })
    } else {
      pushNotification(db, { org_id: link.org_id, project_id: bundle.project.id, type: 'info', severity: 'info', title: `Termin bestätigt: ${task.name}`, message: `${from} hat den Termin ${formatDate(task.start_date)} bestätigt (${bundle.project.name}, ${formatDate(todayISO())}).` })
    }
    return c.json({ ok: true, confirmation: conf }, 201)
  })

  return app
}
