alter table public.catalog_products
  add column if not exists market_segment text;

alter table public.catalog_products
  drop constraint if exists catalog_products_market_segment_check;

alter table public.catalog_products
  add constraint catalog_products_market_segment_check
  check (
    market_segment is null
    or market_segment in ('truck', 'bus', 'agriculture', 'marine', 'passenger_car', 'industrial')
  );

create index if not exists idx_catalog_products_org_market_segment
  on public.catalog_products (organization_id, market_segment)
  where market_segment is not null and market_segment <> '';

create index if not exists idx_catalog_products_org_market_segment_brand_code
  on public.catalog_products (organization_id, market_segment, brand_id, product_code)
  where market_segment is not null and market_segment <> '';

drop function if exists public.cloud_catalog_page(text, text, integer, integer);
drop function if exists public.cloud_catalog_page(text, integer, integer);

create or replace function public.cloud_catalog_page(
  input_search text default '',
  input_brand text default '',
  input_market_segment text default '',
  input_page integer default 1,
  input_page_size integer default 250
)
returns table (
  total_count bigint,
  product_id uuid,
  product_code text,
  brand text,
  image_url text,
  market_segment text,
  description text,
  oem_no text,
  hs_code text,
  origin text,
  weight_kg numeric,
  lifecycle_status text,
  lifecycle_note text
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  org_id uuid;
begin
  org_id := public.current_profile_org_id();
  if org_id is null or not public.is_superadmin() then
    raise exception 'Only active superadmin users can load catalog';
  end if;

  return query
  with params as (
    select
      nullif(trim(coalesce(input_search, '')), '') as raw_search,
      public.normalize_part_code(input_search) as search_norm,
      public.normalize_part_code(input_brand) as brand_norm,
      case
        when lower(regexp_replace(trim(coalesce(input_market_segment, '')), '[^a-z0-9]+', '_', 'g')) in ('pkw', 'passengercar', 'passenger_vehicle', 'passengervehicle')
          then 'passenger_car'
        when lower(regexp_replace(trim(coalesce(input_market_segment, '')), '[^a-z0-9]+', '_', 'g')) in (
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
        else lower(regexp_replace(trim(coalesce(input_market_segment, '')), '[^a-z0-9]+', '_', 'g'))
      end as segment_norm,
      greatest(input_page, 1) as page_no,
      least(greatest(input_page_size, 1), 1000) as page_size,
      greatest(0, (greatest(input_page, 1) - 1) * least(greatest(input_page_size, 1), 1000)) as row_offset
  ),
  flags as (
    select
      raw_search,
      search_norm,
      brand_norm,
      segment_norm,
      page_no,
      page_size,
      row_offset,
      (search_norm <> '' and (raw_search ~ '[0-9]' or raw_search ~ '[-/+.()]')) as search_is_code
    from params
  ),
  filtered as (
    select
      cp.id,
      cp.product_code,
      b.name as brand,
      cp.image_url,
      cp.market_segment,
      cp.description,
      cp.oem_no,
      cp.hs_code,
      cp.origin,
      cp.weight_kg,
      cp.lifecycle_status,
      cp.lifecycle_note
    from public.catalog_products cp
    join public.brands b
      on b.id = cp.brand_id
    cross join flags f
    where cp.organization_id = org_id
      and (
        f.brand_norm = ''
        or coalesce(b.normalized_name, public.normalize_part_code(b.name)) = f.brand_norm
      )
      and (
        f.segment_norm = ''
        or coalesce(cp.market_segment, '') = f.segment_norm
      )
      and (
        f.raw_search is null
        or (
          f.search_is_code
          and (
            cp.normalized_code = f.search_norm
            or cp.normalized_oem = f.search_norm
            or cp.normalized_code like f.search_norm || '%'
            or cp.normalized_oem like f.search_norm || '%'
            or cp.normalized_oem like '%' || f.search_norm || '%'
            or public.normalize_part_code(coalesce(cp.oem_no, '')) like '%' || f.search_norm || '%'
            or (
              f.search_norm ~ '^[0-9]+$'
              and public.normalize_part_code(coalesce(cp.oem_no, '')) like '%a' || f.search_norm || '%'
            )
            or cp.product_code ilike '%' || f.raw_search || '%'
            or coalesce(cp.oem_no, '') ilike '%' || f.raw_search || '%'
          )
        )
        or (
          not f.search_is_code
          and (
            cp.product_code ilike '%' || f.raw_search || '%'
            or coalesce(cp.description, '') ilike '%' || f.raw_search || '%'
            or coalesce(cp.oem_no, '') ilike '%' || f.raw_search || '%'
            or b.name ilike '%' || f.raw_search || '%'
            or cp.market_segment ilike '%' || f.raw_search || '%'
            or replace(coalesce(cp.market_segment, ''), '_', ' ') ilike '%' || f.raw_search || '%'
            or coalesce(cp.market_segment, '') = case
              when lower(regexp_replace(trim(coalesce(f.raw_search, '')), '[^a-z0-9]+', '_', 'g')) in ('pkw', 'passengercar', 'passenger_vehicle', 'passengervehicle')
                then 'passenger_car'
              when lower(regexp_replace(trim(coalesce(f.raw_search, '')), '[^a-z0-9]+', '_', 'g')) in (
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
              else ''
            end
            or cp.normalized_code like '%' || f.search_norm || '%'
            or (
              nullif(cp.normalized_oem, '') is not null
              and cp.normalized_oem like '%' || f.search_norm || '%'
            )
          )
        )
      )
  ),
  counted as (
    select
      filtered.*,
      count(*) over () as total_count,
      row_number() over (order by filtered.product_code) as row_no
    from filtered
  ),
  paged as (
    select counted.*
    from counted
    cross join flags f
    where counted.row_no > f.row_offset
      and counted.row_no <= (f.row_offset + f.page_size)
  )
  select
    total_count,
    id,
    product_code,
    brand,
    image_url,
    market_segment,
    description,
    oem_no,
    hs_code,
    origin,
    weight_kg,
    lifecycle_status,
    lifecycle_note
  from paged;
end;
$$;

create or replace function public.cloud_catalog_page(
  input_search text default '',
  input_brand text default '',
  input_page integer default 1,
  input_page_size integer default 250
)
returns table (
  total_count bigint,
  product_id uuid,
  product_code text,
  brand text,
  image_url text,
  market_segment text,
  description text,
  oem_no text,
  hs_code text,
  origin text,
  weight_kg numeric,
  lifecycle_status text,
  lifecycle_note text
)
language sql
stable
security definer
set search_path = public
as $$
  select *
  from public.cloud_catalog_page(input_search, input_brand, '', input_page, input_page_size);
$$;

create or replace function public.cloud_catalog_page(
  input_search text default '',
  input_page integer default 1,
  input_page_size integer default 250
)
returns table (
  total_count bigint,
  product_id uuid,
  product_code text,
  brand text,
  image_url text,
  market_segment text,
  description text,
  oem_no text,
  hs_code text,
  origin text,
  weight_kg numeric,
  lifecycle_status text,
  lifecycle_note text
)
language sql
stable
security definer
set search_path = public
as $$
  select *
  from public.cloud_catalog_page(input_search, '', '', input_page, input_page_size);
$$;

grant execute on function public.cloud_catalog_page(text, text, text, integer, integer) to authenticated;
grant execute on function public.cloud_catalog_page(text, text, integer, integer) to authenticated;
grant execute on function public.cloud_catalog_page(text, integer, integer) to authenticated;

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
