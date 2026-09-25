/**
 * E-Mail-Zustellung in zwei Dringlichkeitsstufen.
 *
 *  Stufe 1 „immediate“ – sofort einzeln versenden:
 *    Vorgänger fertig / Aufgabe startbereit, Frist heute oder in 24 h, Verzug, kritische Lage.
 *  Stufe 2 „digest“ – im Sammelfenster (Standard 3 Stunden) zu einer Mail je Person bündeln:
 *    neue Zuweisungen, Terminverschiebungen ohne Fristgefahr, allgemeine Infos.
 *
 * Alles läuft über die Tabelle `email_outbox`. Der eigentliche Versand erfolgt über die
 * Lovable-Mailinfrastruktur; solange keine Absenderdomain verifiziert ist, bleiben die
 * Einträge mit Status `blocked` liegen und gehen nicht verloren.
 */

import type { Db, Row } from '../db.ts'
import { newId, nowISO } from '../db.ts'
import type { NotificationSeverity, NotificationType, NotificationUrgency } from '../../shared/types.ts'

/** Sammelfenster für Stufe 2 in Minuten. */
export const DIGEST_WINDOW_MINUTES = 180

/** Zuordnung Ereignisart → Dringlichkeitsstufe. */
const URGENCY_BY_TYPE: Record<NotificationType, NotificationUrgency> = {
  task_ready: 'immediate',
  task_due: 'immediate',
  task_overdue: 'immediate',
  milestone_upcoming: 'immediate',
  task_assigned: 'digest',
  task_shift: 'digest',
  project_variance: 'digest',
  site_update: 'digest',
  baseline_saved: 'digest',
  resource_overload: 'digest',
  info: 'digest',
}

/** Kritische Meldungen gehen unabhängig von der Art sofort raus. */
export function urgencyFor(type: NotificationType, severity: NotificationSeverity): NotificationUrgency {
  if (severity === 'critical') return 'immediate'
  return URGENCY_BY_TYPE[type] ?? 'digest'
}

export interface OutboxEntry extends Row {
  id: string
  org_id: string
  user_id: string | null
  to_email: string
  to_name: string
  urgency: NotificationUrgency
  severity: NotificationSeverity
  subject: string
  body: string
  notification_id: string | null
  project_id: string | null
  status: 'pending' | 'sent' | 'blocked' | 'failed'
  scheduled_for: string
  attempts: number
}

const plusMinutes = (min: number) => new Date(Date.now() + min * 60_000).toISOString()

/** Nimmt eine Benachrichtigung in die Warteschlange auf (Empfänger wird aufgelöst). */
export async function enqueueEmail(
  db: Db,
  input: {
    org_id: string
    user_id: string | null
    project_id: string | null
    notification_id: string
    type: NotificationType
    severity: NotificationSeverity
    urgency: NotificationUrgency
    title: string
    message: string
  },
): Promise<void> {
  if (!input.user_id) return
  const user = await db.get<{ email: string; name: string }>('SELECT email, name FROM users WHERE id = ?', input.user_id)
  if (!user?.email) return

  await db.insert('email_outbox', {
    id: newId('mo'),
    org_id: input.org_id,
    user_id: input.user_id,
    to_email: user.email,
    to_name: user.name ?? '',
    urgency: input.urgency,
    severity: input.severity,
    subject: input.title,
    body: input.message,
    notification_id: input.notification_id,
    project_id: input.project_id,
    status: 'pending',
    scheduled_for: input.urgency === 'immediate' ? nowISO() : plusMinutes(DIGEST_WINDOW_MINUTES),
    attempts: 0,
    sent_at: null,
    error: null,
    created_at: nowISO(),
  })
}

/**
 * Versandadapter. Nutzt die Lovable-Mailinfrastruktur, sobald eine Absenderdomain
 * eingerichtet ist. Vorher wird sauber gemeldet, dass noch nicht zugestellt werden kann.
 */
type Sender = { sendTemplateEmail?: (name: string, to: string, opts: { templateData: Record<string, unknown> }) => Promise<{ sent: boolean; reason?: string }> }

async function sendMail(to: string, subject: string, text: string): Promise<{ sent: boolean; reason?: string }> {
  try {
    const specifier = '@/lib/email-templates/send-email'
    const mod = (await import(/* @vite-ignore */ specifier).catch(() => null)) as Sender | null
    if (!mod?.sendTemplateEmail) return { sent: false, reason: 'Absenderdomain noch nicht eingerichtet.' }
    return await mod.sendTemplateEmail('bautakt-benachrichtigung', to, { templateData: { subject, text } })
  } catch (e) {
    return { sent: false, reason: (e as Error).message }
  }
}

/**
 * Verarbeitet fällige Einträge: Stufe 1 einzeln, Stufe 2 je Person gebündelt.
 * `limit` begrenzt die Arbeit pro Durchlauf (Hintergrundlauf bleibt beschränkt).
 */
export async function flushDueEmails(db: Db, limit = 200): Promise<{ immediate: number; digests: number; blocked: number }> {
  const due = await db.all<OutboxEntry>(
    "SELECT * FROM email_outbox WHERE status = 'pending' AND scheduled_for <= ? ORDER BY scheduled_for LIMIT ?",
    nowISO(),
    limit,
  )
  let immediate = 0
  let digests = 0
  let blocked = 0

  const digestByUser = new Map<string, OutboxEntry[]>()
  for (const row of due) {
    if (row.urgency === 'immediate') {
      const res = await sendMail(row.to_email, row.subject, row.body)
      await markRow(db, row, res)
      if (res.sent) immediate++
      else blocked++
    } else {
      const key = `${row.user_id ?? row.to_email}`
      digestByUser.set(key, [...(digestByUser.get(key) ?? []), row])
    }
  }

  for (const rows of digestByUser.values()) {
    const first = rows[0]!
    const subject = rows.length === 1 ? first.subject : `Ihre ${rows.length} Aufgaben-Updates`
    const body = rows.map((r) => `• ${r.subject}\n  ${r.body}`).join('\n\n')
    const res = await sendMail(first.to_email, subject, body)
    for (const r of rows) await markRow(db, r, res)
    if (res.sent) digests++
    else blocked += rows.length
  }

  return { immediate, digests, blocked }
}

async function markRow(db: Db, row: OutboxEntry, res: { sent: boolean; reason?: string }): Promise<void> {
  await db.run(
    'UPDATE email_outbox SET status = ?, sent_at = ?, error = ?, attempts = attempts + 1 WHERE id = ?',
    res.sent ? 'sent' : 'blocked',
    res.sent ? nowISO() : null,
    res.sent ? null : (res.reason ?? 'Versand nicht möglich.'),
    row.id,
  )
}
