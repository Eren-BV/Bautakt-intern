-- Sammelstelle: mehrere Zeitpläne eines größeren Vorhabens auf einer Stelle gruppieren
-- (z. B. ein Bauträgerprojekt mit mehreren Bauabschnitten, jeder mit eigenem Terminplan).
-- Bewusst leichtgewichtig: eine flache Gruppe pro Projekt, keine verschachtelte Planung,
-- keine gemeinsame Terminberechnung über Projektgrenzen hinweg.

CREATE TABLE project_groups (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_project_groups_org ON project_groups(org_id);

ALTER TABLE projects ADD COLUMN group_id TEXT;
CREATE INDEX IF NOT EXISTS idx_projects_group ON projects(group_id);
