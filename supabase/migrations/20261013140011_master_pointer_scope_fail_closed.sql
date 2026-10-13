-- Amend staging after the first 140007 application: a pointer always owns its scope.
-- A bounded, tenant-scoped Master page for brands with a current published
-- supplier release. The scope bit prevents callers from displaying a stale
-- supplier_price_rollups page when the published page is empty or fails.
create or replace function public.cloud_master_published_price_page_v3(
  input_search text default '',
  input_brand_id uuid default null,
  input_page integer default 1,
  input_page_size integer default 50,
  input_margin_a numeric default 0.10,
  input_margin_b numeric default 0.15
)
returns jsonb
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  v_organization_id uuid;
  v_brand_name text;
  v_page integer;
  v_page_size integer;
  v_scan_limit integer;
  v_exact_code text;
  v_result jsonb;
begin
  if auth.uid() is null then
    raise exception 'MASTER_AUTH_REQUIRED';
  end if;
  v_organization_id := public.current_profile_org_id();
  if v_organization_id is null then
    raise exception 'MASTER_ACCESS_DENIED';
  end if;
  if input_brand_id is null or input_page is null or input_page not between 1 and 100
     or input_page_size is null or input_page_size not between 1 and 100
     or pg_catalog.length(coalesce(input_search, '')) > 100
     or input_margin_a is null or input_margin_a not between -1 and 10
     or input_margin_b is null or input_margin_b not between -1 and 10 then
    raise exception 'MASTER_PAGE_INPUT_INVALID';
  end if;
  select b.name into v_brand_name
  from public.brands b
  where b.id = input_brand_id and b.organization_id = v_organization_id;
  if v_brand_name is null then
    raise exception 'MASTER_BRAND_SCOPE_INVALID';
  end if;

  v_page := input_page;
  v_page_size := input_page_size;
  v_scan_limit := v_page * v_page_size;
  v_exact_code := nullif(
    pg_catalog.upper(pg_catalog.regexp_replace(
      pg_catalog.btrim(coalesce(input_search, '')), '[[:space:]]+', '', 'g')),
    '');
  -- Search is exact SKU identity. A punctuation-preserving code such as 61/1
  -- must never be merged with 611 by the legacy alphanumeric normalizer.

  with pointer_scope as materialized (
    select ptr.*
    from public.supplier_current_price_pointers ptr
    where ptr.organization_id = v_organization_id
      and ptr.brand_id = input_brand_id
  ),
  current_releases as materialized (
    select ptr.release_id, ptr.supplier_id, s.name as supplier_name,
      rel.accepted_rows
    from pointer_scope ptr
    join public.supplier_price_publications pub
      on pub.id = ptr.publication_id and pub.release_id = ptr.release_id
     and pub.organization_id = ptr.organization_id
     and pub.supplier_id = ptr.supplier_id and pub.brand_id = ptr.brand_id
     and pub.status = 'published'
    left join public.suppliers s
      on s.id = ptr.supplier_id and s.organization_id = ptr.organization_id
    left join public.supplier_price_releases rel
      on rel.id = ptr.release_id and rel.organization_id = ptr.organization_id
     and rel.supplier_id = ptr.supplier_id and rel.brand_id = ptr.brand_id
  ),
  release_codes as materialized (
    select candidate.normalized_code
    from current_releases cr
    cross join lateral (
      select distinct r.normalized_code
      from public.supplier_price_release_rows r
      where r.release_id = cr.release_id
        and (v_exact_code is null or r.normalized_code = v_exact_code)
        and r.row_status = 'accepted' and r.buy_price > 0
        and r.currency = 'EUR' and r.valid_from <= current_date
        and r.normalized_code ~ '[A-Z0-9]'
        and r.normalized_code = pg_catalog.upper(
          pg_catalog.regexp_replace(r.product_code, '[[:space:]]+', '', 'g'))
      order by r.normalized_code
      limit v_scan_limit
    ) candidate
  ),
  page_codes as materialized (
    select distinct normalized_code
    from release_codes
    order by normalized_code
    limit v_page_size offset ((v_page - 1) * v_page_size)
  ),
  supplier_rows as materialized (
    select r.normalized_code, r.product_code, r.description, r.buy_price,
      r.valid_from, r.notes, cr.supplier_id, cr.supplier_name,
      row_number() over (
        partition by r.normalized_code, cr.supplier_id
        order by r.valid_from desc, r.id desc
      ) as supplier_rank
    from page_codes pc
    join current_releases cr on true
    join public.supplier_price_release_rows r
      on r.release_id = cr.release_id and r.normalized_code = pc.normalized_code
    where r.row_status = 'accepted' and r.buy_price > 0
      and r.currency = 'EUR' and r.valid_from <= current_date
      and r.normalized_code = pg_catalog.upper(
        pg_catalog.regexp_replace(r.product_code, '[[:space:]]+', '', 'g'))
  ),
  ranked as materialized (
    select sr.*,
      row_number() over (
        partition by sr.normalized_code
        order by sr.buy_price, sr.valid_from desc, sr.supplier_id
      ) as price_rank
    from supplier_rows sr
    where sr.supplier_rank = 1
  ),
  summary as materialized (
    select normalized_code,
      max(product_code) filter (where price_rank = 1) as product_code,
      max(description) filter (where price_rank = 1) as description,
      max(supplier_name) filter (where price_rank = 1) as cheapest_supplier,
      max(buy_price) filter (where price_rank = 1) as cheapest_price,
      max(supplier_name) filter (where price_rank = 2) as second_supplier_name,
      max(buy_price) filter (where price_rank = 2) as second_price,
      max(valid_from) filter (where price_rank = 1) as price_date,
      max(notes) filter (where price_rank = 1) as notes,
      count(*)::bigint as supplier_count
    from ranked
    group by normalized_code
  ),
  scope_totals as (
    -- Accepted-row metadata avoids a full 1M-row COUNT(DISTINCT) on every
    -- page. It is an upper-bound estimate when suppliers share SKUs or a
    -- historical release contains filtered rows.
    select exists(select 1 from pointer_scope) as has_published_scope,
      coalesce(sum(accepted_rows), 0)::bigint as estimated_count
    from current_releases
  )
  select pg_catalog.jsonb_build_object(
    'has_published_scope', st.has_published_scope,
    'rows', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'total_count', case when v_exact_code is null then st.estimated_count
          else 1 end,
        'product_id', null,
        'product_code', sm.product_code,
        'brand', v_brand_name,
        'description', sm.description,
        'oem_no', null, 'hs_code', null, 'origin', null, 'weight_kg', null,
        'cheapest_supplier', sm.cheapest_supplier,
        'cheapest_price', sm.cheapest_price,
        'second_supplier_name', sm.second_supplier_name,
        'second_price', sm.second_price,
        'price_gap', case when sm.second_price is null then null
          else sm.second_price - sm.cheapest_price end,
        'price_gap_percent', case when sm.second_price is null then null
          else pg_catalog.round((sm.second_price - sm.cheapest_price)
            * 100 / sm.cheapest_price, 2) end,
        'price_date', sm.price_date,
        'sales_a', pg_catalog.round(sm.cheapest_price * (1 + input_margin_a), 2),
        'sales_b', pg_catalog.round(sm.cheapest_price * (1 + input_margin_b), 2),
        'supplier_count', sm.supplier_count,
        'catalog_status', 'Supplier Price Only',
        'notes', sm.notes,
        'has_notes', nullif(pg_catalog.btrim(coalesce(sm.notes, '')), '') is not null
      ) order by sm.normalized_code)
      from summary sm
    ), '[]'::jsonb)
  ) into v_result
  from scope_totals st;

  return v_result;
end;
$function$;

revoke all on function public.cloud_master_published_price_page_v3(text,uuid,integer,integer,numeric,numeric)
  from public, anon;
grant execute on function public.cloud_master_published_price_page_v3(text,uuid,integer,integer,numeric,numeric)
  to authenticated;
