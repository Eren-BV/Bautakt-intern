/**
 * Planimport-Routen für den internen Aufgabenbereich:
 *   - Lucidchart: Diagramm über die Lucid-API laden und in einen Planentwurf übersetzen
 *   - Dokument (PDF/Word): im Browser extrahierter Text → KI-Analyse → Planentwurf
 *   - Übernahme eines geprüften Planentwurfs in ein bestehendes Projekt
 * Der Entwurf wird immer erst angezeigt und kann bearbeitet werden; erst die Übernahme schreibt.
 */

import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { HttpError, requireCap, type AppEnv } from '../auth.ts'
import { Repo } from '../repo.ts'
import { ProjectService } from '../services/projectService.ts'
import { extractPlanFromTextStream, generatePlanFromBriefStream, refinePlan, sortPlanWithAi } from '../services/aiPlanService.ts'
import { getAiProvider } from '../services/aiGateway.ts'
import { fetchLucidPlan, lucidConfigured } from '../services/lucidService.ts'
import { jiraToExtractedPlan, type JiraSearchResponse } from '../../shared/integrations/jira/adapter.ts'
import { normalizeExtractedPlan, type ExtractedPlan } from '../../shared/integrations/planextract/types.ts'


export const planImportRoutes = new Hono<AppEnv>()

planImportRoutes.get('/plan-import/status', (c) => {
  const hasLucid = lucidConfigured()
  const hasAi = !!getAiProvider()
  const hasJira = !!(process.env['JIRA_BASE_URL'] && process.env['JIRA_EMAIL'] && process.env['JIRA_API_TOKEN'])
  return c.json({
    lucidchart: { configured: hasLucid, note: hasLucid ? 'Verbunden – Diagramme können geladen werden.' : 'API-Schlüssel fehlt.' },
    document_ai: { configured: hasAi, note: hasAi ? 'KI-Analyse von PDF und Word verfügbar.' : 'KI ist nicht konfiguriert.' },
    jira: { configured: hasJira, note: hasJira ? 'Verbunden – Vorgänge können geladen werden.' : 'Zugangsdaten werden beim Import abgefragt.' },
  })
})

// ---------------------------------------------------------------- Lucidchart
planImportRoutes.post('/plan-import/lucidchart', requireCap('project.create'), async (c) => {
  const body = await c.req.json<{ document: string }>()
  return c.json(await fetchLucidPlan(body.document ?? ''))
})

// ---------------------------------------------------------------- Dokument (KI)
/** Wie oben, aber als Server-Sent-Events: meldet zwischendurch die Anzahl entworfener Aufgaben,
 *  damit die Oberfläche einen Fortschritt statt nur eines Ladesymbols zeigen kann. */
planImportRoutes.post('/plan-import/document', requireCap('project.create'), async (c) => {
  const body = await c.req.json<{ text: string; file_name?: string; hint?: string }>()
  if (!body.text?.trim()) throw new HttpError(400, 'Es wurde kein Text aus dem Dokument übergeben.')
  c.header('Cache-Control', 'no-cache, no-transform')
  c.header('X-Accel-Buffering', 'no')
  return streamSSE(
    c,
    async (stream) => {
      try {
        for await (const ev of extractPlanFromTextStream(body.text, body.file_name ?? 'Dokument', body.hint)) await stream.writeSSE({ data: JSON.stringify(ev) })
      } catch (e) {
        await stream.writeSSE({ data: JSON.stringify({ type: 'error', message: e instanceof HttpError ? e.message : 'Die Auswertung ist fehlgeschlagen.' }) })
      }
    },
    async (err, stream) => {
      console.error('[plan-import] Stream-Fehler', err)
      await stream.writeSSE({ data: JSON.stringify({ type: 'error', message: 'Da ist etwas schiefgegangen.' }) })
    },
  )
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
/** Projektplan aus einer freien Beschreibung entwerfen - als Server-Sent-Events (siehe oben). */
planImportRoutes.post('/plan-import/generate', requireCap('project.create'), async (c) => {
  const body = await c.req.json<{ brief: string; kind?: string; people?: string[] }>()
  c.header('Cache-Control', 'no-cache, no-transform')
  c.header('X-Accel-Buffering', 'no')
  return streamSSE(
    c,
    async (stream) => {
      try {
        for await (const ev of generatePlanFromBriefStream(body.brief ?? '', { kind: body.kind, people: body.people })) await stream.writeSSE({ data: JSON.stringify(ev) })
      } catch (e) {
        await stream.writeSSE({ data: JSON.stringify({ type: 'error', message: e instanceof HttpError ? e.message : 'Der Entwurf ist fehlgeschlagen.' }) })
      }
    },
    async (err, stream) => {
      console.error('[plan-import] Stream-Fehler', err)
      await stream.writeSSE({ data: JSON.stringify({ type: 'error', message: 'Da ist etwas schiefgegangen.' }) })
    },
  )
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
  const body = await c.req.json<{ plan: ExtractedPlan; parent_id?: string | null; after_id?: string | null } | ExtractedPlan>()
  // Abwärtskompatibel: alte Aufrufer senden den ExtractedPlan direkt als Body (ohne Einfüge-Position).
  const plan = 'plan' in body && body.plan ? body.plan : (body as ExtractedPlan)
  const { parent_id, after_id } = 'plan' in body ? body : { parent_id: undefined, after_id: undefined }
  const svc = new ProjectService(c.get('db'))
  return c.json(await svc.attachExtractedPlan(s, project.id, plan, { parent_id, after_id }))
})

