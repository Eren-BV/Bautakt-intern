-- Eigenes Schema für die Bautakt-Anwendung. Die App verwaltet Benutzer, Sitzungen und
-- Mandanten selbst; der Zugriff erfolgt ausschließlich serverseitig über service_role.
CREATE SCHEMA IF NOT EXISTS bautakt;

REVOKE ALL ON SCHEMA bautakt FROM PUBLIC;
GRANT USAGE ON SCHEMA bautakt TO service_role;

-- Ersetzt die Platzhalter ? der Reihe nach durch korrekt gequotete Literale.
CREATE OR REPLACE FUNCTION public.bautakt_bind(q text, p jsonb)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  stmt text := q;
  i int;
  v jsonb;
  lit text;
  pos int;
BEGIN
  IF p IS NULL THEN
    RETURN stmt;
  END IF;
  FOR i IN 0 .. COALESCE(jsonb_array_length(p), 0) - 1 LOOP
    v := p -> i;
    IF v IS NULL OR jsonb_typeof(v) = 'null' THEN
      lit := 'NULL';
    ELSIF jsonb_typeof(v) = 'number' THEN
      lit := v #>> '{}';
    ELSIF jsonb_typeof(v) = 'boolean' THEN
      lit := CASE WHEN (v #>> '{}') = 'true' THEN '1' ELSE '0' END;
    ELSE
      lit := quote_literal(v #>> '{}');
    END IF;
    pos := position('?' in stmt);
    IF pos = 0 THEN
      RAISE EXCEPTION 'Zu viele Parameter für die Abfrage: %', q;
    END IF;
    stmt := left(stmt, pos - 1) || lit || substr(stmt, pos + 1);
  END LOOP;
  IF position('?' in stmt) > 0 THEN
    RAISE EXCEPTION 'Zu wenige Parameter für die Abfrage: %', q;
  END IF;
  RETURN stmt;
END;
$$;

-- SELECT: liefert alle Zeilen als JSON-Array.
CREATE OR REPLACE FUNCTION public.bautakt_query(q text, p jsonb DEFAULT '[]'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = bautakt, public
AS $$
DECLARE
  stmt text := public.bautakt_bind(q, p);
  res jsonb;
BEGIN
  EXECUTE 'SELECT COALESCE(jsonb_agg(row_to_json(t)), ''[]''::jsonb) FROM (' || stmt || ') t'
    INTO res;
  RETURN res;
END;
$$;

-- INSERT/UPDATE/DELETE: liefert die Anzahl betroffener Zeilen.
CREATE OR REPLACE FUNCTION public.bautakt_exec(q text, p jsonb DEFAULT '[]'::jsonb)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = bautakt, public
AS $$
DECLARE
  stmt text := public.bautakt_bind(q, p);
  n integer;
BEGIN
  EXECUTE stmt;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

-- Mehrere Anweisungen (Schema-Migrationen) in einer Transaktion.
CREATE OR REPLACE FUNCTION public.bautakt_script(q text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = bautakt, public
AS $$
BEGIN
  EXECUTE q;
END;
$$;

REVOKE ALL ON FUNCTION public.bautakt_bind(text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.bautakt_query(text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.bautakt_exec(text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.bautakt_script(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bautakt_query(text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.bautakt_exec(text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.bautakt_script(text) TO service_role;