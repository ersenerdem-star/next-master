-- Supplier order quantity rules.
--
-- MOQ is a minimum quantity. order_multiple is an optional pack/case multiple.
-- A rule never changes catalog_products and is consumed by quote/sales-order
-- resolution only. The import wrappers remain the authorization boundary.

alter table public.supplier_prices
  add column if not exists order_multiple integer;

alter table public.supplier_price_import_stage
  add column if not exists order_multiple integer;

alter table public.supplier_prices
  drop constraint if exists supplier_prices_order_multiple_check;

alter table public.supplier_prices
  add constraint supplier_prices_order_multiple_check
  check (order_multiple is null or order_multiple > 0);

alter table public.supplier_price_import_stage
  drop constraint if exists supplier_price_import_stage_order_multiple_check;

alter table public.supplier_price_import_stage
  add constraint supplier_price_import_stage_order_multiple_check
  check (order_multiple is null or order_multiple > 0);

create index if not exists idx_supplier_prices_order_rules
  on public.supplier_prices (organization_id, brand_id, normalized_code, supplier_id, valid_from desc, id desc)
  where is_active;

create or replace function public.fill_supplier_price_order_multiple_from_stage()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.order_multiple is null then
    select s.order_multiple
      into new.order_multiple
    from public.supplier_price_import_stage s
    where s.organization_id = new.organization_id
      and s.supplier_id = new.supplier_id
      and s.brand_id = new.brand_id
      and s.normalized_code = new.normalized_code
      and s.valid_from = new.valid_from
      and s.order_multiple is not null
    order by s.created_at desc, s.id desc
    limit 1;
  end if;
  return new;
end;
$$;

drop trigger if exists supplier_prices_fill_order_multiple
on public.supplier_prices;

create trigger supplier_prices_fill_order_multiple
before insert or update of order_multiple, normalized_code, valid_from
on public.supplier_prices
for each row
execute function public.fill_supplier_price_order_multiple_from_stage();

-- Keep the existing staged-import and bulk-import authorization wrappers, but
-- copy the additive field from the JSON payload after their legacy inner
-- functions have accepted the rest of the row.
create or replace function public.stage_supplier_price_import_chunk(
  input_run_id uuid,
  payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  result jsonb;
begin
  if public.current_profile_org_id() is null
     or (public.current_profile_role() <> 'admin' and not public.is_superadmin()) then
    raise exception 'Only active admin users can import supplier prices';
  end if;

  result := public.stage_supplier_price_import_chunk_inner(input_run_id, payload);

  update public.supplier_price_import_stage stage
  set order_multiple = nullif(rows.order_multiple, 0)
  from (
    select distinct on (public.normalize_part_code(product_code), coalesce(valid_from, current_date))
      product_code, valid_from, order_multiple
    from jsonb_to_recordset(payload) as input_rows(
      product_code text,
      valid_from date,
      order_multiple integer
    )
    where order_multiple is not null
    order by public.normalize_part_code(product_code), coalesce(valid_from, current_date), order_multiple desc nulls last
  ) rows
  where stage.run_id = input_run_id
    and stage.normalized_code = public.normalize_part_code(rows.product_code)
    and stage.valid_from = coalesce(rows.valid_from, current_date)
    and rows.order_multiple is not null;

  return result;
end;
$$;

create or replace function public.bulk_import_supplier_prices(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  result jsonb;
  org_id uuid := public.current_profile_org_id();
begin
  if org_id is null
     or (public.current_profile_role() <> 'admin' and not public.is_superadmin()) then
    raise exception 'Only active admin users can import supplier prices';
  end if;

  result := public.bulk_import_supplier_prices_inner(payload);

  update public.supplier_prices price
  set order_multiple = nullif(rows.order_multiple, 0)
  from (
    select distinct on (
      public.normalize_part_code(supplier_name),
      public.normalize_part_code(coalesce(brand, 'Unbranded')),
      public.normalize_part_code(product_code),
      coalesce(valid_from, current_date)
    ) supplier_name, brand, product_code, valid_from, order_multiple
    from jsonb_to_recordset(payload) as input_rows(
      supplier_name text,
      brand text,
      product_code text,
      valid_from date,
      order_multiple integer
    )
    where order_multiple is not null
    order by
      public.normalize_part_code(supplier_name),
      public.normalize_part_code(coalesce(brand, 'Unbranded')),
      public.normalize_part_code(product_code),
      coalesce(valid_from, current_date),
      order_multiple desc nulls last
  ) rows
  join public.suppliers supplier
    on supplier.organization_id = org_id
   and supplier.normalized_name = public.normalize_part_code(rows.supplier_name)
  join public.brands brand
    on brand.organization_id = org_id
   and brand.normalized_name = public.normalize_part_code(coalesce(rows.brand, 'Unbranded'))
  where price.organization_id = org_id
    and price.supplier_id = supplier.id
    and price.brand_id = brand.id
    and price.normalized_code = public.normalize_part_code(rows.product_code)
    and price.valid_from = coalesce(rows.valid_from, current_date)
    and rows.order_multiple is not null;

  return result;
end;
$$;

create or replace function public.cloud_supplier_order_rules(
  input_code text,
  input_brand text default ''
)
returns table (
  supplier_name text,
  moq integer,
  order_multiple integer
)
language sql
stable
security definer
set search_path = public
as $$
  with requested_brand as (
    select b.id
    from public.brands b
    where b.organization_id = public.current_profile_org_id()
      and b.normalized_name = public.normalize_part_code(input_brand)
    limit 1
  ),
  catalog_exact as (
    select cp.brand_id, cp.normalized_code
    from public.catalog_products cp
    where cp.organization_id = public.current_profile_org_id()
      and (cp.normalized_code = public.normalize_part_code(input_code)
        or cp.normalized_oem = public.normalize_part_code(input_code))
      and (coalesce(input_brand, '') = '' or cp.brand_id in (select id from requested_brand))
    order by
      case when cp.brand_id in (select id from requested_brand) then 0 else 1 end,
      case when cp.normalized_code = public.normalize_part_code(input_code) then 0 else 1 end,
      cp.product_code
    limit 1
  ),
  supplier_exact as (
    select sp.brand_id, sp.normalized_code
    from public.supplier_prices sp
    where sp.organization_id = public.current_profile_org_id()
      and sp.is_active
      and sp.normalized_code = public.normalize_part_code(input_code)
      and sp.valid_from <= current_date
      and (sp.valid_to is null or sp.valid_to >= current_date)
      and (coalesce(input_brand, '') = '' or sp.brand_id in (select id from requested_brand))
      and not exists (select 1 from catalog_exact)
    order by sp.valid_from desc, sp.id desc
    limit 1
  ),
  product_match as (
    select * from catalog_exact
    union all
    select * from supplier_exact
    limit 1
  ),
  ranked as (
    select
      supplier.name as supplier_name,
      sp.moq,
      sp.order_multiple,
      row_number() over (
        partition by sp.supplier_id
        order by sp.valid_from desc, sp.updated_at desc, sp.id desc
      ) as supplier_rank
    from product_match pm
    join public.supplier_prices sp
      on sp.organization_id = public.current_profile_org_id()
     and sp.brand_id = pm.brand_id
     and sp.normalized_code = pm.normalized_code
     and sp.is_active
     and sp.valid_from <= current_date
     and (sp.valid_to is null or sp.valid_to >= current_date)
    join public.suppliers supplier on supplier.id = sp.supplier_id
  )
  select supplier_name, moq, order_multiple
  from ranked
  where supplier_rank = 1
  order by supplier_name;
$$;

grant execute on function public.cloud_supplier_order_rules(text, text) to authenticated;

-- The original supplier-price page predates order_multiple and its return
-- type cannot be altered in place. Expose a compatible additive page for the
-- operations UI without breaking the historical RPC.
create or replace function public.cloud_supplier_price_page_with_rules(
  input_supplier_id uuid,
  input_search text default '',
  input_page integer default 1,
  input_page_size integer default 250,
  input_freshness text default 'all'
)
returns table (
  total_count bigint,
  price_id uuid,
  product_code text,
  brand text,
  description text,
  oem_no text,
  buy_price numeric,
  currency text,
  price_date date,
  moq integer,
  order_multiple integer,
  lead_time_days integer,
  notes text,
  freshness text
)
language sql
stable
security definer
set search_path = public
as $$
  with params as (
    select
      nullif(trim(coalesce(input_search, '')), '') as raw_search,
      public.normalize_part_code(input_search) as search_norm,
      greatest(coalesce(input_page, 1), 1) as page_no,
      least(greatest(coalesce(input_page_size, 250), 1), 1000) as page_size
  ),
  scoped as (
    select
      sp.id,
      sp.product_code,
      b.name as brand,
      sp.description,
      sp.oem_no,
      sp.buy_price,
      sp.currency,
      sp.valid_from,
      sp.moq,
      sp.order_multiple,
      sp.lead_time_days,
      sp.notes,
      case
        when sp.valid_from is null then 'unknown'
        when sp.valid_from < current_date - interval '180 days' then 'stale'
        when sp.valid_from < current_date - interval '90 days' then 'aging'
        else 'fresh'
      end as freshness
    from public.supplier_prices sp
    left join public.brands b on b.id = sp.brand_id
    cross join params p
    where sp.organization_id = public.current_profile_org_id()
      and sp.supplier_id = input_supplier_id
      and sp.is_active
      and (
        p.raw_search is null
        or sp.normalized_code = p.search_norm
        or sp.normalized_code like p.search_norm || '%'
        or sp.product_code ilike '%' || p.raw_search || '%'
        or coalesce(sp.description, '') ilike '%' || p.raw_search || '%'
        or coalesce(sp.oem_no, '') ilike '%' || p.raw_search || '%'
        or coalesce(b.name, '') ilike '%' || p.raw_search || '%'
      )
  ),
  filtered as (
    select *
    from scoped
    where coalesce(input_freshness, 'all') = 'all' or freshness = input_freshness
  )
  select
    count(*) over () as total_count,
    id,
    product_code,
    brand,
    description,
    oem_no,
    buy_price,
    currency,
    valid_from,
    moq,
    order_multiple,
    lead_time_days,
    notes,
    freshness
  from filtered
  cross join params p
  order by product_code
  limit (select page_size from params)
  offset ((select page_no from params) - 1) * (select page_size from params);
$$;

grant execute on function public.cloud_supplier_price_page_with_rules(uuid, text, integer, integer, text) to authenticated;
