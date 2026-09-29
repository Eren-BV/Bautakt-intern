/**
 * Eigenständige Aufgaben (Delegation): projektübergreifend, losgelöst vom Terminplan.
 * Ablauf: erteilen (mit Frist + optionaler Erinnerung, optional Anhänge) → bearbeiten →
 * Ergebnis zurückgeben (Notiz + optional Anhänge) → Auftraggeber schließt ab oder gibt zurück.
 */

import { Hono } from 'hono'
import { HttpError, requireCap, type AppEnv } from '../auth.ts'
import { newId, nowISO, type Db } from '../db.ts'
import { Repo } from '../repo.ts'
import type { Assignment, AssignmentStatus, AssignmentView, Attachment } from '../../shared/types.ts'
import { createViewUrl } from '../services/storage.ts'
import { pushNotification } from '../services/notificationService.ts'
import { broadcastOrg } from '../services/realtime.ts'

export const assignmentRoutes = new Hono<AppEnv>()

async function enrich(db: Db, repo: Repo, orgId: string, rows: Assignment[]): Promise<AssignmentView[]> {
  if (!rows.length) return []
  const [members, projects] = await Promise.all([repo.members(orgId), repo.projects(orgId)])
  const nameOf = (id: string) => members.find((m) => m.user_id === id)?.user?.name ?? '–'
  const projectName = (id: string) => projects.find((p) => p.id === id)?.name ?? '–'

  const taskIds = [...new Set(rows.map((r) => r.task_id).filter((x): x is string => !!x))]
  const taskNames = new Map<string, string>()
  if (taskIds.length) {
    const trows = await db.all<{ id: string; name: string }>(`SELECT id, name FROM tasks WHERE id IN (${taskIds.map(() => '?').join(',')})`, ...taskIds)
    for (const t of trows) taskNames.set(t.id, t.name)
  }

  const ids = rows.map((r) => r.id)
  const attRows = await db.all<Attachment>(`SELECT * FROM attachments WHERE assignment_id IN (${ids.map(() => '?').join(',')}) ORDER BY created_at`, ...ids)
  const attByAssignment = new Map<string, Attachment[]>()
  for (const a of attRows) {
    const withUrl = { ...a, url: await createViewUrl(a.storage_key).catch(() => undefined) }
    attByAssignment.set(a.assignment_id!, [...(attByAssignment.get(a.assignment_id!) ?? []), withUrl])
  }

  return rows.map((r) => ({
    ...r,
    project_name: projectName(r.project_id),
    task_name: r.task_id ? (taskNames.get(r.task_id) ?? null) : null,
    assigned_by_name: nameOf(r.assigned_by),
    assigned_to_name: nameOf(r.assigned_to),
    attachments: attByAssignment.get(r.id) ?? [],
  }))
}

/** Aufgaben, an denen der Nutzer beteiligt ist: an ihn vergeben oder von ihm vergeben. */
assignmentRoutes.get('/assignments', async (c) => {
  const s = c.get('session')
  const db = c.get('db')
  const repo = new Repo(db)
  const scope = c.req.query('scope') ?? 'mine'
  const column = scope === 'given' ? 'assigned_by' : 'assigned_to'
  const rows = await db.all<Assignment>(`SELECT * FROM assignments WHERE org_id = ? AND ${column} = ? ORDER BY (due_date IS NULL), due_date, created_at DESC`, s.org.id, s.user.id)
  return c.json(await enrich(db, repo, s.org.id, rows))
})

assignmentRoutes.post('/assignments', requireCap('site.update'), async (c) => {
  const s = c.get('session')
  const db = c.get('db')
  const repo = new Repo(db)
  const body = await c.req.json<{ project_id: string; task_id?: string | null; title: string; description?: string; assigned_to: string; due_date?: string | null; reminder_date?: string | null }>()
  if (!body.project_id || !(await repo.project(s.org.id, body.project_id))) throw new HttpError(404, 'Projekt nicht gefunden.')
  if (!body.title?.trim()) throw new HttpError(400, 'Titel ist erforderlich.')
  if (!body.assigned_to) throw new HttpError(400, 'Wer soll die Aufgabe bekommen?')
  const member = (await repo.members(s.org.id)).find((m) => m.user_id === body.assigned_to)
  if (!member) throw new HttpError(400, 'Diese Person ist nicht Teil der Organisation.')
  const now = nowISO()
  const row: Assignment = {
    id: newId('as'), org_id: s.org.id, project_id: body.project_id, task_id: body.task_id ?? null,
    title: body.title.trim().slice(0, 200), description: (body.description ?? '').slice(0, 4000),
    assigned_by: s.user.id, assigned_to: body.assigned_to,
    due_date: body.due_date ?? null, reminder_date: body.reminder_date ?? null,
    status: 'open', result_note: null, result_submitted_at: null, closed_at: null,
    created_at: now, updated_at: now,
  }
  await db.insert('assignments', row)
  if (row.assigned_to !== s.user.id) {
    await pushNotification(db, {
      org_id: s.org.id, user_id: row.assigned_to, project_id: row.project_id, type: 'assignment_new', severity: 'info',
      title: `Neue Aufgabe: ${row.title}`,
      message: `${s.user.name} hat dir eine Aufgabe gegeben${row.due_date ? `, fällig ${row.due_date}` : ''}.`,
      channels: ['in_app', 'email'],
    })
  }
  await broadcastOrg(s.org.id, 'notification', { scope: 'assignment' })
  return c.json((await enrich(db, repo, s.org.id, [row]))[0], 201)
})

async function requireAssignment(c: { get: (k: 'db' | 'session') => unknown }, id: string): Promise<{ db: Db; session: AppEnv['Variables']['session']; row: Assignment }> {
  const db = c.get('db') as Db
  const session = c.get('session') as AppEnv['Variables']['session']
  const row = await db.get<Assignment>('SELECT * FROM assignments WHERE id = ? AND org_id = ?', id, session.org.id)
  if (!row) throw new HttpError(404, 'Aufgabe nicht gefunden.')
  return { db, session, row }
}

/** Titel, Beschreibung, Frist, Erinnerung, Empfänger ändern - nur der Auftraggeber, solange offen. */
assignmentRoutes.patch('/assignments/:id', async (c) => {
  const { db, session, row } = await requireAssignment(c, c.req.param('id'))
  if (row.assigned_by !== session.user.id) throw new HttpError(403, 'Nur wer die Aufgabe erteilt hat, kann sie ändern.')
  if (row.status === 'done') throw new HttpError(400, 'Abgeschlossene Aufgaben lassen sich nicht mehr ändern.')
  const body = await c.req.json<Partial<Pick<Assignment, 'title' | 'description' | 'due_date' | 'reminder_date' | 'assigned_to'>>>()
  const patch: Record<string, unknown> = { updated_at: nowISO() }
  if (body.title !== undefined) patch.title = body.title.trim().slice(0, 200)
  if (body.description !== undefined) patch.description = body.description.slice(0, 4000)
  if (body.due_date !== undefined) patch.due_date = body.due_date
  if (body.reminder_date !== undefined) patch.reminder_date = body.reminder_date
  if (body.assigned_to !== undefined && body.assigned_to !== row.assigned_to) {
    const member = (await new Repo(db).members(session.org.id)).find((m) => m.user_id === body.assigned_to)
    if (!member) throw new HttpError(400, 'Diese Person ist nicht Teil der Organisation.')
    patch.assigned_to = body.assigned_to
  }
  await db.update('assignments', row.id, patch)
  const fresh = (await db.get<Assignment>('SELECT * FROM assignments WHERE id = ?', row.id))!
  if (patch.assigned_to && patch.assigned_to !== session.user.id) {
    await pushNotification(db, {
      org_id: session.org.id, user_id: fresh.assigned_to, project_id: fresh.project_id, type: 'assignment_new', severity: 'info',
      title: `Aufgabe übertragen: ${fresh.title}`, message: `${session.user.name} hat dir diese Aufgabe zugewiesen.`, channels: ['in_app', 'email'],
    })
  }
  await broadcastOrg(session.org.id, 'notification', { scope: 'assignment' })
  return c.json((await enrich(db, new Repo(db), session.org.id, [fresh]))[0])
})

/** Bearbeiter gibt das Ergebnis zurück - Anhänge werden vorher separat hochgeladen und hier referenziert. */
assignmentRoutes.post('/assignments/:id/submit', async (c) => {
  const { db, session, row } = await requireAssignment(c, c.req.param('id'))
  if (row.assigned_to !== session.user.id) throw new HttpError(403, 'Nur wer die Aufgabe bearbeitet, kann das Ergebnis zurückgeben.')
  if (row.status === 'done') throw new HttpError(400, 'Diese Aufgabe ist bereits abgeschlossen.')
  const body = await c.req.json<{ result_note?: string }>().catch(() => ({}) as { result_note?: string })
  const now = nowISO()
  await db.update('assignments', row.id, { status: 'submitted' as AssignmentStatus, result_note: (body.result_note ?? '').slice(0, 4000), result_submitted_at: now, updated_at: now })
  await pushNotification(db, {
    org_id: session.org.id, user_id: row.assigned_by, project_id: row.project_id, type: 'assignment_submitted', severity: 'info',
    title: `Ergebnis erhalten: ${row.title}`, message: `${session.user.name} hat ein Ergebnis zurückgegeben.`, channels: ['in_app', 'email'],
  })
  await broadcastOrg(session.org.id, 'notification', { scope: 'assignment' })
  const fresh = (await db.get<Assignment>('SELECT * FROM assignments WHERE id = ?', row.id))!
  return c.json((await enrich(db, new Repo(db), session.org.id, [fresh]))[0])
})

/** Auftraggeber schließt die Aufgabe ab (Ergebnis akzeptiert). */
assignmentRoutes.post('/assignments/:id/close', async (c) => {
  const { db, session, row } = await requireAssignment(c, c.req.param('id'))
  if (row.assigned_by !== session.user.id) throw new HttpError(403, 'Nur wer die Aufgabe erteilt hat, kann sie abschließen.')
  const now = nowISO()
  await db.update('assignments', row.id, { status: 'done' as AssignmentStatus, closed_at: now, updated_at: now })
  await pushNotification(db, {
    org_id: session.org.id, user_id: row.assigned_to, project_id: row.project_id, type: 'assignment_closed', severity: 'info',
    title: `Aufgabe abgeschlossen: ${row.title}`, message: `${session.user.name} hat die Aufgabe als erledigt bestätigt.`, channels: ['in_app'],
  })
  await broadcastOrg(session.org.id, 'notification', { scope: 'assignment' })
  const fresh = (await db.get<Assignment>('SELECT * FROM assignments WHERE id = ?', row.id))!
  return c.json((await enrich(db, new Repo(db), session.org.id, [fresh]))[0])
})

/** Auftraggeber schickt ein eingereichtes Ergebnis mit Anmerkung zurück an den Bearbeiter. */
assignmentRoutes.post('/assignments/:id/reopen', async (c) => {
  const { db, session, row } = await requireAssignment(c, c.req.param('id'))
  if (row.assigned_by !== session.user.id) throw new HttpError(403, 'Nur wer die Aufgabe erteilt hat, kann sie zurückgeben.')
  if (row.status !== 'submitted') throw new HttpError(400, 'Nur eingereichte Aufgaben lassen sich zurückgeben.')
  const body = await c.req.json<{ note?: string }>().catch(() => ({}) as { note?: string })
  const now = nowISO()
  await db.update('assignments', row.id, { status: 'open' as AssignmentStatus, updated_at: now })
  await pushNotification(db, {
    org_id: session.org.id, user_id: row.assigned_to, project_id: row.project_id, type: 'assignment_reopened', severity: 'warning',
    title: `Bitte nacharbeiten: ${row.title}`, message: body.note?.trim() ? `${session.user.name}: ${body.note.trim()}` : `${session.user.name} hat die Aufgabe zurückgegeben.`,
    channels: ['in_app', 'email'],
  })
  await broadcastOrg(session.org.id, 'notification', { scope: 'assignment' })
  const fresh = (await db.get<Assignment>('SELECT * FROM assignments WHERE id = ?', row.id))!
  return c.json((await enrich(db, new Repo(db), session.org.id, [fresh]))[0])
})

assignmentRoutes.delete('/assignments/:id', async (c) => {
  const { db, session, row } = await requireAssignment(c, c.req.param('id'))
  if (row.assigned_by !== session.user.id) throw new HttpError(403, 'Nur wer die Aufgabe erteilt hat, kann sie zurückziehen.')
  await db.run('DELETE FROM assignments WHERE id = ?', row.id)
  await broadcastOrg(session.org.id, 'notification', { scope: 'assignment' })
  return c.json({ ok: true })
})
