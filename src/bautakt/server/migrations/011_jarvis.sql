-- Batch-Anweisungen können eine erwartete Anzahl betroffener Zeilen angeben ("expect"), z. B. den
-- Versionsschutz beim Speichern eines Plans. Weicht sie ab, bricht der gesamte Batch mit
-- BAUTAKT_EXPECT:<tag> ab und nichts davon wird geschrieben.
CREATE OR REPLACE FUNCTION public.bautakt_batch(items jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = bautakt, public
AS $$
DECLARE
  item jsonb;
  n integer;
  results jsonb := '[]'::jsonb;
BEGIN
  FOR item IN SELECT * FROM jsonb_array_elements(items) LOOP
    EXECUTE public.bautakt_bind(item->>'q', item->'p');
    GET DIAGNOSTICS n = ROW_COUNT;
    IF jsonb_typeof(item->'expect') = 'number' AND n <> (item->>'expect')::integer THEN
      RAISE EXCEPTION 'BAUTAKT_EXPECT:%', COALESCE(item->>'tag', 'rows');
    END IF;
    results := results || to_jsonb(n);
  END LOOP;
  RETURN results;
END;
$$;

REVOKE ALL ON FUNCTION public.bautakt_batch(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bautakt_batch(jsonb) TO service_role;

-- Jarvis: ausgeführte und zur Bestätigung vorgemerkte Aktionen, inkl. Daten zum Rückgängigmachen.
CREATE TABLE IF NOT EXISTS jarvis_actions (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  project_id TEXT,
  tool TEXT NOT NULL,
  args TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  fingerprint TEXT,
  version_after INTEGER,
  undo TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  decided_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_jarvis_actions_user ON jarvis_actions(org_id, user_id, created_at);

-- Jarvis: Nutzung je Gesprächsrunde (Kosten, Latenz, Tageslimit).
CREATE TABLE IF NOT EXISTS jarvis_turns (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  iterations INTEGER NOT NULL DEFAULT 0,
  tool_calls INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_jarvis_turns_user ON jarvis_turns(user_id, created_at);
