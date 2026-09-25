-- Posteingang gehört dem einzelnen Benutzer: jede E-Mail ist einem Benutzer zugeordnet
-- und nur für diesen sichtbar. Bestehende Nachrichten gehen an den Inhaber (Owner) der Organisation.

ALTER TABLE inbound_emails ADD COLUMN user_id TEXT;
CREATE INDEX IF NOT EXISTS idx_inbound_user ON inbound_emails(org_id, user_id, status);

UPDATE inbound_emails
SET user_id = (
  SELECT om.user_id FROM organization_members om
  WHERE om.org_id = inbound_emails.org_id AND om.role = 'owner'
  LIMIT 1
)
WHERE user_id IS NULL;
