/**
 * Datenzugriff mit Mandanten-Trennung: jede Abfrage ist an eine org_id gebunden.
 * Projektbezogene Tabellen werden über `projects.org_id` gefiltert - ein Projekt einer
 * fremden Organisation ist für den Aufrufer schlicht nicht vorhanden (404, nie 403).
 */

import type { Db, Row } from './db.ts'
import type {
  AppNotification,
  Baseline,
  BaselineTask,
  CalendarException,
  ChangeHistoryEntry,
  ChangeProposal,
  Company,
  Contact,
  DelayEvent,
  OrganizationMember,
  ProgressUpdate,
  Project,
  ProjectBundle,
  ProjectCalendar,
  ProjectMember,
  ProjectSection,
  ProjectTemplate,
  Organization,
  Resource,
  ResourceAssignment,
  Scenario,
  Task,
  TaskConstraint,
  TaskDependency,
  TemplateTask,
  Trade,
  User,
} from '../shared/types.ts'
import type { PlanRule } from '../shared/rules/engine.ts'

const bool = (v: unknown) => v === 1 || v === true
const json = <T>(v: unknown, fallback: T): T => {
  if (typeof v !== 'string') return fallback
  try {
    return JSON.parse(v) as T
  } catch {
    return fallback
  }
}

export const mapProject = (r: Row): Project => ({ ...(r as unknown as Project), has_basement: bool(r.has_basement) })
export const mapTask = (r: Row): Task => ({
  ...(r as unknown as Task),
  responsible_user_ids: json<string[]>(r.responsible_user_ids, []),
  is_critical: bool(r.is_critical),
  has_conflict: bool(r.has_conflict),
})
export const mapCalendar = (r: Row): ProjectCalendar => ({
  ...(r as unknown as ProjectCalendar),
  working_days: json<number[]>(r.working_days, [1, 2, 3, 4, 5]),
  is_default: bool(r.is_default),
})
export const mapBaseline = (r: Row): Baseline => ({ ...(r as unknown as Baseline), is_active: bool(r.is_active) })
export const mapTemplate = (r: Row): ProjectTemplate => ({ ...(r as unknown as ProjectTemplate), is_builtin: bool(r.is_builtin) })
export const mapTemplateTask = (r: Row): TemplateTask => ({ ...(r as unknown as TemplateTask), dependencies: json(r.dependencies, []), constraints: json(r.constraints, []) })
export const mapNotification = (r: Row): AppNotification => ({ ...(r as unknown as AppNotification), channels: json(r.channels, ['in_app']) })
export const mapProgress = (r: Row): ProgressUpdate => ({ ...(r as unknown as ProgressUpdate), attachments: json(r.attachments, []) })
export const mapScenario = (r: Row): Scenario => ({ ...(r as unknown as Scenario), tasks: json(r.tasks, []), dependencies: json(r.dependencies, []), meta: json(r.meta, {}), origin: (r.origin as Scenario['origin']) ?? 'manual', proposal_id: (r.proposal_id as string | null) ?? null })
export const mapProposal = (r: Row): ChangeProposal => ({ ...(r as unknown as ChangeProposal), operations: json(r.operations, []), title: String(r.title ?? ''), origin_kind: (r.origin_kind as ChangeProposal['origin_kind']) ?? 'manual', origin_ref: (r.origin_ref as string | null) ?? null })
export const mapUser = (r: Row): User => ({ id: String(r.id), email: String(r.email), name: String(r.name), created_at: String(r.created_at) })

export class Repo {
  readonly db: Db
  constructor(db: Db) {
    this.db = db
  }

  // ---- Org-Stammdaten
  async trades(orgId: string): Promise<Trade[]> {
    return this.db.all<Trade>('SELECT * FROM trades WHERE org_id = ? ORDER BY sort_order, name', orgId)
  }
  async organization(orgId: string): Promise<Organization | undefined> {
    return this.db.get<Organization>('SELECT * FROM organizations WHERE id = ?', orgId)
  }
  async companies(orgId: string): Promise<Company[]> {
    const links = await this.db.all<{ company_id: string; trade_id: string }>('SELECT ct.company_id, ct.trade_id FROM company_trades ct JOIN companies c ON c.id = ct.company_id WHERE c.org_id = ?', orgId)
    const byCompany = new Map<string, string[]>()
    for (const l of links) (byCompany.get(l.company_id) ?? byCompany.set(l.company_id, []).get(l.company_id)!).push(l.trade_id)
    const rows = await this.db.all<Company>('SELECT * FROM companies WHERE org_id = ? ORDER BY name', orgId)
    return rows.map((c) => {
      const ids = byCompany.get(c.id) ?? []
      if (c.trade_id && !ids.includes(c.trade_id)) ids.unshift(c.trade_id)
      return { ...c, trade_ids: ids }
    })
  }
  async contacts(orgId: string): Promise<Contact[]> {
    const links = await this.db.all<{ contact_id: string; project_id: string }>('SELECT cp.contact_id, cp.project_id FROM contact_projects cp JOIN contacts c ON c.id = cp.contact_id WHERE c.org_id = ?', orgId)
    const byContact = new Map<string, string[]>()
    for (const l of links) (byContact.get(l.contact_id) ?? byContact.set(l.contact_id, []).get(l.contact_id)!).push(l.project_id)
    const rows = await this.db.all<Contact>('SELECT * FROM contacts WHERE org_id = ? ORDER BY name', orgId)
    return rows.map((c) => ({ ...c, project_ids: byContact.get(c.id) ?? [] }))
  }
  async rules(orgId: string): Promise<PlanRule[]> {
    const rows = await this.db.all<Row>('SELECT * FROM plan_rules WHERE org_id = ? ORDER BY created_at', orgId)
    return rows.map((r) => ({ ...(r as unknown as PlanRule), config: json(r.config, { trade_a: '', trade_b: null }), enabled: bool(r.enabled) }))
  }
  async proposals(projectId: string): Promise<ChangeProposal[]> {
    const rows = await this.db.all<Row>('SELECT * FROM change_proposals WHERE project_id = ? ORDER BY created_at DESC', projectId)
    return rows.map(mapProposal)
  }
  async proposal(projectId: string, id: string): Promise<ChangeProposal | undefined> {
    const r = await this.db.get<Row>('SELECT * FROM change_proposals WHERE id = ? AND project_id = ?', id, projectId)
    return r ? mapProposal(r) : undefined
  }
  async resources(orgId: string): Promise<Resource[]> {
    return this.db.all<Resource>('SELECT * FROM resources WHERE org_id = ? ORDER BY name', orgId)
  }
  async members(orgId: string): Promise<OrganizationMember[]> {
    const rows = await this.db.all<Row>(
      'SELECT m.org_id, m.user_id, m.role, u.email, u.name, u.created_at FROM organization_members m JOIN users u ON u.id = m.user_id WHERE m.org_id = ? ORDER BY u.name',
      orgId,
    )
    return rows.map((r) => ({ org_id: String(r.org_id), user_id: String(r.user_id), role: r.role as OrganizationMember['role'], user: { id: String(r.user_id), email: String(r.email), name: String(r.name), created_at: String(r.created_at) } }))
  }
  async calendars(orgId: string): Promise<ProjectCalendar[]> {
    const rows = await this.db.all<Row>('SELECT * FROM project_calendars WHERE org_id = ? ORDER BY is_default DESC, name', orgId)
    return rows.map(mapCalendar)
  }
  async exceptions(orgId: string): Promise<CalendarException[]> {
    return this.db.all<CalendarException>(
      'SELECT e.* FROM calendar_exceptions e JOIN project_calendars c ON c.id = e.calendar_id WHERE c.org_id = ? ORDER BY e.date',
      orgId,
    )
  }
  async userName(userId: string | null): Promise<string> {
    if (!userId) return ''
    const r = await this.db.get<{ name: string }>('SELECT name FROM users WHERE id = ?', userId)
    return r?.name ?? ''
  }

  // ---- Projekte
  async projects(orgId: string): Promise<Project[]> {
    const rows = await this.db.all<Row>('SELECT * FROM projects WHERE org_id = ? ORDER BY start_date DESC', orgId)
    return rows.map(mapProject)
  }
  async project(orgId: string, id: string): Promise<Project | undefined> {
    const r = await this.db.get<Row>('SELECT * FROM projects WHERE org_id = ? AND id = ?', orgId, id)
    return r ? mapProject(r) : undefined
  }
  async tasks(projectId: string): Promise<Task[]> {
    const rows = await this.db.all<Row>('SELECT * FROM tasks WHERE project_id = ? ORDER BY sort_order', projectId)
    return rows.map(mapTask)
  }
  async dependencies(projectId: string): Promise<TaskDependency[]> {
    const rows = await this.db.all<Row>('SELECT * FROM task_dependencies WHERE project_id = ?', projectId)
    return rows.map((r) => ({ ...(r as unknown as TaskDependency), is_driving: bool(r.is_driving) }))
  }
  async sections(projectId: string): Promise<ProjectSection[]> {
    return this.db.all<ProjectSection>('SELECT * FROM project_sections WHERE project_id = ? ORDER BY sort_order, name', projectId)
  }
  async constraints(projectId: string): Promise<TaskConstraint[]> {
    return this.db.all<TaskConstraint>('SELECT * FROM task_constraints WHERE project_id = ? ORDER BY created_at', projectId)
  }
  async baselines(projectId: string): Promise<Baseline[]> {
    const rows = await this.db.all<Row>('SELECT * FROM baselines WHERE project_id = ? ORDER BY created_at DESC', projectId)
    return rows.map(mapBaseline)
  }
  async baselineTasks(projectId: string): Promise<BaselineTask[]> {
    return this.db.all<BaselineTask>('SELECT bt.* FROM baseline_tasks bt JOIN baselines b ON b.id = bt.baseline_id WHERE b.project_id = ?', projectId)
  }
  async assignments(projectId: string): Promise<ResourceAssignment[]> {
    return this.db.all<ResourceAssignment>('SELECT a.* FROM resource_assignments a JOIN tasks t ON t.id = a.task_id WHERE t.project_id = ?', projectId)
  }
  async projectMembers(projectId: string): Promise<ProjectMember[]> {
    return this.db.all<ProjectMember>('SELECT * FROM project_members WHERE project_id = ?', projectId)
  }

  async bundle(orgId: string, projectId: string): Promise<ProjectBundle | undefined> {
    const project = await this.project(orgId, projectId)
    if (!project) return undefined
    const [tasks, dependencies, calendars, exceptions, baselines, baseline_tasks, assignments, members, sections, constraints, resources] = await Promise.all([
      this.tasks(projectId),
      this.dependencies(projectId),
      this.calendars(orgId),
      this.exceptions(orgId),
      this.baselines(projectId),
      this.baselineTasks(projectId),
      this.assignments(projectId),
      this.projectMembers(projectId),
      this.sections(projectId),
      this.constraints(projectId),
      this.resources(orgId),
    ])
    return {
      project,
      tasks,
      dependencies,
      calendars,
      exceptions,
      baselines,
      baseline_tasks,
      assignments,
      members,
      sections,
      constraints,
      resources,
    }
  }

  async history(projectId: string, limit = 500): Promise<ChangeHistoryEntry[]> {
    return this.db.all<ChangeHistoryEntry>('SELECT * FROM change_history WHERE project_id = ? ORDER BY created_at DESC LIMIT ?', projectId, limit)
  }
  async delays(projectId: string): Promise<DelayEvent[]> {
    return this.db.all<DelayEvent>('SELECT * FROM delay_events WHERE project_id = ? ORDER BY created_at DESC', projectId)
  }
  async progressUpdates(projectId: string): Promise<ProgressUpdate[]> {
    const rows = await this.db.all<Row>('SELECT * FROM progress_updates WHERE project_id = ? ORDER BY created_at DESC', projectId)
    return rows.map(mapProgress)
  }
  async scenarios(projectId: string): Promise<Scenario[]> {
    const rows = await this.db.all<Row>('SELECT * FROM scenarios WHERE project_id = ? ORDER BY created_at DESC', projectId)
    return rows.map(mapScenario)
  }

  // ---- Vorlagen
  async templates(orgId: string): Promise<ProjectTemplate[]> {
    const rows = await this.db.all<Row>('SELECT * FROM project_templates WHERE org_id = ? OR org_id IS NULL ORDER BY is_builtin DESC, name', orgId)
    return rows.map(mapTemplate)
  }
  async template(orgId: string, id: string): Promise<ProjectTemplate | undefined> {
    const r = await this.db.get<Row>('SELECT * FROM project_templates WHERE id = ? AND (org_id = ? OR org_id IS NULL)', id, orgId)
    return r ? mapTemplate(r) : undefined
  }
  async templateTasks(templateId: string): Promise<TemplateTask[]> {
    const rows = await this.db.all<Row>('SELECT * FROM template_tasks WHERE template_id = ? ORDER BY sort_order', templateId)
    return rows.map(mapTemplateTask)
  }

  // ---- Benachrichtigungen
  async notifications(orgId: string, userId: string, limit = 100): Promise<AppNotification[]> {
    const rows = await this.db.all<Row>('SELECT * FROM notifications WHERE org_id = ? AND (user_id IS NULL OR user_id = ?) ORDER BY created_at DESC LIMIT ?', orgId, userId, limit)
    return rows.map(mapNotification)
  }
}
