/**
 * Integrations-, Regel- und KI-Routen:
 *   - BuildFlow: Prozess-Verknüpfungen je Projekt, Import in bestehendes Projekt,
 *     Abgleich (Diff → Change Proposal, nie direkte Änderung)
 *   - E-Mail-Eingang: providerneutrale Ingestion (manuell / Webhook), Analyse, Vorschlag
 *   - Provider-Status (Microsoft 365 / Gmail: vorbereitet, nicht verbunden)
 *   - Baulogische Regeln (Org/Projekt) + Prüfung des aktuellen Plans
 *   - „Lösung finden“ (KI): Vertrag + Endpunkt, liefert 501 solange kein Dienst angebunden ist
 */

import { Hono } from 'hono'
import { HttpError, requireCap, type AppEnv } from '../auth.ts'
import { newId, nowISO, type Row } from '../db.ts'
import { Repo } from '../repo.ts'
import { ProjectService } from '../services/projectService.ts'
import { EmailService, type InboundEmailStatus } from '../services/emailService.ts'
import { MailboxService, type MailboxProvider } from '../services/mailboxService.ts'
import { pushNotification } from '../services/notificationService.ts'
import type { AiSolutionRequest, ChangeProposal } from '../../shared/types.ts'
import { parseBuildFlowExport, type BuildFlowProcess } from '../../shared/integrations/buildflow/types.ts'
import { diffProcess, diffToOperations } from '../../shared/integrations/buildflow/adapter.ts'
import { SAMPLE_BUILDFLOW_PROCESS, SAMPLE_BUILDFLOW_PROCESS_V2 } from '../../shared/integrations/buildflow/sample.ts'
import { recompute } from '../../shared/engine/operations.ts'
import { effectiveRules, evaluateRules, SYSTEM_RULES, type PlanRule, type RuleKind } from '../../shared/rules/engine.ts'
import type { EmailProviderKind } from '../../shared/integrations/email/types.ts'

export const integrationRoutes = new Hono<AppEnv>()

async function requireProject(c: { get: (k: 'db' | 'session') => unknown }, projectId: string) {
  const repo = new Repo(c.get('db') as AppEnv['Variables']['db'])
  const s = c.get('session') as AppEnv['Variables']['session']
  const project = await repo.project(s.org.id, projectId)
  if (!project) throw new HttpError(404, 'Projekt nicht gefunden.')
  return { repo, session: s, project }
}

interface ProcessLink {
  id: string
  project_id: string
  process_id: string
  process_name: string
  process_version: string
  snapshot: BuildFlowProcess
  mapping: Record<string, string>
  phase_task_id: string | null
  created_at: string
  last_synced_at: string | null
}
const json = <T>(v: unknown, fallback: T): T => {
  if (typeof v !== 'string') return fallback
  try { return JSON.parse(v) as T } catch { return fallback }
}
const mapLink = (r: Row): ProcessLink => ({ ...(r as unknown as ProcessLink), snapshot: json(r.snapshot, {} as BuildFlowProcess), mapping: json(r.mapping, {}) })

// ---------------------------------------------------------------- Provider-Status
integrationRoutes.get('/integrations', async (c) => {
  const s = c.get('session')
  const rows = await c.get('db').all<Row>('SELECT * FROM integrations WHERE org_id = ? ORDER BY kind, provider', s.org.id)
  const stored = rows.map((r) => ({ ...(r as unknown as { id: string; kind: string; provider: string; name: string; status: string }), config: json<Record<string, unknown>>(r.config, {}) }))
  const providers: { kind: 'email' | 'buildflow'; provider: string; name: string; status: 'not_connected' | 'available' | 'connected'; note: string }[] = [
    { kind: 'buildflow', provider: 'file', name: 'BuildFlow (JSON-Export)', status: 'available', note: 'Prozesse aus BuildFlow „Exportieren“ (prozesse.json) importieren und abgleichen.' },
    { kind: 'buildflow', provider: 'http', name: 'BuildFlow-API', status: 'not_connected', note: 'Direkte Verbindung – Adapter-Vertrag vorhanden (BuildFlowProvider), Endpunkt in BuildFlow noch nicht verfügbar.' },
    { kind: 'email', provider: 'manual', name: 'Manueller E-Mail-Eingang', status: 'available', note: 'E-Mail-Text einfügen oder per Webhook POST /api/email/inbound übergeben.' },
    { kind: 'email', provider: 'microsoft365', name: 'Microsoft 365 (Exchange Online)', status: 'not_connected', note: 'Adapter-Vertrag (EmailProviderAdapter) vorhanden; benötigt Azure-App-Registrierung und Postfach-Berechtigung.' },
    { kind: 'email', provider: 'gmail', name: 'Google Workspace / Gmail', status: 'not_connected', note: 'Adapter-Vertrag vorhanden; benötigt OAuth-Client und Pub/Sub-Benachrichtigung.' },
    { kind: 'email', provider: 'imap', name: 'IMAP-Postfach', status: 'not_connected', note: 'Adapter-Vertrag vorhanden; benötigt Zugangsdaten (werden verschlüsselt gespeichert).' },
  ]
  return c.json({ providers: providers.map((p) => ({ ...p, status: stored.find((x) => x.kind === p.kind && x.provider === p.provider)?.status ?? p.status })), stored, analyzer: { active: 'rules', ai_available: false, note: 'Regelbasierte Erkennung (Absender, Projekt, Datum, Schlüsselwörter). KI-Analyzer: Vertrag vorhanden, kein Dienst verbunden.' } })
})

// ---------------------------------------------------------------- BuildFlow
integrationRoutes.get('/buildflow/sample', (c) => c.json({ current: SAMPLE_BUILDFLOW_PROCESS, changed: SAMPLE_BUILDFLOW_PROCESS_V2 }))

integrationRoutes.get('/projects/:id/process-links', async (c) => {
  await requireProject(c, c.req.param('id'))
  const links = (await c.get('db').all<Row>('SELECT * FROM project_process_links WHERE project_id = ? ORDER BY created_at', c.req.param('id'))).map(mapLink)
  const proposals = await c.get('db').all<{ id: string; origin_ref: string; status: string }>("SELECT id, origin_ref, status FROM change_proposals WHERE project_id = ? AND origin_kind = 'buildflow' AND status = 'open'", c.req.param('id'))
  return c.json(links.map((l) => ({ id: l.id, process_id: l.process_id, process_name: l.process_name, process_version: l.process_version, phase_task_id: l.phase_task_id, created_at: l.created_at, last_synced_at: l.last_synced_at, node_count: l.snapshot.nodes?.length ?? 0, mapped_tasks: Object.keys(l.mapping).length, open_proposal_id: proposals.find((p) => p.origin_ref === l.id)?.id ?? null })))
})

/** Prozess in ein bestehendes Projekt übernehmen (neue Phase) */
integrationRoutes.post('/projects/:id/process-links', requireCap('plan.edit'), async (c) => {
  const { session } = await requireProject(c, c.req.param('id'))
  const body = await c.req.json<{ process: unknown }>()
  const r = new ProjectService(c.get('db')).attachBuildFlow(session, c.req.param('id'), body.process)
  return c.json(r, 201)
})

/** Vorschau eines Abgleichs (ohne Speichern) */
integrationRoutes.post('/projects/:id/process-links/:lid/diff', async (c) => {
  const { repo } = await requireProject(c, c.req.param('id'))
  const db = c.get('db')
  const row = await db.get<Row>('SELECT * FROM project_process_links WHERE id = ? AND project_id = ?', c.req.param('lid'), c.req.param('id'))
  if (!row) throw new HttpError(404, 'Verknüpfung nicht gefunden.')
  const link = mapLink(row)
  const body = await c.req.json<{ process: unknown }>()
  const after = parseBuildFlowExport(body.process).find((p) => p.id === link.process_id) ?? parseBuildFlowExport(body.process)[0]
  if (!after) throw new HttpError(400, 'Kein gültiger BuildFlow-Prozess.')
  const diff = diffProcess(link.snapshot, after)
  const tasks = await repo.tasks(c.req.param('id'))
  const deps = await repo.dependencies(c.req.param('id'))
  const { operations, summary } = diffToOperations(diff, after, link.mapping, tasks, deps, link.phase_task_id)
  return c.json({ process: { id: after.id, name: after.name, version: after.templateVersion ?? String(after.version) }, same_process: after.id === link.process_id, counts: { added: diff.added.length, changed: diff.changed.length, removed: diff.removed.length, edges_added: diff.edgesAdded.length, edges_removed: diff.edgesRemoved.length }, summary, operations })
})

/** Abgleich: Diff → Change Proposal (BUILDFLOW_SYNC). Der laufende Plan bleibt unverändert. */
integrationRoutes.post('/projects/:id/process-links/:lid/sync', requireCap('plan.edit'), async (c) => {
  const { repo, session, project } = await requireProject(c, c.req.param('id'))
  const db = c.get('db')
  const row = await db.get<Row>('SELECT * FROM project_process_links WHERE id = ? AND project_id = ?', c.req.param('lid'), project.id)
  if (!row) throw new HttpError(404, 'Verknüpfung nicht gefunden.')
  const link = mapLink(row)
  if (await db.get("SELECT id FROM change_proposals WHERE origin_kind = 'buildflow' AND origin_ref = ? AND status = 'open'", link.id)) throw new HttpError(409, 'Für diese Verknüpfung liegt bereits ein offener Abgleich-Vorschlag vor.')
  const body = await c.req.json<{ process: unknown }>()
  const after = parseBuildFlowExport(body.process).find((p) => p.id === link.process_id)
  if (!after) throw new HttpError(400, `Der Export enthält den verknüpften Prozess „${link.process_name}“ (${link.process_id}) nicht.`)
  const diff = diffProcess(link.snapshot, after)
  const { operations, summary } = diffToOperations(diff, after, link.mapping, await repo.tasks(project.id), await repo.dependencies(project.id), link.phase_task_id)
  if (!operations.length) {
    await db.update('project_process_links', link.id, { snapshot: after, process_version: after.templateVersion ?? String(after.version), last_synced_at: nowISO() })
    return c.json({ changed: false, message: 'Keine terminrelevanten Änderungen – Stand übernommen.' })
  }
  const counts = `${diff.added.length} neu, ${diff.changed.length} geändert, ${diff.removed.length} entfernt, ${diff.edgesAdded.length + diff.edgesRemoved.length} Verbindungen`
  const p: ChangeProposal = {
    id: newId('cp'), project_id: project.id, task_id: null, source: 'BUILDFLOW_SYNC', status: 'open', title: `BuildFlow „${after.name}“ ${link.process_version} → ${after.templateVersion ?? after.version}: ${counts}`,
    proposed_start: null, proposed_end: null, operations, reason: 'buildflow_sync', comment: summary.join(' · '), submitted_by_name: 'BuildFlow-Abgleich', submitted_by_user_id: session.user.id, share_link_id: null,
    origin_kind: 'buildflow', origin_ref: link.id, created_at: nowISO(), decided_at: null, decided_by: null, decision_note: '',
  }
  await db.transaction(async () => {
    await db.insert('change_proposals', p)
    // Neuer Stand wird gemerkt; Mapping neuer Schritte entsteht bei Übernahme (add_task-Keys → IDs) - bis dahin bleibt der alte Snapshot als Vergleichsbasis in `pending_snapshot`
    await db.update('project_process_links', link.id, { snapshot: after, process_version: after.templateVersion ?? String(after.version) })
  })
  pushNotification(db, { org_id: session.org.id, project_id: project.id, type: 'info', severity: 'warning', title: 'BuildFlow wurde geändert', message: `${project.name}: „${after.name}“ – ${counts}. Änderungen prüfen.` })
  return c.json({ changed: true, proposal: p, counts: { added: diff.added.length, changed: diff.changed.length, removed: diff.removed.length, edges: diff.edgesAdded.length + diff.edgesRemoved.length } }, 201)
})

integrationRoutes.delete('/projects/:id/process-links/:lid', requireCap('plan.edit'), async (c) => {
  await requireProject(c, c.req.param('id'))
  await c.get('db').run('DELETE FROM project_process_links WHERE id = ? AND project_id = ?', c.req.param('lid'), c.req.param('id'))
  return c.json({ ok: true })
})

// ---------------------------------------------------------------- E-Mail-Eingang
integrationRoutes.get('/email/inbox', requireCap('inbox.view'), async (c) => {
  const s = c.get('session')
  const status = c.req.query('status') as InboundEmailStatus | undefined
  return c.json(await new EmailService(c.get('db')).list(s.user.id, s.org.id, status))
})
integrationRoutes.get('/email/inbox/:id', requireCap('inbox.view'), async (c) => {
  const s = c.get('session')
  return c.json(await new EmailService(c.get('db')).get(s.user.id, s.org.id, c.req.param('id')))
})
/** Ingestion - manuell (UI, eigener Posteingang) oder Webhook eines Providers; providerneutrales Format */
integrationRoutes.post('/email/inbound', requireCap('inbox.view'), async (c) => {
  const s = c.get('session')
  const body = await c.req.json<{ provider?: EmailProviderKind; external_id?: string | null; from_email: string; from_name?: string; to_email?: string; subject?: string; body_text: string; received_at?: string }>()
  const rec = await new EmailService(c.get('db')).ingest(s.user.id, s.org.id, body)
  return c.json(rec, 201)
})
integrationRoutes.post('/email/inbox/:id/reanalyze', requireCap('inbox.view'), async (c) => {
  const s = c.get('session')
  return c.json(await new EmailService(c.get('db')).reanalyze(s.user.id, s.org.id, c.req.param('id')))
})
integrationRoutes.post('/email/inbox/:id/ignore', requireCap('inbox.view'), async (c) => {
  const s = c.get('session')
  return c.json(await new EmailService(c.get('db')).ignore(s.user.id, s.org.id, c.req.param('id')))
})
// ---------------------------------------------------------------- Postfach-Anbindung (Outlook / Gmail) & Versand
const MAILBOX_PROVIDERS: MailboxProvider[] = ['microsoft365', 'gmail']
const isMailboxProvider = (v: string): v is MailboxProvider => (MAILBOX_PROVIDERS as string[]).includes(v)

integrationRoutes.get('/mailbox', requireCap('inbox.view'), async (c) => {
  const s = c.get('session')
  return c.json(await new MailboxService(c.get('db')).status(s.user.id, s.org.id))
})
integrationRoutes.post('/mailbox/:provider/connect', requireCap('inbox.view'), async (c) => {
  const s = c.get('session')
  const provider = c.req.param('provider')
  if (!isMailboxProvider(provider)) throw new HttpError(400, 'Unbekannter Anbieter.')
  return c.json(await new MailboxService(c.get('db')).connect(s.user.id, s.org.id, provider))
})
integrationRoutes.post('/mailbox/:provider/disconnect', requireCap('inbox.view'), async (c) => {
  const s = c.get('session')
  const provider = c.req.param('provider')
  if (!isMailboxProvider(provider)) throw new HttpError(400, 'Unbekannter Anbieter.')
  await new MailboxService(c.get('db')).disconnect(s.user.id, s.org.id, provider)
  return c.json({ ok: true })
})
integrationRoutes.post('/mailbox/:provider/sync', requireCap('inbox.view'), async (c) => {
  const s = c.get('session')
  const provider = c.req.param('provider')
  if (!isMailboxProvider(provider)) throw new HttpError(400, 'Unbekannter Anbieter.')
  const svc = new MailboxService(c.get('db'))
  const email = new EmailService(c.get('db'))
  return c.json(await svc.sync(s.user.id, s.org.id, provider, (input) => email.ingest(s.user.id, s.org.id, input)))
})
integrationRoutes.get('/email/sent', requireCap('inbox.view'), async (c) => {
  const s = c.get('session')
  return c.json(await new MailboxService(c.get('db')).sent(s.user.id, s.org.id))
})
integrationRoutes.post('/email/send', requireCap('inbox.view'), async (c) => {
  const s = c.get('session')
  const body = await c.req.json<{ provider?: MailboxProvider; to_email: string; cc_email?: string; subject?: string; body_text: string; project_id?: string | null; reply_to_id?: string | null }>()
  return c.json(await new MailboxService(c.get('db')).send(s.user.id, s.org.id, { ...body, provider: body.provider ?? 'microsoft365' }), 201)
})
integrationRoutes.post('/email/inbox/:id/propose', requireCap('site.update'), async (c) => {
  const s = c.get('session')
  const body = await c.req.json<{ project_id?: string; task_id?: string | null; new_start?: string | null }>().catch(() => ({}))
  return c.json(await new EmailService(c.get('db')).propose(s, c.req.param('id'), body), 201)
})

// ---------------------------------------------------------------- Baulogische Regeln
const RULE_KINDS: RuleKind[] = ['required_order', 'min_gap', 'no_overlap']
integrationRoutes.get('/rules', async (c) => {
  const s = c.get('session')
  const repo = new Repo(c.get('db'))
  const projectId = c.req.query('project_id') ?? null
  const custom = await repo.rules(s.org.id)
  return c.json({ system: SYSTEM_RULES, custom, effective: effectiveRules(custom, projectId) })
})
integrationRoutes.post('/rules', requireCap('rules.manage'), async (c) => {
  const s = c.get('session')
  const db = c.get('db')
  const body = await c.req.json<Partial<PlanRule> & { overrides_system_id?: string }>()
  if (!body.kind || !RULE_KINDS.includes(body.kind)) throw new HttpError(400, 'Ungültige Regelart.')
  if (!body.name?.trim()) throw new HttpError(400, 'Name ist erforderlich.')
  if (!body.config?.trade_a && !body.config?.pattern_a) throw new HttpError(400, 'Gewerk A oder Muster A ist erforderlich.')
  if (body.project_id && !(await new Repo(db).project(s.org.id, body.project_id))) throw new HttpError(404, 'Projekt nicht gefunden.')
  const id = body.overrides_system_id && SYSTEM_RULES.some((r) => r.id === body.overrides_system_id) ? `${body.overrides_system_id}@${body.project_id ?? s.org.id}` : newId('rule')
  const rule: PlanRule = { id, org_id: s.org.id, project_id: body.project_id ?? null, template_id: body.template_id ?? null, kind: body.kind, name: body.name.trim(), config: { same_section: true, ...body.config, trade_b: body.config?.trade_b ?? null }, severity: body.severity ?? 'warning', enabled: body.enabled ?? true, created_at: nowISO() }
  await db.run('DELETE FROM plan_rules WHERE id = ?', id)
  await db.insert('plan_rules', rule)
  return c.json(rule, 201)
})
integrationRoutes.patch('/rules/:id', requireCap('rules.manage'), async (c) => {
  const s = c.get('session')
  const db = c.get('db')
  if (!(await db.get('SELECT id FROM plan_rules WHERE id = ? AND org_id = ?', c.req.param('id'), s.org.id))) throw new HttpError(404, 'Regel nicht gefunden.')
  const body = await c.req.json<Partial<PlanRule>>()
  const { id: _i, org_id: _o, created_at: _c, ...patch } = body
  await db.update('plan_rules', c.req.param('id'), patch)
  const rules = await new Repo(db).rules(s.org.id)
  return c.json(rules.find((r) => r.id === c.req.param('id')))
})
integrationRoutes.delete('/rules/:id', requireCap('rules.manage'), async (c) => {
  const s = c.get('session')
  await c.get('db').run('DELETE FROM plan_rules WHERE id = ? AND org_id = ?', c.req.param('id'), s.org.id)
  return c.json({ ok: true })
})
/** Regelprüfung des aktuellen (oder eines übergebenen) Plans */
integrationRoutes.post('/projects/:id/rule-check', async (c) => {
  const { repo, session, project } = await requireProject(c, c.req.param('id'))
  const bundle = (await repo.bundle(session.org.id, project.id))!
  const body: { tasks?: typeof bundle.tasks; dependencies?: typeof bundle.dependencies } = await c.req.json<{ tasks?: typeof bundle.tasks; dependencies?: typeof bundle.dependencies }>().catch(() => ({}))
  const ctx = new ProjectService(c.get('db')).planContext(bundle)
  const r = recompute({ tasks: body.tasks ?? bundle.tasks, dependencies: body.dependencies ?? bundle.dependencies }, ctx)
  const trades = await repo.trades(session.org.id)
  const rules = effectiveRules(await repo.rules(session.org.id), project.id)
  return c.json({ violations: evaluateRules(rules, { tasks: r.state.tasks, dependencies: r.state.dependencies, sched: r.result, trades, sections: bundle.sections }), rule_count: rules.filter((x) => x.enabled).length })
})

// ---------------------------------------------------------------- KI: „Lösung finden“ (Vertrag, kein Dienst)
integrationRoutes.post('/projects/:id/scenarios/find-solution', requireCap('scenario.manage'), async (c) => {
  const { project } = await requireProject(c, c.req.param('id'))
  const body: Partial<AiSolutionRequest> = await c.req.json<Partial<AiSolutionRequest>>().catch(() => ({}))
  return c.json({
    error: 'KI-Lösungssuche ist vorbereitet, aber es ist kein KI-Dienst verbunden.',
    contract: {
      request: 'AiSolutionRequest { project_id, disturbance: ProposalOperation[], goal, allow }',
      response: 'AiSolutionVariant[] { name, strategy, operations, summary } → jede Variante wird als Szenario (origin "ai") angelegt, nie in den Masterplan geschrieben',
      boundaries: 'Scheduling Engine = Wahrheit (deterministisch), Rule Engine = Grenzen (Regelverstöße einer Variante werden ausgewiesen), Mensch entscheidet.',
      received: { project_id: project.id, goal: body.goal ?? null, allow: body.allow ?? null, disturbance_ops: body.disturbance?.length ?? 0 },
    },
  }, 501)
})
