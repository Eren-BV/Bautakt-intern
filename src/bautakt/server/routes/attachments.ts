/**
 * Datei-/Foto-Anhänge: signierte Upload-URL anfordern, Metadaten bestätigen, auflisten.
 * Die Datei-Bytes laufen nie durch diesen Server - der Browser lädt direkt zu Storage hoch,
 * hier wird nur die signierte URL ausgestellt und danach die Metadaten-Zeile geschrieben.
 */

import { Hono } from 'hono'
import { HttpError, requireCap, type AppEnv } from '../auth.ts'
import { newId, nowISO } from '../db.ts'
import { Repo } from '../repo.ts'
import type { Attachment } from '../../shared/types.ts'
import { ALLOWED_ATTACHMENT_MIME, MAX_ATTACHMENT_SIZE, createUploadUrl, createViewUrl } from '../services/storage.ts'
import { broadcastProject } from '../services/realtime.ts'

export const attachmentRoutes = new Hono<AppEnv>()

async function requireProject(c: { get: (k: 'db' | 'session') => unknown }, projectId: string) {
  const repo = new Repo(c.get('db') as AppEnv['Variables']['db'])
  const session = c.get('session') as AppEnv['Variables']['session']
  const project = await repo.project(session.org.id, projectId)
  if (!project) throw new HttpError(404, 'Projekt nicht gefunden.')
  return { session, project }
}

/** Signierte Upload-URL für eine neue Datei (Vorgang und/oder Baustellen-Update optional). */
attachmentRoutes.post('/projects/:id/attachments/upload-url', requireCap('site.update'), async (c) => {
  const { session, project } = await requireProject(c, c.req.param('id'))
  const body = await c.req.json<{ filename?: string; mime?: string; size?: number }>()
  const filename = (body.filename ?? '').trim().slice(0, 200)
  if (!filename) throw new HttpError(400, 'Dateiname fehlt.')
  if (!body.mime || !ALLOWED_ATTACHMENT_MIME.includes(body.mime)) throw new HttpError(400, 'Dateityp nicht erlaubt.')
  if (!body.size || body.size > MAX_ATTACHMENT_SIZE) throw new HttpError(400, `Datei zu groß (max. ${Math.round(MAX_ATTACHMENT_SIZE / 1024 / 1024)} MB).`)
  const id = newId('att')
  const storageKey = `${session.org.id}/${project.id}/${id}-${filename}`
  const { signedUrl, token } = await createUploadUrl(storageKey)
  return c.json({ attachment_id: id, storage_key: storageKey, upload_url: signedUrl, token })
})

/** Bestätigt einen abgeschlossenen Upload: schreibt die Metadaten-Zeile. */
attachmentRoutes.post('/projects/:id/attachments', requireCap('site.update'), async (c) => {
  const { session, project } = await requireProject(c, c.req.param('id'))
  const db = c.get('db')
  const body = await c.req.json<{ id: string; filename: string; mime: string; size: number; storage_key: string; task_id?: string | null; progress_update_id?: string | null }>()
  if (!body.id || !body.storage_key) throw new HttpError(400, 'Ungültige Angaben.')
  const row: Attachment = {
    id: body.id,
    org_id: session.org.id,
    project_id: project.id,
    task_id: body.task_id ?? null,
    progress_update_id: body.progress_update_id ?? null,
    filename: (body.filename ?? '').slice(0, 200),
    mime: body.mime ?? 'application/octet-stream',
    size: Number(body.size) || 0,
    storage_key: body.storage_key,
    created_at: nowISO(),
  }
  await db.insert('attachments', row)
  await broadcastProject(session.org.id, project.id, 'attachment', { task_id: row.task_id, progress_update_id: row.progress_update_id })
  return c.json(row, 201)
})

/** Liste, optional gefiltert nach Vorgang oder Baustellen-Update; je Zeile eine kurzlebige Lese-URL. */
attachmentRoutes.get('/projects/:id/attachments', async (c) => {
  const { project } = await requireProject(c, c.req.param('id'))
  const db = c.get('db')
  const taskId = c.req.query('task_id')
  const progressUpdateId = c.req.query('progress_update_id')
  const conditions = ['project_id = ?']
  const params: string[] = [project.id]
  if (taskId) {
    conditions.push('task_id = ?')
    params.push(taskId)
  }
  if (progressUpdateId) {
    conditions.push('progress_update_id = ?')
    params.push(progressUpdateId)
  }
  const rows = await db.all<Attachment>(`SELECT * FROM attachments WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC`, ...params)
  const withUrls = await Promise.all(rows.map(async (r) => ({ ...r, url: await createViewUrl(r.storage_key) })))
  return c.json(withUrls)
})
