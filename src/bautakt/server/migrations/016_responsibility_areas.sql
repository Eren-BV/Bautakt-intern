-- Aufgabenbereiche je Mitglied (z. B. "Elektro", "Ausschreibung", "Kundenkommunikation"):
-- Grundlage, damit KI-Planerstellung/-Import Vorgänge künftig nicht nur über Namensnennung,
-- sondern auch über die fachliche Zuständigkeit einer Person zuordnen kann. Frei getaggt
-- (kein fester Katalog); die eigentliche Zuordnungslogik folgt später.
ALTER TABLE organization_members ADD COLUMN responsibility_areas TEXT NOT NULL DEFAULT '[]';
