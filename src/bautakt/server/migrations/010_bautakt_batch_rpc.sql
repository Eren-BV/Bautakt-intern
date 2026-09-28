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
    results := results || to_jsonb(n);
  END LOOP;
  RETURN results;
END;
$$;

REVOKE ALL ON FUNCTION public.bautakt_batch(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bautakt_batch(jsonb) TO service_role;
