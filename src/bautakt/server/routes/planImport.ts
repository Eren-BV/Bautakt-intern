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

// ---------------------------------------------------------------- Jira
/** Zugangsdaten: bevorzugt aus den Umgebungswerten, sonst aus der Anfrage. */
function jiraAuth(body: { base_url?: string; email?: string; api_token?: string }) {
  const baseUrl = (process.env['JIRA_BASE_URL'] || body.base_url || '').trim().replace(/\/+$/, '')
  const email = (process.env['JIRA_EMAIL'] || body.email || '').trim()
  const token = (process.env['JIRA_API_TOKEN'] || body.api_token || '').trim()
  if (!baseUrl || !email || !token) throw new HttpError(400, 'Für Jira fehlen Adresse, E-Mail oder API-Token.')
  if (!/^https:\/\//i.test(baseUrl)) throw new HttpError(400, 'Die Jira-Adresse muss mit https:// beginnen.')
  return { baseUrl, header: `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}` }
}

planImportRoutes.post('/plan-import/jira', requireCap('project.create'), async (c) => {
  const body = await c.req.json<{ base_url?: string; email?: string; api_token?: string; project_key?: string; jql?: string }>()
  const { baseUrl, header } = jiraAuth(body)
  const projectKey = (body.project_key ?? '').trim()
  const jql = (body.jql ?? '').trim() || (projectKey ? `project = "${projectKey}" ORDER BY created ASC` : '')
  if (!jql) throw new HttpError(400, 'Bitte einen Jira-Projektschlüssel oder eine JQL-Abfrage angeben.')

  const url = new URL(`${baseUrl}/rest/api/3/search`)
  url.searchParams.set('jql', jql)
  url.searchParams.set('maxResults', '200')
  url.searchParams.set('fields', 'summary,description,duedate,timeoriginalestimate,customfield_10016,issuetype,status,assignee,parent,project,issuelinks')

  const res = await fetch(url, { headers: { Authorization: header, Accept: 'application/json' } })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    if (res.status === 401 || res.status === 403) throw new HttpError(403, 'Jira verweigert den Zugriff (E-Mail oder API-Token prüfen).')
    if (res.status === 404) throw new HttpError(404, 'Die Jira-Adresse oder das Projekt wurde nicht gefunden.')
    throw new HttpError(502, `Jira-Abruf fehlgeschlagen (${res.status}). ${text.slice(0, 200)}`)
  }
  const data = (await res.json()) as JiraSearchResponse
  const name = data.issues?.[0]?.fields?.project?.name || projectKey || 'Jira-Import'
  const plan = normalizeExtractedPlan(jiraToExtractedPlan(data, name, projectKey || jql), { source: 'document', reference: projectKey || jql })
  if (!plan.tasks.length) throw new HttpError(422, 'Zu dieser Jira-Abfrage wurden keine Vorgänge gefunden.')
  return c.json(plan)
})

// ---------------------------------------------------------------- KI-Assistent
/** Projektplan aus einer freien Beschreibung entwerfen. */
planImportRoutes.post('/plan-import/generate', requireCap('project.create'), async (c) => {
  const body = await c.req.json<{ brief: string; kind?: string; people?: string[] }>()
  return c.json(await generatePlanFromBrief(body.brief ?? '', { kind: body.kind, people: body.people }))
})

/** Einen Planentwurf per Anweisung erweitern oder optimieren. */
planImportRoutes.post('/plan-import/refine', requireCap('project.create'), async (c) => {
  const body = await c.req.json<{ plan: ExtractedPlan; instruction: string; people?: string[] }>()
  const plan = normalizeExtractedPlan(body.plan, { source: body.plan?.source ?? 'document' })
  return c.json(await refinePlan(plan, body.instruction ?? '', body.people))
})

/** Reihenfolge eines Planentwurfs von der KI sortieren lassen. */
planImportRoutes.post('/plan-import/sort', requireCap('project.create'), async (c) => {
  const body = await c.req.json<{ plan: ExtractedPlan }>()
  const plan = normalizeExtractedPlan(body.plan, { source: body.plan?.source ?? 'document' })
  return c.json(await sortPlanWithAi(plan))
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

