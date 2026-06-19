-- Make supplier price imports duplicate-safe inside each RPC batch.
-- PostgreSQL raises "ON CONFLICT DO UPDATE command cannot affect row a second time"
-- when a single insert statement contains duplicate conflict keys. Large supplier
-- files commonly repeat the same supplier/brand/code/date row, so collapse them
-- before upserting into supplier_prices.

create or replace function public.bulk_import_supplier_prices_inner(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  org_id uuid;
  processed_count integer := 0;
  synced_catalog_count integer := 0;
  duplicate_count integer := 0;
begin
  org_id := public.current_profile_org_id();

  if org_id is null or (public.current_profile_role() <> 'admin' and not public.is_superadmin()) then
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
  where public.normalize_part_code(product_code) <> ''
    and nullif(trim(coalesce(supplier_name, '')), '') is not null;

  insert into suppliers (organization_id, name)
  select distinct org_id, supplier_name
  from tmp_supplier_price_import
  on conflict (organization_id, normalized_name) do nothing;

  insert into brands (organization_id, name)
  select distinct org_id, coalesce(brand, 'Unbranded')
  from tmp_supplier_price_import
  on conflict (organization_id, normalized_name) do nothing;

  with supplier_source_rows as (
    select distinct on (
      s.id,
      b.id,
      public.normalize_part_code(t.product_code),
      t.valid_from
    )
      org_id as organization_id,
      s.id as supplier_id,
      b.id as brand_id,
      t.product_code,
      t.description,
      t.oem_no,
      round(coalesce(t.buy_price, 0), 2) as buy_price,
      t.currency,
      t.moq,
      t.lead_time_days,
      t.notes,
      t.valid_from,
      public.normalize_part_code(t.product_code) as normalized_code
    from tmp_supplier_price_import t
    join suppliers s
      on s.organization_id = org_id
     and s.normalized_name = public.normalize_part_code(t.supplier_name)
    join brands b
      on b.organization_id = org_id
     and b.normalized_name = public.normalize_part_code(coalesce(t.brand, 'Unbranded'))
    order by
      s.id,
      b.id,
      public.normalize_part_code(t.product_code),
      t.valid_from,
      case when t.buy_price is not null and t.buy_price > 0 then 0 else 1 end,
      case when nullif(trim(coalesce(t.description, '')), '') is not null then 0 else 1 end,
      case when nullif(trim(coalesce(t.oem_no, '')), '') is not null then 0 else 1 end,
      case when nullif(trim(coalesce(t.notes, '')), '') is not null then 0 else 1 end,
      t.buy_price asc nulls last
  ),
  duplicate_stats as (
    select
      greatest(
        (select count(*) from tmp_supplier_price_import) - (select count(*) from supplier_source_rows),
        0
      )::integer as duplicate_rows
  ),
  upserted_supplier_prices as (
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
      true
    from supplier_source_rows
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
      or supplier_prices.is_active is distinct from true
    returning 1
  )
  select
    (select count(*) from upserted_supplier_prices)::integer,
    (select duplicate_rows from duplicate_stats)
  into processed_count, duplicate_count;

  with source_rows as (
    select distinct on (b.id, public.normalize_part_code(t.product_code))
      org_id as organization_id,
      b.id as brand_id,
      t.product_code,
      t.description,
      t.oem_no,
      t.notes
    from tmp_supplier_price_import t
    join brands b
      on b.organization_id = org_id
     and b.normalized_name = public.normalize_part_code(coalesce(t.brand, 'Unbranded'))
    where public.normalize_part_code(t.product_code) <> ''
    order by
      b.id,
      public.normalize_part_code(t.product_code),
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
  select count(*)::integer into synced_catalog_count
  from upserted_catalog;

  return jsonb_build_object(
    'status', 'ok',
    'processed', processed_count,
    'catalog_synced', synced_catalog_count,
    'deduped_rows', duplicate_count
  );
end;
$$;

grant execute on function public.bulk_import_supplier_prices_inner(jsonb) to authenticated;
