-- Match canonical EANs and preserved alternate EANs by exact normalized value.
CREATE OR REPLACE FUNCTION public.search_catalog_products(input_search text DEFAULT ''::text, input_brand text DEFAULT ''::text, input_market_segment text DEFAULT ''::text, input_page integer DEFAULT 1, input_page_size integer DEFAULT 250)
 RETURNS TABLE(total_count bigint, product_id uuid, product_code text, brand text, image_url text, market_segment text, description text, oem_no text, hs_code text, origin text, weight_kg numeric, lifecycle_status text, lifecycle_note text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
 SET plan_cache_mode TO 'force_custom_plan'
AS $function$
declare
  org_id uuid;
begin
  org_id := public.current_profile_org_id();
  if org_id is null or not public.is_superadmin() then
    raise exception 'Only active superadmin users can load catalog';
  end if;

  return query
  with params as not materialized (
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
        when cp.normalized_oem = p.search_norm or cp.normalized_ean = p.search_norm then 1
        when cp.id in (
          select identifier.catalog_product_id
          from public.catalog_product_identifiers identifier
          where identifier.organization_id = org_id
            and identifier.identifier_type in ('oem', 'ean')
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
      and cp.id in (
        select candidate.id from public.catalog_products candidate
        where candidate.organization_id = org_id
          and (candidate.normalized_code = p.search_norm
            or candidate.normalized_oem = p.search_norm
            or (candidate.normalized_ean <> '' and candidate.normalized_ean = p.search_norm)
            or candidate.normalized_code like p.search_norm || '%'
            or candidate.normalized_oem like p.search_norm || '%')
        union
        select identifier.catalog_product_id from public.catalog_product_identifiers identifier
        where identifier.organization_id = org_id
          and identifier.identifier_type in ('oem', 'ean')
          and identifier.normalized_value = p.search_norm
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

notify pgrst,'reload schema';
