alter table public.catalog_products
  add column if not exists vehicle text;

update public.catalog_products
set vehicle = null
where trim(coalesce(vehicle, '')) = '';

create or replace function public.cloud_catalog_page(
  input_search text default '',
  input_page integer default 1,
  input_page_size integer default 200
)
returns table(
  total_count bigint,
  product_id uuid,
  product_code text,
  brand text,
  description text,
  oem_no text,
  vehicle text,
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
  with params as (
    select
      nullif(trim(coalesce(input_search, '')), '') as raw_search,
      normalize_part_code(input_search) as search_norm,
      greatest(input_page, 1) as page_no,
      least(greatest(input_page_size, 1), 1000) as page_size,
      greatest(0, (greatest(input_page, 1) - 1) * least(greatest(input_page_size, 1), 1000)) as row_offset
  ),
  search_flags as (
    select
      raw_search,
      search_norm,
      page_no,
      page_size,
      row_offset,
      (search_norm <> '' and length(search_norm) >= 5) as search_is_code
    from params
  ),
  filtered as (
    select
      cp.id,
      cp.product_code,
      b.name as brand,
      cp.description,
      cp.oem_no,
      cp.vehicle,
      cp.hs_code,
      cp.origin,
      cp.weight_kg,
      cp.lifecycle_status,
      cp.lifecycle_note
    from public.catalog_products cp
    join public.brands b on b.id = cp.brand_id
    cross join search_flags f
    where cp.organization_id = public.current_profile_org_id()
      and (
        f.raw_search is null
        or (
          f.search_is_code
          and (
            cp.normalized_code = f.search_norm
            or cp.normalized_oem = f.search_norm
            or cp.normalized_code like f.search_norm || '%'
            or cp.normalized_oem like f.search_norm || '%'
          )
        )
        or (
          not f.search_is_code
          and (
            cp.product_code ilike '%' || f.raw_search || '%'
            or coalesce(cp.description, '') ilike '%' || f.raw_search || '%'
            or coalesce(cp.oem_no, '') ilike '%' || f.raw_search || '%'
            or coalesce(cp.vehicle, '') ilike '%' || f.raw_search || '%'
            or b.name ilike '%' || f.raw_search || '%'
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
    cross join search_flags f
    where counted.row_no > f.row_offset
      and counted.row_no <= (f.row_offset + f.page_size)
  )
  select
    total_count,
    id,
    product_code,
    brand,
    description,
    oem_no,
    vehicle,
    hs_code,
    origin,
    weight_kg,
    lifecycle_status,
    lifecycle_note
  from paged;
$$;

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
    description text,
    oem_no text,
    vehicle text,
    hs_code text,
    origin text,
    weight_kg numeric,
    lifecycle_status text,
    lifecycle_note text
  ) on commit drop;

  insert into tmp_catalog_import (
    brand,
    product_code,
    description,
    oem_no,
    vehicle,
    hs_code,
    origin,
    weight_kg,
    lifecycle_status,
    lifecycle_note
  )
  select
    nullif(trim(coalesce(brand, '')), ''),
    nullif(trim(coalesce(product_code, '')), ''),
    nullif(trim(coalesce(description, '')), ''),
    nullif(trim(coalesce(oem_no, '')), ''),
    nullif(trim(coalesce(vehicle, '')), ''),
    nullif(trim(coalesce(hs_code, '')), ''),
    nullif(trim(coalesce(origin, '')), ''),
    weight_kg,
    case
      when lower(trim(coalesce(lifecycle_status, ''))) = 'discontinued' then 'discontinued'
      else 'active'
    end,
    nullif(trim(coalesce(lifecycle_note, '')), '')
  from jsonb_to_recordset(payload) as x(
    brand text,
    product_code text,
    description text,
    oem_no text,
    vehicle text,
    hs_code text,
    origin text,
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
    description,
    oem_no,
    vehicle,
    hs_code,
    origin,
    weight_kg,
    lifecycle_status,
    lifecycle_note
  )
  select
    org_id,
    b.id,
    t.product_code,
    t.description,
    t.oem_no,
    t.vehicle,
    t.hs_code,
    t.origin,
    t.weight_kg,
    t.lifecycle_status,
    t.lifecycle_note
  from tmp_catalog_import t
  join public.brands b
    on b.organization_id = org_id
   and b.normalized_name = normalize_part_code(coalesce(t.brand, 'Unbranded'))
  on conflict (organization_id, brand_id, normalized_code) do update set
    product_code = excluded.product_code,
    description = coalesce(excluded.description, public.catalog_products.description),
    oem_no = coalesce(excluded.oem_no, public.catalog_products.oem_no),
    vehicle = coalesce(excluded.vehicle, public.catalog_products.vehicle),
    hs_code = coalesce(excluded.hs_code, public.catalog_products.hs_code),
    origin = coalesce(excluded.origin, public.catalog_products.origin),
    weight_kg = coalesce(excluded.weight_kg, public.catalog_products.weight_kg),
    lifecycle_status = coalesce(excluded.lifecycle_status, public.catalog_products.lifecycle_status),
    lifecycle_note = coalesce(excluded.lifecycle_note, public.catalog_products.lifecycle_note),
    updated_at = now()
  where
    public.catalog_products.product_code is distinct from excluded.product_code
    or (excluded.description is not null and public.catalog_products.description is distinct from excluded.description)
    or (excluded.oem_no is not null and public.catalog_products.oem_no is distinct from excluded.oem_no)
    or (excluded.vehicle is not null and public.catalog_products.vehicle is distinct from excluded.vehicle)
    or (excluded.hs_code is not null and public.catalog_products.hs_code is distinct from excluded.hs_code)
    or (excluded.origin is not null and public.catalog_products.origin is distinct from excluded.origin)
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
