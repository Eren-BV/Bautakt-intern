-- „Mach das rückgängig“ bezieht sich auf das laufende Gespräch; ältere Aktionen nur nach Rückfrage.
ALTER TABLE jarvis_actions ADD COLUMN IF NOT EXISTS conversation_id TEXT;
