-- Catalog multilingual descriptions and the canonical off-highway segment.
-- This migration is additive: English description remains canonical, while
-- description_tr is an optional Turkish enrichment/fallback field.

alter table public.catalog_products
  add column if not exists description_tr text;

alter table public.catalog_import_stage
  add column if not exists description_tr text;

revoke update on table public.catalog_products from authenticated;

grant update (
  brand_id,
  product_code,
  ean,
  description,
  description_tr,
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

create index if not exists idx_catalog_products_org_description_tr
  on public.catalog_products (organization_id, description_tr)
  where description_tr is not null and description_tr <> '';

create or replace function public.normalize_catalog_market_segment(input_value text)
returns text
language sql
immutable
set search_path = public
as $$
  with normalized as (
    select regexp_replace(lower(trim(coalesce(input_value, ''))), '[^a-z0-9]+', '_', 'g') as value
  )
  select case
    when input_value is null then null
    when value in ('pc', 'pkw', 'passengercar', 'passenger_car', 'passenger_cars', 'passenger_vehicle', 'passengervehicle', 'passenger_vehicles', 'car') then 'pc'
    when value in ('cv', 'truck', 'truckbus', 'truck_bus', 'truck_bus_commercial', 'truck_bus_light_commercial', 'commercial', 'commercial_vehicle', 'commercialvehicle', 'commercial_vehicles', 'lkw') then 'cv'
    when value in ('lcv', 'light_commercial', 'lightcommercial', 'light_commercial_vehicle', 'lightcommercialvehicle', 'light_commercial_vehicles', 'van') then 'lcv'
    when value in ('motorcycle', 'motorbike', 'motorcycles', 'motorbikes', 'bike') then 'motorcycle'
    when value in ('engine', 'engines', 'powertrain') then 'engines'
    when value = 'universal' then 'universal'
    when value = 'marine' then 'marine'
    when value = 'industrial' then 'industrial'
    when value in ('agriculture', 'agricultural', 'agri') then 'agriculture'
    when value in ('off_highway', 'offhighway', 'ohv', 'oh') then 'off_highway'
    else null
  end
  from normalized;
$$;

update public.catalog_products
set market_segment = public.normalize_catalog_market_segment(market_segment)
where market_segment is not null
  and public.normalize_catalog_market_segment(market_segment) is distinct from market_segment;

alter table public.catalog_products
  drop constraint if exists catalog_products_market_segment_check;

alter table public.catalog_products
  add constraint catalog_products_market_segment_check
  check (
    market_segment is null
    or market_segment in (
      'pc', 'cv', 'lcv', 'motorcycle', 'engines', 'universal',
      'marine', 'industrial', 'agriculture', 'off_highway'
    )
  );

-- Preserve the already deployed staging implementation and add only the new
-- field transport. The existing function remains the source of validation and
-- authorization; this wrapper only copies description_tr into the stage row.
alter function public.stage_catalog_import_chunk(uuid, jsonb)
  rename to stage_catalog_import_chunk_pre_description_tr;

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
  v_result := public.stage_catalog_import_chunk_pre_description_tr(input_run_id, payload);

  update public.catalog_import_stage s
  set description_tr = p.description_tr
  from (
    select
      nullif(trim(coalesce(item.value->>'row_index', '')), '')::integer as row_index,
      nullif(trim(coalesce(
        item.value->>'description_tr',
        item.value->>'description_turkish',
        item.value->>'Product_Name_TR',
        ''
      )), '') as description_tr
    from jsonb_array_elements(coalesce(payload, '[]'::jsonb)) as item(value)
  ) p
  where s.run_id = input_run_id
    and s.organization_id = v_org_id
    and s.row_index = p.row_index;

  return v_result;
end;
$$;

revoke all on function public.stage_catalog_import_chunk_pre_description_tr(uuid, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.stage_catalog_import_chunk(uuid, jsonb)
  from public, anon;
grant execute on function public.stage_catalog_import_chunk(uuid, jsonb) to authenticated;
grant execute on function public.stage_catalog_import_chunk(uuid, jsonb) to service_role;

-- Carry the staged Turkish value into Product only during the existing guarded
-- finalization step. No direct catalog mutation is introduced here.
alter function public.finalize_catalog_import(uuid)
  rename to finalize_catalog_import_pre_description_tr;

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
  v_updated integer := 0;
begin
  v_result := public.finalize_catalog_import_pre_description_tr(input_run_id);

  with staged_products as (
    select distinct on (s.row_index)
      s.description_tr,
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
    order by s.row_index, s.created_at desc
  ), updated as (
    update public.catalog_products cp
    set description_tr = coalesce(sp.description_tr, cp.description_tr),
        updated_at = now()
    from staged_products sp
    where cp.id = sp.catalog_product_id
      and sp.description_tr is not null
      and cp.description_tr is distinct from sp.description_tr
    returning cp.id
  )
  select count(*)::integer into v_updated from updated;

  return v_result || jsonb_build_object('description_tr_updated_count', v_updated);
end;
$$;

revoke all on function public.finalize_catalog_import_pre_description_tr(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.finalize_catalog_import(uuid)
  from public, anon;
grant execute on function public.finalize_catalog_import(uuid) to authenticated;
grant execute on function public.finalize_catalog_import(uuid) to service_role;
