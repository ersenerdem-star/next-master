alter table public.catalog_products
  add column if not exists vehicle_model text;

create or replace function public.bulk_import_catalog(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  org_id uuid;
  inserted_count integer := 0;
begin
  org_id := current_profile_org_id();

  if org_id is null or current_profile_role() not in ('admin', 'superadmin') then
    raise exception 'Only active admin users can import catalog data';
  end if;

  create temporary table tmp_catalog_import (
    brand text,
    product_code text,
    ean text,
    description text,
    oem_no text,
    vehicle text,
    vehicle_model text,
    hs_code text,
    origin text,
    market_segment text,
    weight_kg numeric,
    lifecycle_status text,
    lifecycle_note text
  ) on commit drop;

  insert into tmp_catalog_import (
    brand,
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
    lifecycle_note
  )
  select
    nullif(trim(coalesce(brand, '')), ''),
    nullif(trim(coalesce(product_code, '')), ''),
    nullif(trim(coalesce(ean, '')), ''),
    nullif(trim(coalesce(description, '')), ''),
    nullif(trim(coalesce(oem_no, '')), ''),
    nullif(trim(coalesce(vehicle, '')), ''),
    nullif(trim(coalesce(vehicle_model, '')), ''),
    nullif(trim(coalesce(hs_code, '')), ''),
    nullif(trim(coalesce(origin, '')), ''),
    case
      when lower(regexp_replace(trim(coalesce(market_segment, '')), '[^a-z0-9]+', '_', 'g')) in ('pkw', 'passengercar', 'passenger_vehicle', 'passengervehicle')
        then 'passenger_car'
      when lower(regexp_replace(trim(coalesce(market_segment, '')), '[^a-z0-9]+', '_', 'g')) in (
        'lkw',
        'commercial',
        'commercial_vehicle',
        'commercialvehicle',
        'light_commercial',
        'lightcommercial',
        'light_commercial_vehicle',
        'lightcommercialvehicle',
        'truck_bus_commercial',
        'truck_bus_light_commercial'
      )
        then 'truck'
      when lower(regexp_replace(trim(coalesce(market_segment, '')), '[^a-z0-9]+', '_', 'g')) in ('truck', 'bus', 'agriculture', 'marine', 'passenger_car', 'industrial')
        then lower(regexp_replace(trim(coalesce(market_segment, '')), '[^a-z0-9]+', '_', 'g'))
      else null
    end,
    weight_kg,
    case
      when lower(trim(coalesce(lifecycle_status, ''))) = 'discontinued' then 'discontinued'
      else 'active'
    end,
    nullif(trim(coalesce(lifecycle_note, '')), '')
  from jsonb_to_recordset(payload) as x(
    brand text,
    product_code text,
    ean text,
    description text,
    oem_no text,
    vehicle text,
    vehicle_model text,
    hs_code text,
    origin text,
    market_segment text,
    weight_kg numeric,
    lifecycle_status text,
    lifecycle_note text
  )
  where normalize_part_code(product_code) <> '';

  insert into public.brands (organization_id, name)
  select distinct org_id, coalesce(brand, 'Unbranded')
  from tmp_catalog_import
  on conflict (organization_id, normalized_name) do nothing;

  insert into public.catalog_products (
    organization_id,
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
    lifecycle_note
  )
  select
    org_id,
    b.id,
    t.product_code,
    t.ean,
    t.description,
    t.oem_no,
    t.vehicle,
    t.vehicle_model,
    t.hs_code,
    t.origin,
    t.market_segment,
    t.weight_kg,
    t.lifecycle_status,
    t.lifecycle_note
  from tmp_catalog_import t
  join public.brands b
    on b.organization_id = org_id
   and b.normalized_name = normalize_part_code(coalesce(t.brand, 'Unbranded'))
  on conflict (organization_id, brand_id, normalized_code) do update set
    product_code = excluded.product_code,
    ean = coalesce(excluded.ean, public.catalog_products.ean),
    description = coalesce(excluded.description, public.catalog_products.description),
    oem_no = coalesce(excluded.oem_no, public.catalog_products.oem_no),
    vehicle = coalesce(excluded.vehicle, public.catalog_products.vehicle),
    vehicle_model = coalesce(excluded.vehicle_model, public.catalog_products.vehicle_model),
    hs_code = coalesce(excluded.hs_code, public.catalog_products.hs_code),
    origin = coalesce(excluded.origin, public.catalog_products.origin),
    market_segment = coalesce(excluded.market_segment, public.catalog_products.market_segment),
    weight_kg = coalesce(excluded.weight_kg, public.catalog_products.weight_kg),
    lifecycle_status = coalesce(excluded.lifecycle_status, public.catalog_products.lifecycle_status),
    lifecycle_note = coalesce(excluded.lifecycle_note, public.catalog_products.lifecycle_note),
    updated_at = now()
  where
    public.catalog_products.product_code is distinct from excluded.product_code
    or public.catalog_products.ean is distinct from excluded.ean
    or (excluded.description is not null and public.catalog_products.description is distinct from excluded.description)
    or (excluded.oem_no is not null and public.catalog_products.oem_no is distinct from excluded.oem_no)
    or (excluded.vehicle is not null and public.catalog_products.vehicle is distinct from excluded.vehicle)
    or (excluded.vehicle_model is not null and public.catalog_products.vehicle_model is distinct from excluded.vehicle_model)
    or (excluded.hs_code is not null and public.catalog_products.hs_code is distinct from excluded.hs_code)
    or (excluded.origin is not null and public.catalog_products.origin is distinct from excluded.origin)
    or (excluded.market_segment is not null and public.catalog_products.market_segment is distinct from excluded.market_segment)
    or (excluded.weight_kg is not null and public.catalog_products.weight_kg is distinct from excluded.weight_kg)
    or public.catalog_products.lifecycle_status is distinct from excluded.lifecycle_status
    or (excluded.lifecycle_note is not null and public.catalog_products.lifecycle_note is distinct from excluded.lifecycle_note);

  get diagnostics inserted_count = row_count;

  return jsonb_build_object(
    'status', 'ok',
    'processed', inserted_count
  );
end;
$$;

grant execute on function public.bulk_import_catalog(jsonb) to authenticated;
