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

/** Verantwortliche Personen eines Vorgangs (Mehrfachzuordnung inklusive). */
function responsibleIds(t: { responsible_user_id: string | null; responsible_user_ids?: string[] }): string[] {
  const ids = new Set<string>([...(t.responsible_user_ids ?? [])])
  if (t.responsible_user_id) ids.add(t.responsible_user_id)
  return [...ids]
}

export async function refreshProjectNotifications(db: Db, orgId: string, bundle: ProjectBundle, today = todayISO()): Promise<void> {
  if (bundle.project.state !== 'active') return
  const a = analyzeProject(bundle, today)
  const todayDay = toDayNumber(today)
  const p = bundle.project
  const taskById = new Map(bundle.tasks.map((t) => [t.id, t]))
  const predecessors = new Map<string, string[]>()
  for (const d of bundle.dependencies) predecessors.set(d.successor_id, [...(predecessors.get(d.successor_id) ?? []), d.predecessor_id])

  for (const t of bundle.tasks) {
    const s = a.current.tasks.get(t.id)
    if (!s || !s.isLeaf || t.status === 'done') continue

    // ---- Personenbezogene Meldungen
    const people = responsibleIds(t)
    if (people.length) {
      const startIn = s.start - todayDay
      const endIn = s.end - todayDay
      const preds = (predecessors.get(t.id) ?? []).map((id) => taskById.get(id)).filter(Boolean)
      const predsDone = preds.every((x) => x!.status === 'done')
      for (const uid of people) {
        if (t.status === 'not_started' && predsDone && startIn <= 1) {
          await pushNotification(db, {
            org_id: orgId, user_id: uid, project_id: p.id, type: 'info', severity: 'info',
            title: `Aufgabe startbereit: ${t.name}`,
            message: `${p.name}: ${preds.length ? 'Alle Vorarbeiten sind erledigt. ' : ''}Geplanter Start ${formatDate(fromDayNumber(s.start))}.`,
            channels: ['in_app', 'email'],
            dedupe_key: `ready:${t.id}:${fromDayNumber(s.start)}:${uid}`,
          })
        }
        if (t.status !== 'done' && endIn >= 0 && endIn <= 2) {
          await pushNotification(db, {
            org_id: orgId, user_id: uid, project_id: p.id, type: 'info', severity: 'warning',
            title: `Frist in ${endIn === 0 ? 'heute' : `${endIn} Tagen`}: ${t.name}`,
            message: `${p.name}: geplantes Ende ${formatDate(fromDayNumber(s.end))}.`,
            channels: ['in_app', 'email'],
            dedupe_key: `due:${t.id}:${fromDayNumber(s.end)}:${uid}`,
          })
        }
        if (s.end < todayDay) {
          const late = todayDay - s.end
          await pushNotification(db, {
            org_id: orgId, user_id: uid, project_id: p.id, type: 'task_overdue', severity: late >= 3 ? 'critical' : 'warning',
            title: `Im Verzug: ${t.name} (${late} ${late === 1 ? 'Tag' : 'Tage'})`,
            message: `${p.name}: geplantes Ende war ${formatDate(fromDayNumber(s.end))}. Nachfolgende Aufgaben verschieben sich entsprechend.`,
            channels: ['in_app', 'email'],
            dedupe_key: `late:${t.id}:${fromDayNumber(s.end)}:${late}:${uid}`,
          })
          // Nachfolger informieren: deren Start verschiebt sich
          for (const d of bundle.dependencies.filter((x) => x.predecessor_id === t.id)) {
            const next = taskById.get(d.successor_id)
            if (!next || next.status === 'done') continue
            for (const nuid of responsibleIds(next)) {
              await pushNotification(db, {
                org_id: orgId, user_id: nuid, project_id: p.id, type: 'info', severity: 'warning',
                title: `Verschiebung erwartet: ${next.name}`,
                message: `${p.name}: Die Vorarbeit „${t.name}“ ist ${late} ${late === 1 ? 'Tag' : 'Tage'} im Verzug.`,
                channels: ['in_app'],
                dedupe_key: `shift:${next.id}:${t.id}:${late}:${nuid}`,
              })
            }
          }
        }
      }
    }

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
