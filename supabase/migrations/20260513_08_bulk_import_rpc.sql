-- Faster browser-to-Supabase import helpers.
-- Run this in Supabase SQL Editor after schema.sql and database-setup.sql.
-- These functions process each browser batch inside PostgreSQL instead of doing many row-level API upserts.

create or replace function bulk_import_catalog(payload jsonb)
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

  if org_id is null or current_profile_role() <> 'admin' then
    raise exception 'Only active admin users can import catalog data';
  end if;

  create temporary table tmp_catalog_import (
    brand text,
    product_code text,
    description text,
    oem_no text,
    hs_code text,
    origin text,
    weight_kg numeric
  ) on commit drop;

  insert into tmp_catalog_import (
    brand,
    product_code,
    description,
    oem_no,
    hs_code,
    origin,
    weight_kg
  )
  select
    nullif(trim(coalesce(brand, '')), ''),
    nullif(trim(coalesce(product_code, '')), ''),
    nullif(trim(coalesce(description, '')), ''),
    nullif(trim(coalesce(oem_no, '')), ''),
    nullif(trim(coalesce(hs_code, '')), ''),
    nullif(trim(coalesce(origin, '')), ''),
    weight_kg
  from jsonb_to_recordset(payload) as x(
    brand text,
    product_code text,
    description text,
    oem_no text,
    hs_code text,
    origin text,
    weight_kg numeric
  )
  where normalize_part_code(product_code) <> '';

  insert into brands (organization_id, name)
  select distinct org_id, coalesce(brand, 'Unbranded')
  from tmp_catalog_import
  on conflict (organization_id, normalized_name) do nothing;

  insert into catalog_products (
    organization_id,
    brand_id,
    product_code,
    description,
    oem_no,
    hs_code,
    origin,
    weight_kg
  )
  select
    org_id,
    b.id,
    t.product_code,
    t.description,
    t.oem_no,
    t.hs_code,
    t.origin,
    t.weight_kg
  from tmp_catalog_import t
  join brands b
    on b.organization_id = org_id
   and b.normalized_name = normalize_part_code(coalesce(t.brand, 'Unbranded'))
  on conflict (organization_id, brand_id, normalized_code) do update set
    product_code = excluded.product_code,
    description = coalesce(excluded.description, catalog_products.description),
    oem_no = coalesce(excluded.oem_no, catalog_products.oem_no),
    hs_code = coalesce(excluded.hs_code, catalog_products.hs_code),
    origin = coalesce(excluded.origin, catalog_products.origin),
    weight_kg = coalesce(excluded.weight_kg, catalog_products.weight_kg),
    updated_at = now()
  where
    catalog_products.product_code is distinct from excluded.product_code
    or (excluded.description is not null and catalog_products.description is distinct from excluded.description)
    or (excluded.oem_no is not null and catalog_products.oem_no is distinct from excluded.oem_no)
    or (excluded.hs_code is not null and catalog_products.hs_code is distinct from excluded.hs_code)
    or (excluded.origin is not null and catalog_products.origin is distinct from excluded.origin)
    or (excluded.weight_kg is not null and catalog_products.weight_kg is distinct from excluded.weight_kg);

  get diagnostics inserted_count = row_count;

  return jsonb_build_object(
    'status', 'ok',
    'processed', inserted_count
  );
end;
$$;

create or replace function bulk_import_supplier_prices(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  org_id uuid;
  processed_count integer := 0;
  synced_catalog_count integer := 0;
begin
  org_id := current_profile_org_id();

  if org_id is null or current_profile_role() <> 'admin' then
    raise exception 'Only active admin users can import supplier prices';
  end if;

  create temporary table tmp_supplier_price_import (
    supplier_name text,
    brand text,
    product_code text,
    description text,
    oem_no text,
    buy_price numeric,
    currency text,
    moq integer,
    lead_time_days integer,
    notes text,
    valid_from date
  ) on commit drop;

  insert into tmp_supplier_price_import (
    supplier_name,
    brand,
    product_code,
    description,
    oem_no,
    buy_price,
    currency,
    moq,
    lead_time_days,
    notes,
    valid_from
  )
  select
    nullif(trim(coalesce(supplier_name, '')), ''),
    nullif(trim(coalesce(brand, '')), ''),
    nullif(trim(coalesce(product_code, '')), ''),
    nullif(trim(coalesce(description, '')), ''),
    nullif(trim(coalesce(oem_no, '')), ''),
    buy_price,
    coalesce(nullif(trim(currency), ''), 'EUR'),
    moq,
    lead_time_days,
    nullif(trim(coalesce(notes, '')), ''),
    coalesce(valid_from, current_date)
  from jsonb_to_recordset(payload) as x(
    supplier_name text,
    brand text,
    product_code text,
    description text,
    oem_no text,
    buy_price numeric,
    currency text,
    moq integer,
    lead_time_days integer,
    notes text,
    valid_from date
  )
  where normalize_part_code(product_code) <> ''
    and nullif(trim(coalesce(supplier_name, '')), '') is not null;

  insert into suppliers (organization_id, name)
  select distinct org_id, supplier_name
  from tmp_supplier_price_import
  on conflict (organization_id, normalized_name) do nothing;

  insert into brands (organization_id, name)
  select distinct org_id, coalesce(brand, 'Unbranded')
  from tmp_supplier_price_import
  on conflict (organization_id, normalized_name) do nothing;

  insert into supplier_prices (
    organization_id,
    supplier_id,
    brand_id,
    product_code,
    description,
    oem_no,
    buy_price,
    currency,
    moq,
    lead_time_days,
    notes,
    valid_from,
    is_active
  )
  select
    org_id,
    s.id,
    b.id,
    t.product_code,
    t.description,
    t.oem_no,
    round(coalesce(t.buy_price, 0), 2),
    t.currency,
    t.moq,
    t.lead_time_days,
    t.notes,
    t.valid_from,
    true
  from tmp_supplier_price_import t
  join suppliers s
    on s.organization_id = org_id
   and s.normalized_name = normalize_part_code(t.supplier_name)
  join brands b
    on b.organization_id = org_id
   and b.normalized_name = normalize_part_code(coalesce(t.brand, 'Unbranded'))
  on conflict (organization_id, supplier_id, brand_id, normalized_code, valid_from) do update set
    product_code = excluded.product_code,
    description = coalesce(excluded.description, supplier_prices.description),
    oem_no = coalesce(excluded.oem_no, supplier_prices.oem_no),
    buy_price = excluded.buy_price,
    currency = excluded.currency,
    moq = coalesce(excluded.moq, supplier_prices.moq),
    lead_time_days = coalesce(excluded.lead_time_days, supplier_prices.lead_time_days),
    notes = coalesce(excluded.notes, supplier_prices.notes),
    is_active = true,
    updated_at = now()
  where
    supplier_prices.product_code is distinct from excluded.product_code
    or (excluded.description is not null and supplier_prices.description is distinct from excluded.description)
    or (excluded.oem_no is not null and supplier_prices.oem_no is distinct from excluded.oem_no)
    or supplier_prices.buy_price is distinct from excluded.buy_price
    or supplier_prices.currency is distinct from excluded.currency
    or (excluded.moq is not null and supplier_prices.moq is distinct from excluded.moq)
    or (excluded.lead_time_days is not null and supplier_prices.lead_time_days is distinct from excluded.lead_time_days)
    or (excluded.notes is not null and supplier_prices.notes is distinct from excluded.notes)
    or supplier_prices.is_active is distinct from true;

  get diagnostics processed_count = row_count;

  with source_rows as (
    select distinct on (b.id, normalize_part_code(t.product_code))
      org_id as organization_id,
      b.id as brand_id,
      t.product_code,
      t.description,
      t.oem_no,
      t.notes
    from tmp_supplier_price_import t
    join brands b
      on b.organization_id = org_id
     and b.normalized_name = normalize_part_code(coalesce(t.brand, 'Unbranded'))
    where normalize_part_code(t.product_code) <> ''
    order by
      b.id,
      normalize_part_code(t.product_code),
      case when nullif(trim(coalesce(t.description, '')), '') is not null then 0 else 1 end,
      case when nullif(trim(coalesce(t.oem_no, '')), '') is not null then 0 else 1 end,
      case when nullif(trim(coalesce(t.notes, '')), '') is not null then 0 else 1 end,
      t.buy_price asc nulls last,
      t.valid_from desc nulls last
  ),
  upserted_catalog as (
    insert into catalog_products (
      organization_id,
      brand_id,
      product_code,
      description,
      oem_no,
      notes
    )
    select
      organization_id,
      brand_id,
      product_code,
      nullif(trim(coalesce(description, '')), ''),
      nullif(trim(coalesce(oem_no, '')), ''),
      nullif(trim(coalesce(notes, '')), '')
    from source_rows
    on conflict (organization_id, brand_id, normalized_code) do update set
      product_code = excluded.product_code,
      description = case
        when nullif(trim(coalesce(catalog_products.description, '')), '') is null
          then excluded.description
        else catalog_products.description
      end,
      oem_no = case
        when nullif(trim(coalesce(catalog_products.oem_no, '')), '') is null
          then excluded.oem_no
        else catalog_products.oem_no
      end,
      notes = case
        when nullif(trim(coalesce(catalog_products.notes, '')), '') is null
          then excluded.notes
        else catalog_products.notes
      end,
      updated_at = now()
    where
      catalog_products.product_code is distinct from excluded.product_code
      or (
        nullif(trim(coalesce(catalog_products.description, '')), '') is null
        and excluded.description is not null
      )
      or (
        nullif(trim(coalesce(catalog_products.oem_no, '')), '') is null
        and excluded.oem_no is not null
      )
      or (
        nullif(trim(coalesce(catalog_products.notes, '')), '') is null
        and excluded.notes is not null
      )
    returning 1
  )
  select count(*) into synced_catalog_count
  from upserted_catalog;

  return jsonb_build_object(
    'status', 'ok',
    'processed', processed_count,
    'catalog_synced', synced_catalog_count
  );
end;
$$;

grant execute on function bulk_import_catalog(jsonb) to authenticated;
grant execute on function bulk_import_supplier_prices(jsonb) to authenticated;
