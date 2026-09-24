-- Verantwortlicher als Freitext (zusätzlich zu responsible_user_id)
ALTER TABLE tasks ADD COLUMN responsible_name TEXT NOT NULL DEFAULT '';
