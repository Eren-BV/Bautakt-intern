/**
 * Öffentlicher OAuth-Rücksprung für die Postfach-Verknüpfung (Microsoft 365). Läuft außerhalb
 * der angemeldeten API, weil Microsoft hier ohne Bearer-Token auf die Seite zurückschickt - die
 * Identität kommt stattdessen aus dem signierten „state“ (siehe mailboxService.signState).
 */

import { Hono } from 'hono'
import type { Db } from '../db.ts'
import { HttpError } from '../auth.ts'
import { MailboxService, verifyState, type MailboxProvider } from '../services/mailboxService.ts'

const MAILBOX_PROVIDERS: MailboxProvider[] = ['microsoft365', 'gmail']
const isMailboxProvider = (v: string): v is MailboxProvider => (MAILBOX_PROVIDERS as string[]).includes(v)

export function mailboxCallbackRoutes(db: Db) {
  const app = new Hono()

  app.get('/mailbox/:provider/callback', async (c) => {
    const provider = c.req.param('provider')
    const redirectTo = (ok: boolean, message: string) => c.redirect(`/inbox?mailbox=${ok ? 'connected' : 'error'}&msg=${encodeURIComponent(message)}`, 302)
    if (!isMailboxProvider(provider)) return redirectTo(false, 'Unbekannter Anbieter.')
    const error = c.req.query('error_description') ?? c.req.query('error')
    if (error) return redirectTo(false, error.slice(0, 200))
    const code = c.req.query('code')
    const state = c.req.query('state')
    if (!code || !state) return redirectTo(false, 'Ungültige Rückmeldung von Microsoft.')
    const identity = await verifyState(state)
    if (!identity) return redirectTo(false, 'Die Anmeldung ist abgelaufen oder ungültig – bitte erneut versuchen.')
    const redirectUri = new URL(c.req.url)
    redirectUri.search = ''
    try {
      await new MailboxService(db).completeConnect(identity.userId, identity.orgId, provider, code, redirectUri.toString())
      return redirectTo(true, 'Postfach verbunden.')
    } catch (e) {
      return redirectTo(false, e instanceof HttpError ? e.message : 'Verbindung fehlgeschlagen.')
    }
  })

  return app
}
