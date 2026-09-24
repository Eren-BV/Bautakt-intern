-- V1: Bauabschnitte, Voraussetzungen, Change Proposals, Share-Links, Arbeitspakete,
-- Kalkulations-Verknüpfung, Mengen/Leistungswerte, Historie-Quelle, Status "gefährdet".

CREATE TABLE project_sections (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_sections_project ON project_sections(project_id);

ALTER TABLE tasks ADD COLUMN section_id TEXT;
ALTER TABLE tasks ADD COLUMN quantity REAL;
ALTER TABLE tasks ADD COLUMN unit TEXT;
ALTER TABLE tasks ADD COLUMN productivity_rate REAL;
ALTER TABLE tasks ADD COLUMN crew_size REAL;
ALTER TABLE tasks ADD COLUMN actual_duration INTEGER;
ALTER TABLE tasks ADD COLUMN created_at TEXT;
ALTER TABLE tasks ADD COLUMN updated_at TEXT;

ALTER TABLE task_dependencies ADD COLUMN lag_unit TEXT NOT NULL DEFAULT 'workdays';
ALTER TABLE task_dependencies ADD COLUMN is_driving INTEGER NOT NULL DEFAULT 0;

ALTER TABLE change_history ADD COLUMN source TEXT NOT NULL DEFAULT 'MANUAL';

ALTER TABLE template_tasks ADD COLUMN section_name TEXT;
ALTER TABLE template_tasks ADD COLUMN constraints TEXT NOT NULL DEFAULT '[]';

-- Ausführungsvoraussetzungen (kein Termin-Einfluss, aber Ausführungsbereitschaft)
CREATE TABLE task_constraints (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  due_date TEXT,
  responsible_user_id TEXT,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_constraints_task ON task_constraints(task_id);
CREATE INDEX idx_constraints_project ON task_constraints(project_id);

-- Ressourcen-Zuweisungen bekommen Zeitraum (optional; leer = ganzer Vorgang)
ALTER TABLE resource_assignments ADD COLUMN start_date TEXT;
ALTER TABLE resource_assignments ADD COLUMN end_date TEXT;

-- Terminänderungsvorschläge (Nachunternehmer, später KI) - verändern den Plan nie direkt
CREATE TABLE change_proposals (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  proposed_start TEXT,
  proposed_end TEXT,
  reason TEXT NOT NULL DEFAULT '',
  comment TEXT NOT NULL DEFAULT '',
  submitted_by_name TEXT NOT NULL DEFAULT '',
  submitted_by_user_id TEXT,
  share_link_id TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT,
  decision_note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_proposals_project ON change_proposals(project_id, status);

-- Sichere Nur-Lese-Links (Gewerkeplan) mit Widerruf und Ablauf
CREATE TABLE share_links (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  scope TEXT NOT NULL DEFAULT 'trade',
  trade_id TEXT,
  company_id TEXT,
  label TEXT NOT NULL DEFAULT '',
  relevance TEXT NOT NULL DEFAULT 'standard',
  expires_at TEXT,
  revoked_at TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  use_count INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_share_project ON share_links(project_id);

CREATE TABLE trade_confirmations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  share_link_id TEXT,
  task_id TEXT NOT NULL,
  status TEXT NOT NULL,
  proposed_start TEXT,
  comment TEXT NOT NULL DEFAULT '',
  contact_name TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_confirm_project ON trade_confirmations(project_id);

-- Arbeitspakete (in bestehende Projekte einfügbar)
CREATE TABLE work_package_templates (
  id TEXT PRIMARY KEY,
  org_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  is_builtin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE work_package_tasks (
  id TEXT PRIMARY KEY,
  package_id TEXT NOT NULL REFERENCES work_package_templates(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  parent_key TEXT,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'task',
  duration INTEGER NOT NULL DEFAULT 1,
  trade_name TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  dependencies TEXT NOT NULL DEFAULT '[]',
  constraints TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX idx_wp_tasks ON work_package_tasks(package_id);

-- Kalkulation ↔ Terminplan (Architektur; Importpfad CSV real, GAEB/Excel/IFC vorbereitet)
CREATE TABLE estimate_imports (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL,
  filename TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'imported',
  item_count INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE estimate_items (
  id TEXT PRIMARY KEY,
  import_id TEXT NOT NULL REFERENCES estimate_imports(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  position TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL,
  quantity REAL,
  unit TEXT,
  trade_name TEXT,
  section_name TEXT,
  unit_price REAL,
  total_price REAL
);
CREATE INDEX idx_estimate_items_project ON estimate_items(project_id);
CREATE TABLE task_estimate_links (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  estimate_item_id TEXT NOT NULL REFERENCES estimate_items(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, estimate_item_id)
);
