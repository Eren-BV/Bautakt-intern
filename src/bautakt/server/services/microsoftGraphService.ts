/**
 * Microsoft 365 / Outlook: OAuth-Anmeldefluss (Authorization Code) und Graph-API-Aufrufe für das
 * persönliche Postfach eines Nutzers - Mail lesen/suchen, Mail senden, Anhang herunterladen.
 * Nur delegierte, vom Nutzer selbst erteilte Rechte (Mail.Read, Mail.Send, offline_access,
 * User.Read); kein Zugriff auf fremde Postfächer, kein Löschen oder Verschieben von Nachrichten.
 */

import { HttpError } from '../auth.ts'

const AUTHORIZE_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize'
const TOKEN_URL = 'https://login.microsoftonline.com/common/oauth2/v2.0/token'
const GRAPH_BASE = 'https://graph.microsoft.com/v1.0'
const SCOPES = 'offline_access Mail.Read Mail.Send User.Read'

export function microsoftConfigured(): boolean {
  return !!(process.env['MICROSOFT_OAUTH_CLIENT_ID'] && process.env['MICROSOFT_OAUTH_CLIENT_SECRET'])
}

function creds(): { clientId: string; clientSecret: string } {
  const clientId = process.env['MICROSOFT_OAUTH_CLIENT_ID']
  const clientSecret = process.env['MICROSOFT_OAUTH_CLIENT_SECRET']
  if (!clientId || !clientSecret) throw new HttpError(400, 'Microsoft 365 ist noch nicht eingerichtet (Client-ID/Secret fehlen).')
  return { clientId, clientSecret }
}

export interface TokenSet {
  access_token: string
  refresh_token: string
  /** Unix-Zeitstempel (Sekunden), ab dem access_token erneuert werden muss */
  expires_at: number
}

export function buildAuthorizeUrl(state: string, redirectUri: string): string {
  const { clientId } = creds()
  const url = new URL(AUTHORIZE_URL)
  url.searchParams.set('client_id', clientId)
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('redirect_uri', redirectUri)
  url.searchParams.set('response_mode', 'query')
  url.searchParams.set('scope', SCOPES)
  url.searchParams.set('state', state)
  url.searchParams.set('prompt', 'select_account')
  return url.toString()
}

async function requestToken(body: Record<string, string>): Promise<TokenSet> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  })
  const json = (await res.json().catch(() => ({}))) as { access_token?: string; refresh_token?: string; expires_in?: number; error_description?: string }
  if (!res.ok || !json.access_token || !json.refresh_token) {
    throw new HttpError(502, `Microsoft-Anmeldung fehlgeschlagen: ${json.error_description?.slice(0, 200) ?? res.status}`)
  }
  return { access_token: json.access_token, refresh_token: json.refresh_token, expires_at: Math.floor(Date.now() / 1000) + (json.expires_in ?? 3600) - 60 }
}

export async function exchangeCode(code: string, redirectUri: string): Promise<TokenSet> {
  const { clientId, clientSecret } = creds()
  return requestToken({ client_id: clientId, client_secret: clientSecret, grant_type: 'authorization_code', code, redirect_uri: redirectUri, scope: SCOPES })
}

export async function refreshTokens(refreshToken: string): Promise<TokenSet> {
  const { clientId, clientSecret } = creds()
  return requestToken({ client_id: clientId, client_secret: clientSecret, grant_type: 'refresh_token', refresh_token: refreshToken, scope: SCOPES })
}

async function graph<T>(accessToken: string, path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${GRAPH_BASE}${path}`, { ...init, headers: { Authorization: `Bearer ${accessToken}`, 'content-type': 'application/json', ...(init.headers ?? {}) } })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    if (res.status === 401) throw new HttpError(401, 'Microsoft-Anmeldung ist abgelaufen – bitte Postfach neu verbinden.')
    throw new HttpError(502, `Microsoft Graph: ${res.status} ${text.slice(0, 200)}`)
  }
  return (await res.json()) as T
}

export async function getMe(accessToken: string): Promise<{ email: string; name: string }> {
  const me = await graph<{ mail?: string; userPrincipalName?: string; displayName?: string }>(accessToken, '/me?$select=mail,userPrincipalName,displayName')
  return { email: me.mail || me.userPrincipalName || '', name: me.displayName ?? '' }
}

export interface GraphMessage {
  id: string
  subject: string
  from_email: string
  from_name: string
  preview: string
  received_at: string
  has_attachments: boolean
  web_link: string
}

/** Volltextsuche im Posteingang ($search) - nur lesen, nichts wird als gelesen markiert oder verschoben. */
export async function searchMessages(accessToken: string, query: string, top = 10): Promise<GraphMessage[]> {
  const params = new URLSearchParams({ $top: String(Math.min(25, Math.max(1, top))), $select: 'id,subject,from,bodyPreview,receivedDateTime,hasAttachments,webLink' })
  if (query.trim()) params.set('$search', `"${query.trim().replace(/"/g, "'")}"`)
  else params.set('$orderby', 'receivedDateTime desc')
  const path = `/me/mailFolders/inbox/messages?${params.toString()}`
  const res = await graph<{ value: Record<string, unknown>[] }>(accessToken, path, { headers: query.trim() ? { ConsistencyLevel: 'eventual' } : {} })
  return res.value.map((m) => {
    const from = (m['from'] as { emailAddress?: { address?: string; name?: string } } | undefined)?.emailAddress
    return {
      id: String(m['id']), subject: String(m['subject'] ?? '(ohne Betreff)'), from_email: from?.address ?? '', from_name: from?.name ?? '',
      preview: String(m['bodyPreview'] ?? '').slice(0, 300), received_at: String(m['receivedDateTime'] ?? ''),
      has_attachments: !!m['hasAttachments'], web_link: String(m['webLink'] ?? ''),
    }
  })
}

export async function sendMail(accessToken: string, input: { to: string; cc?: string; subject: string; bodyText: string }): Promise<void> {
  const toRecipients = input.to.split(/[,;]/).map((e) => e.trim()).filter(Boolean).map((address) => ({ emailAddress: { address } }))
  if (!toRecipients.length) throw new HttpError(400, 'Empfängeradresse fehlt.')
  const ccRecipients = (input.cc ?? '').split(/[,;]/).map((e) => e.trim()).filter(Boolean).map((address) => ({ emailAddress: { address } }))
  await graph(accessToken, '/me/sendMail', {
    method: 'POST',
    body: JSON.stringify({ message: { subject: input.subject, body: { contentType: 'Text', content: input.bodyText }, toRecipients, ccRecipients }, saveToSentItems: true }),
  })
}

export interface GraphAttachmentInfo {
  id: string
  name: string
  content_type: string
  size: number
}

export async function listAttachments(accessToken: string, messageId: string): Promise<GraphAttachmentInfo[]> {
  const res = await graph<{ value: Record<string, unknown>[] }>(accessToken, `/me/messages/${encodeURIComponent(messageId)}/attachments?$select=id,name,contentType,size`)
  return res.value.filter((a) => a['@odata.type'] === '#microsoft.graph.fileAttachment' || !a['@odata.type']).map((a) => ({ id: String(a['id']), name: String(a['name'] ?? 'Anhang'), content_type: String(a['contentType'] ?? 'application/octet-stream'), size: Number(a['size']) || 0 }))
}

/** Lädt die Rohdaten eines Anhangs (Base64 → Bytes). Nur Datei-Anhänge (keine eingebetteten Termine o. Ä.). */
export async function downloadAttachment(accessToken: string, messageId: string, attachmentId: string): Promise<{ name: string; contentType: string; bytes: Uint8Array }> {
  const a = await graph<{ name?: string; contentType?: string; contentBytes?: string; '@odata.type'?: string }>(accessToken, `/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`)
  if (a['@odata.type'] !== '#microsoft.graph.fileAttachment' || !a.contentBytes) throw new HttpError(400, 'Dieser Anhang lässt sich nicht als Datei herunterladen.')
  const bin = atob(a.contentBytes)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return { name: a.name ?? 'Anhang', contentType: a.contentType ?? 'application/octet-stream', bytes }
}
