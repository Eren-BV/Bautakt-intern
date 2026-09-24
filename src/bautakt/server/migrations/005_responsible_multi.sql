-- Mehrere Verantwortliche pro Vorgang (JSON-Array von Benutzer-IDs)
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS responsible_user_ids TEXT NOT NULL DEFAULT '[]';
