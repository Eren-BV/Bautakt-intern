-- V1-Erweiterung: freie Projektplanung, Feiertagsregionen & Kalender-Schichten,
-- Firmen/Ansprechpartner, Change-Proposal-Operationen, BuildFlow-Verknüpfung,
-- E-Mail-Eingang, Szenario-Herkunft, baulogische Regeln.

-- Feiertagsregion (Land-Region, z. B. DE-BY) - Org-Standard und je Projekt
ALTER TABLE organizations ADD COLUMN holiday_region TEXT NOT NULL DEFAULT 'DE-BY';
ALTER TABLE projects ADD COLUMN planning_kind TEXT NOT NULL DEFAULT 'construction';
ALTER TABLE projects ADD COLUMN holiday_region TEXT NOT NULL DEFAULT 'DE-BY';
ALTER TABLE project_templates ADD COLUMN planning_kind TEXT NOT NULL DEFAULT 'construction';

-- Kalender-Schichten: Firmenkalender + eigene Feiertagsregion je Kalender
ALTER TABLE project_calendars ADD COLUMN company_id TEXT;
ALTER TABLE project_calendars ADD COLUMN holiday_region TEXT;

-- Firmen: Adresse, Notizen, mehrere Gewerke, Ansprechpartner
ALTER TABLE companies ADD COLUMN address TEXT NOT NULL DEFAULT '';
ALTER TABLE companies ADD COLUMN notes TEXT NOT NULL DEFAULT '';
CREATE TABLE company_trades (
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  trade_id TEXT NOT NULL REFERENCES trades(id) ON DELETE CASCADE,
  PRIMARY KEY (company_id, trade_id)
);
CREATE TABLE contacts (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_contacts_org ON contacts(org_id);
CREATE INDEX idx_contacts_company ON contacts(company_id);
CREATE INDEX idx_contacts_email ON contacts(email);
CREATE TABLE contact_projects (
  contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  PRIMARY KEY (contact_id, project_id)
);

-- Change Proposals: Operationen, Titel, Herkunft; task_id optional (Mehrfach-Operationen)
CREATE TABLE change_proposals_v2 (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id TEXT,
  source TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  title TEXT NOT NULL DEFAULT '',
  proposed_start TEXT,
  proposed_end TEXT,
  operations TEXT NOT NULL DEFAULT '[]',
  reason TEXT NOT NULL DEFAULT '',
  comment TEXT NOT NULL DEFAULT '',
  submitted_by_name TEXT NOT NULL DEFAULT '',
  submitted_by_user_id TEXT,
  share_link_id TEXT,
  origin_kind TEXT NOT NULL DEFAULT 'manual',
  origin_ref TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT,
  decided_by TEXT,
  decision_note TEXT NOT NULL DEFAULT ''
);
INSERT INTO change_proposals_v2 (id, project_id, task_id, source, status, proposed_start, proposed_end, reason, comment, submitted_by_name, submitted_by_user_id, share_link_id, origin_kind, created_at, decided_at, decided_by, decision_note)
  SELECT id, project_id, task_id, source, status, proposed_start, proposed_end, reason, comment, submitted_by_name, submitted_by_user_id, share_link_id,
         CASE WHEN share_link_id IS NULL THEN 'manual' ELSE 'share_link' END, created_at, decided_at, decided_by, decision_note FROM change_proposals;
DROP TABLE change_proposals;
ALTER TABLE change_proposals_v2 RENAME TO change_proposals;
CREATE INDEX idx_proposals_project ON change_proposals(project_id, status);

-- Szenarien: Herkunft (manuell / aus Vorschlag / KI-Variante) + Zusammenfassung
ALTER TABLE scenarios ADD COLUMN origin TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE scenarios ADD COLUMN proposal_id TEXT;
ALTER TABLE scenarios ADD COLUMN meta TEXT NOT NULL DEFAULT '{}';

-- Integrationen (BuildFlow, E-Mail-Provider) - providerunabhängig, Konfiguration als JSON
CREATE TABLE integrations (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'not_connected',
  config TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_integrations_org ON integrations(org_id, kind);

-- BuildFlow-Prozess ↔ Projekt: eingefrorener Stand für spätere Änderungsprüfung
CREATE TABLE project_process_links (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  process_id TEXT NOT NULL,
  process_name TEXT NOT NULL DEFAULT '',
  process_version TEXT NOT NULL DEFAULT '',
  snapshot TEXT NOT NULL DEFAULT '{}',
  mapping TEXT NOT NULL DEFAULT '{}',
  phase_task_id TEXT,
  created_at TEXT NOT NULL,
  last_synced_at TEXT
);
CREATE INDEX idx_process_links_project ON project_process_links(project_id);

-- Eingehende E-Mails: Rohnachricht + strukturierte Analyse + Entscheidung
CREATE TABLE inbound_emails (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'manual',
  external_id TEXT,
  from_email TEXT NOT NULL DEFAULT '',
  from_name TEXT NOT NULL DEFAULT '',
  to_email TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '',
  body_text TEXT NOT NULL DEFAULT '',
  received_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',
  analysis TEXT,
  project_id TEXT,
  proposal_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_inbound_org ON inbound_emails(org_id, status);

-- Baulogische Regeln: System (org_id NULL), Org, Projekt, Vorlage
CREATE TABLE plan_rules (
  id TEXT PRIMARY KEY,
  org_id TEXT REFERENCES organizations(id) ON DELETE CASCADE,
  project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
  template_id TEXT,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  config TEXT NOT NULL DEFAULT '{}',
  severity TEXT NOT NULL DEFAULT 'warning',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_rules_org ON plan_rules(org_id);
CREATE INDEX idx_rules_project ON plan_rules(project_id);
