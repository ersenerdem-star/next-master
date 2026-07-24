-- H3 read-only baseline preflight.
-- This does not repair migration-history drift or alter a database. It proves
-- that the pre-H3 function shape is present before migration 004 is attempted.
begin read only;

do $h3_preflight$
declare
  v_validate_oid oid := to_regprocedure('public.validate_catalog_import(uuid)');
  v_pre_h3_oid oid := to_regprocedure('public.validate_catalog_import_pre_h3(uuid)');
  v_finalizer_oid oid := to_regprocedure('public.finalize_catalog_import(uuid)');
  v_validate_definition text;
  v_finalizer_definition text;
  v_has_quarantine_column boolean;
begin
  if v_validate_oid is null or v_finalizer_oid is null then
    raise exception 'BLOCKED: H3 preflight requires validate_catalog_import(uuid) and finalize_catalog_import(uuid)';
  end if;

  select exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'catalog_import_runs'
      and column_name = 'image_quarantined_count'
  ) into v_has_quarantine_column;

  select pg_get_functiondef(v_validate_oid), pg_get_functiondef(v_finalizer_oid)
    into v_validate_definition, v_finalizer_definition;

  if v_pre_h3_oid is not null
     or v_has_quarantine_column
     or v_validate_definition ilike '%validate_catalog_import_pre_h3%'
     or v_finalizer_definition ilike '%image_quarantined_count%'
     or v_finalizer_definition !~* 'image_url\s*=' then
    raise exception using
      message = 'BLOCKED: H3 baseline drift detected',
      detail = 'Pre-H3 baseline is absent or H3-like objects already exist. Reconcile migration history and function provenance before migration 004; do not drop, rename, or overwrite functions to proceed.';
  end if;
end;
$h3_preflight$;

select 'H3_IMPORT_IMAGE_QUARANTINE_PREFLIGHT_PASSED' as result;
rollback;
