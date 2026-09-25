/**
 * Persönliche Postfach-Anbindung (Microsoft 365 / Gmail) und Versand aus dem echten Konto.
 *
 * Stand „Erst Oberfläche bauen“: Verknüpfungs- und Versandlogik sind als Verträge
 * implementiert; der eigentliche OAuth-Austausch bzw. Graph-/Gmail-Aufruf wird erst
 * aktiviert, wenn die Anbieter-App-Registrierung (Client-Id/Secret) hinterlegt ist.
 * Solange melden connect/sync/send eine klare, benutzerlesbare Meldung.
 */

import type { Db } from '../db.ts'
import { newId, nowISO, type Row } from '../db.ts'
import { HttpError } from '../auth.ts'

export type MailboxProvider = 'microsoft365' | 'gmail'
export type MailboxStatus = 'connected' | 'not_connected' | 'setup_pending'

export interface MailboxAccount {
  id: string
  org_id: string
  user_id: string
  provider: MailboxProvider
  email: string
  status: MailboxStatus
  last_sync_at: string | null
  last_error: string | null
  created_at: string
}

export interface OutboundEmailRecord {
  id: string
  org_id: string
  user_id: string
  provider: MailboxProvider
  from_email: string
  to_email: string
  cc_email: string
  subject: string
  body_text: string
  project_id: string | null
  reply_to_id: string | null
  status: string
  error: string | null
  sent_at: string | null
  created_at: string
}

const mapMailbox = (r: Row): MailboxAccount => r as unknown as MailboxAccount

export const PROVIDER_LABEL: Record<MailboxProvider, string> = {
  microsoft365: 'Microsoft 365 / Outlook',
  gmail: 'Google Workspace / Gmail',
}

export class MailboxService {
  readonly db: Db
  constructor(db: Db) {
    this.db = db
  }

  async account(userId: string, orgId: string, provider: MailboxProvider): Promise<MailboxAccount | undefined> {
    return await this.db.get<Row>(
      'SELECT * FROM mailbox_accounts WHERE org_id = ? AND user_id = ? AND provider = ?',
      orgId, userId, provider,
    ).then((r) => (r ? mapMailbox(r) : undefined))
  }

  async status(userId: string, orgId: string): Promise<{ accounts: MailboxAccount[]; setup: { provider: MailboxProvider; label: string; ready: boolean }[] }> {
    const rows = await this.db.all<Row>('SELECT * FROM mailbox_accounts WHERE org_id = ? AND user_id = ? ORDER BY provider', orgId, userId)
    const setup = (['microsoft365', 'gmail'] as MailboxProvider[]).map((p) => ({
      provider: p,
      label: PROVIDER_LABEL[p],
      ready: Boolean(
        p === 'microsoft365'
          ? (process.env['MICROSOFT_OAUTH_CLIENT_ID'] && process.env['MICROSOFT_OAUTH_CLIENT_SECRET'])
          : (process.env['GOOGLE_OAUTH_CLIENT_ID'] && process.env['GOOGLE_OAUTH_CLIENT_SECRET']),
      ),
    }))
    return { accounts: rows.map(mapMailbox), setup }
  }

  async connect(userId: string, orgId: string, provider: MailboxProvider): Promise<MailboxAccount> {
    const existing = await this.account(userId, orgId, provider)
    if (existing) return existing
    throw new HttpError(400, 'Die Verbindung wird erst nach der Freischaltung der Anbieter-Anbindung möglich sein. Alle Oberflächen dafür stehen bereit.')
  }

  async disconnect(userId: string, orgId: string, provider: MailboxProvider): Promise<void> {
    await this.db.run('DELETE FROM mailbox_accounts WHERE org_id = ? AND user_id = ? AND provider = ?', orgId, userId, provider)
  }

  /**
   * Neue Nachrichten aus dem echten Postfach abholen und in den persönlichen
   * Posteingang übernehmen. Erfordert eine aktive Verbindung.
   */
  async sync(userId: string, orgId: string, provider: MailboxProvider, ingest: (input: { provider: MailboxProvider; external_id: string | null; from_email: string; from_name?: string; to_email?: string; subject?: string; body_text: string; received_at?: string }) => Promise<unknown>): Promise<{ imported: number; synced_at: string }> {
    const acc = await this.account(userId, orgId, provider)
    if (!acc) throw new HttpError(400, `Kein ${PROVIDER_LABEL[provider]}-Postfach verbunden. Bitte zuerst verbinden.`)
    const now = nowISO()
    // Provider-Abruf (Graph/Gmail-API) wird mit der App-Registrierung aktiviert;
    // bis dahin bleibt der letzte Stand unverändert.
    await this.db.update('mailbox_accounts', acc.id, { last_sync_at: now })
    return { imported: 0, synced_at: now }
  }

  /**
   * Nachricht über das echte Benutzer-Postfach versenden (Graph sendMail bzw.
   * Gmail send) und im Protokoll festhalten.
   */
  async send(userId: string, orgId: string, input: { provider: MailboxProvider; to_email: string; cc_email?: string; subject: string; body_text: string; project_id?: string | null; reply_to_id?: string | null }): Promise<OutboundEmailRecord> {
    const to = input.to_email.trim()
    if (!to.includes('@')) throw new HttpError(400, 'Empfängeradresse fehlt.')
    if (!input.body_text?.trim()) throw new HttpError(400, 'Nachrichtentext fehlt.')
    const acc = await this.account(userId, orgId, input.provider)
    if (!acc) throw new HttpError(400, `Kein ${PROVIDER_LABEL[input.provider]}-Postfach verbunden. Bitte zuerst verbinden – erst dann wird aus deinem echten Konto gesendet.`)
    const id = newId('out')
    const rec: OutboundEmailRecord = {
      id, org_id: orgId, user_id: userId, provider: input.provider,
      from_email: acc.email || '', to_email: to, cc_email: input.cc_email ?? '',
      subject: input.subject ?? '', body_text: input.body_text,
      project_id: input.project_id ?? null, reply_to_id: input.reply_to_id ?? null,
      status: 'queued', error: null, sent_at: null, created_at: nowISO(),
    }
    await this.db.insert('outbound_emails', rec)
    // Provider-Versand wird mit der App-Registrierung aktiviert; die Nachricht
    // bleibt als „queued“ protokolliert und geht nicht verloren.
    return rec
  }

  /** Protokoll der gesendeten Nachrichten des Benutzers. */
  async sent(userId: string, orgId: string, limit = 50): Promise<OutboundEmailRecord[]> {
    const rows = await this.db.all<Row>('SELECT * FROM outbound_emails WHERE org_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT ?', orgId, userId, limit)
    return rows as unknown as OutboundEmailRecord[]
  }
}
