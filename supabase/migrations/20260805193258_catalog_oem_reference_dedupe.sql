-- Keep OEM references deterministic and duplicate-free when an import is finalized.
-- The comparison key ignores spaces, punctuation, and case, while the stored
-- value preserves the first readable spelling that was observed.
create or replace function public.merge_catalog_oem_numbers(
  input_existing text,
  input_incoming text
)
returns text
language sql
immutable
set search_path = public
as $$
  with source_values as (
    select
      1 as source_priority,
      parts.ordinality::integer as ordinal,
      btrim(parts.value) as value
    from regexp_split_to_table(
      coalesce(input_existing, ''),
      E'[|,;\r\n]+'
    ) with ordinality as parts(value, ordinality)

    union all

    select
      2 as source_priority,
      parts.ordinality::integer as ordinal,
      btrim(parts.value) as value
    from regexp_split_to_table(
      coalesce(input_incoming, ''),
      E'[|,;\r\n]+'
    ) with ordinality as parts(value, ordinality)
  ), prepared as (
    select
      source_priority,
      ordinal,
      value,
      upper(regexp_replace(value, '[^A-Za-z0-9]+', '', 'g')) as dedupe_key
    from source_values
    where value <> ''
  ), distinct_values as (
    select distinct on (dedupe_key)
      source_priority,
      ordinal,
      value
    from prepared
    where dedupe_key <> ''
    order by dedupe_key, source_priority, ordinal
  )
  select nullif(
    string_agg(value, ' | ' order by source_priority, ordinal),
    ''
  )
  from distinct_values;
$$;

-- The existing canonical finalizer remains the authority for applying a run.
-- Before it runs, normalize every staged OEM value for a product to the union
-- of the current catalog value and all incoming values in this run. This means
-- repeated rows in one upload and repeated uploads are both idempotent.
create or replace function public.finalize_catalog_import(input_run_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
set statement_timeout = '300s'
as $$
declare
  v_result jsonb;
  v_org_id uuid := public.current_profile_org_id();
  v_oem_stage_rows integer := 0;
begin
  with grouped as (
    select
      public.normalize_catalog_brand_key(s.brand) as brand_key,
      s.normalized_code,
      max(cp.oem_no) as existing_oem_no,
      string_agg(
        nullif(btrim(s.oem_no), ''),
        ' | '
        order by s.created_at asc, s.row_index asc
      ) as incoming_oem_no
    from public.catalog_import_stage s
    left join public.brands b
      on b.organization_id = v_org_id
     and public.normalize_catalog_brand_key(b.name) = public.normalize_catalog_brand_key(s.brand)
    left join public.catalog_products cp
      on cp.organization_id = v_org_id
     and cp.brand_id = b.id
     and cp.normalized_code = s.normalized_code
    where s.run_id = input_run_id
      and s.organization_id = v_org_id
      and s.validation_status = 'valid'
      and s.proposed_action in ('insert', 'update')
      and nullif(btrim(s.oem_no), '') is not null
    group by public.normalize_catalog_brand_key(s.brand), s.normalized_code
  ), normalized_stage as (
    update public.catalog_import_stage s
    set oem_no = public.merge_catalog_oem_numbers(
      grouped.existing_oem_no,
      grouped.incoming_oem_no
    )
    from grouped
    where s.run_id = input_run_id
      and s.organization_id = v_org_id
      and s.validation_status = 'valid'
      and s.proposed_action in ('insert', 'update')
      and nullif(btrim(s.oem_no), '') is not null
      and public.normalize_catalog_brand_key(s.brand) = grouped.brand_key
      and s.normalized_code = grouped.normalized_code
    returning s.row_index
  )
  select count(*)::integer into v_oem_stage_rows from normalized_stage;

  v_result := public.finalize_catalog_import_pre_description_tr(input_run_id);

  return v_result || jsonb_build_object(
    'oem_stage_rows_normalized', v_oem_stage_rows
  );
end;
$$;

revoke all on function public.merge_catalog_oem_numbers(text, text)
  from public, anon, authenticated, service_role;
revoke all on function public.finalize_catalog_import(uuid) from public, anon;
grant execute on function public.finalize_catalog_import(uuid) to authenticated;
grant execute on function public.finalize_catalog_import(uuid) to service_role;
