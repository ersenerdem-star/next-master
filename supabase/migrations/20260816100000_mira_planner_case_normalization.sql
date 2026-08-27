-- Keep autonomous planner brand matching case-insensitive.
-- The planner function was corrected in production after the initial canary
-- exposed a normalization bug; this migration records that correction durably.
DO $do$
DECLARE
  v_definition text;
  v_updated text;
  v_old text := $needle$lower(regexp_replace(brand.name, '[^a-z0-9]+', '', 'g'))$needle$;
  v_new text := $replacement$lower(regexp_replace(lower(brand.name), '[^a-z0-9]+', '', 'g'))$replacement$;
BEGIN
  SELECT pg_get_functiondef(
    'public.plan_mira_catalog_missions(uuid,uuid,integer)'::regprocedure
  )
  INTO v_definition;

  -- Idempotent: the live function may already contain the corrected form.
  IF position(v_old IN v_definition) = 0 THEN
    RETURN;
  END IF;

  v_updated := replace(v_definition, v_old, v_new);
  IF v_updated = v_definition THEN
    RAISE EXCEPTION 'MIRA planner brand normalization patch did not match';
  END IF;

  EXECUTE v_updated;
END
$do$;
