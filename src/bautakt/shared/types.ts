/**
 * Zentrales Domänenmodell - wird von Client UND Server importiert.
 * Alle Datumsangaben sind ISO-Strings `YYYY-MM-DD` (Kalendertag, keine Uhrzeit),
 * Zeitstempel sind ISO-8601 mit Uhrzeit. Dauern sind Arbeitstage (Integer).
 */

export type ISODate = string
export type ISODateTime = string

// ---------------------------------------------------------------- Mandant / Nutzer

export type OrgRole =
  | 'owner'
  | 'admin'
  | 'management'
  | 'project_manager'
  | 'site_manager'
  | 'employee'
  | 'subcontractor'
  | 'viewer'

export interface Organization {
  id: string
  name: string
  slug: string
  /** Standard-Feiertagsregion für neue Projekte, z. B. "DE-BY" (siehe engine/holidays.ts) */
  holiday_region: string
  created_at: ISODateTime
}

export interface User {
  id: string
  email: string
  name: string
  created_at: ISODateTime
}

export interface OrganizationMember {
  org_id: string
  user_id: string
  role: OrgRole
  user?: User
}

export interface Session {
  token: string
  user: User
  org: Organization
  role: OrgRole
}

// ---------------------------------------------------------------- Projekt

export type ProjectType =
  | 'efh'
  | 'dhh'
  | 'mfh'
  | 'gewerbe'
  | 'wohnung_sanierung'
  | 'haus_sanierung'
  | 'bad_sanierung'
  | 'individuell'

export type ConstructionMethod = 'massiv' | 'holzstaender' | 'hybrid' | 'individuell'

export type ProjectState = 'active' | 'paused' | 'completed' | 'planning'

/**
 * Art der Planung - die Scheduling Engine ist für alle identisch; baubezogene Felder
 * (Bauweise, Fläche, Geschosse, Bauabschnitte, Baustelle) sind nur bei 'construction'
 * relevant und werden sonst ausgeblendet.
 */
export type PlanningKind = 'free' | 'development' | 'construction' | 'process'

export interface Project {
  id: string
  org_id: string
  number: string
  name: string
  customer: string
  address: string
  city: string
  project_type: ProjectType
  construction_method: ConstructionMethod
  start_date: ISODate
  target_end_date: ISODate
  area_sqm: number | null
  floors: number | null
  has_basement: boolean
  project_manager_id: string | null
  site_manager_id: string | null
  state: ProjectState
  calendar_id: string | null
  planning_kind: PlanningKind
  /** Feiertagsregion (Land-Region, z. B. "DE-BY") - Grundlage der gesetzlichen Feiertage */
  holiday_region: string
  version: number
  created_at: ISODateTime
  updated_at: ISODateTime
}

export type ProjectRole = 'project_manager' | 'site_manager' | 'member' | 'subcontractor' | 'viewer'

export interface ProjectMember {
  project_id: string
  user_id: string
  role: ProjectRole
}

// ---------------------------------------------------------------- Kalender

/**
 * Kalender-Definition. Schichten: Org-Standard (is_default), Projekt (project_id),
 * Gewerk (trade_id), Firma (company_id), Ressource (resources.calendar_id), Vorgang
 * (tasks.calendar_id). Auflösung und Priorität: engine/calendar.ts `resolveCalendars`.
 */
export interface ProjectCalendar {
  id: string
  org_id: string
  project_id: string | null
  trade_id: string | null
  company_id: string | null
  name: string
  /** Arbeitstage als Wochentage 0 (So) – 6 (Sa) */
  working_days: number[]
  is_default: boolean
  /** Eigene Feiertagsregion (z. B. Firma aus anderem Bundesland); null = Projektregion */
  holiday_region: string | null
}

export type CalendarExceptionType = 'holiday' | 'vacation' | 'nonworking' | 'working'

export interface CalendarException {
  id: string
  calendar_id: string
  date: ISODate
  type: CalendarExceptionType
  name: string
}

// ---------------------------------------------------------------- Vorgänge

/**
 * Eine einzige Baumstruktur für Bauphase → Gewerk-Gruppe → Vorgang → Untervorgang und
 * Meilensteine. Bauphasen und Meilensteine sind bewusst KEINE eigenen Tabellen, sondern
 * `type`-Ausprägungen desselben Knotens - so bleibt die Scheduling Engine auf einer
 * einzigen, rekursiven Struktur und Ein-/Ausklappen, Sortierung, Drag & Drop
 * funktionieren auf allen Ebenen gleich.
 */
export type TaskType = 'phase' | 'group' | 'task' | 'milestone'

export type TaskStatus = 'not_started' | 'in_progress' | 'at_risk' | 'delayed' | 'blocked' | 'done'

export type ConstraintType = 'asap' | 'snet' | 'mso' | 'fnlt'

export type SchedulingMode = 'auto' | 'manual'

export interface Task {
  id: string
  project_id: string
  parent_id: string | null
  name: string
  description: string
  type: TaskType
  sort_order: number
  start_date: ISODate
  end_date: ISODate
  duration: number
  progress: number
  status: TaskStatus
  trade_id: string | null
  responsible_user_id: string | null
  /** Mehrere verantwortliche Teammitglieder (Benutzer-IDs); wird neben responsible_user_id/responsible_name angezeigt */
  responsible_user_ids: string[]
  /** Verantwortlicher als Freitext (z. B. Fremdfirma, Person ohne Konto); leer = Benutzer per responsible_user_id(s) */
  responsible_name: string
  company_id: string | null
  resource_id: string | null
  actual_start: ISODate | null
  actual_finish: ISODate | null
  remaining_duration: number | null
  constraint_type: ConstraintType
  constraint_date: ISODate | null
  scheduling_mode: SchedulingMode
  calendar_id: string | null
  is_critical: boolean
  total_float: number
  free_float: number
  early_start: ISODate | null
  early_finish: ISODate | null
  late_start: ISODate | null
  late_finish: ISODate | null
  /** Vom Server berechnet: Abhängigkeit verletzt (nur bei manuell geplanten Vorgängen möglich) */
  has_conflict: boolean
  notes: string
  /** Bauabschnitt (orthogonal zur Hierarchie) */
  section_id: string | null
  /** Mengen/Leistungswerte für spätere Dauerberechnung: Menge ÷ (Leistungswert × Kolonnen) */
  quantity: number | null
  unit: string | null
  productivity_rate: number | null
  crew_size: number | null
  /** Tatsächliche Dauer in Arbeitstagen (bei Erledigung aus Ist-Terminen abgeleitet) */
  actual_duration: number | null
}

export type DependencyType = 'FS' | 'SS' | 'FF' | 'SF'

export interface TaskDependency {
  id: string
  project_id: string
  predecessor_id: string
  successor_id: string
  type: DependencyType
  lag_days: number
  lag_unit: 'workdays' | 'days'
  /** Von der Engine gesetzt: bestimmt diese Beziehung den Start des Nachfolgers? */
  is_driving: boolean
}

export interface ProjectSection {
  id: string
  project_id: string
  name: string
  sort_order: number
}

/**
 * Ausführungsvoraussetzung - bewusst KEINE Terminabhängigkeit. Verschiebt keine Termine,
 * bestimmt aber die Ausführungsbereitschaft („Noch nicht ausführungsbereit“).
 */
export type ConstraintKind = 'predecessor' | 'material' | 'planning' | 'approval' | 'staff' | 'equipment' | 'authority' | 'client' | 'other'
export type ConstraintStatus = 'open' | 'fulfilled' | 'blocked'

export interface TaskConstraint {
  id: string
  project_id: string
  task_id: string
  type: ConstraintKind
  title: string
  status: ConstraintStatus
  due_date: ISODate | null
  responsible_user_id: string | null
  note: string
  created_at: ISODateTime
  updated_at: ISODateTime
}

// ---------------------------------------------------------------- Ressourcen

export interface Trade {
  id: string
  org_id: string
  name: string
  color: string
  sort_order: number
}

export interface Company {
  id: string
  org_id: string
  name: string
  /** Hauptgewerk (weitere über trade_ids) */
  trade_id: string | null
  trade_ids: string[]
  contact_name: string
  phone: string
  /** Allgemeine E-Mail-Adresse (Absender-Zuordnung eingehender E-Mails) */
  email: string
  address: string
  notes: string
}

/** Ansprechpartner einer Firma - wer schreibt? (Disposition, Buchhaltung, Bauleitung …) */
export interface Contact {
  id: string
  org_id: string
  company_id: string
  name: string
  role: string
  email: string
  phone: string
  notes: string
  /** Relevante Projekte (für Projekt-Zuordnung eingehender E-Mails) */
  project_ids: string[]
  created_at: ISODateTime
}

export type ResourceType = 'team' | 'person' | 'equipment'

export interface Resource {
  id: string
  org_id: string
  name: string
  type: ResourceType
  trade_id: string | null
  company_id: string | null
  capacity: number
  calendar_id: string | null
}

export interface ResourceAssignment {
  id: string
  task_id: string
  resource_id: string
  units: number
  /** Optionaler Teilzeitraum; leer = gesamter Vorgang */
  start_date: ISODate | null
  end_date: ISODate | null
}

// ---------------------------------------------------------------- Baseline / Fortschritt

export interface Baseline {
  id: string
  project_id: string
  name: string
  created_at: ISODateTime
  created_by: string | null
  is_active: boolean
  project_end: ISODate
}

export interface BaselineTask {
  baseline_id: string
  task_id: string
  start_date: ISODate
  end_date: ISODate
  duration: number
}

export type SiteFlag = 'on_track' | 'at_risk' | 'delayed' | 'done'

export type DelayReason =
  | 'weather'
  | 'material'
  | 'staff'
  | 'subcontractor'
  | 'predecessor'
  | 'planning'
  | 'client'
  | 'authority'
  | 'delivery'
  | 'other'

export interface ProgressUpdate {
  id: string
  project_id: string
  task_id: string
  user_id: string | null
  created_at: ISODateTime
  flag: SiteFlag
  progress: number
  comment: string
  delay_reason: DelayReason | null
  new_forecast_end: ISODate | null
  /** Vorbereitet: Dateianhänge (Fotos) - Metadaten, Speicherung über Storage-Adapter */
  attachments: AttachmentMeta[]
}

export interface AttachmentMeta {
  id: string
  filename: string
  mime: string
  size: number
  storage_key: string
}

export interface DelayEvent {
  id: string
  project_id: string
  task_id: string
  user_id: string | null
  created_at: ISODateTime
  reason: DelayReason
  days: number
  comment: string
}

export interface ChangeHistoryEntry {
  id: string
  project_id: string
  task_id: string | null
  task_name: string
  user_id: string | null
  user_name: string
  created_at: ISODateTime
  field: string
  old_value: string | null
  new_value: string | null
  reason: string
  source: ChangeSource
}

export type ChangeSource = 'MANUAL' | 'SITE_UPDATE' | 'SUBCONTRACTOR_PROPOSAL' | 'SCENARIO_APPLY' | 'IMPORT' | 'WORK_PACKAGE' | 'EMAIL' | 'BUILDFLOW_SYNC' | 'FUTURE_AI'

/**
 * Change-Proposal-Schicht: JEDE Änderung von außen (Nachunternehmer, E-Mail, BuildFlow,
 * später KI) wird als Vorschlag mit deterministischen Operationen beschrieben. Die
 * Scheduling Engine wendet die Operationen auf eine Kopie an und berechnet die
 * Auswirkung; der Mensch entscheidet. Der Masterplan wird nie direkt verändert.
 */
export type ProposalOperation =
  | { op: 'move_task'; task_id: string; new_start: ISODate; cascade?: boolean }
  | { op: 'set_end'; task_id: string; new_end: ISODate }
  | { op: 'set_duration'; task_id: string; duration: number }
  | { op: 'add_task'; key: string; name: string; type: TaskType; duration: number; parent_id?: string | null; parent_key?: string | null; trade_name?: string | null; notes?: string; after_task_id?: string | null }
  | { op: 'update_task'; task_id: string; fields: Partial<Pick<Task, 'name' | 'duration' | 'notes' | 'description' | 'trade_id' | 'responsible_user_id' | 'responsible_user_ids' | 'responsible_name' | 'resource_id' | 'company_id' | 'constraint_type' | 'constraint_date'>> }
  | { op: 'remove_task'; task_id: string }
  | { op: 'add_dependency'; predecessor: string; successor: string; type: DependencyType; lag_days: number }
  | { op: 'update_dependency'; dependency_id: string; type?: DependencyType; lag_days?: number }
  | { op: 'remove_dependency'; dependency_id: string }
  | { op: 'add_constraint'; task_id?: string; task_key?: string; type: ConstraintKind; title: string; due_date?: ISODate | null }

export type ProposalOrigin = 'share_link' | 'manual' | 'email' | 'buildflow' | 'ai'

/** Terminänderungsvorschlag - verändert den Plan nie direkt; Projektleiter entscheidet. */
export type ProposalStatus = 'open' | 'accepted' | 'rejected'
export interface ChangeProposal {
  id: string
  project_id: string
  /** Hauptvorgang (bei Mehrfach-Operationen optional) */
  task_id: string | null
  source: ChangeSource
  status: ProposalStatus
  title: string
  /** Einfache Form (ein Vorgang) - wird intern in Operationen übersetzt */
  proposed_start: ISODate | null
  proposed_end: ISODate | null
  /** Strukturierte Operationen (E-Mail, BuildFlow, KI) */
  operations: ProposalOperation[]
  reason: string
  comment: string
  submitted_by_name: string
  submitted_by_user_id: string | null
  share_link_id: string | null
  origin_kind: ProposalOrigin
  /** Verweis auf die Quelle (E-Mail-ID, BuildFlow-Prozess-ID …) */
  origin_ref: string | null
  created_at: ISODateTime
  decided_at: ISODateTime | null
  decided_by: string | null
  decision_note: string
}

export type ShareRelevance = 'compact' | 'standard' | 'full'
export interface ShareLink {
  id: string
  org_id: string
  project_id: string
  scope: 'trade' | 'company'
  trade_id: string | null
  company_id: string | null
  label: string
  relevance: ShareRelevance
  expires_at: ISODateTime | null
  revoked_at: ISODateTime | null
  created_by: string | null
  created_at: ISODateTime
  last_used_at: ISODateTime | null
  use_count: number
  /** Nur direkt nach dem Anlegen gefüllt (Token wird gehasht gespeichert) */
  url?: string
}

export interface TradeConfirmation {
  id: string
  project_id: string
  share_link_id: string | null
  task_id: string
  status: 'confirmed' | 'not_possible'
  proposed_start: ISODate | null
  comment: string
  contact_name: string
  created_at: ISODateTime
}

// ---------------------------------------------------------------- Vorlagen

export interface ProjectTemplate {
  id: string
  org_id: string | null
  name: string
  description: string
  planning_kind: PlanningKind
  project_type: ProjectType | null
  construction_method: ConstructionMethod | null
  is_builtin: boolean
  created_at: ISODateTime
}

export interface TemplateDependency {
  predecessor_key: string
  type: DependencyType
  lag_days: number
}

export interface TemplateTask {
  id: string
  template_id: string
  key: string
  parent_key: string | null
  name: string
  type: TaskType
  duration: number
  trade_name: string | null
  section_name: string | null
  sort_order: number
  dependencies: TemplateDependency[]
  constraints: TemplateConstraint[]
  /** Optionale Notiz (z. B. BuildFlow-Rolle) */
  notes?: string
}

export interface TemplateConstraint {
  type: ConstraintKind
  title: string
}

/** Arbeitspaket: in bestehende Projekte einfügbare Teilstruktur inkl. Abhängigkeiten */
export interface WorkPackageTemplate {
  id: string
  org_id: string | null
  name: string
  description: string
  is_builtin: boolean
  created_at: ISODateTime
}
export interface WorkPackageTask {
  id: string
  package_id: string
  key: string
  parent_key: string | null
  name: string
  type: TaskType
  duration: number
  trade_name: string | null
  sort_order: number
  dependencies: TemplateDependency[]
  constraints: TemplateConstraint[]
}

// ---------------------------------------------------------------- Kalkulation ↔ Terminplan (vorbereitet)

export interface EstimateImport {
  id: string
  org_id: string
  project_id: string | null
  source_type: 'csv' | 'excel' | 'gaeb' | 'pdf' | 'api' | 'ifc'
  filename: string
  status: 'imported' | 'mapped' | 'discarded'
  item_count: number
  created_by: string | null
  created_at: ISODateTime
}
export interface EstimateItem {
  id: string
  import_id: string
  project_id: string | null
  position: string
  description: string
  quantity: number | null
  unit: string | null
  trade_name: string | null
  section_name: string | null
  unit_price: number | null
  total_price: number | null
}

// ---------------------------------------------------------------- Benachrichtigungen / Szenarien

export type NotificationType =
  | 'milestone_upcoming'
  | 'task_overdue'
  | 'project_variance'
  | 'site_update'
  | 'baseline_saved'
  | 'resource_overload'
  | 'info'

export type NotificationSeverity = 'info' | 'warning' | 'critical'

export interface AppNotification {
  id: string
  org_id: string
  user_id: string | null
  project_id: string | null
  type: NotificationType
  severity: NotificationSeverity
  title: string
  message: string
  created_at: ISODateTime
  read_at: ISODateTime | null
  /** Zustell-Kanäle (in_app immer; email/push vorbereitet, werden vom Dispatcher ausgewertet) */
  channels: NotificationChannel[]
}

export type NotificationChannel = 'in_app' | 'email' | 'push'

export type ScenarioOrigin = 'manual' | 'proposal' | 'ai'

/**
 * Zusammenfassung einer Variante - wird beim Vergleich berechnet und bei KI-Varianten
 * vom Dienst mitgeliefert. Der Masterplan bleibt davon unberührt.
 */
export interface ScenarioSummary {
  changed_tasks: number
  changed_dependencies: number
  added_resources: string[]
  original_end: ISODate
  new_end: ISODate
  delta_days: number
  risks: string[]
  rule_violations: number
}

export interface Scenario {
  id: string
  project_id: string
  name: string
  description: string
  created_at: ISODateTime
  created_by: string | null
  origin: ScenarioOrigin
  proposal_id: string | null
  /** Von KI/Import mitgelieferte Zusammenfassung (optional; Vergleich rechnet immer selbst) */
  meta: Partial<ScenarioSummary>
  tasks: Task[]
  dependencies: TaskDependency[]
}

// ---------------------------------------------------------------- Aggregierte Lade-Objekte

/** Alles, was die Engine für ein Projekt braucht - wird als Ganzes geladen. */
export interface ProjectBundle {
  project: Project
  tasks: Task[]
  dependencies: TaskDependency[]
  calendars: ProjectCalendar[]
  exceptions: CalendarException[]
  baselines: Baseline[]
  baseline_tasks: BaselineTask[]
  assignments: ResourceAssignment[]
  members: ProjectMember[]
  sections: ProjectSection[]
  constraints: TaskConstraint[]
  /** Für Ressourcenkalender (resource.calendar_id) */
  resources: Resource[]
}

/** Vom Server für Listen/Dashboard vorberechnet (mittels shared engine). */
export type HealthStatus = 'green' | 'yellow' | 'red' | 'grey'

export interface ProjectSummary {
  project: Project
  health: HealthStatus
  progress: number
  planned_end: ISODate
  baseline_end: ISODate | null
  forecast_end: ISODate
  variance_days: number
  next_milestone: { id: string; name: string; date: ISODate } | null
  critical_count: number
  delayed_count: number
  overdue_count: number
  task_count: number
  done_count: number
  project_manager_name: string
  site_manager_name: string
}

export interface CriticalEvent {
  project_id: string
  project_name: string
  task_id: string | null
  severity: NotificationSeverity
  message: string
  date: ISODate
}

export interface OrgData {
  org: Organization
  trades: Trade[]
  companies: Company[]
  contacts: Contact[]
  resources: Resource[]
  members: OrganizationMember[]
  calendars: ProjectCalendar[]
  exceptions: CalendarException[]
}

// ---------------------------------------------------------------- Befehle (Client → Server)

export interface SavePlanRequest {
  expected_version: number
  tasks: Task[]
  dependencies: TaskDependency[]
  reason: string
  source?: ChangeSource
}

export interface SavePlanResponse {
  version: number
  tasks: Task[]
  changes: ChangeHistoryEntry[]
}

export interface SiteUpdateRequest {
  flag: SiteFlag
  progress?: number
  comment?: string
  delay_reason?: DelayReason | null
  new_forecast_end?: ISODate | null
}

export interface CreateProjectRequest {
  number: string
  name: string
  customer: string
  address: string
  city: string
  project_manager_id: string | null
  site_manager_id: string | null
  planning_kind: PlanningKind
  holiday_region?: string | null
  project_type: ProjectType
  construction_method: ConstructionMethod
  start_date: ISODate
  target_end_date: ISODate
  area_sqm: number | null
  floors: number | null
  has_basement: boolean
  plan_source: { kind: 'empty' } | { kind: 'template'; template_id: string } | { kind: 'buildflow'; process: unknown } | { kind: 'ai' }
  sections?: string[]
}

// ---------------------------------------------------------------- KI-Schnittstelle (vorbereitet)

/**
 * Strukturierter Kontext, den ein späterer KI-Dienst erhält. Bewusst als reines
 * Datenobjekt definiert: alles, was die KI wissen muss, liegt in Tabellen und nicht in
 * Fließtext. Es existiert noch KEINE Implementierung - nur der Vertrag.
 */
export type AiCapability =
  | 'create_plan'
  | 'suggest_durations'
  | 'suggest_dependencies'
  | 'check_plan'
  | 'analyze_risks'
  | 'explain_delay'
  | 'find_solution'
  | 'optimize_plan'

/**
 * Werkzeuge, die ein späterer KI-Dienst aufrufen darf. Bewusst keine Tabellenzugriffe:
 * Lesen über strukturierte Kontexte, Schreiben ausschließlich als Vorschlag
 * (change_proposals mit source FUTURE_AI), den ein Mensch bestätigt.
 */
export interface AiToolContract {
  name: 'get_planning_context' | 'preview_change' | 'propose_change' | 'list_findings' | 'list_rules' | 'create_scenario_variant'
  description: string
  input: string
  output: string
}
export const AI_TOOL_CONTRACTS: AiToolContract[] = [
  { name: 'list_rules', description: 'Baulogische Regeln (System/Org/Projekt) - Grenzen, innerhalb derer optimiert werden darf', input: '{ project_id }', output: 'PlanRule[]' },
  { name: 'create_scenario_variant', description: 'Variante als separates Szenario anlegen (nie den Masterplan)', input: '{ project_id, name, operations: ProposalOperation[] }', output: 'Scenario' },
  { name: 'get_planning_context', description: 'Strukturierter Projektkontext (AiPlanningContext)', input: '{ project_id }', output: 'AiPlanningContext' },
  { name: 'preview_change', description: 'Auswirkungsanalyse einer Terminänderung ohne Speichern', input: '{ project_id, task_id, new_start | new_duration }', output: 'ImpactAnalysis' },
  { name: 'propose_change', description: 'Änderungsvorschlag anlegen (kein direktes Schreiben)', input: '{ project_id, task_id, proposed_start, proposed_end, reason }', output: 'ChangeProposal' },
  { name: 'list_findings', description: 'Regelbasierte Planprüfung (ohne Vorgänger, Trocknungszeiten, doppelte Kolonnen …)', input: '{ project_id }', output: 'PlanFinding[]' },
]

export interface AiPlanningContext {
  project: Project
  tasks: Task[]
  dependencies: TaskDependency[]
  baseline: { baseline: Baseline; tasks: BaselineTask[] } | null
  delays: DelayEvent[]
  history: ChangeHistoryEntry[]
  calendars: ProjectCalendar[]
  exceptions: CalendarException[]
  trades: Trade[]
  sections: ProjectSection[]
  constraints: TaskConstraint[]
  today: ISODate
}

/**
 * Anfrage an einen späteren KI-Dienst „Lösung finden“: Ausgangslage (Störung als
 * Operationen) + Ziel. Antwort: Varianten, die ausschließlich als Szenarien angelegt werden.
 * Es existiert noch KEIN Dienst - nur der Vertrag und der Endpunkt (501).
 */
export interface AiSolutionRequest {
  project_id: string
  disturbance: ProposalOperation[]
  goal: 'hold_end_date' | 'minimize_delay' | 'minimize_resources'
  allow: { resequence: boolean; parallelize: boolean; add_resources: boolean; resequence_sections: boolean }
}
export interface AiSolutionVariant {
  name: string
  strategy: 'resequence' | 'parallelize' | 'add_resources' | 'resequence_sections'
  operations: ProposalOperation[]
  summary: ScenarioSummary
}
