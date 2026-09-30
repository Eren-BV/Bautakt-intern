-- Herkunft eines von der KI erstellten Vorgangs: das wörtliche Zitat aus dem diktierten/
-- eingegebenen Text, aus dem dieser Vorgang abgeleitet wurde - sichtbar im Vorgang, damit
-- nachvollziehbar bleibt, welcher Abschnitt der Vorlage zu welchem Vorgang geführt hat.

ALTER TABLE tasks ADD COLUMN source_excerpt TEXT;
