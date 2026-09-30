-- Checkliste am Vorgang: einfache Büro-To-Dos (z. B. "Briefing erstellen", "Freigabe
-- einholen"). Bewusst leichtgewichtig und getrennt von Voraussetzungen (typisierte Blocker
-- der Ausführungsbereitschaft) und Untervorgängen (eigene geplante Vorgänge) - keine Termine,
-- keine Abhängigkeiten, kein Einfluss auf die Terminberechnung oder den Fortschritt.

CREATE TABLE task_checklist_items (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  text TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_checklist_task ON task_checklist_items(task_id);
CREATE INDEX IF NOT EXISTS idx_checklist_project ON task_checklist_items(project_id);
