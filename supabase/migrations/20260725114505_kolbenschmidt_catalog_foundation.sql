-- NM-CATALOG-KOLBENSCHMIDT-ONBOARDING
-- Official-source catalog foundation for Kolbenschmidt and future brands.
-- This migration is source/runtime preparation only; it does not insert a brand
-- or product row and does not apply any external-source data.
-- Production migration record: 20260725114505_kolbenschmidt_catalog_foundation.

alter table public.catalog_products
  add column if not exists vehicle_model text;

revoke update on table public.catalog_products from authenticated;

grant update (
  brand_id,
  product_code,
  ean,
  description,
  oem_no,
  vehicle,
  vehicle_model,
  hs_code,
  origin,
  market_segment,
  weight_kg,
  lifecycle_status,
  lifecycle_note,
  updated_at
) on table public.catalog_products to authenticated;

create unique index if not exists uq_catalog_products_id_organization
  on public.catalog_products (id, organization_id);

create table if not exists public.catalog_product_source_records (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  catalog_product_id uuid not null,
  source_key text not null,
  source_url text not null,
  source_product_id text,
  source_version text,
  source_product_type text,
  source_as_of date,
  retrieved_at timestamptz not null default now(),
  payload_fingerprint text not null,
  created_at timestamptz not null default now(),
  constraint catalog_product_source_records_product_org_fk
    foreign key (catalog_product_id, organization_id)
    references public.catalog_products(id, organization_id)
    on delete cascade,
  constraint catalog_product_source_records_source_url_check
    check (source_url ~* '^https://'),
  constraint catalog_product_source_records_fingerprint_check
    check (payload_fingerprint ~ '^[0-9a-fA-F]{64}$'),
  unique (organization_id, catalog_product_id, source_key, payload_fingerprint)
);

create index if not exists idx_catalog_product_source_records_product
  on public.catalog_product_source_records (organization_id, catalog_product_id, retrieved_at desc);

create unique index if not exists uq_catalog_product_source_records_id_org
  on public.catalog_product_source_records (id, organization_id);

create table if not exists public.catalog_product_identifiers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  catalog_product_id uuid not null,
  identifier_type text not null,
  authority text,
  value text not null,
  normalized_value text generated always as (public.normalize_part_code(value)) stored,
  source_record_id uuid,
  created_at timestamptz not null default now(),
  constraint catalog_product_identifiers_product_org_fk
    foreign key (catalog_product_id, organization_id)
    references public.catalog_products(id, organization_id)
    on delete cascade,
  constraint catalog_product_identifiers_source_org_fk
    foreign key (source_record_id, organization_id)
    references public.catalog_product_source_records(id, organization_id)
    on delete cascade,
  constraint catalog_product_identifiers_type_check
    check (identifier_type in ('ean', 'oem', 'manufacturer_reference', 'casting_number', 'old_code', 'other'))
);

create unique index if not exists uq_catalog_product_identifiers_identity
  on public.catalog_product_identifiers (
    organization_id,
    catalog_product_id,
    identifier_type,
    coalesce(authority, ''),
    normalized_value
  );

create index if not exists idx_catalog_product_identifiers_lookup
  on public.catalog_product_identifiers (organization_id, identifier_type, normalized_value);

create table if not exists public.catalog_product_fitments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  catalog_product_id uuid not null,
  manufacturer text,
  model_series text,
  vehicle text,
  model_year_from text,
  model_year_to text,
  engine_code text,
  fuel_type text,
  power_kw_min numeric,
  power_kw_max numeric,
  power_ps_min numeric,
  power_ps_max numeric,
  source_record_id uuid,
  fitment_fingerprint text not null,
  created_at timestamptz not null default now(),
  constraint catalog_product_fitments_product_org_fk
    foreign key (catalog_product_id, organization_id)
    references public.catalog_products(id, organization_id)
    on delete cascade,
  constraint catalog_product_fitments_source_org_fk
    foreign key (source_record_id, organization_id)
    references public.catalog_product_source_records(id, organization_id)
    on delete cascade,
  constraint catalog_product_fitments_fingerprint_check
    check (fitment_fingerprint ~ '^[0-9a-fA-F]{64}$'),
  unique (organization_id, catalog_product_id, fitment_fingerprint)
);

create index if not exists idx_catalog_product_fitments_product
  on public.catalog_product_fitments (organization_id, catalog_product_id);

create index if not exists idx_catalog_product_fitments_vehicle
  on public.catalog_product_fitments (organization_id, manufacturer, vehicle, model_series);

create table if not exists public.catalog_product_relations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  catalog_product_id uuid not null,
  relation_type text not null,
  related_brand text,
  related_product_code text,
  related_oem_no text,
  related_description text,
  source_record_id uuid,
  relation_fingerprint text not null,
  created_at timestamptz not null default now(),
  constraint catalog_product_relations_product_org_fk
    foreign key (catalog_product_id, organization_id)
    references public.catalog_products(id, organization_id)
    on delete cascade,
  constraint catalog_product_relations_source_org_fk
    foreign key (source_record_id, organization_id)
    references public.catalog_product_source_records(id, organization_id)
    on delete cascade,
  constraint catalog_product_relations_type_check
    check (relation_type in ('replacement', 'replaced_by', 'alternative', 'kit_component', 'recommended_tool', 'related')),
  constraint catalog_product_relations_fingerprint_check
    check (relation_fingerprint ~ '^[0-9a-fA-F]{64}$'),
  unique (organization_id, catalog_product_id, relation_fingerprint)
);

create index if not exists idx_catalog_product_relations_product
  on public.catalog_product_relations (organization_id, catalog_product_id, relation_type);

create table if not exists public.catalog_product_attributes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  catalog_product_id uuid not null,
  attribute_key text not null,
  label text not null,
  value_text text,
  value_numeric numeric,
  unit text,
  ordinal integer not null default 0,
  source_record_id uuid,
  created_at timestamptz not null default now(),
  constraint catalog_product_attributes_product_org_fk
    foreign key (catalog_product_id, organization_id)
    references public.catalog_products(id, organization_id)
    on delete cascade,
  constraint catalog_product_attributes_source_org_fk
    foreign key (source_record_id, organization_id)
    references public.catalog_product_source_records(id, organization_id)
    on delete cascade,
  constraint catalog_product_attributes_value_check
    check (value_text is not null or value_numeric is not null),
  unique (organization_id, catalog_product_id, attribute_key, ordinal)
);

create index if not exists idx_catalog_product_attributes_product
  on public.catalog_product_attributes (organization_id, catalog_product_id, attribute_key);

alter table public.catalog_product_source_records enable row level security;
alter table public.catalog_product_identifiers enable row level security;
alter table public.catalog_product_fitments enable row level security;
alter table public.catalog_product_relations enable row level security;
alter table public.catalog_product_attributes enable row level security;

drop policy if exists catalog_product_source_records_select_own_org on public.catalog_product_source_records;
create policy catalog_product_source_records_select_own_org
  on public.catalog_product_source_records
  for select
  using (organization_id = public.current_profile_org_id());

drop policy if exists catalog_product_source_records_insert_admin on public.catalog_product_source_records;
create policy catalog_product_source_records_insert_admin
  on public.catalog_product_source_records
  for insert
  with check (public.is_admin() and organization_id = public.current_profile_org_id());

drop policy if exists catalog_product_identifiers_select_own_org on public.catalog_product_identifiers;
create policy catalog_product_identifiers_select_own_org
  on public.catalog_product_identifiers
  for select
  using (organization_id = public.current_profile_org_id());

drop policy if exists catalog_product_identifiers_insert_admin on public.catalog_product_identifiers;
create policy catalog_product_identifiers_insert_admin
  on public.catalog_product_identifiers
  for insert
  with check (public.is_admin() and organization_id = public.current_profile_org_id());

drop policy if exists catalog_product_fitments_select_own_org on public.catalog_product_fitments;
create policy catalog_product_fitments_select_own_org
  on public.catalog_product_fitments
  for select
  using (organization_id = public.current_profile_org_id());

drop policy if exists catalog_product_fitments_insert_admin on public.catalog_product_fitments;
create policy catalog_product_fitments_insert_admin
  on public.catalog_product_fitments
  for insert
  with check (public.is_admin() and organization_id = public.current_profile_org_id());

drop policy if exists catalog_product_relations_select_own_org on public.catalog_product_relations;
create policy catalog_product_relations_select_own_org
  on public.catalog_product_relations
  for select
  using (organization_id = public.current_profile_org_id());

drop policy if exists catalog_product_relations_insert_admin on public.catalog_product_relations;
create policy catalog_product_relations_insert_admin
  on public.catalog_product_relations
  for insert
  with check (public.is_admin() and organization_id = public.current_profile_org_id());

drop policy if exists catalog_product_attributes_select_own_org on public.catalog_product_attributes;
create policy catalog_product_attributes_select_own_org
  on public.catalog_product_attributes
  for select
  using (organization_id = public.current_profile_org_id());

drop policy if exists catalog_product_attributes_insert_admin on public.catalog_product_attributes;
create policy catalog_product_attributes_insert_admin
  on public.catalog_product_attributes
  for insert
  with check (public.is_admin() and organization_id = public.current_profile_org_id());

revoke all on public.catalog_product_source_records,
  public.catalog_product_identifiers,
  public.catalog_product_fitments,
  public.catalog_product_relations,
  public.catalog_product_attributes
  from public, anon;

grant select, insert on public.catalog_product_source_records,
  public.catalog_product_identifiers,
  public.catalog_product_fitments,
  public.catalog_product_relations,
  public.catalog_product_attributes
  to authenticated;

grant select, insert on public.catalog_product_source_records,
  public.catalog_product_identifiers,
  public.catalog_product_fitments,
  public.catalog_product_relations,
  public.catalog_product_attributes
  to service_role;

comment on table public.catalog_product_source_records is
  'Append-only official-source provenance for catalog enrichment; raw payloads and credentials are intentionally not stored.';

comment on table public.catalog_product_fitments is
  'One row per source-supported vehicle/engine fitment; do not flatten large fitment sets into catalog_products.vehicle.';

comment on table public.catalog_product_relations is
  'One row per replacement, alternative, component, tool, or related-product relation.';

comment on table public.catalog_product_attributes is
  'Structured product specifications such as piston dimensions and ring/material descriptors.';

alter table public.catalog_import_stage
  add column if not exists ean text,
  add column if not exists vehicle text,
  add column if not exists vehicle_model text,
  add column if not exists market_segment text,
  add column if not exists product_type text,
  add column if not exists source_url text,
  add column if not exists source_as_of date,
  add column if not exists source_retrieved_at timestamptz,
  add column if not exists source_fingerprint text;

create index if not exists idx_catalog_import_stage_run_source
  on public.catalog_import_stage (run_id, source_fingerprint)
  where source_fingerprint is not null and source_fingerprint <> '';

alter function public.stage_catalog_import_chunk(uuid, jsonb)
  rename to stage_catalog_import_chunk_pre_kolbenschmidt;

create or replace function public.stage_catalog_import_chunk(
  input_run_id uuid,
  payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_result jsonb;
  v_org_id uuid := public.current_profile_org_id();
begin
  v_result := public.stage_catalog_import_chunk_pre_kolbenschmidt(input_run_id, payload);

  update public.catalog_import_stage s
  set ean = nullif(trim(coalesce(p.ean, '')), ''),
      vehicle = nullif(trim(coalesce(p.vehicle, '')), ''),
      vehicle_model = nullif(trim(coalesce(p.vehicle_model, '')), ''),
      market_segment = public.normalize_catalog_market_segment(p.market_segment),
      product_type = nullif(trim(coalesce(p.product_type, '')), ''),
      source_url = nullif(trim(coalesce(p.source_url, '')), ''),
      source_as_of = case
        when p.source_as_of ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then p.source_as_of::date
        else null
      end,
      source_retrieved_at = case
        when p.source_retrieved_at ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' then p.source_retrieved_at::timestamptz
        else null
      end,
      source_fingerprint = nullif(lower(trim(coalesce(p.source_fingerprint, ''))), '')
  from (
    select
      case
        when nullif(trim(coalesce(item.value->>'row_index', '')), '') ~ '^[0-9]+$'
          then (item.value->>'row_index')::integer
        else null
      end as row_index,
      item.value->>'ean' as ean,
      item.value->>'vehicle' as vehicle,
      item.value->>'vehicle_model' as vehicle_model,
      item.value->>'market_segment' as market_segment,
      item.value->>'product_type' as product_type,
      item.value->>'source_url' as source_url,
      item.value->>'source_as_of' as source_as_of,
      item.value->>'source_retrieved_at' as source_retrieved_at,
      item.value->>'source_fingerprint' as source_fingerprint
    from jsonb_array_elements(coalesce(payload, '[]'::jsonb)) with ordinality as item(value, ordinality)
  ) p
  where s.run_id = input_run_id
    and s.organization_id = v_org_id
    and p.row_index = s.row_index;

  return v_result;
end;
$$;

revoke all on function public.stage_catalog_import_chunk_pre_kolbenschmidt(uuid, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.stage_catalog_import_chunk(uuid, jsonb) to authenticated;

alter function public.validate_catalog_import(uuid)
  rename to validate_catalog_import_pre_kolbenschmidt;

create or replace function public.validate_catalog_import(input_run_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_result jsonb;
  v_org_id uuid := public.current_profile_org_id();
  v_total integer := 0;
  v_insert integer := 0;
  v_update integer := 0;
  v_skip integer := 0;
  v_error integer := 0;
  v_duplicate integer := 0;
  v_source_invalid integer := 0;
begin
  v_result := public.validate_catalog_import_pre_kolbenschmidt(input_run_id);

  with compared as (
    select
      s.id,
      s.proposed_action,
      array_remove(array[
        case when s.ean is not null and cp.ean is distinct from s.ean then 'ean' end,
        case when s.vehicle is not null and cp.vehicle is distinct from s.vehicle then 'vehicle' end,
        case when s.vehicle_model is not null and cp.vehicle_model is distinct from s.vehicle_model then 'vehicle_model' end,
        case when s.market_segment is not null and cp.market_segment is distinct from public.normalize_catalog_market_segment(s.market_segment) then 'market_segment' end,
        case when s.source_url is not null and s.source_url !~* '^https://' then 'source_url' end,
        case when s.source_fingerprint is not null and s.source_fingerprint !~ '^[0-9a-fA-F]{64}$' then 'source_fingerprint' end
      ], null)::text[] as extra_changed_fields
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
  )
  update public.catalog_import_stage s
  set validation_status = case
        when c.extra_changed_fields @> array['source_url']::text[]
          or c.extra_changed_fields @> array['source_fingerprint']::text[]
          then 'error'
        else s.validation_status
      end,
      validation_message = case
        when c.extra_changed_fields @> array['source_url']::text[] then 'Source URL must use HTTPS'
        when c.extra_changed_fields @> array['source_fingerprint']::text[] then 'Source fingerprint must be a SHA-256 hex digest'
        else s.validation_message
      end,
      proposed_action = case
        when s.validation_status = 'error'
          or c.extra_changed_fields @> array['source_url']::text[]
          or c.extra_changed_fields @> array['source_fingerprint']::text[]
          then 'error'
        when cardinality(c.extra_changed_fields) > 0 and s.proposed_action in ('skip', 'update') then 'update'
        else s.proposed_action
      end,
      conflict_summary = jsonb_set(
        jsonb_set(
          coalesce(s.conflict_summary, '{}'::jsonb),
          '{changed_fields}',
          coalesce(s.conflict_summary->'changed_fields', '[]'::jsonb) || to_jsonb(c.extra_changed_fields),
          true
        ),
        '{source_fields_present}',
        to_jsonb(
          s.source_url is not null
          or s.source_as_of is not null
          or s.source_retrieved_at is not null
          or s.source_fingerprint is not null
        ),
        true
      )
  from compared c
  where s.id = c.id;

  select
    count(*)::integer,
    count(*) filter (where proposed_action = 'insert')::integer,
    count(*) filter (where proposed_action = 'update')::integer,
    count(*) filter (where proposed_action = 'skip')::integer,
    count(*) filter (where validation_status = 'error')::integer,
    count(*) filter (where coalesce((conflict_summary->>'duplicate_in_run')::boolean, false))::integer,
    count(*) filter (where source_url is not null and source_fingerprint is not null)::integer
  into v_total, v_insert, v_update, v_skip, v_error, v_duplicate, v_source_invalid
  from public.catalog_import_stage
  where run_id = input_run_id
    and organization_id = v_org_id;

  update public.catalog_import_runs
  set status = case when v_error > 0 then 'validation_failed' else status end,
      finished_at = case when v_error > 0 then now() else finished_at end,
      error_message = case when v_error > 0 then 'Catalog import validation failed' else error_message end,
      staged_rows = v_total,
      valid_rows = greatest(v_total - v_error, 0),
      error_rows = v_error,
      duplicate_rows = v_duplicate,
      insert_rows = v_insert,
      update_rows = v_update,
      skip_rows = v_skip,
      processed_rows = v_total
  where id = input_run_id
    and organization_id = v_org_id;

  return v_result || jsonb_build_object(
    'status', case when v_error > 0 then 'validation_failed' else 'validated' end,
    'total_count', v_total,
    'insert_count', v_insert,
    'update_count', v_update,
    'skip_count', v_skip,
    'error_count', v_error,
    'source_rows', v_source_invalid
  );
end;
$$;

revoke all on function public.validate_catalog_import_pre_kolbenschmidt(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.validate_catalog_import(uuid) to authenticated;

alter function public.finalize_catalog_import(uuid)
  rename to finalize_catalog_import_pre_kolbenschmidt;

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
  v_enrichment_updated integer := 0;
  v_source_inserted integer := 0;
  v_identifier_inserted integer := 0;
  v_declared_updates integer := 0;
begin
  v_result := public.finalize_catalog_import_pre_kolbenschmidt(input_run_id);

  with staged_products as (
    select
      s.*,
      cp.id as catalog_product_id
    from public.catalog_import_stage s
    join public.brands b
      on b.organization_id = v_org_id
     and public.normalize_catalog_brand_key(b.name) = public.normalize_catalog_brand_key(s.brand)
    join public.catalog_products cp
      on cp.organization_id = v_org_id
     and cp.brand_id = b.id
     and cp.normalized_code = s.normalized_code
    where s.run_id = input_run_id
      and s.organization_id = v_org_id
      and s.validation_status = 'valid'
      and s.proposed_action in ('insert', 'update')
  ),
  updated as (
    update public.catalog_products cp
    set ean = coalesce(sp.ean, cp.ean),
        vehicle = coalesce(sp.vehicle, cp.vehicle),
        vehicle_model = coalesce(sp.vehicle_model, cp.vehicle_model),
        market_segment = coalesce(public.normalize_catalog_market_segment(sp.market_segment), cp.market_segment),
        updated_at = now()
    from staged_products sp
    where cp.id = sp.catalog_product_id
      and (
        (sp.ean is not null and cp.ean is distinct from sp.ean)
        or (sp.vehicle is not null and cp.vehicle is distinct from sp.vehicle)
        or (sp.vehicle_model is not null and cp.vehicle_model is distinct from sp.vehicle_model)
        or (
          sp.market_segment is not null
          and cp.market_segment is distinct from public.normalize_catalog_market_segment(sp.market_segment)
        )
      )
    returning cp.id
  )
  select count(*)::integer into v_enrichment_updated from updated;

  with source_rows as (
    select distinct on (s.row_index)
      s.*,
      cp.id as catalog_product_id
    from public.catalog_import_stage s
    join public.brands b
      on b.organization_id = v_org_id
     and public.normalize_catalog_brand_key(b.name) = public.normalize_catalog_brand_key(s.brand)
    join public.catalog_products cp
      on cp.organization_id = v_org_id
     and cp.brand_id = b.id
     and cp.normalized_code = s.normalized_code
    where s.run_id = input_run_id
      and s.organization_id = v_org_id
      and s.validation_status = 'valid'
      and s.source_url is not null
      and s.source_fingerprint is not null
      and s.source_url ~* '^https://'
      and s.source_fingerprint ~ '^[0-9a-fA-F]{64}$'
    order by s.row_index, s.created_at desc
  ),
  inserted as (
    insert into public.catalog_product_source_records (
      organization_id,
      catalog_product_id,
      source_key,
      source_url,
      source_product_id,
      source_version,
      source_product_type,
      source_as_of,
      retrieved_at,
      payload_fingerprint
    )
    select
      v_org_id,
      sr.catalog_product_id,
      'motorservice-msicd',
      sr.source_url,
      sr.product_code,
      null,
      sr.product_type,
      sr.source_as_of,
      coalesce(sr.source_retrieved_at, now()),
      lower(sr.source_fingerprint)
    from source_rows sr
    on conflict (organization_id, catalog_product_id, source_key, payload_fingerprint) do nothing
    returning id, catalog_product_id
  )
  select count(*)::integer into v_source_inserted from inserted;

  with source_rows as (
    select distinct on (s.row_index)
      s.*,
      cp.id as catalog_product_id,
      (
        select sr.id
        from public.catalog_product_source_records sr
        where sr.organization_id = v_org_id
          and sr.catalog_product_id = cp.id
          and sr.source_key = 'motorservice-msicd'
          and sr.payload_fingerprint = lower(s.source_fingerprint)
        order by sr.created_at desc
        limit 1
      ) as source_record_id
    from public.catalog_import_stage s
    join public.brands b
      on b.organization_id = v_org_id
     and public.normalize_catalog_brand_key(b.name) = public.normalize_catalog_brand_key(s.brand)
    join public.catalog_products cp
      on cp.organization_id = v_org_id
     and cp.brand_id = b.id
     and cp.normalized_code = s.normalized_code
    where s.run_id = input_run_id
      and s.organization_id = v_org_id
      and s.validation_status = 'valid'
  ),
  ean_rows as (
    select
      sr.organization_id,
      sr.catalog_product_id,
      'ean'::text as identifier_type,
      'Motorservice MSICD'::text as authority,
      sr.ean as value,
      sr.source_record_id
    from source_rows sr
    where nullif(trim(coalesce(sr.ean, '')), '') is not null
  ),
  oem_rows as (
    select
      sr.organization_id,
      sr.catalog_product_id,
      'oem'::text as identifier_type,
      'Motorservice MSICD'::text as authority,
      nullif(trim(value), '') as value,
      sr.source_record_id
    from source_rows sr
    cross join lateral regexp_split_to_table(coalesce(sr.oem_no, ''), '\s*[,;]\s*') as split(value)
    where nullif(trim(value), '') is not null
  ),
  inserted as (
    insert into public.catalog_product_identifiers (
      organization_id,
      catalog_product_id,
      identifier_type,
      authority,
      value,
      source_record_id
    )
    select organization_id, catalog_product_id, identifier_type, authority, value, source_record_id from ean_rows
    union all
    select organization_id, catalog_product_id, identifier_type, authority, value, source_record_id from oem_rows
    on conflict do nothing
    returning 1
  )
  select count(*)::integer into v_identifier_inserted from inserted;

  select count(*)::integer
  into v_declared_updates
  from public.catalog_import_stage
  where run_id = input_run_id
    and organization_id = v_org_id
    and proposed_action = 'update'
    and validation_status = 'valid';

  update public.catalog_import_runs
  set updated_count = greatest(updated_count, v_declared_updates),
      update_rows = greatest(update_rows, v_declared_updates)
  where id = input_run_id
    and organization_id = v_org_id;

  return v_result || jsonb_build_object(
    'enrichment_updated_count', v_enrichment_updated,
    'source_records_inserted', v_source_inserted,
    'identifiers_inserted', v_identifier_inserted
  );
end;
$$;

revoke all on function public.finalize_catalog_import_pre_kolbenschmidt(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.finalize_catalog_import(uuid) to authenticated;

comment on function public.finalize_catalog_import(uuid) is
  'Catalog import finalizer with EAN, vehicle model, source provenance and normalized identifier capture. Product images remain governed by the existing H3 quarantine.';
