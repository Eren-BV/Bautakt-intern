-- Eigenständige Aufgaben (Delegation): losgelöst vom Terminplan, mit eigenem Fertigstellungs-
-- und Erinnerungstermin. Optional einem Vorgang zugeordnet, aber nicht Teil der Ablaufberechnung.

CREATE TABLE assignments (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  task_id TEXT,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  assigned_by TEXT NOT NULL,
  assigned_to TEXT NOT NULL,
  due_date TEXT,
  reminder_date TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  result_note TEXT,
  result_submitted_at TEXT,
  closed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_assignments_to ON assignments(org_id, assigned_to, status);
CREATE INDEX IF NOT EXISTS idx_assignments_by ON assignments(org_id, assigned_by, status);
CREATE INDEX IF NOT EXISTS idx_assignments_project ON assignments(project_id);

-- Anhänge in beide Richtungen: vom Auftraggeber beim Erteilen, vom Bearbeiter beim Rückgeben.
ALTER TABLE attachments ADD COLUMN assignment_id TEXT;
ALTER TABLE attachments ADD COLUMN is_result BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_attachments_assignment ON attachments(assignment_id);
