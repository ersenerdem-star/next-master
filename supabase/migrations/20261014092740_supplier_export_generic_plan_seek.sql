-- A nullable OR cursor lets PL/pgSQL generic plans scan/sort the entire release.
-- Every eligible published SKU is nonempty, so the empty lower bound admits
-- the same first page and keeps subsequent tuple comparisons directly indexed.
-- The legacy branch also gets a redundant inclusive index bound, preserving
-- blank/null code and cursor compatibility without scanning earlier SKUs.
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
  v_has_pointer boolean;
  v_release_id uuid;
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

  select exists(select 1 from public.supplier_current_price_pointers ptr
    where ptr.organization_id=input_organization_id and ptr.supplier_id=input_supplier_id and ptr.brand_id=input_brand_id)
    into v_has_pointer;
  if v_has_pointer then
    select ptr.release_id into v_release_id from public.supplier_current_price_pointers ptr
    join public.supplier_price_publications pub on pub.id=ptr.publication_id
      and pub.release_id=ptr.release_id and pub.organization_id=ptr.organization_id
      and pub.supplier_id=ptr.supplier_id and pub.brand_id=ptr.brand_id and pub.status='published'
    where ptr.organization_id=input_organization_id and ptr.supplier_id=input_supplier_id and ptr.brand_id=input_brand_id;
    -- An invalid pointer intentionally yields no rows; stale legacy prices are not substituted.
    return query with page as materialized (
      select r.* from public.supplier_price_release_rows r
      where r.release_id=v_release_id and r.row_status='accepted' and r.normalized_code=public.normalize_catalog_product_code(r.product_code) and r.buy_price>0 and r.currency='EUR' and r.valid_from<=current_date
          and r.normalized_code ~ '[A-Z0-9]'
          and (v_search is null or r.product_code ilike '%'||v_search||'%' or r.description ilike '%'||v_search||'%'
            or r.oem_no ilike '%'||v_search||'%' or (v_search_norm<>'' and
              (r.normalized_code like v_search_norm||'%' or public.normalize_part_code(r.oem_no) like v_search_norm||'%')))
          and (v_freshness='all'
            or (v_freshness='fresh' and r.valid_from>=current_date-90)
            or (v_freshness='aging' and r.valid_from>=current_date-180 and r.valid_from<current_date-90)
            or (v_freshness='stale' and r.valid_from<current_date-180)
            or (v_freshness='unknown' and r.valid_from is null))
        and (r.product_code collate "C",md5(r.id::text)::uuid)>
          (coalesce(input_after_product_code,'') collate "C",input_after_id)
      order by r.product_code collate "C",md5(r.id::text)::uuid limit v_page_size
    ), total as materialized (
      select count(*)::bigint n from public.supplier_price_release_rows r
      where input_after_product_code is null and r.release_id=v_release_id and r.row_status='accepted' and r.normalized_code=public.normalize_catalog_product_code(r.product_code) and r.buy_price>0 and r.currency='EUR' and r.valid_from<=current_date
          and r.normalized_code ~ '[A-Z0-9]'
          and (v_search is null or r.product_code ilike '%'||v_search||'%' or r.description ilike '%'||v_search||'%'
            or r.oem_no ilike '%'||v_search||'%' or (v_search_norm<>'' and
              (r.normalized_code like v_search_norm||'%' or public.normalize_part_code(r.oem_no) like v_search_norm||'%')))
          and (v_freshness='all'
            or (v_freshness='fresh' and r.valid_from>=current_date-90)
            or (v_freshness='aging' and r.valid_from>=current_date-180 and r.valid_from<current_date-90)
            or (v_freshness='stale' and r.valid_from<current_date-180)
            or (v_freshness='unknown' and r.valid_from is null))
    )
    select case when input_after_product_code is null then t.n else null end,
      md5(p.id::text)::uuid,p.product_code,b.name,p.description,p.oem_no,p.buy_price,p.currency,
      p.valid_from,p.moq,null::integer,p.lead_time_days,p.notes,
      case when p.valid_from is null then 'unknown' when p.valid_from<current_date-180 then 'stale'
        when p.valid_from<current_date-90 then 'aging' else 'fresh' end
    from page p cross join total t
    join public.brands b on b.id=input_brand_id and b.organization_id=input_organization_id
    order by p.product_code collate "C",md5(p.id::text)::uuid;
    return;
  end if;

  return query
  with scoped as not materialized (
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
      and coalesce(sp.product_code,'') collate "C">=coalesce(input_after_product_code,'') collate "C"
      and (
        input_after_product_code is null
        or coalesce(sp.product_code, '') collate "C" > coalesce(input_after_product_code, '') collate "C"
        or (coalesce(sp.product_code, '') = coalesce(input_after_product_code, '') and input_after_id is not null and sp.id > input_after_id)
      )
  ),
  page as (
    select s.*
    from scoped s
    order by coalesce(s.product_code, '') collate "C" asc, s.id asc
    limit v_page_size
  ),
  first_page_count as materialized (
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
  order by coalesce(p.product_code, '') collate "C" asc, p.id asc;
end;
$function$;

revoke all on function public.cloud_supplier_price_export_page(uuid, uuid, uuid, text, text, text, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.cloud_supplier_price_export_page(uuid, uuid, uuid, text, text, text, uuid, integer)
  to service_role;

