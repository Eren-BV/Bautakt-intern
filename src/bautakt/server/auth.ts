/**
 * Anmeldung & Sitzungen. Passwörter mit PBKDF2 (WebCrypto), Sitzungs-Token als
 * Bearer-Header. Die Middleware hängt `session` (Nutzer, Organisation, Rolle) an den
 * Hono-Kontext - jede Route arbeitet danach ausschließlich im Mandanten der Sitzung.
 */

import type { Context, MiddlewareHandler } from 'hono'
import type { Db } from './db.ts'
import { newId, nowISO, randomToken } from './db.ts'
import type { Organization, OrgRole, Session, User } from '../shared/types.ts'
import { can, type Capability } from '../shared/permissions.ts'

const SESSION_DAYS = 30
const PBKDF2_ITERATIONS = 100_000

const hex = (buf: ArrayBuffer) =>
  Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')

async function pbkdf2(password: string, saltHex: string, iterations: number): Promise<string> {
  const salt = Uint8Array.from(saltHex.match(/.{1,2}/g) ?? [], (b) => parseInt(b, 16))
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, 512)
  return hex(bits)
}

export async function hashPassword(password: string): Promise<string> {
  const saltHex = hex(crypto.getRandomValues(new Uint8Array(16)).buffer)
  const hash = await pbkdf2(password, saltHex, PBKDF2_ITERATIONS)
  return `pbkdf2:${PBKDF2_ITERATIONS}:${saltHex}:${hash}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split(':')
  if (parts[0] !== 'pbkdf2' || parts.length !== 4) return false
  const iterations = Number(parts[1])
  if (!Number.isFinite(iterations) || iterations <= 0) return false
  const test = await pbkdf2(password, parts[2], iterations)
  if (test.length !== parts[3].length) return false
  let diff = 0
  for (let i = 0; i < test.length; i++) diff |= test.charCodeAt(i) ^ parts[3].charCodeAt(i)
  return diff === 0
}

export async function sha256Hex(value: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))
}

export async function createSession(db: Db, userId: string, orgId: string): Promise<string> {
  const token = randomToken(32)
  const now = new Date()
  await db.insert('sessions', {
    token,
    user_id: userId,
    org_id: orgId,
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + SESSION_DAYS * 86_400_000).toISOString(),
  })
  return token
}

export async function resolveSession(db: Db, token: string): Promise<Session | null> {
  const row = await db.get<{
    token: string
    user_id: string
    org_id: string
    expires_at: string
  }>('SELECT * FROM sessions WHERE token = ?', token)
  if (!row || row.expires_at < nowISO()) return null
  const user = await db.get<User>('SELECT id, email, name, created_at FROM users WHERE id = ?', row.user_id)
  const org = await db.get<Organization>('SELECT * FROM organizations WHERE id = ?', row.org_id)
  const member = await db.get<{ role: OrgRole }>(
    'SELECT role FROM organization_members WHERE org_id = ? AND user_id = ?',
    row.org_id,
    row.user_id,
  )
  if (!user || !org || !member) return null
  return { token, user, org, role: member.role }
}

export async function login(db: Db, email: string, password: string, orgSlug?: string): Promise<Session | null> {
  const user = await db.get<{ id: string; password_hash: string }>(
    'SELECT id, password_hash FROM users WHERE lower(email) = lower(?)',
    email.trim(),
  )
  if (!user || !(await verifyPassword(password, user.password_hash))) return null
  const membership = orgSlug
    ? await db.get<{ org_id: string }>(
        'SELECT m.org_id FROM organization_members m JOIN organizations o ON o.id = m.org_id WHERE m.user_id = ? AND o.slug = ?',
        user.id,
        orgSlug,
      )
    : await db.get<{ org_id: string }>('SELECT org_id FROM organization_members WHERE user_id = ? ORDER BY org_id LIMIT 1', user.id)
  if (!membership) return null
  const token = await createSession(db, user.id, membership.org_id)
  return await resolveSession(db, token)
}

/**
 * Sitzung für eine bereits extern geprüfte E-Mail-Adresse (Google/Microsoft/Apple).
 * Erstellt keine neuen Zugänge - die Person muss bereits Mitglied einer Organisation sein.
 */
export async function loginWithEmail(db: Db, email: string, orgSlug?: string): Promise<Session | null> {
  const user = await db.get<{ id: string }>('SELECT id FROM users WHERE lower(email) = lower(?)', email.trim())
  if (!user) return null
  const membership = orgSlug
    ? await db.get<{ org_id: string }>(
        'SELECT m.org_id FROM organization_members m JOIN organizations o ON o.id = m.org_id WHERE m.user_id = ? AND o.slug = ?',
        user.id,
        orgSlug,
      )
    : await db.get<{ org_id: string }>('SELECT org_id FROM organization_members WHERE user_id = ? ORDER BY org_id LIMIT 1', user.id)
  if (!membership) return null
  const token = await createSession(db, user.id, membership.org_id)
  return await resolveSession(db, token)
}

export async function register(
  db: Db,
  input: { email: string; name: string; password: string; orgName: string },
): Promise<Session> {
  const existing = await db.get('SELECT id FROM users WHERE lower(email) = lower(?)', input.email.trim())
  if (existing) throw new HttpError(409, 'E-Mail-Adresse ist bereits registriert.')
  const userId = newId('usr')
  const orgId = newId('org')
  const slug = input.orgName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'org'
  const passwordHash = await hashPassword(input.password)
  await db.transaction(async () => {
    await db.insert('organizations', {
      id: orgId,
      name: input.orgName.trim(),
      slug: `${slug}-${orgId.slice(-4)}`,
      created_at: nowISO(),
    })
    await db.insert('users', {
      id: userId,
      email: input.email.trim(),
      name: input.name.trim(),
      password_hash: passwordHash,
      created_at: nowISO(),
    })
    await db.insert('organization_members', { org_id: orgId, user_id: userId, role: 'owner' })
  })
  const token = await createSession(db, userId, orgId)
  return (await resolveSession(db, token))!
}

export class HttpError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export type AppEnv = { Variables: { session: Session; db: Db } }

export function authMiddleware(db: Db): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const header = c.req.header('authorization') ?? ''
    const token = header.startsWith('Bearer ') ? header.slice(7) : ''
    const session = token ? await resolveSession(db, token) : null
    if (!session) return c.json({ error: 'Nicht angemeldet.' }, 401)
    c.set('session', session)
    c.set('db', db)
    return await next()
  }
}

export function requireCap(cap: Capability): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const s = c.get('session')
    if (!can(s.role, cap)) return c.json({ error: 'Keine Berechtigung für diese Aktion.' }, 403)
    return await next()
  }
}

export function sessionOf(c: Context<AppEnv>): Session {
  return c.get('session')
}
