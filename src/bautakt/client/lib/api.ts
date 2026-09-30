/**
 * Typisierter API-Client. Token liegt im localStorage und wird als Bearer gesendet.
 * Jede Antwort ≠ 2xx wird zu einem `ApiError` mit der Server-Meldung.
 */

import type {
  AppNotification,
  Baseline,
  CalendarException,
  ChangeHistoryEntry,
  Company,
  CreateProjectRequest,
  CriticalEvent,
  DelayEvent,
  OrgData,
  OrganizationMember,
  ProgressUpdate,
  Project,
  ProjectBundle,
  ProjectCalendar,
  ProjectSummary,
  ProjectTemplate,
  Resource,
  SavePlanRequest,
  SavePlanResponse,
  Scenario,
  Session,
  SiteUpdateRequest,
  Task,
  TaskDependency,
  TemplateTask,
  Trade,
  HealthStatus,
  ResourceAssignment,
  ProjectGroup,
  ProjectSection,
  TaskChecklistItem,
  TaskConstraint,
  ChangeProposal,
  ShareLink,
  ShareRelevance,
  WorkPackageTemplate,
  WorkPackageTask,
  TradeConfirmation,
  Contact,
  ProposalOperation,
  AiSolutionRequest,
  Attachment,
  Assignment,
  AssignmentView,
} from '../../shared/types'
import type { PlanRule, RuleViolation } from '../../shared/rules/engine'
import type { BuildFlowProcess } from '../../shared/integrations/buildflow/types'
import type { ExtractedPlan } from '../../shared/integrations/planextract/types'
import type { EmailAnalysis, EmailProviderKind } from '../../shared/integrations/email/types'
export type MailboxProvider = 'microsoft365' | 'gmail'
import type { ImpactAnalysis } from '../../shared/engine/operations'
import type { ImportMapping, NormalizedItem } from '../../shared/import/pipeline'
import type { Readiness } from '../../shared/engine/readiness'
import type { ResourceConflict } from '../../shared/engine/analysis'

const TOKEN_KEY = 'bautakt.token'
/** Leer = gleiche Origin (Dev-Proxy / Produktion aus einem Prozess); sonst z. B. https://bautakt-api.up.railway.app */
export const API_BASE = ((import.meta.env.VITE_API_URL as string | undefined) ?? '').replace(/\/$/, '')

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY)
  } catch {
    return null
  }
}
export function setToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token)
    else localStorage.removeItem(TOKEN_KEY)
  } catch {
    /* privater Modus o. ä. */
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {}
  const token = getToken()
  if (token) headers.authorization = `Bearer ${token}`
  if (body !== undefined) headers['content-type'] = 'application/json'
  let res: Response
  try {
    res = await fetch(`${API_BASE}/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
  } catch {
    throw new ApiError(0, 'Server nicht erreichbar. Läuft der API-Prozess?')
  }
  if (res.status === 204) return undefined as T
  const text = await res.text()
  let data: unknown = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = null
  }
  if (!res.ok) {
    const msg = (data as { error?: string } | null)?.error ?? `Fehler ${res.status}`
    throw new ApiError(res.status, msg)
  }
  return data as T
}

/**
 * POST mit Server-Sent-Events als Antwort lesen (KI-Planerstellung mit Fortschritt). Liefert
 * die zwischenzeitlichen Ereignisse an `onEvent`, das Ergebnis ist der letzte `{type:'done'}`-Wert.
 */
async function requestStream<TDone>(path: string, body: unknown, onEvent: (ev: { type: string; [k: string]: unknown }) => void): Promise<TDone> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  const token = getToken()
  if (token) headers.authorization = `Bearer ${token}`
  let res: Response
  try {
    res = await fetch(`${API_BASE}/api${path}`, { method: 'POST', headers, body: JSON.stringify(body) })
  } catch {
    throw new ApiError(0, 'Server nicht erreichbar. Läuft der API-Prozess?')
  }
  if (!res.ok || !res.body) {
    const data = (await res.json().catch(() => null)) as { error?: string } | null
    throw new ApiError(res.status, data?.error ?? `Fehler ${res.status}`)
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  let result: TDone | undefined
  let errorMsg: string | null = null
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf = (buf + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n')
    let idx: number
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, idx)
      buf = buf.slice(idx + 2)
      const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n')
      if (!data) continue
      let evt: { type: string; [k: string]: unknown }
      try {
        evt = JSON.parse(data)
      } catch {
        continue
      }
      if (evt.type === 'error') errorMsg = String(evt.message ?? 'Fehlgeschlagen.')
      else if (evt.type === 'done') result = evt as TDone
      else onEvent(evt)
    }
  }
  if (errorMsg) throw new ApiError(502, errorMsg)
  if (result === undefined) throw new ApiError(502, 'Die Verbindung wurde unterbrochen.')
  return result
}

export interface PortfolioEntry {
  project: Project
  health: HealthStatus
  progress: number
  forecast_end: string
  planned_end: string
  baseline_end: string | null
  variance_days: number
  phases: { id: string; name: string; start: string; end: string; is_critical: boolean; progress: number }[]
  milestones: { id: string; name: string; date: string; done: boolean }[]
  tasks: Task[]
  dependencies: TaskDependency[]
  assignments: ResourceAssignment[]
  constraints: TaskConstraint[]
  sections: ProjectSection[]
}

export interface SiteTodayEntry {
  project: Project
  tasks: (Task & { planned_progress: number; is_critical: boolean; readiness: Readiness })[]
}

export interface SharePayloadTask {
  id: string
  name: string
  start: string
  end: string
  status: Task['status']
  progress: number
  is_critical: boolean
  trade: string | null
  distance: number
  relation: string
  type: Task['type']
  readiness: Readiness | null
}
export interface SharePayload {
  project: { name: string; city: string; number: string }
  scope: string
  relevance: ShareRelevance
  contact: { site_manager: string; project_manager: string }
  own: SharePayloadTask[]
  before: SharePayloadTask[]
  after: SharePayloadTask[]
  milestones: SharePayloadTask[]
  next_start: string | null
  confirmations: TradeConfirmation[]
  generated_at: string
}

export type ReportKind = 'schedule' | 'status' | 'milestones' | 'variance' | 'lookahead' | 'trade'

export interface ProposalImpact {
  proposal: ChangeProposal
  impact: ImpactAnalysis
  milestones: ImpactAnalysis['affected']
  current_end: string
  operations: { op: ProposalOperation; kind: 'added' | 'changed' | 'removed'; text: string }[]
  warnings: string[]
  new_constraints: { task_id: string; type: string; title: string; due_date: string | null }[]
  new_rule_violations: RuleViolation[]
}

export interface ProcessLinkInfo {
  id: string
  process_id: string
  process_name: string
  process_version: string
  phase_task_id: string | null
  created_at: string
  last_synced_at: string | null
  node_count: number
  mapped_tasks: number
  open_proposal_id: string | null
}

export interface InboundEmail {
  id: string
  org_id: string
  provider: EmailProviderKind
  external_id: string | null
  from_email: string
  from_name: string
  to_email: string
  subject: string
  body_text: string
  received_at: string
  status: 'new' | 'analyzed' | 'proposed' | 'ignored'
  analysis: EmailAnalysis | null
  project_id: string | null
  proposal_id: string | null
  created_at: string
}

export interface MailboxAccount {
  id: string
  org_id: string
  user_id: string
  provider: MailboxProvider
  email: string
  status: 'connected' | 'not_connected' | 'setup_pending'
  last_sync_at: string | null
  last_error: string | null
  created_at: string
}

export interface MailboxStatusInfo {
  accounts: MailboxAccount[]
  setup: { provider: MailboxProvider; label: string; ready: boolean }[]
}

export interface SentEmail {
  id: string
  provider: MailboxProvider
  from_email: string
  to_email: string
  cc_email: string
  subject: string
  body_text: string
  project_id: string | null
  reply_to_id: string | null
  status: string
  error: string | null
  sent_at: string | null
  created_at: string
}

export const api = {
  auth: {
    login: (email: string, password: string) => request<Session>('POST', '/auth/login', { email, password }),
    oauth: (accessToken: string) => request<Session>('POST', '/auth/oauth', { accessToken }),
    register: (input: { email: string; name: string; password: string; orgName: string }) => request<Session>('POST', '/auth/register', input),
    me: () => request<Session>('GET', '/auth/me'),
    logout: () => request<{ ok: true }>('POST', '/auth/logout'),
    demo: () => request<{ password: string; accounts: { email: string; name: string; role: string }[] }>('GET', '/auth/demo'),
  },
  org: {
    get: () => request<OrgData>('GET', '/org'),
    update: (patch: { name?: string; holiday_region?: string }) => request<{ ok: true }>('PATCH', '/org', patch),
    addMember: (input: { email: string; name: string; role: string; password?: string }) => request<OrganizationMember[]>('POST', '/org/members', input),
    updateMember: (userId: string, role: string) => request<OrganizationMember[]>('PATCH', `/org/members/${userId}`, { role }),
    updateMemberAreas: (userId: string, responsibility_areas: string[]) => request<OrganizationMember[]>('PATCH', `/org/members/${userId}`, { responsibility_areas }),
    removeMember: (userId: string) => request<OrganizationMember[]>('DELETE', `/org/members/${userId}`),
  },
  trades: {
    create: (input: Partial<Trade>) => request<Trade>('POST', '/trades', input),
    update: (id: string, input: Partial<Trade>) => request<Trade>('PATCH', `/trades/${id}`, input),
    remove: (id: string) => request<{ ok: true }>('DELETE', `/trades/${id}`),
  },
  companies: {
    create: (input: Partial<Company>) => request<Company>('POST', '/companies', input),
    update: (id: string, input: Partial<Company>) => request<Company>('PATCH', `/companies/${id}`, input),
    remove: (id: string) => request<{ ok: true }>('DELETE', `/companies/${id}`),
  },
  contacts: {
    create: (input: Partial<Contact>) => request<Contact>('POST', '/contacts', input),
    update: (id: string, input: Partial<Contact>) => request<Contact>('PATCH', `/contacts/${id}`, input),
    remove: (id: string) => request<{ ok: true }>('DELETE', `/contacts/${id}`),
  },
  resources: {
    create: (input: Partial<Resource>) => request<Resource>('POST', '/resources', input),
    update: (id: string, input: Partial<Resource>) => request<Resource>('PATCH', `/resources/${id}`, input),
    remove: (id: string) => request<{ ok: true }>('DELETE', `/resources/${id}`),
    conflicts: () => request<ResourceConflict[]>('GET', '/resources/conflicts'),
  },
  calendars: {
    create: (input: Partial<ProjectCalendar>) => request<ProjectCalendar[]>('POST', '/calendars', input),
    update: (id: string, input: Partial<ProjectCalendar>) => request<ProjectCalendar[]>('PATCH', `/calendars/${id}`, input),
    remove: (id: string) => request<ProjectCalendar[]>('DELETE', `/calendars/${id}`),
    addExceptions: (id: string, items: { date: string; type: string; name: string }[]) => request<CalendarException[]>('POST', `/calendars/${id}/exceptions`, { items }),
    removeException: (id: string, exId: string) => request<CalendarException[]>('DELETE', `/calendars/${id}/exceptions/${exId}`),
  },
  projects: {
    list: () => request<{ summaries: ProjectSummary[]; events: CriticalEvent[] }>('GET', '/projects'),
    create: (input: CreateProjectRequest) => request<Project>('POST', '/projects', input),
    get: (id: string) => request<ProjectBundle>('GET', `/projects/${id}`),
    update: (id: string, patch: Partial<Project> & { shift_tasks?: boolean }) => request<Project>('PATCH', `/projects/${id}`, patch),
    duplicate: (id: string, input: { name?: string; number?: string; start_date?: string; task_ids?: string[]; reset_progress?: boolean }) => request<Project>('POST', `/projects/${id}/duplicate`, input),
    remove: (id: string) => request<{ ok: true }>('DELETE', `/projects/${id}`),
    savePlan: (id: string, req: SavePlanRequest) => request<SavePlanResponse>('PUT', `/projects/${id}/plan`, req),
    history: (id: string) => request<{ history: ChangeHistoryEntry[]; delays: DelayEvent[]; updates: ProgressUpdate[] }>('GET', `/projects/${id}/history`),
    siteUpdate: (id: string, taskId: string, req: SiteUpdateRequest) => request<{ tasks: Task[]; version: number; progress_update_id: string }>('POST', `/projects/${id}/tasks/${taskId}/site-update`, req),
    saveBaseline: (id: string, name: string) => request<Baseline>('POST', `/projects/${id}/baselines`, { name }),
    activateBaseline: (id: string, bid: string) => request<{ ok: true }>('POST', `/projects/${id}/baselines/${bid}/activate`),
    removeBaseline: (id: string, bid: string) => request<{ ok: true }>('DELETE', `/projects/${id}/baselines/${bid}`),
    scenarios: (id: string) => request<Scenario[]>('GET', `/projects/${id}/scenarios`),
    createScenario: (id: string, input: { name: string; description?: string; origin?: Scenario['origin']; proposal_id?: string | null; tasks?: Task[]; dependencies?: TaskDependency[]; meta?: Scenario['meta'] }) => request<Scenario>('POST', `/projects/${id}/scenarios`, input),
    findSolution: (id: string, input: Partial<AiSolutionRequest>) => request<never>('POST', `/projects/${id}/scenarios/find-solution`, input),
    updateScenario: (id: string, sid: string, input: { name?: string; description?: string; tasks?: Task[]; dependencies?: TaskDependency[] }) => request<Scenario>('PUT', `/projects/${id}/scenarios/${sid}`, input),
    removeScenario: (id: string, sid: string) => request<{ ok: true }>('DELETE', `/projects/${id}/scenarios/${sid}`),
    applyScenario: (id: string, sid: string) => request<SavePlanResponse>('POST', `/projects/${id}/scenarios/${sid}/apply`),
  },
  projectGroups: {
    list: () => request<ProjectGroup[]>('GET', '/project-groups'),
    create: (name: string) => request<ProjectGroup[]>('POST', '/project-groups', { name }),
    update: (id: string, name: string) => request<ProjectGroup[]>('PATCH', `/project-groups/${id}`, { name }),
    remove: (id: string) => request<ProjectGroup[]>('DELETE', `/project-groups/${id}`),
  },
  site: {
    today: (date?: string, project?: string) => request<SiteTodayEntry[]>('GET', `/site/today?${new URLSearchParams({ ...(date ? { date } : {}), ...(project ? { project } : {}) })}`),
  },
  attachments: {
    uploadUrl: (projectId: string, input: { filename: string; mime: string; size: number; task_id?: string | null; progress_update_id?: string | null; assignment_id?: string | null; is_result?: boolean }) =>
      request<{ attachment_id: string; storage_key: string; upload_url: string; token: string }>('POST', `/projects/${projectId}/attachments/upload-url`, input),
    confirm: (projectId: string, input: { id: string; filename: string; mime: string; size: number; storage_key: string; task_id?: string | null; progress_update_id?: string | null; assignment_id?: string | null; is_result?: boolean }) =>
      request<Attachment>('POST', `/projects/${projectId}/attachments`, input),
    list: (projectId: string, filter: { task_id?: string; progress_update_id?: string; assignment_id?: string } = {}) =>
      request<Attachment[]>('GET', `/projects/${projectId}/attachments?${new URLSearchParams(filter as Record<string, string>)}`),
  },
  portfolio: () => request<PortfolioEntry[]>('GET', '/portfolio'),
  templates: {
    list: () => request<(ProjectTemplate & { task_count: number })[]>('GET', '/templates'),
    get: (id: string) => request<{ template: ProjectTemplate; tasks: TemplateTask[] }>('GET', `/templates/${id}`),
    create: (input: { name: string; description?: string; planning_kind?: ProjectTemplate['planning_kind']; project_type?: string | null; construction_method?: string | null; from_project_id?: string; copy_of?: string; tasks?: TemplateTask[] }) =>
      request<{ template: ProjectTemplate; tasks: TemplateTask[] }>('POST', '/templates', input),
    update: (id: string, input: { name?: string; description?: string; project_type?: string | null; construction_method?: string | null; tasks?: TemplateTask[] }) =>
      request<{ template: ProjectTemplate; tasks: TemplateTask[] }>('PUT', `/templates/${id}`, input),
    remove: (id: string) => request<{ ok: true }>('DELETE', `/templates/${id}`),
  },
  sections: {
    create: (projectId: string, name: string) => request<ProjectSection[]>('POST', `/projects/${projectId}/sections`, { name }),
    update: (projectId: string, id: string, patch: Partial<ProjectSection>) => request<ProjectSection[]>('PATCH', `/projects/${projectId}/sections/${id}`, patch),
    remove: (projectId: string, id: string) => request<ProjectSection[]>('DELETE', `/projects/${projectId}/sections/${id}`),
  },
  constraints: {
    create: (projectId: string, input: Partial<TaskConstraint>) => request<TaskConstraint[]>('POST', `/projects/${projectId}/constraints`, input),
    update: (projectId: string, id: string, patch: Partial<TaskConstraint>) => request<TaskConstraint[]>('PATCH', `/projects/${projectId}/constraints/${id}`, patch),
    remove: (projectId: string, id: string) => request<TaskConstraint[]>('DELETE', `/projects/${projectId}/constraints/${id}`),
  },
  checklist: {
    create: (projectId: string, input: Partial<TaskChecklistItem>) => request<TaskChecklistItem[]>('POST', `/projects/${projectId}/checklist`, input),
    update: (projectId: string, id: string, patch: Partial<TaskChecklistItem>) => request<TaskChecklistItem[]>('PATCH', `/projects/${projectId}/checklist/${id}`, patch),
    remove: (projectId: string, id: string) => request<TaskChecklistItem[]>('DELETE', `/projects/${projectId}/checklist/${id}`),
  },
  assignments: {
    set: (projectId: string, taskId: string, assignments: Partial<ResourceAssignment>[]) => request<ResourceAssignment[]>('PUT', `/projects/${projectId}/tasks/${taskId}/assignments`, { assignments }),
  },
  proposals: {
    open: () => request<(ChangeProposal & { project_name: string; task_name: string })[]>('GET', '/proposals/open'),
    list: (projectId: string) => request<ChangeProposal[]>('GET', `/projects/${projectId}/proposals`),
    create: (projectId: string, input: { task_id?: string | null; proposed_start?: string | null; proposed_end?: string | null; operations?: ProposalOperation[]; title?: string; reason?: string; comment?: string }) => request<ChangeProposal>('POST', `/projects/${projectId}/proposals`, input),
    impact: (projectId: string, id: string) => request<ProposalImpact>('GET', `/projects/${projectId}/proposals/${id}/impact`),
    decide: (projectId: string, id: string, decision: 'accept' | 'reject', note?: string) => request<ChangeProposal>('POST', `/projects/${projectId}/proposals/${id}/decide`, { decision, note }),
    toScenario: (projectId: string, id: string) => request<Scenario>('POST', `/projects/${projectId}/proposals/${id}/scenario`),
  },
  planImport: {
    status: () => request<{ lucidchart: { configured: boolean; note: string }; document_ai: { configured: boolean; note: string }; jira: { configured: boolean; note: string } }>('GET', '/plan-import/status'),
    lucidchart: (document: string) => request<ExtractedPlan>('POST', '/plan-import/lucidchart', { document }),
    document: (input: { text: string; file_name?: string; hint?: string }, onProgress?: (tasks: number) => void) =>
      requestStream<{ plan: ExtractedPlan }>('/plan-import/document', input, (ev) => { if (ev.type === 'progress') onProgress?.(Number(ev.tasks) || 0) }).then((r) => r.plan),
    jira: (input: { base_url?: string; email?: string; api_token?: string; project_key?: string; jql?: string }) => request<ExtractedPlan>('POST', '/plan-import/jira', input),
    generate: (input: { brief: string; kind?: string; people?: string[] }, onProgress?: (tasks: number) => void) =>
      requestStream<{ plan: ExtractedPlan }>('/plan-import/generate', input, (ev) => { if (ev.type === 'progress') onProgress?.(Number(ev.tasks) || 0) }).then((r) => r.plan),
    refine: (input: { plan: ExtractedPlan; instruction: string; people?: string[] }) => request<ExtractedPlan>('POST', '/plan-import/refine', input),
    sort: (plan: ExtractedPlan) => request<ExtractedPlan>('POST', '/plan-import/sort', { plan }),
    attach: (projectId: string, plan: ExtractedPlan, position?: { parent_id?: string | null; after_id?: string | null }) => request<{ tasks_created: number; unmatched: string[] }>('POST', `/projects/${projectId}/plan-import`, { plan, ...position }),
    preview: (projectId: string, plan: ExtractedPlan) => request<{ tasks: Task[]; dependencies: TaskDependency[]; unmatched: string[] }>('POST', `/projects/${projectId}/plan-import/preview`, { plan }),
  },

  integrations: {
    status: () => request<{ providers: { kind: 'email' | 'buildflow'; provider: string; name: string; status: 'not_connected' | 'available' | 'connected'; note: string }[]; analyzer: { active: string; ai_available: boolean; note: string } }>('GET', '/integrations'),
  },
  buildflow: {
    sample: () => request<{ current: BuildFlowProcess; changed: BuildFlowProcess }>('GET', '/buildflow/sample'),
    links: (projectId: string) => request<ProcessLinkInfo[]>('GET', `/projects/${projectId}/process-links`),
    attach: (projectId: string, process: unknown) => request<{ processes: string[]; tasks_created: number }>('POST', `/projects/${projectId}/process-links`, { process }),
    diff: (projectId: string, linkId: string, process: unknown) => request<{ process: { id: string; name: string; version: string }; same_process: boolean; counts: { added: number; changed: number; removed: number; edges_added: number; edges_removed: number }; summary: string[]; operations: ProposalOperation[] }>('POST', `/projects/${projectId}/process-links/${linkId}/diff`, { process }),
    sync: (projectId: string, linkId: string, process: unknown) => request<{ changed: boolean; message?: string; proposal?: ChangeProposal; counts?: { added: number; changed: number; removed: number; edges: number } }>('POST', `/projects/${projectId}/process-links/${linkId}/sync`, { process }),
    unlink: (projectId: string, linkId: string) => request<{ ok: true }>('DELETE', `/projects/${projectId}/process-links/${linkId}`),
  },
  email: {
    inbox: (status?: string) => request<InboundEmail[]>('GET', `/email/inbox${status ? `?status=${status}` : ''}`),
    get: (id: string) => request<InboundEmail>('GET', `/email/inbox/${id}`),
    ingest: (input: { provider?: EmailProviderKind; from_email: string; from_name?: string; to_email?: string; subject?: string; body_text: string; received_at?: string }) => request<InboundEmail>('POST', '/email/inbound', input),
    reanalyze: (id: string) => request<InboundEmail>('POST', `/email/inbox/${id}/reanalyze`),
    ignore: (id: string) => request<InboundEmail>('POST', `/email/inbox/${id}/ignore`),
    propose: (id: string, input: { project_id?: string; task_id?: string | null; new_start?: string | null }) => request<{ email: InboundEmail; proposal: ChangeProposal }>('POST', `/email/inbox/${id}/propose`, input),
    sent: () => request<SentEmail[]>('GET', '/email/sent'),
    send: (input: { provider?: MailboxProvider; to_email: string; cc_email?: string; subject?: string; body_text: string; project_id?: string | null; reply_to_id?: string | null }) => request<SentEmail>('POST', '/email/send', input),
  },
  mailbox: {
    status: () => request<MailboxStatusInfo>('GET', '/mailbox'),
    connect: (provider: MailboxProvider) => request<{ authorize_url: string }>('POST', `/mailbox/${provider}/connect`),
    disconnect: (provider: MailboxProvider) => request<{ ok: true }>('POST', `/mailbox/${provider}/disconnect`),
    sync: (provider: MailboxProvider) => request<{ imported: number; synced_at: string }>('POST', `/mailbox/${provider}/sync`),
  },
  rules: {
    list: (projectId?: string) => request<{ system: PlanRule[]; custom: PlanRule[]; effective: PlanRule[] }>('GET', `/rules${projectId ? `?project_id=${projectId}` : ''}`),
    create: (input: Partial<PlanRule> & { overrides_system_id?: string }) => request<PlanRule>('POST', '/rules', input),
    update: (id: string, patch: Partial<PlanRule>) => request<PlanRule>('PATCH', `/rules/${id}`, patch),
    remove: (id: string) => request<{ ok: true }>('DELETE', `/rules/${id}`),
    check: (projectId: string, plan?: { tasks: Task[]; dependencies: TaskDependency[] }) => request<{ violations: RuleViolation[]; rule_count: number }>('POST', `/projects/${projectId}/rule-check`, plan ?? {}),
  },
  share: {
    list: (projectId: string) => request<ShareLink[]>('GET', `/projects/${projectId}/share-links`),
    create: (projectId: string, input: { trade_id?: string | null; company_id?: string | null; label?: string; relevance?: ShareRelevance; expires_in_days?: number | null }) => request<ShareLink & { url: string }>('POST', `/projects/${projectId}/share-links`, input),
    revoke: (projectId: string, id: string) => request<{ ok: true }>('POST', `/projects/${projectId}/share-links/${id}/revoke`),
    confirmations: (projectId: string) => request<TradeConfirmation[]>('GET', `/projects/${projectId}/confirmations`),
    get: (token: string) => request<SharePayload>('GET', `/share/${token}`),
    confirm: (token: string, input: { task_id: string; status: 'confirmed' | 'not_possible'; proposed_start?: string | null; comment?: string; contact_name?: string }) => request<{ ok: true }>('POST', `/share/${token}/confirm`, input),
  },
  workPackages: {
    list: () => request<(WorkPackageTemplate & { task_count: number })[]>('GET', '/work-packages'),
    get: (id: string) => request<{ package: WorkPackageTemplate; tasks: WorkPackageTask[] }>('GET', `/work-packages/${id}`),
    create: (input: { name: string; description?: string; tasks?: WorkPackageTask[]; copy_of?: string }) => request<{ package: WorkPackageTemplate; tasks: WorkPackageTask[] }>('POST', '/work-packages', input),
    remove: (id: string) => request<{ ok: true }>('DELETE', `/work-packages/${id}`),
    insert: (projectId: string, id: string, input: { parent_id?: string | null; after_id?: string | null; start_date?: string | null; section_id?: string | null; predecessor_id?: string | null; root_name?: string; expected_version: number }) => request<SavePlanResponse & { inserted_ids: string[] }>('POST', `/projects/${projectId}/work-packages/${id}/insert`, input),
  },
  imports: {
    preview: (projectId: string, csv: string, mapping?: Partial<ImportMapping>) => request<{ headers: string[]; row_count: number; mapping: ImportMapping; items: NormalizedItem[]; validation: { errors: string[]; warnings: string[] } }>('POST', `/projects/${projectId}/import/preview`, { csv, mapping }),
    apply: (projectId: string, input: { csv: string; mapping?: Partial<ImportMapping>; mode: 'tasks' | 'estimate'; parent_id?: string | null; filename?: string; expected_version: number }) => request<{ import_id: string; items: number; tasks_created: number; version?: number }>('POST', `/projects/${projectId}/import/apply`, input),
  },
  analytics: {
    durations: () => request<{ records: Record<string, unknown>[]; by_trade: { trade_id: string | null; count: number; planned: number; actual: number; delayed: number; ratio: number | null }[] }>('GET', '/analytics/durations'),
  },
  reports: {
    url: (projectId: string, report: ReportKind, params: Record<string, string> = {}) => `${API_BASE}/api/projects/${projectId}/reports/${report}.pdf?${new URLSearchParams(params)}`,
    /** PDF vom Server holen (mit Bearer) und im neuen Tab öffnen */
    open: async (projectId: string, report: ReportKind, params: Record<string, string> = {}) => {
      const res = await fetch(api.reports.url(projectId, report, params), { headers: { authorization: `Bearer ${getToken() ?? ''}` } })
      if (!res.ok) throw new ApiError(res.status, (await res.json().catch(() => ({ error: 'PDF-Fehler' }))).error)
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      window.open(url, '_blank')
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
    },
  },
  notifications: {
    list: () => request<AppNotification[]>('GET', '/notifications'),
    read: (id: string) => request<{ ok: true }>('POST', `/notifications/${id}/read`),
    readAll: () => request<{ ok: true }>('POST', '/notifications/read-all'),
  },
  myTasks: {
    list: (scope: 'mine' | 'given') => request<AssignmentView[]>('GET', `/assignments?scope=${scope}`),
    create: (input: { project_id: string; task_id?: string | null; title: string; description?: string; assigned_to: string; due_date?: string | null; reminder_date?: string | null }) =>
      request<AssignmentView>('POST', '/assignments', input),
    update: (id: string, patch: Partial<Pick<Assignment, 'title' | 'description' | 'due_date' | 'reminder_date' | 'assigned_to'>>) =>
      request<AssignmentView>('PATCH', `/assignments/${id}`, patch),
    submit: (id: string, result_note?: string) => request<AssignmentView>('POST', `/assignments/${id}/submit`, { result_note }),
    close: (id: string) => request<AssignmentView>('POST', `/assignments/${id}/close`, {}),
    reopen: (id: string, note?: string) => request<AssignmentView>('POST', `/assignments/${id}/reopen`, { note }),
    remove: (id: string) => request<{ ok: true }>('DELETE', `/assignments/${id}`),
  },
}
