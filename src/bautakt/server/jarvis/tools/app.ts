/**
 * Allgemeiner Zugriff von Jarvis auf alle Programmfunktionen: ruft dieselben API-Routen auf wie die
 * Oberfläche - mit der Sitzung und damit den Rechten des angemeldeten Nutzers (requireCap greift
 * unverändert). Lesen und Ändern laufen direkt; Löschen, Organisation/Rechte, öffentliche
 * Freigabelinks und das Überschreiben ganzer Pläne nur nach Bestätigung, da nicht rückgängig machbar.
 */

import { Hono } from 'hono'
import { HttpError, type AppEnv } from '../../auth.ts'
import { Repo } from '../../repo.ts'
import { requestConfirmation, s, str, type ToolCtx, type ToolDef, type ToolResult } from './common.ts'

const CATALOG = `Pfade relativ zu /api, {id} = Projekt-ID. Body als JSON-Text.
PROJEKTE
GET /projects – alle Projekte (Kennzahlen) · GET /projects/{id} – Projekt komplett (Plan, Vorgänge, Abschnitte, Mitglieder – groß!) · GET /portfolio · GET /site/today?date=YYYY-MM-DD&project={id}
PATCH /projects/{id} – Projekteinstellungen: number, name, customer, address, city, project_type (efh|dhh|mfh|gewerbe|wohnung_sanierung|haus_sanierung|bad_sanierung|individuell), construction_method (massiv|holzstaender|hybrid|individuell), start_date, target_end_date, area_sqm, floors, has_basement, project_manager_id, site_manager_id, state (planning|active|paused|completed), calendar_id, planning_kind (free|development|construction|process), holiday_region (z. B. DE-BY), shift_tasks (true = Vorgänge beim Startwechsel mitschieben)
POST /projects/{id}/duplicate {name?, number?, start_date?, task_ids?, reset_progress?} · DELETE /projects/{id}
GET /projects/{id}/history – Änderungen, Verzüge, Vor-Ort-Meldungen
ABSCHNITTE · POST /projects/{id}/sections {name} · PATCH /projects/{id}/sections/{sid} {name?, sort_order?} · DELETE …/sections/{sid}
BEHINDERUNGEN/VORAUSSETZUNGEN · POST /projects/{id}/constraints {task_id, type (predecessor|material|planning|approval|staff|equipment|authority|client|other), title, status (open|fulfilled|blocked), due_date?, responsible_user_id?, note?} · PATCH …/constraints/{cid} · DELETE …/constraints/{cid}
CHECKLISTE (einfache Büro-To-Dos am Vorgang, ohne Termin/Einfluss auf Terminberechnung) · POST /projects/{id}/checklist {task_id, text} · PATCH …/checklist/{iid} {text?, done?, sort_order?} · DELETE …/checklist/{iid}
RESSOURCEN AM VORGANG · PUT /projects/{id}/tasks/{taskId}/assignments {assignments:[{resource_id, units, start_date?, end_date?}]}
BASELINES · POST /projects/{id}/baselines {name?} · POST …/baselines/{bid}/activate · DELETE …/baselines/{bid}
SZENARIEN · GET /projects/{id}/scenarios · POST {name, description?} · PUT …/scenarios/{sid} {name?, description?} · DELETE · POST …/scenarios/{sid}/apply (übernimmt in den echten Plan)
ÄNDERUNGSVORSCHLÄGE · GET /projects/{id}/proposals · GET /proposals/open · GET …/proposals/{pid}/impact · POST …/proposals/{pid}/decide {decision: accept|reject, note?}
FREIGABELINKS für Firmen/Kategorien · GET /projects/{id}/share-links · POST {scope: trade|company, trade_id?, company_id?, label?, relevance (compact|standard|full), expires_in_days?} · POST …/share-links/{sid}/revoke · GET /projects/{id}/confirmations
REGELN (fachlich) · GET /rules?project_id= · POST /rules {kind (required_order|min_gap|no_overlap), name, config {trade_a, trade_b, min_days?}, severity (info|warning|critical), enabled, project_id?} · PATCH /rules/{id} · DELETE /rules/{id} · POST /projects/{id}/rule-check
ARBEITSPAKETE · GET /work-packages · GET /work-packages/{wid} · POST /projects/{id}/work-packages/{wid}/insert {expected_version, parent_id?, after_id?, start_date?, section_id?}
VORLAGEN · GET /templates · GET /templates/{tid} · POST /templates {name, description?, from_project_id?} · PUT /templates/{tid} {name?, description?} · DELETE /templates/{tid}
ORGANISATION
GET /org – Firma, Kategorien, Firmen, Kontakte, Ressourcen, Mitglieder, Kalender, Ausnahmen
PATCH /org {name?, holiday_region?} · POST /org/members {email, name, role} · PATCH /org/members/{userId} {role} · DELETE /org/members/{userId}
Rollen: owner, admin, management, project_manager, site_manager, employee, subcontractor, viewer
KATEGORIEN /trades · FIRMEN /companies {name, trade_id?, trade_ids?, contact_name?, phone?, email?, address?, notes?} · RESSOURCEN /resources {name, type (team|person|equipment), trade_id?, company_id?, capacity?} – je POST, PATCH /{x}/{id}, DELETE /{x}/{id}
KONTAKTE · POST /contacts {company_id, name, role?, email?, phone?, notes?, project_ids?} · PATCH /contacts/{id} · DELETE /contacts/{id}
KALENDER · POST /calendars {name, working_days [1=Mo…7=So], project_id?, trade_id?, company_id?, holiday_region?, is_default?} · PATCH /calendars/{id} · DELETE /calendars/{id} · POST /calendars/{id}/exceptions {date, type, name} · DELETE /calendars/{id}/exceptions/{exId}
GET /resources/conflicts · GET /analytics/durations
BENACHRICHTIGUNGEN · GET /notifications · POST /notifications/{id}/read · POST /notifications/read-all
POSTEINGANG (BauTakt) · GET /email/inbox?status= · GET /email/inbox/{id} · POST /email/inbox/{id}/reanalyze · POST /email/inbox/{id}/ignore · POST /email/inbox/{id}/propose {project_id?, task_id?, new_start?} · GET /email/sent · GET /mailbox
ANHÄNGE · GET /projects/{id}/attachments?q=&task_id=
AUFGABEN (eigenständig, projektübergreifend, losgelöst vom Terminplan – für „gib jemandem eine Aufgabe“, NICHT für Vorgänge im Terminplan) · GET /assignments?scope=mine|given · POST /assignments {project_id, task_id?, title, description?, assigned_to (Nutzer-ID), due_date? (JJJJ-MM-TT), reminder_date? (JJJJ-MM-TT)} · PATCH /assignments/{id} {title?, description?, due_date?, reminder_date?, assigned_to?} (nur Auftraggeber, solange offen) · POST /assignments/{id}/submit {result_note?} (nur Bearbeiter: Ergebnis zurückgeben) · POST /assignments/{id}/close (nur Auftraggeber: abschließen) · POST /assignments/{id}/reopen {note?} (nur Auftraggeber: zur Nacharbeit zurückgeben) · DELETE /assignments/{id}
INTEGRATIONEN · GET /integrations · GET /plan-import/status · GET /projects/{id}/process-links`

const BLOCKED: { test: RegExp; message: string; link?: (path: string) => { label: string; to: string } }[] = [
  { test: /^\/(jarvis|auth)(\/|$)/, message: 'Dieser Bereich ist für Jarvis gesperrt.' },
  { test: /\/reports\/[^/]+\.pdf/, message: 'PDF-Berichte öffnen sich über die Berichte-Seite.', link: (p) => ({ label: 'Berichte', to: `/projects/${projectIdOf(p)}/reports` }) },
  { test: /\/attachments\/upload-url|\/attachments$/, message: 'Dateien hochladen geht nur über die Oberfläche (Datei auswählen).' },
  { test: /^\/mailbox\/[^/]+\/(connect|disconnect)/, message: 'Das Postfach wird im Posteingang verbunden (Microsoft-Anmeldung im Browser).', link: () => ({ label: 'Posteingang', to: '/inbox' }) },
  { test: /^\/plan-import\/(document|jira)/, message: 'Dokument- und Jira-Import laufen über die Oberfläche.' },
]

/** Nicht rückgängig machbar oder mit Außenwirkung - nur nach Bestätigung durch den Nutzer. */
function needsConfirmation(method: string, path: string): boolean {
  if (method === 'GET') return false
  if (method === 'DELETE') return true
  return (
    /^\/org(\/|$)/.test(path) ||
    /\/share-links/.test(path) ||
    (method === 'PUT' && /^\/projects\/[^/]+\/plan$/.test(path)) ||
    /\/import\/apply$/.test(path) ||
    /\/scenarios\/[^/]+\/apply$/.test(path) ||
    /\/baselines\/[^/]+\/activate$/.test(path)
  )
}

/** Die geänderten Felder lesbar für die Bestätigungskarte („name: Test Bau GmbH“). */
function fieldLines(body: string | undefined): string[] {
  if (!body) return []
  const data = JSON.parse(body) as Record<string, unknown>
  return Object.entries(data)
    .slice(0, 5)
    .map(([k, v]) => `${k.replace(/_/g, ' ')}: ${typeof v === 'string' ? v : JSON.stringify(v)}`.slice(0, 120))
}

function projectIdOf(path: string): string | null {
  return /^\/projects\/([\w-]+)/.exec(path)?.[1] ?? null
}

type InternalEnv = AppEnv & { Bindings: { session: AppEnv['Variables']['session']; db: AppEnv['Variables']['db'] } }
let internalApp: Promise<Hono<InternalEnv>> | null = null

/** Dieselben geschützten Routen wie unter /api - erst beim ersten Aufruf geladen (keine Zirkel-Importe). */
function getInternalApp(): Promise<Hono<InternalEnv>> {
  internalApp ??= (async () => {
    const [org, projects, templates, v1, integrations, planImport, attachments, assignments] = await Promise.all([
      import('../../routes/org.ts'), import('../../routes/projects.ts'), import('../../routes/templates.ts'), import('../../routes/v1.ts'),
      import('../../routes/integrations.ts'), import('../../routes/planImport.ts'), import('../../routes/attachments.ts'), import('../../routes/assignments.ts'),
    ])
    const app = new Hono<InternalEnv>()
    app.onError((err, c) => (err instanceof HttpError ? c.json({ error: err.message }, err.status as 400) : c.json({ error: (err as Error).message }, 500)))
    app.use('*', async (c, next) => {
      c.set('session', c.env.session)
      c.set('db', c.env.db)
      await next()
    })
    for (const r of [org.orgRoutes, projects.projectRoutes, templates.templateRoutes, v1.v1Routes, integrations.integrationRoutes, planImport.planImportRoutes, attachments.attachmentRoutes, assignments.assignmentRoutes]) {
      app.route('/', r as unknown as Hono<InternalEnv>)
    }
    return app
  })()
  return internalApp
}

const LIMIT = 5500

function shrink(v: unknown, items: number, chars: number, depth = 0): unknown {
  if (typeof v === 'string') return v.length > chars ? `${v.slice(0, chars)}…` : v
  if (Array.isArray(v)) {
    const head = v.slice(0, items).map((x) => shrink(x, items, chars, depth + 1))
    return v.length > items ? [...head, `… ${v.length - items} weitere`] : head
  }
  if (v && typeof v === 'object') {
    if (depth > 4) return '…'
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shrink(x, items, chars, depth + 1)]))
  }
  return v
}

/** Große Antworten lesbar verkleinern (Listen und Texte kürzen) statt mitten im JSON abzuschneiden. */
function clip(data: unknown): unknown {
  if (JSON.stringify(data).length <= LIMIT) return data
  for (const [items, chars] of [[25, 200], [12, 120], [6, 80], [3, 60]] as const) {
    const small = shrink(data, items, chars)
    if (JSON.stringify(small).length <= LIMIT) return { gekuerzt: 'Listen/Texte gekürzt – für Details genauer abfragen', daten: small }
  }
  return { gekuerzt: 'Antwort sehr groß – genauer abfragen (Detailpfad, Filter) oder Fachwerkzeuge nutzen', auszug: JSON.stringify(data).slice(0, LIMIT - 200) }
}

export const appApi: ToolDef = {
  name: 'app_api',
  description: `Zugriff auf ALLE Funktionen von BauTakt, genau wie die Oberfläche und mit den Rechten des Nutzers: Projekteinstellungen, Organisation, Kategorien, Firmen, Kontakte, Ressourcen, Kalender, Regeln, Vorlagen, Baselines, Szenarien, Vorschläge, Freigabelinks, Posteingang, Benachrichtigungen u. v. m. Für Terminplan-Änderungen (verschieben, anlegen, zuweisen, Fortschritt, löschen) IMMER die Fachwerkzeuge nutzen – die sind rückgängig machbar, app_api-Änderungen nicht. IDs erst per GET nachschlagen, nie raten. Löschen, Organisation/Mitglieder, Freigabelinks und Plan-Überschreiben brauchen eine Bestätigung des Nutzers (kommt automatisch).\n${CATALOG}`,
  parameters: s.object({
    method: s.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'], 'HTTP-Methode'),
    path: s.str('Pfad ohne /api, mit Query, z. B. "/projects/prj_x" oder "/rules?project_id=prj_x"'),
    body: s.nstr('JSON-Text des Bodys (nur bei POST/PUT/PATCH), sonst null'),
    label: s.str('Kurz auf Deutsch, was passiert – z. B. „Feiertagsregion auf Bayern gesetzt“ oder „Lese Firmenliste“'),
  }),
  label: (a) => String(a.label ?? 'Programmfunktion …').slice(0, 80),
  async run(ctx, a) {
    const method = String(a.method ?? 'GET').toUpperCase()
    const path = str(a.path)
    const label = str(a.label) ?? `${method} ${path}`
    if (!path || !path.startsWith('/') || path.includes('..')) return { ok: false, status: 'invalid', message: 'Ungültiger Pfad.' }
    const bare = path.split('?')[0]!
    const blocked = BLOCKED.find((b) => b.test.test(bare))
    if (blocked) return { ok: false, status: 'forbidden', message: blocked.message, ...(blocked.link ? { link: blocked.link(bare) } : {}) }

    let body: string | undefined
    if (method !== 'GET' && method !== 'DELETE') {
      const raw = str(a.body) ?? '{}'
      try {
        body = JSON.stringify(JSON.parse(raw))
      } catch {
        return { ok: false, status: 'invalid', message: 'Der Body ist kein gültiges JSON.' }
      }
    }

    if (!ctx.confirmed && needsConfirmation(method, bare)) {
      return requestConfirmation(ctx, {
        project_id: projectIdOf(bare),
        tool: 'app_api',
        args: a,
        title: label,
        lines: [...fieldLines(body), method === 'DELETE' ? 'Wird endgültig gelöscht.' : 'Lässt sich nicht über „Rückgängig“ zurücknehmen.'],
        impact: null,
        fingerprint: null,
        summary: label,
      })
    }

    return execute(ctx, method, path, body, label)
  },
}

async function execute(ctx: ToolCtx, method: string, path: string, body: string | undefined, label: string): Promise<ToolResult> {
  const app = await getInternalApp()
  const res = await app.request(`http://bautakt.internal${path}`, { method, headers: body ? { 'content-type': 'application/json' } : {}, body }, { session: ctx.session, db: ctx.db })
  const type = res.headers.get('content-type') ?? ''
  const data: unknown = type.includes('json') ? await res.json().catch(() => null) : null
  if (!res.ok) {
    const message = (data as { error?: string } | null)?.error ?? `Fehler ${res.status}`
    const status = res.status === 403 ? 'forbidden' : res.status === 404 ? 'not_found' : res.status === 409 ? 'conflict' : 'invalid'
    return { ok: false, status, message }
  }
  if (method === 'GET') return { ok: true, summary: label, data: data === null ? { hinweis: `Keine JSON-Antwort (${type || 'leer'})` } : clip(data) }

  ctx.writes.count++
  const projectId = projectIdOf(path)
  if (projectId) {
    const project = await new Repo(ctx.db).project(ctx.session.org.id, projectId).catch(() => null)
    if (project) ctx.emit({ type: 'ui', action: 'reload_project', project_id: projectId, version: project.version })
    else ctx.emit({ type: 'ui', action: 'data_changed', scope: 'projects' })
  } else {
    ctx.emit({ type: 'ui', action: 'data_changed', scope: /notifications/.test(path) ? 'notifications' : 'projects' })
  }
  return { ok: true, summary: label, undoable: false, data: clip(data) }
}
