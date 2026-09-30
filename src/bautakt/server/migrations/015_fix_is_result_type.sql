-- Korrektur zu 013_assignments.sql: is_result wurde als natives Postgres BOOLEAN angelegt.
-- Db.insert()/Db.update() wandeln JS-Booleans aber immer in 0/1 (INTEGER) um (siehe toSql()
-- in db.ts) - Konvention, die auch is_default/is_critical/enabled u. a. befolgen. Ein Insert
-- mit is_result: true/false schlug dadurch mit einem Typkonflikt fehl.

ALTER TABLE attachments ALTER COLUMN is_result DROP DEFAULT;
ALTER TABLE attachments ALTER COLUMN is_result TYPE INTEGER USING (CASE WHEN is_result THEN 1 ELSE 0 END);
ALTER TABLE attachments ALTER COLUMN is_result SET DEFAULT 0;
