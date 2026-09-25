-- Zweistufige Benachrichtigungen (sofort vs. gesammelt) + stundengenaue Planung

ALTER TABLE notifications ADD COLUMN IF NOT EXISTS urgency TEXT NOT NULL DEFAULT 'digest';

CREATE TABLE IF NOT EXISTS email_outbox (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  user_id TEXT,
  to_email TEXT NOT NULL,
  to_name TEXT NOT NULL DEFAULT '',
  urgency TEXT NOT NULL DEFAULT 'digest',
  severity TEXT NOT NULL DEFAULT 'info',
  subject TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  notification_id TEXT,
  project_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  scheduled_for TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  sent_at TEXT,
  error TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_outbox_due ON email_outbox(status, scheduled_for);
CREATE INDEX IF NOT EXISTS idx_outbox_user ON email_outbox(user_id, status);

-- Stundengenaue Planung: mehrere Vorgänge innerhalb eines Tages
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS start_time TEXT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS end_time TEXT;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS duration_hours REAL;
