-- Wortlaut jeder Jarvis-Anfrage organisationsweit festhalten - auch ohne Projektbezug
-- (Dashboard, Projektliste usw.). Innerhalb eines Projekts landet dieselbe Anfrage zusätzlich
-- in dessen Änderungshistorie (change_history, field 'ki_anfrage') - hier ist die vollständige,
-- projektübergreifende Liste.

CREATE TABLE jarvis_commands (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  project_id TEXT,
  user_id TEXT NOT NULL,
  user_name TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL,
  via TEXT NOT NULL DEFAULT 'text',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_jarvis_commands_org ON jarvis_commands(org_id, created_at);
