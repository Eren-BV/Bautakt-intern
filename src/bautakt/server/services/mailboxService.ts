/**
 * Persönliche Postfach-Anbindung (Microsoft 365) und Versand aus dem echten Konto.
 * Tokens liegen verschlüsselt in `connection_key`; jede Verknüpfung gehört genau einem Nutzer.
 * Nur delegierte Rechte (lesen/suchen/senden) - kein Löschen, Verschieben oder Bearbeiten
 * bestehender Nachrichten im echten Postfach.
 */

import type { Db } from '../db.ts'
import { newId, nowISO, type Row } from '../db.ts'
import { HttpError } from '../auth.ts'
import { encryptSecret, decryptSecret } from './secretBox.ts'
import {
  buildAuthorizeUrl, downloadAttachment as graphDownloadAttachment, exchangeCode, getMe, listAttachments as graphListAttachments,
  microsoftConfigured, refreshTokens, searchMessages, sendMail, type GraphMessage, type TokenSet,
} from './microsoftGraphService.ts'

export type MailboxProvider = 'microsoft365' | 'gmail'
export type MailboxStatus = 'connected' | 'not_connected' | 'setup_pending'

export interface MailboxAccount {
  id: string
  org_id: string
  user_id: string
  provider: MailboxProvider
  email: string
  status: MailboxStatus
  connection_key: string | null
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

const TOKEN_NS = 'mailbox-tokens'

/** Signiertes, ablaufendes „state“ für den OAuth-Redirect: bindet die Rückkehr an genau diesen Nutzer. */
async function signState(userId: string, orgId: string): Promise<string> {
  const secret = process.env['MICROSOFT_OAUTH_CLIENT_SECRET'] ?? ''
  const payload = JSON.stringify({ u: userId, o: orgId, n: newId('n'), exp: Date.now() + 10 * 60_000 })
  const b64 = Buffer.from(payload, 'utf8').toString('base64url')
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(b64))
  const sigHex = Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('')
  return `${b64}.${sigHex}`
}

export async function verifyState(state: string): Promise<{ userId: string; orgId: string } | null> {
  const [b64, sigHex] = state.split('.')
  if (!b64 || !sigHex) return null
  const secret = process.env['MICROSOFT_OAUTH_CLIENT_SECRET'] ?? ''
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'])
  const sigBytes = Uint8Array.from(sigHex.match(/.{1,2}/g) ?? [], (b) => parseInt(b, 16))
  const ok = await crypto.subtle.verify('HMAC', key, sigBytes, new TextEncoder().encode(b64))
  if (!ok) return null
  try {
    const payload = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8')) as { u: string; o: string; exp: number }
    if (payload.exp < Date.now()) return null
    return { userId: payload.u, orgId: payload.o }
  } catch {
    return null
  }
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
      ready: Boolean(p === 'microsoft365' ? microsoftConfigured() : (process.env['GOOGLE_OAUTH_CLIENT_ID'] && process.env['GOOGLE_OAUTH_CLIENT_SECRET'])),
    }))
    return { accounts: rows.map((r) => ({ ...mapMailbox(r), connection_key: null })), setup }
  }

  /** Startet den OAuth-Anmeldefluss: liefert die URL, zu der der Browser (volle Seite) wechseln muss. */
  async beginConnect(userId: string, orgId: string, provider: MailboxProvider, redirectUri: string): Promise<{ authorize_url: string }> {
    if (provider !== 'microsoft365') throw new HttpError(400, 'Dieser Anbieter ist noch nicht angebunden.')
    if (!microsoftConfigured()) throw new HttpError(400, 'Microsoft 365 ist noch nicht eingerichtet (Client-ID/Secret fehlen).')
    const state = await signState(userId, orgId)
    return { authorize_url: buildAuthorizeUrl(state, redirectUri) }
  }

  /** Callback-Ziel: Code gegen Tokens tauschen, Postfach-Adresse ermitteln, Verknüpfung speichern. */
  async completeConnect(userId: string, orgId: string, provider: MailboxProvider, code: string, redirectUri: string): Promise<MailboxAccount> {
    const tokens = await exchangeCode(code, redirectUri)
    const me = await getMe(tokens.access_token)
    const secret = process.env['MICROSOFT_OAUTH_CLIENT_SECRET'] ?? ''
    const connectionKey = await encryptSecret(JSON.stringify(tokens), secret, TOKEN_NS)
    const existing = await this.account(userId, orgId, provider)
    if (existing) {
      await this.db.update('mailbox_accounts', existing.id, { email: me.email, status: 'connected', connection_key: connectionKey, last_error: null })
      return { ...existing, email: me.email, status: 'connected' }
    }
    const row: MailboxAccount = { id: newId('mbx'), org_id: orgId, user_id: userId, provider, email: me.email, status: 'connected', connection_key: connectionKey, last_sync_at: null, last_error: null, created_at: nowISO() }
    await this.db.insert('mailbox_accounts', row)
    return row
  }

  async disconnect(userId: string, orgId: string, provider: MailboxProvider): Promise<void> {
    await this.db.run('DELETE FROM mailbox_accounts WHERE org_id = ? AND user_id = ? AND provider = ?', orgId, userId, provider)
  }

  /** Entschlüsselt die Tokens, erneuert sie bei Bedarf und schreibt eine Erneuerung zurück. */
  private async validAccessToken(account: MailboxAccount): Promise<string> {
    if (!account.connection_key) throw new HttpError(400, `Kein ${PROVIDER_LABEL[account.provider]}-Postfach verbunden. Bitte zuerst verbinden.`)
    const secret = process.env['MICROSOFT_OAUTH_CLIENT_SECRET'] ?? ''
    let tokens: TokenSet
    try {
      tokens = JSON.parse(await decryptSecret(account.connection_key, secret, TOKEN_NS)) as TokenSet
    } catch {
      await this.db.update('mailbox_accounts', account.id, { status: 'setup_pending', last_error: 'Verbindung ungültig – bitte neu verbinden.' })
      throw new HttpError(400, 'Die Postfach-Verbindung ist ungültig geworden. Bitte neu verbinden.')
    }
    if (tokens.expires_at > Math.floor(Date.now() / 1000)) return tokens.access_token
    try {
      const fresh = await refreshTokens(tokens.refresh_token)
      await this.db.update('mailbox_accounts', account.id, { connection_key: await encryptSecret(JSON.stringify(fresh), secret, TOKEN_NS) })
      return fresh.access_token
    } catch (e) {
      await this.db.update('mailbox_accounts', account.id, { status: 'setup_pending', last_error: e instanceof Error ? e.message.slice(0, 300) : 'Erneuerung fehlgeschlagen' })
      throw new HttpError(400, 'Die Postfach-Verbindung ist abgelaufen. Bitte neu verbinden.')
    }
  }

  /** Live-Suche im echten Postfach (nur lesen - nichts wird als gelesen markiert). */
  async search(userId: string, orgId: string, provider: MailboxProvider, query: string, top = 10): Promise<GraphMessage[]> {
    const acc = await this.account(userId, orgId, provider)
    if (!acc) throw new HttpError(400, `Kein ${PROVIDER_LABEL[provider]}-Postfach verbunden. Bitte zuerst in den Einstellungen verbinden.`)
    const token = await this.validAccessToken(acc)
    return searchMessages(token, query, top)
  }

  async messageAttachments(userId: string, orgId: string, provider: MailboxProvider, messageId: string) {
    const acc = await this.account(userId, orgId, provider)
    if (!acc) throw new HttpError(400, `Kein ${PROVIDER_LABEL[provider]}-Postfach verbunden.`)
    const token = await this.validAccessToken(acc)
    return graphListAttachments(token, messageId)
  }

  async downloadAttachment(userId: string, orgId: string, provider: MailboxProvider, messageId: string, attachmentId: string) {
    const acc = await this.account(userId, orgId, provider)
    if (!acc) throw new HttpError(400, `Kein ${PROVIDER_LABEL[provider]}-Postfach verbunden.`)
    const token = await this.validAccessToken(acc)
    return graphDownloadAttachment(token, messageId, attachmentId)
  }

  /**
   * Neue Nachrichten aus dem echten Postfach abholen und in den persönlichen
   * Posteingang übernehmen (dedupliziert über external_id).
   */
  async sync(userId: string, orgId: string, provider: MailboxProvider, ingest: (input: { provider: MailboxProvider; external_id: string | null; from_email: string; from_name?: string; to_email?: string; subject?: string; body_text: string; received_at?: string }) => Promise<unknown>): Promise<{ imported: number; synced_at: string }> {
    const acc = await this.account(userId, orgId, provider)
    if (!acc) throw new HttpError(400, `Kein ${PROVIDER_LABEL[provider]}-Postfach verbunden. Bitte zuerst verbinden.`)
    const token = await this.validAccessToken(acc)
    const messages = await searchMessages(token, '', 25)
    let imported = 0
    for (const m of messages) {
      const seen = await this.db.get('SELECT id FROM inbound_emails WHERE org_id = ? AND external_id = ?', orgId, m.id)
      if (seen) continue
      await ingest({ provider, external_id: m.id, from_email: m.from_email, from_name: m.from_name, subject: m.subject, body_text: m.preview, received_at: m.received_at })
      imported++
    }
    const now = nowISO()
    await this.db.update('mailbox_accounts', acc.id, { last_sync_at: now, last_error: null })
    return { imported, synced_at: now }
  }

  /** Nachricht über das echte Benutzer-Postfach versenden (Graph sendMail) und im Protokoll festhalten. */
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
    try {
      const token = await this.validAccessToken(acc)
      await sendMail(token, { to, cc: input.cc_email, subject: input.subject ?? '(ohne Betreff)', bodyText: input.body_text })
      const sentAt = nowISO()
      await this.db.update('outbound_emails', id, { status: 'sent', sent_at: sentAt })
      return { ...rec, status: 'sent', sent_at: sentAt }
    } catch (e) {
      const message = e instanceof Error ? e.message.slice(0, 300) : 'Versand fehlgeschlagen'
      await this.db.update('outbound_emails', id, { status: 'failed', error: message })
      throw e instanceof HttpError ? e : new HttpError(502, message)
    }
  }

  /** Protokoll der gesendeten Nachrichten des Benutzers. */
  async sent(userId: string, orgId: string, limit = 50): Promise<OutboundEmailRecord[]> {
    const rows = await this.db.all<Row>('SELECT * FROM outbound_emails WHERE org_id = ? AND user_id = ? ORDER BY created_at DESC LIMIT ?', orgId, userId, limit)
    return rows as unknown as OutboundEmailRecord[]
  }
}
