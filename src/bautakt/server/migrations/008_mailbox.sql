-- Persönliche Postfach-Anbindung (Outlook / Gmail) und Protokoll gesendeter Nachrichten.
-- Jede Verknüpfung gehört genau einem Benutzer; Zugangsschlüssel werden verschlüsselt abgelegt.

CREATE TABLE IF NOT EXISTS mailbox_accounts (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  email TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'connected',
  connection_key TEXT,
  last_sync_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mailbox_user ON mailbox_accounts(org_id, user_id, provider);

CREATE TABLE IF NOT EXISTS outbound_emails (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  from_email TEXT NOT NULL DEFAULT '',
  to_email TEXT NOT NULL,
  cc_email TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '',
  body_text TEXT NOT NULL DEFAULT '',
  project_id TEXT,
  reply_to_id TEXT,
  status TEXT NOT NULL DEFAULT 'queued',
  error TEXT,
  sent_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_outbound_user ON outbound_emails(org_id, user_id, created_at);
