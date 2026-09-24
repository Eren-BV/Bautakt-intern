CREATE OR REPLACE FUNCTION public.bautakt_bind(q text, p jsonb)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  out_sql text := '';
  rest text := q;
  i int;
  v jsonb;
  lit text;
  pos int;
BEGIN
  IF p IS NULL THEN
    RETURN q;
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
    pos := position('?' in rest);
    IF pos = 0 THEN
      RAISE EXCEPTION 'Zu viele Parameter für die Abfrage: %', q;
    END IF;
    out_sql := out_sql || left(rest, pos - 1) || lit;
    rest := substr(rest, pos + 1);
  END LOOP;
  IF position('?' in rest) > 0 THEN
    RAISE EXCEPTION 'Zu wenige Parameter für die Abfrage: %', q;
  END IF;
  RETURN out_sql || rest;
END;
$$;

REVOKE ALL ON FUNCTION public.bautakt_bind(text, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.bautakt_bind(text, jsonb) TO service_role;