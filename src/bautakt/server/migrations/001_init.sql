-- Grundschema. Multi-Tenant: jede fachliche Tabelle trägt org_id (direkt oder über project_id).
-- Termine als ISO-Text (YYYY-MM-DD), Zeitstempel als ISO-8601, Booleans als 0/1, Listen als JSON.

CREATE TABLE organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE organization_members (
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  PRIMARY KEY (org_id, user_id)
);

CREATE TABLE sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE project_calendars (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id TEXT,
  trade_id TEXT,
  name TEXT NOT NULL,
  working_days TEXT NOT NULL DEFAULT '[1,2,3,4,5]',
  is_default INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_calendars_org ON project_calendars(org_id);

CREATE TABLE calendar_exceptions (
  id TEXT PRIMARY KEY,
  calendar_id TEXT NOT NULL REFERENCES project_calendars(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  type TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_calex_cal ON calendar_exceptions(calendar_id);

CREATE TABLE trades (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#64748b',
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_trades_org ON trades(org_id);

CREATE TABLE companies (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  trade_id TEXT REFERENCES trades(id) ON DELETE SET NULL,
  contact_name TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_companies_org ON companies(org_id);

CREATE TABLE resources (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'team',
  trade_id TEXT REFERENCES trades(id) ON DELETE SET NULL,
  company_id TEXT REFERENCES companies(id) ON DELETE SET NULL,
  capacity REAL NOT NULL DEFAULT 1,
  calendar_id TEXT REFERENCES project_calendars(id) ON DELETE SET NULL
);
CREATE INDEX idx_resources_org ON resources(org_id);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  number TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  customer TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '',
  project_type TEXT NOT NULL DEFAULT 'individuell',
  construction_method TEXT NOT NULL DEFAULT 'individuell',
  start_date TEXT NOT NULL,
  target_end_date TEXT NOT NULL,
  area_sqm REAL,
  floors INTEGER,
  has_basement INTEGER NOT NULL DEFAULT 0,
  project_manager_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  site_manager_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  state TEXT NOT NULL DEFAULT 'active',
  calendar_id TEXT REFERENCES project_calendars(id) ON DELETE SET NULL,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_projects_org ON projects(org_id);

CREATE TABLE project_members (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member',
  PRIMARY KEY (project_id, user_id)
);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_id TEXT,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT 'task',
  sort_order INTEGER NOT NULL DEFAULT 0,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  duration INTEGER NOT NULL DEFAULT 1,
  progress INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'not_started',
  trade_id TEXT,
  responsible_user_id TEXT,
  company_id TEXT,
  resource_id TEXT,
  actual_start TEXT,
  actual_finish TEXT,
  remaining_duration INTEGER,
  constraint_type TEXT NOT NULL DEFAULT 'asap',
  constraint_date TEXT,
  scheduling_mode TEXT NOT NULL DEFAULT 'auto',
  calendar_id TEXT,
  is_critical INTEGER NOT NULL DEFAULT 0,
  total_float INTEGER NOT NULL DEFAULT 0,
  free_float INTEGER NOT NULL DEFAULT 0,
  early_start TEXT,
  early_finish TEXT,
  late_start TEXT,
  late_finish TEXT,
  has_conflict INTEGER NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_tasks_project ON tasks(project_id);
CREATE INDEX idx_tasks_parent ON tasks(parent_id);

CREATE TABLE task_dependencies (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  predecessor_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  successor_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  type TEXT NOT NULL DEFAULT 'FS',
  lag_days INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_deps_project ON task_dependencies(project_id);

CREATE TABLE resource_assignments (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  resource_id TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  units REAL NOT NULL DEFAULT 1
);
CREATE INDEX idx_assign_task ON resource_assignments(task_id);

CREATE TABLE baselines (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  created_by TEXT,
  is_active INTEGER NOT NULL DEFAULT 1,
  project_end TEXT NOT NULL
);
CREATE INDEX idx_baselines_project ON baselines(project_id);

CREATE TABLE baseline_tasks (
  baseline_id TEXT NOT NULL REFERENCES baselines(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL,
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  duration INTEGER NOT NULL,
  PRIMARY KEY (baseline_id, task_id)
);

CREATE TABLE progress_updates (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL,
  user_id TEXT,
  created_at TEXT NOT NULL,
  flag TEXT NOT NULL,
  progress INTEGER NOT NULL DEFAULT 0,
  comment TEXT NOT NULL DEFAULT '',
  delay_reason TEXT,
  new_forecast_end TEXT,
  attachments TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX idx_progress_project ON progress_updates(project_id);

CREATE TABLE delay_events (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL,
  user_id TEXT,
  created_at TEXT NOT NULL,
  reason TEXT NOT NULL,
  days INTEGER NOT NULL DEFAULT 0,
  comment TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_delay_project ON delay_events(project_id);

CREATE TABLE change_history (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id TEXT,
  task_name TEXT NOT NULL DEFAULT '',
  user_id TEXT,
  user_name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  field TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  reason TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_history_project ON change_history(project_id, created_at);

CREATE TABLE project_templates (
  id TEXT PRIMARY KEY,
  org_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  project_type TEXT,
  construction_method TEXT,
  is_builtin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE template_tasks (
  id TEXT PRIMARY KEY,
  template_id TEXT NOT NULL REFERENCES project_templates(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  parent_key TEXT,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'task',
  duration INTEGER NOT NULL DEFAULT 1,
  trade_name TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  dependencies TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX idx_tpl_tasks ON template_tasks(template_id);

CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT,
  project_id TEXT,
  type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info',
  title TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  read_at TEXT,
  channels TEXT NOT NULL DEFAULT '["in_app"]',
  dedupe_key TEXT
);
CREATE INDEX idx_notif_org ON notifications(org_id, created_at);
CREATE UNIQUE INDEX idx_notif_dedupe ON notifications(org_id, dedupe_key) WHERE dedupe_key IS NOT NULL;

CREATE TABLE scenarios (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  created_by TEXT,
  tasks TEXT NOT NULL DEFAULT '[]',
  dependencies TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX idx_scenarios_project ON scenarios(project_id);

-- Vorbereitet: Datei-/Fotoanhänge (Metadaten; Binärdaten über Storage-Adapter)
CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id TEXT,
  task_id TEXT,
  progress_update_id TEXT,
  filename TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  storage_key TEXT NOT NULL,
  created_at TEXT NOT NULL
);
