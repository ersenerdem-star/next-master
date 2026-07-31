-- Bilstein Group source-derived enrichment.
--
-- This function only normalizes fields that are present in the provider stage
-- payload and links every row back to the exact source record. It never writes
-- catalog_products and it deliberately does not infer fitments, engine codes,
-- replacements, EAN, HS code, origin, or weight from the PartsFinder list API.

create or replace function public.enrich_bilstein_source_run(
  input_run_id uuid,
  input_organization_id uuid,
  input_apply boolean default false,
  input_limit integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_run record;
  v_source_rows integer := 0;
  v_unmatched_source_rows integer := 0;
  v_oem_rows integer := 0;
  v_attribute_rows integer := 0;
  v_inserted_oem integer := 0;
  v_inserted_attributes integer := 0;
begin
  if input_run_id is null or input_organization_id is null then
    raise exception 'input_run_id and input_organization_id are required';
  end if;

  if input_limit is not null and (input_limit < 1 or input_limit > 50000) then
    raise exception 'input_limit must be between 1 and 50000';
  end if;

  select r.*
    into v_run
  from public.catalog_import_runs r
  where r.id = input_run_id
    and r.organization_id = input_organization_id;

  if not found then
    raise exception 'Bilstein source run not found for organization';
  end if;

  if coalesce(v_run.input_scope ->> 'source', '') <> 'provider_stage_only'
     or coalesce(v_run.input_scope ->> 'provider', '') <> 'bilstein_group_partsfinder' then
    raise exception 'Run is not a Bilstein provider stage run';
  end if;

  if v_run.status not in ('staged', 'succeeded', 'finalized') then
    raise exception 'Run status % is not eligible for source enrichment', v_run.status;
  end if;

  create temporary table tmp_bilstein_source_rows (
    organization_id uuid not null,
    product_id uuid not null,
    product_code text not null,
    source_record_id uuid not null,
    source_payload jsonb not null
  ) on commit drop;

  insert into tmp_bilstein_source_rows (
    organization_id,
    product_id,
    product_code,
    source_record_id,
    source_payload
  )
  select
    s.organization_id,
    p.id,
    s.product_code,
    sr.id,
    coalesce(s.source_payload, '{}'::jsonb)
  from public.catalog_import_stage s
  join public.catalog_products p
    on p.organization_id = s.organization_id
   and p.normalized_code = s.normalized_code
  join public.catalog_product_source_records sr
    on sr.organization_id = p.organization_id
   and sr.catalog_product_id = p.id
   and sr.source_key = s.source_key
   and sr.payload_fingerprint = s.source_fingerprint
  where s.run_id = input_run_id
    and s.organization_id = input_organization_id
    and s.source_key = 'bilstein_group_partsfinder_list'
  order by s.row_index
  limit coalesce(input_limit, 2147483647);

  select count(*) into v_source_rows from tmp_bilstein_source_rows;

  select count(*)
    into v_unmatched_source_rows
  from public.catalog_import_stage s
  where s.run_id = input_run_id
    and s.organization_id = input_organization_id
    and s.source_key = 'bilstein_group_partsfinder_list'
    and not exists (
      select 1
      from tmp_bilstein_source_rows t
      where t.product_code = s.product_code
    );

  create temporary table tmp_bilstein_oem (
    organization_id uuid not null,
    product_id uuid not null,
    authority text,
    value text not null,
    source_record_id uuid not null
  ) on commit drop;

  insert into tmp_bilstein_oem (
    organization_id,
    product_id,
    authority,
    value,
    source_record_id
  )
  select distinct
    t.organization_id,
    t.product_id,
    nullif(trim(group_entry.value ->> 'make'), ''),
    trim(number_entry.value),
    t.source_record_id
  from tmp_bilstein_source_rows t
  cross join lateral jsonb_array_elements(
    coalesce(t.source_payload -> 'attributes' -> 'oeNumbers', '[]'::jsonb)
  ) group_entry(value)
  cross join lateral jsonb_array_elements_text(
    coalesce(group_entry.value -> 'numbers', '[]'::jsonb)
  ) number_entry(value)
  where nullif(trim(number_entry.value), '') is not null;

  select count(*) into v_oem_rows from tmp_bilstein_oem;

  create temporary table tmp_bilstein_attributes (
    organization_id uuid not null,
    product_id uuid not null,
    attribute_key text not null,
    label text not null,
    value_text text,
    value_numeric numeric,
    unit text,
    ordinal integer not null,
    source_record_id uuid not null
  ) on commit drop;

  insert into tmp_bilstein_attributes (
    organization_id,
    product_id,
    attribute_key,
    label,
    value_text,
    value_numeric,
    unit,
    ordinal,
    source_record_id
  )
  select
    t.organization_id,
    t.product_id,
    'bilstein_group.article_attribute.' || coalesce(nullif(trim(a.value ->> 'typeId'), ''), public.normalize_part_code(a.value ->> 'type')),
    trim(a.value ->> 'type'),
    nullif(trim(a.value ->> 'value'), ''),
    case
      when replace(trim(a.value ->> 'value'), ',', '.') ~ '^-?[0-9]+(\\.[0-9]+)?$'
      then replace(trim(a.value ->> 'value'), ',', '.')::numeric
      else null
    end,
    nullif(trim(a.value ->> 'unit'), ''),
    row_number() over (
      partition by t.product_id,
        coalesce(nullif(trim(a.value ->> 'typeId'), ''), public.normalize_part_code(a.value ->> 'type'))
      order by a.ordinality
    )::integer - 1,
    t.source_record_id
  from tmp_bilstein_source_rows t
  cross join lateral jsonb_array_elements(
    coalesce(t.source_payload -> 'attributes' -> 'articleAttributes', '[]'::jsonb)
  ) with ordinality a(value, ordinality)
  where nullif(trim(a.value ->> 'type'), '') is not null
    and nullif(trim(a.value ->> 'value'), '') is not null;

  insert into tmp_bilstein_attributes (
    organization_id, product_id, attribute_key, label, value_text,
    value_numeric, unit, ordinal, source_record_id
  )
  select organization_id, product_id, 'bilstein_group.fitting_side',
         'Fitting side', nullif(trim(source_payload -> 'attributes' ->> 'fittingSide'), ''),
         null, null, 0, source_record_id
  from tmp_bilstein_source_rows
  where nullif(trim(source_payload -> 'attributes' ->> 'fittingSide'), '') is not null;

  insert into tmp_bilstein_attributes (
    organization_id, product_id, attribute_key, label, value_text,
    value_numeric, unit, ordinal, source_record_id
  )
  select organization_id, product_id, 'bilstein_group.packaging_quantity',
         'Packaging quantity', null, (source_payload -> 'attributes' ->> 'packagingQty')::numeric,
         null, 0, source_record_id
  from tmp_bilstein_source_rows
  where (source_payload -> 'attributes' ->> 'packagingQty') ~ '^[0-9]+(\\.[0-9]+)?$';

  insert into tmp_bilstein_attributes (
    organization_id, product_id, attribute_key, label, value_text,
    value_numeric, unit, ordinal, source_record_id
  )
  select organization_id, product_id, 'bilstein_group.additional_description',
         'Additional description', nullif(trim(source_payload -> 'attributes' ->> 'additionalDescription'), ''),
         null, null, 0, source_record_id
  from tmp_bilstein_source_rows
  where nullif(trim(source_payload -> 'attributes' ->> 'additionalDescription'), '') is not null;

  insert into tmp_bilstein_attributes (
    organization_id, product_id, attribute_key, label, value_text,
    value_numeric, unit, ordinal, source_record_id
  )
  select organization_id, product_id, 'bilstein_group.vehicle_type',
         'Provider vehicle type', nullif(trim(source_payload -> 'attributes' ->> 'vehicleType'), ''),
         null, null, 0, source_record_id
  from tmp_bilstein_source_rows
  where nullif(trim(source_payload -> 'attributes' ->> 'vehicleType'), '') is not null;

  insert into tmp_bilstein_attributes (
    organization_id, product_id, attribute_key, label, value_text,
    value_numeric, unit, ordinal, source_record_id
  )
  select organization_id, product_id, 'bilstein_group.master_id',
         'Provider master ID', null, (source_payload -> 'attributes' ->> 'masterId')::numeric,
         null, 0, source_record_id
  from tmp_bilstein_source_rows
  where (source_payload -> 'attributes' ->> 'masterId') ~ '^[0-9]+$';

  select count(*) into v_attribute_rows from tmp_bilstein_attributes;

  if input_apply then
    insert into public.catalog_product_identifiers (
      organization_id, catalog_product_id, identifier_type, authority, value, source_record_id
    )
    select organization_id, product_id, 'oem', authority, value, source_record_id
    from tmp_bilstein_oem
    on conflict (
      organization_id, catalog_product_id, identifier_type,
      coalesce(authority, ''), normalized_value
    ) do nothing;
    get diagnostics v_inserted_oem = row_count;

    insert into public.catalog_product_attributes (
      organization_id, catalog_product_id, attribute_key, label, value_text,
      value_numeric, unit, ordinal, source_record_id
    )
    select organization_id, product_id, attribute_key, label, value_text,
           value_numeric, unit, ordinal, source_record_id
    from tmp_bilstein_attributes
    on conflict (organization_id, catalog_product_id, attribute_key, ordinal)
    do update set
      label = excluded.label,
      value_text = excluded.value_text,
      value_numeric = excluded.value_numeric,
      unit = excluded.unit,
      source_record_id = excluded.source_record_id;
    get diagnostics v_inserted_attributes = row_count;
  end if;

  return jsonb_build_object(
    'run_id', input_run_id,
    'organization_id', input_organization_id,
    'mode', case when input_apply then 'apply' else 'dry_run' end,
    'source_rows', v_source_rows,
    'unmatched_source_rows', v_unmatched_source_rows,
    'oem_rows', v_oem_rows,
    'attribute_rows', v_attribute_rows,
    'inserted_oem', v_inserted_oem,
    'inserted_attributes', v_inserted_attributes,
    'not_inferred', jsonb_build_array('vehicle_fitments', 'engine_codes', 'replacement_relations', 'ean', 'hs_code', 'origin', 'weight')
  );
end;
$$;

revoke all on function public.enrich_bilstein_source_run(uuid, uuid, boolean, integer) from public, anon, authenticated;
grant execute on function public.enrich_bilstein_source_run(uuid, uuid, boolean, integer) to service_role;

comment on function public.enrich_bilstein_source_run(uuid, uuid, boolean, integer) is
  'Idempotently normalizes OEM and provider technical attributes from an exact Bilstein provider stage run; never writes catalog_products or infers unavailable fitment fields.';
