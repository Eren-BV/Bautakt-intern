/**
 * API-Anwendung (Hono). Läuft innerhalb der Lovable-Serverumgebung und wird von der
 * Route src/routes/api/$.ts unter /api/* eingebunden. Datenhaltung: Lovable Cloud.
 *
 * Migrationen und Demodaten werden beim ersten Aufruf einmalig angewendet.
 */

import { Hono } from 'hono'
import { Db } from './db.ts'
import { authMiddleware, HttpError, login, loginWithEmail, register, resolveSession, type AppEnv } from './auth.ts'
import { orgRoutes } from './routes/org.ts'
import { projectRoutes } from './routes/projects.ts'
import { templateRoutes } from './routes/templates.ts'
import { v1Routes } from './routes/v1.ts'
import { reportRoutes } from './routes/reports.ts'
import { shareRoutes } from './routes/share.ts'
import { integrationRoutes } from './routes/integrations.ts'
import { planImportRoutes } from './routes/planImport.ts'
import { attachmentRoutes } from './routes/attachments.ts'
import { jarvisRoutes } from './routes/jarvis.ts'
import { ensureAttachmentsBucket } from './services/storage.ts'
import { seedBuiltinTemplates, seedDemoOrg, seedEsWohnbauOrg, seedWorkspaceOrg } from './seed.ts'

const migrationFiles = import.meta.glob('./migrations/*.sql', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

function buildApp(db: Db) {
  const app = new Hono<AppEnv>()

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status as 400)
    console.error(err)
    return c.json({ error: 'Interner Fehler: ' + (err as Error).message }, 500)
  })

  // ---- Öffentlich
  app.post('/api/auth/login', async (c) => {
    const body = await c.req.json<{ email: string; password: string; org?: string }>()
    const session = await login(db, body.email ?? '', body.password ?? '', body.org)
    if (!session) return c.json({ error: 'E-Mail oder Passwort ist falsch.' }, 401)
    return c.json(session)
  })
  // Anmeldung über Google / Microsoft / Apple: das geprüfte Konto wird per E-Mail
  // mit dem bestehenden Zugang der Organisation verknüpft.
  app.post('/api/auth/oauth', async (c) => {
    const body = await c.req.json<{ accessToken?: string }>()
    const accessToken = (body.accessToken ?? '').trim()
    if (!accessToken) return c.json({ error: 'Anmeldung konnte nicht bestätigt werden.' }, 400)
    const baseUrl = process.env['SUPABASE_URL'] ?? ''
    const apiKey = process.env['SUPABASE_PUBLISHABLE_KEY'] ?? ''
    if (!baseUrl || !apiKey) return c.json({ error: 'Anmeldedienst ist nicht eingerichtet.' }, 500)
    const res = await fetch(`${baseUrl}/auth/v1/user`, {
      headers: { apikey: apiKey, authorization: `Bearer ${accessToken}` },
    })
    if (!res.ok) return c.json({ error: 'Anmeldung konnte nicht bestätigt werden.' }, 401)
    const profile = (await res.json()) as { email?: string }
    const email = (profile.email ?? '').trim()
    if (!email) return c.json({ error: 'Das gewählte Konto hat keine E-Mail-Adresse.' }, 400)
    const session = await loginWithEmail(db, email)
    if (!session) {
      return c.json(
        { error: `Für ${email} gibt es noch keinen Zugang. Bitte wenden Sie sich an Ihre Administration.` },
        403,
      )
    }
    return c.json(session)
  })
  app.post('/api/auth/register', async (c) => {
    const body = await c.req.json<{ email: string; name: string; password: string; orgName: string }>()
    if (!body.email?.includes('@') || !body.name?.trim() || (body.password ?? '').length < 8 || !body.orgName?.trim()) {
      return c.json({ error: 'Bitte alle Felder ausfüllen (Passwort mindestens 8 Zeichen).' }, 400)
    }
    return c.json(await register(db, body), 201)
  })
  app.get('/api/auth/me', async (c) => {
    const header = c.req.header('authorization') ?? ''
    const session = header.startsWith('Bearer ') ? await resolveSession(db, header.slice(7)) : null
    if (!session) return c.json({ error: 'Nicht angemeldet.' }, 401)
    return c.json(session)
  })
  app.post('/api/auth/logout', async (c) => {
    const header = c.req.header('authorization') ?? ''
    if (header.startsWith('Bearer ')) await db.run('DELETE FROM sessions WHERE token = ?', header.slice(7))
    return c.json({ ok: true })
  })
  // Demo-Zugänge werden in der Oberfläche nicht mehr angeboten (Daten bleiben erhalten).
  app.get('/api/auth/demo', (c) => c.json({ password: '', accounts: [] }))

  // ---- Geschützt
  const api = new Hono<AppEnv>()
  api.use('*', authMiddleware(db))
  api.route('/', orgRoutes)
  api.route('/', projectRoutes)
  api.route('/', templateRoutes)
  api.route('/', v1Routes)
  api.route('/', reportRoutes)
  api.route('/', integrationRoutes)
  api.route('/', planImportRoutes)
  api.route('/', attachmentRoutes)
  api.route('/', jarvisRoutes)
  // Öffentlich (Token-basiert, ohne Sitzung) - vor der geschützten API registrieren
  app.route('/api', shareRoutes(db))
  app.route('/api', api)

  return app
}

let appPromise: Promise<ReturnType<typeof buildApp>> | null = null

/** Initialisiert Datenbank, Migrationen und Demodaten einmalig und liefert die Hono-App. */
export function getApiApp() {
  if (!appPromise) {
    appPromise = (async () => {
      const db = new Db()
      await db.migrate(migrationFiles)
      await ensureAttachmentsBucket()
      await seedBuiltinTemplates(db)
      await seedDemoOrg(db)
      await seedWorkspaceOrg(db)
      await seedEsWohnbauOrg(db)
      return buildApp(db)
    })().catch((err) => {
      appPromise = null
      throw err
    })
  }
  return appPromise
}
