-- Supplier export page source.
-- The UI previously fetched supplier_prices with offset pagination. Large supplier
-- lists drifted between pages and forced the browser to hold the whole dataset.
-- Keep this source on the active supplier price table (the supplier export is a
-- supplier-specific operational view), but read it through a tenant-scoped,
-- service-only keyset page.

create index if not exists idx_supplier_prices_export_keyset
  on public.supplier_prices (
    organization_id,
    supplier_id,
    brand_id,
    product_code,
    id
  )
  where is_active;

create index if not exists idx_supplier_prices_export_search
  on public.supplier_prices (
    organization_id,
    supplier_id,
    brand_id,
    normalized_code,
    normalized_oem,
    product_code,
    id
  )
  where is_active;


create or replace function public.get_supplier_price_export_version(
  input_organization_id uuid,
  input_supplier_id uuid,
  input_brand_id uuid
)
returns text
language sql
stable
security definer
set search_path to ''
as $function$
  select md5(
    coalesce(input_organization_id::text, '') || ':' ||
    coalesce(input_supplier_id::text, '') || ':' ||
    coalesce(input_brand_id::text, '') || ':' ||
    coalesce((select count(*)::text from public.supplier_prices sp
      where sp.organization_id = input_organization_id
        and sp.supplier_id = input_supplier_id
        and sp.brand_id = input_brand_id
        and sp.is_active), '') || ':' ||
    coalesce((select max(sp.updated_at)::text from public.supplier_prices sp
      where sp.organization_id = input_organization_id
        and sp.supplier_id = input_supplier_id
        and sp.brand_id = input_brand_id
        and sp.is_active), '') || ':' ||
    coalesce((select max(sp.valid_from)::text from public.supplier_prices sp
      where sp.organization_id = input_organization_id
        and sp.supplier_id = input_supplier_id
        and sp.brand_id = input_brand_id
        and sp.is_active), '')
  );
$function$;

revoke all on function public.get_supplier_price_export_version(uuid, uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.get_supplier_price_export_version(uuid, uuid, uuid)
  to service_role;

create or replace function public.cloud_supplier_price_export_page(
  input_organization_id uuid,
  input_supplier_id uuid,
  input_brand_id uuid,
  input_search text default '',
  input_freshness text default 'all',
  input_after_product_code text default null,
  input_after_id uuid default null,
  input_page_size integer default 1000
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
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  v_page_size integer;
  v_search text;
  v_search_norm text;
  v_original_norm text;
  v_freshness text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'SUPPLIER_PRICE_EXPORT_SERVICE_ROLE_REQUIRED';
  end if;
  if input_organization_id is null or input_supplier_id is null or input_brand_id is null then
    raise exception 'SUPPLIER_PRICE_EXPORT_SCOPE_REQUIRED';
  end if;

  v_page_size := least(greatest(coalesce(input_page_size, 1000), 1), 5000);
  v_search := nullif(pg_catalog.btrim(coalesce(input_search, '')), '');
  v_search_norm := public.normalize_part_code(coalesce(v_search, ''));
  v_original_norm := pg_catalog.regexp_replace(v_search_norm, '^([A-Z]{1,3})([0-9]{6,})$', '\2');
  v_freshness := lower(coalesce(nullif(pg_catalog.btrim(input_freshness), ''), 'all'));
  if v_freshness not in ('all', 'fresh', 'aging', 'stale', 'unknown') then
    raise exception 'SUPPLIER_PRICE_EXPORT_FRESHNESS_INVALID';
  end if;

  return query
  with scoped as materialized (
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
    join public.brands b
      on b.id = sp.brand_id
     and b.organization_id = input_organization_id
    where sp.organization_id = input_organization_id
      and sp.supplier_id = input_supplier_id
      and sp.brand_id = input_brand_id
      and sp.is_active
      and (
        v_search is null
        or sp.product_code ilike '%' || v_search || '%'
        or coalesce(sp.description, '') ilike '%' || v_search || '%'
        or coalesce(sp.oem_no, '') ilike '%' || v_search || '%'
        or (v_search_norm <> '' and (
          sp.normalized_code = v_search_norm
          or sp.normalized_oem = v_search_norm
          or sp.normalized_code like v_search_norm || '%'
          or sp.normalized_oem like v_search_norm || '%'
          or (pg_catalog.length(v_original_norm) >= 6 and sp.normalized_oem like '%' || v_original_norm || '%')
        ))
      )
      and (
        v_freshness = 'all'
        or (v_freshness = 'fresh' and sp.valid_from >= current_date - interval '90 days')
        or (v_freshness = 'aging' and sp.valid_from >= current_date - interval '180 days' and sp.valid_from < current_date - interval '90 days')
        or (v_freshness = 'stale' and sp.valid_from < current_date - interval '180 days')
        or (v_freshness = 'unknown' and sp.valid_from is null)
      )
      and (
        input_after_product_code is null
        or coalesce(sp.product_code, '') > coalesce(input_after_product_code, '')
        or (coalesce(sp.product_code, '') = coalesce(input_after_product_code, '') and input_after_id is not null and sp.id > input_after_id)
      )
  ),
  page as (
    select s.*
    from scoped s
    order by coalesce(s.product_code, '') asc, s.id asc
    limit v_page_size
  ),
  first_page_count as (
    select count(*)::bigint as total_count
    from (
      -- Count is deliberately emitted only for the first page. Subsequent
      -- keyset requests never repeat an all-row COUNT/window operation.
      select 1 from public.supplier_prices sp
      join public.brands b on b.id = sp.brand_id and b.organization_id = input_organization_id
      where input_after_product_code is null
        and sp.organization_id = input_organization_id
        and sp.supplier_id = input_supplier_id
        and sp.brand_id = input_brand_id
        and sp.is_active
        and (
          v_search is null
          or sp.product_code ilike '%' || v_search || '%'
          or coalesce(sp.description, '') ilike '%' || v_search || '%'
          or coalesce(sp.oem_no, '') ilike '%' || v_search || '%'
          or (v_search_norm <> '' and (
            sp.normalized_code = v_search_norm
            or sp.normalized_oem = v_search_norm
            or sp.normalized_code like v_search_norm || '%'
            or sp.normalized_oem like v_search_norm || '%'
            or (pg_catalog.length(v_original_norm) >= 6 and sp.normalized_oem like '%' || v_original_norm || '%')
          ))
        )
        and (
          v_freshness = 'all'
          or (v_freshness = 'fresh' and sp.valid_from >= current_date - interval '90 days')
          or (v_freshness = 'aging' and sp.valid_from >= current_date - interval '180 days' and sp.valid_from < current_date - interval '90 days')
          or (v_freshness = 'stale' and sp.valid_from < current_date - interval '180 days')
          or (v_freshness = 'unknown' and sp.valid_from is null)
        )
    ) counted
  )
  select
    case when input_after_product_code is null then fc.total_count else null end,
    p.id,
    p.product_code,
    p.brand,
    p.description,
    p.oem_no,
    p.buy_price,
    p.currency,
    p.valid_from,
    p.moq,
    p.order_multiple,
    p.lead_time_days,
    p.notes,
    p.freshness
  from page p
  cross join first_page_count fc
  order by coalesce(p.product_code, '') asc, p.id asc;
end;
$function$;

revoke all on function public.cloud_supplier_price_export_page(uuid, uuid, uuid, text, text, text, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.cloud_supplier_price_export_page(uuid, uuid, uuid, text, text, text, uuid, integer)
  to service_role;
