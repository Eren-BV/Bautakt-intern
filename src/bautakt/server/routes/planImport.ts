/**
 * Planimport-Routen für den internen Aufgabenbereich:
 *   - Lucidchart: Diagramm über die Lucid-API laden und in einen Planentwurf übersetzen
 *   - Dokument (PDF/Word): im Browser extrahierter Text → KI-Analyse → Planentwurf
 *   - Übernahme eines geprüften Planentwurfs in ein bestehendes Projekt
 * Der Entwurf wird immer erst angezeigt und kann bearbeitet werden; erst die Übernahme schreibt.
 */

import { Hono } from 'hono'
import { HttpError, requireCap, type AppEnv } from '../auth.ts'
import { Repo } from '../repo.ts'
import { ProjectService } from '../services/projectService.ts'
import { extractPlanFromText } from '../services/aiPlanService.ts'
import { lucidToExtractedPlan, type LucidDocumentContents } from '../../shared/integrations/lucidchart/adapter.ts'
import { normalizeExtractedPlan, type ExtractedPlan } from '../../shared/integrations/planextract/types.ts'

export const planImportRoutes = new Hono<AppEnv>()

const LUCID_API = 'https://api.lucid.co'

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i

/** Dokument-ID aus einer Lucid-URL (lucid.app, lucidchart.com) oder direkter Eingabe lesen. */
export function parseLucidDocumentId(input: string): string | null {
  const v = input.trim()
  if (!v) return null
  // Direkte Dokument-ID
  if (new RegExp(`^${UUID.source}$`, 'i').test(v)) return v.toLowerCase()
  // Pfadform: /lucidchart/<id>/edit, /documents/edit/<id>, /documents/<id> …
  const path = v.match(new RegExp(`(?:lucidchart|documents)/(?:(?:edit|view|embeddedchart)/)?(${UUID.source})`, 'i'))
  if (path) return path[1]!.toLowerCase()
  // Sonst: erste ID vor den Query-Parametern (ignoriert z. B. invitationId)
  const beforeQuery = v.split('?')[0]!.match(UUID)
  if (beforeQuery) return beforeQuery[0].toLowerCase()
  const anywhere = v.match(UUID)
  if (anywhere) return anywhere[0].toLowerCase()
  if (/^[0-9a-z-]{16,}$/i.test(v)) return v
  return null
}

planImportRoutes.get('/plan-import/status', (c) => {
  const hasLucid = !!process.env['LUCIDCHART_API_KEY']
  const hasAi = !!process.env['LOVABLE_API_KEY']
  return c.json({
    lucidchart: { configured: hasLucid, note: hasLucid ? 'Verbunden – Diagramme können geladen werden.' : 'API-Schlüssel fehlt.' },
    document_ai: { configured: hasAi, note: hasAi ? 'KI-Analyse von PDF und Word verfügbar.' : 'KI ist nicht konfiguriert.' },
  })
})

// ---------------------------------------------------------------- Lucidchart
planImportRoutes.post('/plan-import/lucidchart', requireCap('project.create'), async (c) => {
  const key = process.env['LUCIDCHART_API_KEY']
  if (!key) throw new HttpError(400, 'Für Lucidchart ist noch kein API-Schlüssel hinterlegt.')
  const body = await c.req.json<{ document: string }>()
  const documentId = parseLucidDocumentId(body.document ?? '')
  if (!documentId) throw new HttpError(400, 'Bitte einen Lucidchart-Link oder eine Dokument-ID angeben.')

  const res = await fetch(`${LUCID_API}/documents/${documentId}/contents`, {
    headers: { Authorization: `Bearer ${key}`, 'Lucid-Api-Version': '1' },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    if (res.status === 401 || res.status === 403) throw new HttpError(403, 'Lucidchart verweigert den Zugriff auf dieses Dokument (Schlüssel oder Freigabe prüfen).')
    if (res.status === 404) throw new HttpError(404, 'Das Lucidchart-Dokument wurde nicht gefunden.')
    throw new HttpError(502, `Lucidchart-Abruf fehlgeschlagen (${res.status}). ${text.slice(0, 200)}`)
  }
  const doc = (await res.json()) as LucidDocumentContents
  const plan = normalizeExtractedPlan(lucidToExtractedPlan(doc, documentId), { source: 'lucidchart', reference: documentId })
  if (!plan.tasks.length) throw new HttpError(422, 'Im Diagramm wurden keine beschrifteten Formen gefunden.')
  return c.json(plan)
})

// ---------------------------------------------------------------- Dokument (KI)
planImportRoutes.post('/plan-import/document', requireCap('project.create'), async (c) => {
  const body = await c.req.json<{ text: string; file_name?: string; hint?: string }>()
  if (!body.text?.trim()) throw new HttpError(400, 'Es wurde kein Text aus dem Dokument übergeben.')
  const plan = await extractPlanFromText(body.text, body.file_name ?? 'Dokument', body.hint)
  return c.json(plan)
})

// ---------------------------------------------------------------- Übernahme
planImportRoutes.post('/projects/:id/plan-import', requireCap('plan.edit'), async (c) => {
  const s = c.get('session')
  const repo = new Repo(c.get('db'))
  const project = await repo.project(s.org.id, c.req.param('id'))
  if (!project) throw new HttpError(404, 'Projekt nicht gefunden.')
  const plan = (await c.req.json()) as ExtractedPlan
  const svc = new ProjectService(c.get('db'))
  return c.json(await svc.attachExtractedPlan(s, project.id, plan))
})
