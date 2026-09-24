/**
 * Notification Center. Zwei Quellen:
 *  1. Ereignisse (Baustellen-Update, Baseline) → `pushNotification`
 *  2. Zustandsprüfungen (Meilenstein in 3 Tagen, Vorgang überfällig, Terminabweichung)
 *     → `refreshProjectNotifications`, dedupliziert über `dedupe_key`, damit ein
 *     Zustand nur einmal gemeldet wird.
 *
 * Zustellung: `dispatch()` ist der Austauschpunkt für E-Mail/Push. Aktuell werden nur
 * In-App-Benachrichtigungen gespeichert; die Kanäle stehen bereits am Datensatz.
 */

import type { Db } from '../db.ts'
import { newId, nowISO } from '../db.ts'
import type { AppNotification, NotificationChannel, NotificationSeverity, NotificationType, ProjectBundle } from '../../shared/types.ts'
import { analyzeProject } from '../../shared/engine/analysis.ts'
import { formatDate, fromDayNumber, todayISO, toDayNumber } from '../../shared/engine/dates.ts'

export interface NotificationInput {
  org_id: string
  user_id?: string | null
  project_id?: string | null
  type: NotificationType
  severity: NotificationSeverity
  title: string
  message: string
  channels?: NotificationChannel[]
  dedupe_key?: string
}

export async function pushNotification(db: Db, input: NotificationInput): Promise<AppNotification | null> {
  const n: AppNotification & { dedupe_key: string | null } = {
    id: newId('nt'),
    org_id: input.org_id,
    user_id: input.user_id ?? null,
    project_id: input.project_id ?? null,
    type: input.type,
    severity: input.severity,
    title: input.title,
    message: input.message,
    created_at: nowISO(),
    read_at: null,
    channels: input.channels ?? ['in_app'],
    dedupe_key: input.dedupe_key ?? null,
  }
  if (n.dedupe_key) {
    const exists = await db.get('SELECT id FROM notifications WHERE org_id = ? AND dedupe_key = ?', n.org_id, n.dedupe_key)
    if (exists) return null
  }
  await db.insert('notifications', n)
  dispatch(n)
  return n
}

/** Austauschpunkt: hier später E-Mail-/Push-Versand anschließen (z. B. Queue + Worker). */
function dispatch(n: AppNotification): void {
  for (const ch of n.channels) {
    if (ch === 'in_app') continue
    // TODO(email/push): Provider-Adapter aufrufen. Bewusst kein Fake-Versand.
  }
}

export async function refreshProjectNotifications(db: Db, orgId: string, bundle: ProjectBundle, today = todayISO()): Promise<void> {
  if (bundle.project.state !== 'active') return
  const a = analyzeProject(bundle, today)
  const todayDay = toDayNumber(today)
  const p = bundle.project
  for (const t of bundle.tasks) {
    const s = a.current.tasks.get(t.id)
    if (!s || !s.isLeaf || t.status === 'done') continue
    if (t.type === 'milestone') {
      const diff = s.start - todayDay
      if (diff >= 0 && diff <= 3) {
        await pushNotification(db, {
          org_id: orgId, project_id: p.id, type: 'milestone_upcoming', severity: 'info',
          title: `Meilenstein ${t.name} in ${diff === 0 ? 'heute' : `${diff} Tagen`}`,
          message: `${p.name}: ${t.name} am ${formatDate(fromDayNumber(s.start))}.`,
          dedupe_key: `ms:${t.id}:${fromDayNumber(s.start)}`,
        })
      }
    } else if (s.end < todayDay) {
      await pushNotification(db, {
        org_id: orgId, project_id: p.id, type: 'task_overdue', severity: 'warning',
        title: `Vorgang ${t.name} ist überfällig`,
        message: `${p.name}: geplantes Ende ${formatDate(fromDayNumber(s.end))}, Status "${t.status === 'in_progress' ? 'in Arbeit' : 'nicht begonnen'}".`,
        dedupe_key: `overdue:${t.id}:${fromDayNumber(s.end)}`,
      })
    }
  }
  if (a.variance_days > 0) {
    await pushNotification(db, {
      org_id: orgId, project_id: p.id, type: 'project_variance', severity: a.variance_days >= 5 ? 'critical' : 'warning',
      title: `Projekt ${p.name} hat ${a.variance_days} Tage Terminabweichung`,
      message: `Prognose ${formatDate(a.forecast_end)} statt ${formatDate(a.baseline_end ?? p.target_end_date)}.`,
      dedupe_key: `variance:${p.id}:${a.variance_days}`,
    })
  }
}
