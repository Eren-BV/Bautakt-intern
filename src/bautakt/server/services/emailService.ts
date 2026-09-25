/**
 * E-Mail-Eingang (Server-Seite der Integrationsschicht): Nachrichten providerneutral
 * entgegennehmen, Analysekontext aus den Stammdaten bauen, Analyzer aufrufen, Ergebnis
 * speichern und - erst auf Wunsch des Nutzers - einen Change Proposal erzeugen.
 * Der Masterplan wird hier nie verändert.
 */

import type { Db, Row } from '../db.ts'
import { newId, nowISO } from '../db.ts'
import { Repo } from '../repo.ts'
import { HttpError } from '../auth.ts'
import type { ChangeProposal, ISODate, Session } from '../../shared/types.ts'
import type { EmailAnalysis, EmailAnalysisContext, EmailAnalyzer, EmailProviderKind, InboundEmailMessage } from '../../shared/integrations/email/types.ts'
import { RuleBasedEmailAnalyzer } from '../../shared/integrations/email/rulesAnalyzer.ts'
import { todayISO } from '../../shared/engine/dates.ts'
import { pushNotification } from './notificationService.ts'
import { EMAIL_TYPE_LABELS } from '../../shared/integrations/email/types.ts'

export type InboundEmailStatus = 'new' | 'analyzed' | 'proposed' | 'ignored'

export interface InboundEmailRecord extends InboundEmailMessage {
  org_id: string
  status: InboundEmailStatus
  analysis: EmailAnalysis | null
  project_id: string | null
  proposal_id: string | null
  created_at: string
}

const json = <T>(v: unknown, fallback: T): T => {
  if (typeof v !== 'string') return fallback
  try { return JSON.parse(v) as T } catch { return fallback }
}
export const mapInboundEmail = (r: Row): InboundEmailRecord => ({ ...(r as unknown as InboundEmailRecord), analysis: json<EmailAnalysis | null>(r.analysis, null) })

/** Analyzer-Registry: heute nur regelbasiert; ein KI-Analyzer wird hier registriert. */
const analyzers: Record<'rules' | 'ai', EmailAnalyzer | null> = { rules: new RuleBasedEmailAnalyzer(), ai: null }
export function activeAnalyzer(): EmailAnalyzer {
  return analyzers.ai ?? analyzers.rules!
}

export async function buildEmailContext(db: Db, orgId: string, today: ISODate = todayISO()): Promise<EmailAnalysisContext> {
  const repo = new Repo(db)
  const [projects, companies, contacts, tasks, shareLinks] = await Promise.all([
    repo.projects(orgId),
    repo.companies(orgId),
    repo.contacts(orgId),
    db.all<Row>(
      "SELECT t.id, t.project_id, t.name, t.start_date, t.end_date, t.trade_id, t.company_id, t.status FROM tasks t JOIN projects p ON p.id = t.project_id WHERE p.org_id = ? AND t.type IN ('task','milestone') AND t.status != 'done' AND NOT EXISTS (SELECT 1 FROM tasks c WHERE c.parent_id = t.id)",
      orgId,
    ) as unknown as Promise<EmailAnalysisContext['tasks']>,
    db.all<{ project_id: string; company_id: string | null; trade_id: string | null }>('SELECT project_id, company_id, trade_id FROM share_links WHERE org_id = ? AND revoked_at IS NULL', orgId),
  ])
  return {
    today,
    companies: companies.map((c) => ({ id: c.id, name: c.name, email: c.email, trade_ids: c.trade_ids })),
    contacts: contacts.map((c) => ({ id: c.id, company_id: c.company_id, name: c.name, email: c.email, project_ids: c.project_ids })),
    projects: projects.map((p) => ({ id: p.id, name: p.name, number: p.number, customer: p.customer, address: p.address, city: p.city, state: p.state })),
    tasks,
    shareLinks,
  }
}

export class EmailService {
  readonly db: Db
  constructor(db: Db) {
    this.db = db
  }

  /** Liste – strikt auf den eigenen Posteingang des Benutzers beschränkt. */
  async list(userId: string, orgId: string, status?: InboundEmailStatus): Promise<InboundEmailRecord[]> {
    const rows = status
      ? await this.db.all<Row>('SELECT * FROM inbound_emails WHERE org_id = ? AND user_id = ? AND status = ? ORDER BY received_at DESC', orgId, userId, status)
      : await this.db.all<Row>('SELECT * FROM inbound_emails WHERE org_id = ? AND user_id = ? ORDER BY received_at DESC LIMIT 200', orgId, userId)
    return rows.map(mapInboundEmail)
  }

  async get(userId: string, orgId: string, id: string): Promise<InboundEmailRecord> {
    const r = await this.db.get<Row>('SELECT * FROM inbound_emails WHERE id = ? AND org_id = ? AND user_id = ?', id, orgId, userId)
    if (!r) throw new HttpError(404, 'E-Mail nicht gefunden.')
    return mapInboundEmail(r)
  }

  /** Ingestion: Nachricht speichern und sofort analysieren (Analyse ist deterministisch und schnell). */
  async ingest(orgId: string, input: { provider?: EmailProviderKind; external_id?: string | null; from_email: string; from_name?: string; to_email?: string; subject?: string; body_text: string; received_at?: string }): Promise<InboundEmailRecord> {
    if (!input.from_email?.includes('@')) throw new HttpError(400, 'Absenderadresse fehlt.')
    if (!input.body_text?.trim()) throw new HttpError(400, 'Nachrichtentext fehlt.')
    const id = newId('em')
    const msg: InboundEmailMessage = {
      id, provider: input.provider ?? 'manual', external_id: input.external_id ?? null, from_email: input.from_email.trim().toLowerCase(), from_name: input.from_name ?? '', to_email: input.to_email ?? '',
      subject: input.subject ?? '', body_text: input.body_text, received_at: input.received_at ?? nowISO(),
    }
    const analysis = await activeAnalyzer().analyze(msg, await buildEmailContext(this.db, orgId))
    const projectId = analysis.project_candidates[0]?.project_id ?? null
    const status: InboundEmailStatus = analysis.operations.length || analysis.message_type !== 'GENERAL_INFORMATION' ? 'analyzed' : 'new'
    await this.db.insert('inbound_emails', { ...msg, org_id: orgId, status, analysis, project_id: projectId, proposal_id: null, created_at: nowISO() })
    if (analysis.operations.length) {
      await pushNotification(this.db, { org_id: orgId, project_id: projectId, type: 'info', severity: 'warning', title: 'Terminrelevante E-Mail erkannt', message: `${analysis.company_name ?? msg.from_email}: ${EMAIL_TYPE_LABELS[analysis.message_type]}${analysis.task_candidates[0] ? ` – „${analysis.task_candidates[0].task_name}“` : ''}. Bitte im Posteingang prüfen.` })
    }
    return this.get(orgId, id)
  }

  /** Erneut analysieren (z. B. nach Pflege von Kontakten) */
  async reanalyze(orgId: string, id: string): Promise<InboundEmailRecord> {
    const rec = await this.get(orgId, id)
    if (rec.status === 'proposed') throw new HttpError(409, 'Aus dieser E-Mail wurde bereits ein Vorschlag erzeugt.')
    const analysis = await activeAnalyzer().analyze(rec, await buildEmailContext(this.db, orgId))
    await this.db.update('inbound_emails', id, { analysis, project_id: analysis.project_candidates[0]?.project_id ?? null, status: analysis.operations.length || analysis.message_type !== 'GENERAL_INFORMATION' ? 'analyzed' : 'new' })
    return this.get(orgId, id)
  }

  async ignore(orgId: string, id: string): Promise<InboundEmailRecord> {
    await this.get(orgId, id)
    await this.db.update('inbound_emails', id, { status: 'ignored' })
    return this.get(orgId, id)
  }

  /**
   * Aus der Analyse einen Change Proposal erzeugen - mit den (ggf. vom Nutzer korrigierten)
   * Zuordnungen. Der Plan bleibt unverändert, bis der Projektleiter den Vorschlag entscheidet.
   */
  async propose(session: Session, id: string, override: { project_id?: string; task_id?: string | null; new_start?: ISODate | null } = {}): Promise<{ email: InboundEmailRecord; proposal: ChangeProposal }> {
    const rec = await this.get(session.org.id, id)
    if (!rec.analysis) throw new HttpError(409, 'E-Mail ist noch nicht analysiert.')
    if (rec.status === 'proposed' && rec.proposal_id) throw new HttpError(409, 'Vorschlag existiert bereits.')
    const a = rec.analysis
    const projectId = override.project_id ?? a.project_candidates[0]?.project_id
    if (!projectId) throw new HttpError(400, 'Kein Projekt zugeordnet – bitte Projekt wählen.')
    const repo = new Repo(this.db)
    const project = await repo.project(session.org.id, projectId)
    if (!project) throw new HttpError(404, 'Projekt nicht gefunden.')
    const taskId = override.task_id !== undefined ? override.task_id : (a.task_candidates.find((t) => t.project_id === projectId)?.task_id ?? null)
    const tasks = await repo.tasks(projectId)
    if (taskId && !tasks.some((t) => t.id === taskId)) throw new HttpError(404, 'Vorgang nicht gefunden.')
    let operations = a.operations.map((op) => ('task_id' in op && op.task_id && taskId ? { ...op, task_id: taskId } : op))
    if (override.new_start && taskId) {
      operations = operations.filter((op) => op.op !== 'move_task')
      operations.unshift({ op: 'move_task', task_id: taskId, new_start: override.new_start, cascade: true })
    }
    if (!operations.length && taskId && (override.new_start ?? a.new_date)) operations.push({ op: 'move_task', task_id: taskId, new_start: (override.new_start ?? a.new_date)!, cascade: true })
    if (!operations.length) throw new HttpError(400, 'Keine terminrelevante Änderung erkannt – bitte Vorgang und neuen Termin angeben.')
    const taskName = taskId ? (tasks.find((t) => t.id === taskId)?.name ?? '') : ''
    const proposal: ChangeProposal = {
      id: newId('cp'), project_id: projectId, task_id: taskId, source: 'EMAIL', status: 'open',
      title: `${EMAIL_TYPE_LABELS[a.message_type]}${taskName ? `: ${taskName}` : ''}${a.new_date ? ` → ${a.new_date.slice(8, 10)}.${a.new_date.slice(5, 7)}.` : ''}`,
      proposed_start: null, proposed_end: null, operations,
      reason: a.message_type.toLowerCase(), comment: `${rec.subject ? rec.subject + ' – ' : ''}${rec.body_text.replace(/\s+/g, ' ').trim().slice(0, 400)}`,
      submitted_by_name: `${rec.from_name || rec.from_email}${a.company_name ? ` (${a.company_name})` : ''}`, submitted_by_user_id: null, share_link_id: null,
      origin_kind: 'email', origin_ref: rec.id, created_at: nowISO(), decided_at: null, decided_by: null, decision_note: '',
    }
    await this.db.transaction(async () => {
      await this.db.insert('change_proposals', proposal)
      await this.db.update('inbound_emails', id, { status: 'proposed', proposal_id: proposal.id, project_id: projectId })
    })
    return { email: await this.get(session.org.id, id), proposal }
  }
}
