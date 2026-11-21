-- Search every verified OE identifier without flattening multiple manufacturers' numbers
-- into the canonical single-value field. Exact product codes retain first rank.
-- No price, order, product, or identifier rows are changed.

CREATE OR REPLACE FUNCTION public.search_catalog_products(input_search text DEFAULT ''::text, input_brand text DEFAULT ''::text, input_market_segment text DEFAULT ''::text, input_page integer DEFAULT 1, input_page_size integer DEFAULT 250)
 RETURNS TABLE(total_count bigint, product_id uuid, product_code text, brand text, image_url text, market_segment text, description text, oem_no text, hs_code text, origin text, weight_kg numeric, lifecycle_status text, lifecycle_note text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
      lower(nullif(trim(coalesce(input_search, '')), '')) as raw_search_lower,
      public.normalize_part_code(input_search) as search_norm,
      public.normalize_part_code(input_brand) as brand_norm,
      coalesce(public.normalize_catalog_market_segment(input_market_segment), '') as segment_norm,
      greatest(coalesce(input_page, 1), 1) as page_no,
      least(greatest(coalesce(input_page_size, 250), 1), 1000) as page_size
  ),
  exact_matches as (
    select
      cp.id,
      cp.product_code,
      b.name as brand,
      cp.image_url,
      coalesce(public.normalize_catalog_market_segment(cp.market_segment), cp.market_segment) as market_segment,
      cp.description,
      cp.oem_no,
      cp.hs_code,
      cp.origin,
      cp.weight_kg,
      cp.lifecycle_status,
      cp.lifecycle_note,
      case
        when cp.normalized_code = p.search_norm then 0
        when cp.normalized_oem = p.search_norm then 1
        when cp.id in (
          select identifier.catalog_product_id
          from public.catalog_product_identifiers identifier
          where identifier.organization_id = org_id
            and identifier.identifier_type = 'oem'
            and identifier.normalized_value = p.search_norm
        ) then 1
        when cp.normalized_code like p.search_norm || '%' then 2
        when cp.normalized_oem like p.search_norm || '%' then 3
        else 4
      end as match_rank
    from public.catalog_products cp
    join public.brands b on b.id = cp.brand_id
    cross join params p
    where cp.organization_id = org_id
      and (p.brand_norm = '' or coalesce(b.normalized_name, public.normalize_part_code(b.name)) = p.brand_norm)
      and (p.segment_norm = '' or coalesce(public.normalize_catalog_market_segment(cp.market_segment), '') = p.segment_norm)
      and p.raw_search is not null
      and p.search_norm <> ''
      and (
        cp.normalized_code = p.search_norm
        or cp.normalized_oem = p.search_norm
        or cp.id in (
          select identifier.catalog_product_id
          from public.catalog_product_identifiers identifier
          where identifier.organization_id = org_id
            and identifier.identifier_type = 'oem'
            and identifier.normalized_value = p.search_norm
        )
        or cp.normalized_code like p.search_norm || '%'
        or cp.normalized_oem like p.search_norm || '%'
      )
  ),
  broad_matches_when_exact as (
    select
      cp.id,
      cp.product_code,
      b.name as brand,
      cp.image_url,
      coalesce(public.normalize_catalog_market_segment(cp.market_segment), cp.market_segment) as market_segment,
      cp.description,
      cp.oem_no,
      cp.hs_code,
      cp.origin,
      cp.weight_kg,
      cp.lifecycle_status,
      cp.lifecycle_note,
      10 as match_rank
    from public.catalog_products cp
    join public.brands b on b.id = cp.brand_id
    cross join params p
    where cp.organization_id = org_id
      and exists (select 1 from exact_matches)
      and (p.brand_norm = '' or coalesce(b.normalized_name, public.normalize_part_code(b.name)) = p.brand_norm)
      and (p.segment_norm = '' or coalesce(public.normalize_catalog_market_segment(cp.market_segment), '') = p.segment_norm)
      and p.raw_search is not null
      and cp.search_text ilike '%' || p.raw_search_lower || '%'
      and not exists (select 1 from exact_matches em where em.id = cp.id)
    order by cp.product_code, cp.id
    limit 1000
  ),
  broad_matches_without_exact as (
    select
      cp.id,
      cp.product_code,
      b.name as brand,
      cp.image_url,
      coalesce(public.normalize_catalog_market_segment(cp.market_segment), cp.market_segment) as market_segment,
      cp.description,
      cp.oem_no,
      cp.hs_code,
      cp.origin,
      cp.weight_kg,
      cp.lifecycle_status,
      cp.lifecycle_note,
      10 as match_rank
    from public.catalog_products cp
    join public.brands b on b.id = cp.brand_id
    cross join params p
    where cp.organization_id = org_id
      and not exists (select 1 from exact_matches)
      and (p.brand_norm = '' or coalesce(b.normalized_name, public.normalize_part_code(b.name)) = p.brand_norm)
      and (p.segment_norm = '' or coalesce(public.normalize_catalog_market_segment(cp.market_segment), '') = p.segment_norm)
      and p.raw_search is not null
      and cp.search_text ilike '%' || p.raw_search_lower || '%'
  ),
  no_search_matches as (
    select
      cp.id,
      cp.product_code,
      b.name as brand,
      cp.image_url,
      coalesce(public.normalize_catalog_market_segment(cp.market_segment), cp.market_segment) as market_segment,
      cp.description,
      cp.oem_no,
      cp.hs_code,
      cp.origin,
      cp.weight_kg,
      cp.lifecycle_status,
      cp.lifecycle_note,
      20 as match_rank
    from public.catalog_products cp
    join public.brands b on b.id = cp.brand_id
    cross join params p
    where cp.organization_id = org_id
      and (p.brand_norm = '' or coalesce(b.normalized_name, public.normalize_part_code(b.name)) = p.brand_norm)
      and (p.segment_norm = '' or coalesce(public.normalize_catalog_market_segment(cp.market_segment), '') = p.segment_norm)
      and p.raw_search is null
  ),
  combined as (
    select * from no_search_matches
    union all
    select * from exact_matches
    union all
    select * from broad_matches_when_exact
    union all
    select * from broad_matches_without_exact
  ),
  collapsed as (
    select distinct on (combined.id)
      combined.*
    from combined
    order by combined.id, combined.match_rank, combined.product_code
  ),
  counted as (
    select
      collapsed.*,
      count(*) over () as total_count,
      row_number() over (order by collapsed.match_rank, collapsed.product_code, collapsed.id) as row_no
    from collapsed
  ),
  paged as (
    select counted.*
    from counted
    cross join params p
    where counted.row_no > ((p.page_no - 1) * p.page_size)
      and counted.row_no <= (p.page_no * p.page_size)
  )
  select
    paged.total_count,
    paged.id,
    paged.product_code,
    paged.brand,
    paged.image_url,
    paged.market_segment,
    paged.description,
    paged.oem_no,
    paged.hs_code,
    paged.origin,
    paged.weight_kg,
    paged.lifecycle_status,
    paged.lifecycle_note
  from paged
  order by paged.row_no;
end;
$function$
;

-- Keep the live RPC privileges on both upgrades and fresh databases.
revoke all on function public.search_catalog_products(text, text, text, integer, integer) from public;
grant execute on function public.search_catalog_products(text, text, text, integer, integer) to authenticated, service_role;
CREATE OR REPLACE FUNCTION public.cloud_catalog_integrity_page(input_search text DEFAULT ''::text, input_brand text DEFAULT ''::text, input_market_segment text DEFAULT ''::text, input_integrity_filter text DEFAULT ''::text, input_page integer DEFAULT 1, input_page_size integer DEFAULT 50)
 RETURNS TABLE(total_count bigint, has_more boolean, product_id uuid, product_code text, brand text, image_url text, market_segment text, description text, oem_no text, vehicle text, hs_code text, origin text, weight_kg numeric, ean text, lifecycle_status text, lifecycle_note text, integrity_status text, critical_missing_fields text[], optional_missing_fields text[], conflict_fields text[], pending_conflict_count integer, last_evaluated_at timestamp with time zone, integrity_last_error text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_organization_id uuid;
  v_raw_search text;
  v_search_norm text;
  v_brand_norm text;
  v_brand_id uuid;
  v_segment_norm text;
  v_integrity_filter text;
  v_page_size integer;
  v_row_offset integer;
begin
  v_organization_id := public.current_profile_org_id();
  v_raw_search := nullif(trim(coalesce(input_search, '')), '');
  v_search_norm := public.normalize_part_code(input_search);
  v_brand_norm := public.normalize_part_code(input_brand);
  v_segment_norm := coalesce(
    public.normalize_catalog_market_segment(input_market_segment),
    ''
  );
  v_integrity_filter := lower(trim(coalesce(input_integrity_filter, '')));
  v_page_size := least(greatest(coalesce(input_page_size, 50), 1), 250);
  v_row_offset := greatest(0, (greatest(coalesce(input_page, 1), 1) - 1) * v_page_size);

  if v_brand_norm <> '' then
    select candidate.id
    into v_brand_id
    from public.brands candidate
    where candidate.organization_id = v_organization_id
      and coalesce(
        candidate.normalized_name,
        public.normalize_part_code(candidate.name)
      ) = v_brand_norm
    limit 1;

    if v_brand_id is null then
      return;
    end if;
  end if;

  /*
   * Normal catalog browsing does not filter on integrity state. Materializing
   * the small product page before the integrity join prevents a tenant-wide
   * join and keeps this path comfortably inside the API timeout.
   */
  if v_integrity_filter in ('', 'all') then
    return query
    with page_base as materialized (
      select
        product.id,
        product.product_code,
        product.brand_id,
        product.image_url,
        product.market_segment,
        product.description,
        product.oem_no,
        product.vehicle,
        product.hs_code,
        product.origin,
        product.weight_kg,
        product.ean,
        product.lifecycle_status,
        product.lifecycle_note
      from public.catalog_products product
      where product.organization_id = v_organization_id
        and (v_brand_norm = '' or product.brand_id = v_brand_id)
        and (v_segment_norm = '' or product.market_segment = v_segment_norm)
        and (
          v_raw_search is null
          or product.product_code ilike '%' || v_raw_search || '%'
          or coalesce(product.description, '') ilike '%' || v_raw_search || '%'
          or coalesce(product.oem_no, '') ilike '%' || v_raw_search || '%'
          or product.normalized_code like '%' || v_search_norm || '%'
          or coalesce(product.normalized_oem, '') like '%' || v_search_norm || '%'
          or (v_search_norm <> '' and product.id in (
            select identifier.catalog_product_id
            from public.catalog_product_identifiers identifier
            where identifier.organization_id = v_organization_id
              and identifier.identifier_type = 'oem'
              and identifier.normalized_value = v_search_norm
          ))
        )
      order by product.product_code, product.id
      offset v_row_offset
      limit v_page_size + 1
    ),
    page_marked as (
      select
        page_product.*,
        row_number() over (
          order by page_product.product_code, page_product.id
        ) as page_row_number
      from page_base page_product
    )
    select
      null::bigint,
      (select count(*) > v_page_size from page_base),
      page_product.id,
      page_product.product_code,
      brand_row.name,
      page_product.image_url,
      page_product.market_segment,
      page_product.description,
      page_product.oem_no,
      page_product.vehicle,
      page_product.hs_code,
      page_product.origin,
      page_product.weight_kg,
      page_product.ean,
      page_product.lifecycle_status,
      page_product.lifecycle_note,
      coalesce(integrity.status, 'unknown'),
      coalesce(integrity.critical_missing_fields, array[]::text[]),
      coalesce(integrity.optional_missing_fields, array[]::text[]),
      coalesce(integrity.conflict_fields, array[]::text[]),
      coalesce(integrity.pending_conflict_count, 0),
      integrity.last_evaluated_at,
      integrity.last_error
    from page_marked page_product
    join public.brands brand_row
      on brand_row.id = page_product.brand_id
     and brand_row.organization_id = v_organization_id
    left join public.catalog_product_integrity integrity
      on integrity.organization_id = v_organization_id
     and integrity.product_id = page_product.id
    where page_product.page_row_number <= v_page_size
    order by page_product.product_code, page_product.id;

    return;
  end if;

  /*
   * Integrity-specific filters must be applied before pagination to preserve
   * their semantics. Direct brand and canonical segment predicates still let
   * Postgres use the existing tenant/brand/segment indexes.
   */
  return query
  with filtered as (
    select
      product.id,
      product.product_code,
      product.brand_id,
      product.image_url,
      product.market_segment,
      product.description,
      product.oem_no,
      product.vehicle,
      product.hs_code,
      product.origin,
      product.weight_kg,
      product.ean,
      product.lifecycle_status,
      product.lifecycle_note,
      coalesce(integrity.status, 'unknown') as product_integrity_status,
      coalesce(integrity.critical_missing_fields, array[]::text[]) as product_critical_missing_fields,
      coalesce(integrity.optional_missing_fields, array[]::text[]) as product_optional_missing_fields,
      coalesce(integrity.conflict_fields, array[]::text[]) as product_conflict_fields,
      coalesce(integrity.pending_conflict_count, 0) as product_pending_conflict_count,
      integrity.last_evaluated_at as product_last_evaluated_at,
      integrity.last_error as product_integrity_last_error
    from public.catalog_products product
    left join public.catalog_product_integrity integrity
      on integrity.organization_id = product.organization_id
     and integrity.product_id = product.id
    where product.organization_id = v_organization_id
      and (v_brand_norm = '' or product.brand_id = v_brand_id)
      and (v_segment_norm = '' or product.market_segment = v_segment_norm)
      and (
        v_raw_search is null
        or product.product_code ilike '%' || v_raw_search || '%'
        or coalesce(product.description, '') ilike '%' || v_raw_search || '%'
        or coalesce(product.oem_no, '') ilike '%' || v_raw_search || '%'
        or product.normalized_code like '%' || v_search_norm || '%'
        or coalesce(product.normalized_oem, '') like '%' || v_search_norm || '%'
          or (v_search_norm <> '' and product.id in (
            select identifier.catalog_product_id
            from public.catalog_product_identifiers identifier
            where identifier.organization_id = v_organization_id
              and identifier.identifier_type = 'oem'
              and identifier.normalized_value = v_search_norm
          ))
      )
      and (
        (v_integrity_filter = 'conflict' and integrity.status = 'conflict')
        or (v_integrity_filter = 'incomplete' and integrity.status = 'incomplete')
        or (
          v_integrity_filter = 'missing_ean'
          and coalesce(integrity.optional_missing_fields, array[]::text[])
            @> array['ean']::text[]
        )
        or (
          v_integrity_filter = 'pending'
          and coalesce(integrity.status, 'unknown') in ('unknown', 'queued', 'evaluating')
        )
        or (v_integrity_filter = 'failed' and integrity.status = 'failed')
      )
  ),
  page_rows as materialized (
    select filtered_product.*
    from filtered filtered_product
    order by filtered_product.product_code, filtered_product.id
    offset v_row_offset
    limit v_page_size + 1
  ),
  page_marked as (
    select
      page_product.*,
      row_number() over (
        order by page_product.product_code, page_product.id
      ) as page_row_number
    from page_rows page_product
  )
  select
    null::bigint,
    (select count(*) > v_page_size from page_rows),
    page_product.id,
    page_product.product_code,
    brand_row.name,
    page_product.image_url,
    page_product.market_segment,
    page_product.description,
    page_product.oem_no,
    page_product.vehicle,
    page_product.hs_code,
    page_product.origin,
    page_product.weight_kg,
    page_product.ean,
    page_product.lifecycle_status,
    page_product.lifecycle_note,
    page_product.product_integrity_status,
    page_product.product_critical_missing_fields,
    page_product.product_optional_missing_fields,
    page_product.product_conflict_fields,
    page_product.product_pending_conflict_count,
    page_product.product_last_evaluated_at,
    page_product.product_integrity_last_error
  from page_marked page_product
  join public.brands brand_row
    on brand_row.id = page_product.brand_id
   and brand_row.organization_id = v_organization_id
  where page_product.page_row_number <= v_page_size
  order by page_product.product_code, page_product.id;
end;
$function$
;

revoke all on function public.cloud_catalog_integrity_page(text, text, text, text, integer, integer) from public;
grant execute on function public.cloud_catalog_integrity_page(text, text, text, text, integer, integer) to authenticated, service_role;

