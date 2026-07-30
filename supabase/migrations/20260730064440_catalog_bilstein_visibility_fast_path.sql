/*
 * Bilstein catalog visibility correction.
 *
 * The authorized PartsFinder source is explicitly scoped to vehicle_type=CAR.
 * The catalog integrity page also joined the integrity table before applying
 * the page limit. Under integrity backfill load that exceeded the authenticated
 * role's statement timeout. The common browse path now pages products first and
 * joins integrity for at most page_size + 1 rows.
 */

drop function if exists public.cloud_catalog_integrity_page(
  text,
  text,
  text,
  text,
  integer,
  integer
);

create function public.cloud_catalog_integrity_page(
  input_search text default '',
  input_brand text default '',
  input_market_segment text default '',
  input_integrity_filter text default '',
  input_page integer default 1,
  input_page_size integer default 50
)
returns table (
  total_count bigint,
  has_more boolean,
  product_id uuid,
  product_code text,
  brand text,
  image_url text,
  market_segment text,
  description text,
  oem_no text,
  vehicle text,
  hs_code text,
  origin text,
  weight_kg numeric,
  ean text,
  lifecycle_status text,
  lifecycle_note text,
  integrity_status text,
  critical_missing_fields text[],
  optional_missing_fields text[],
  conflict_fields text[],
  pending_conflict_count integer,
  last_evaluated_at timestamptz,
  integrity_last_error text
)
language plpgsql
stable
security definer
set search_path = public
as $$
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
$$;

revoke all on function public.cloud_catalog_integrity_page(
  text,
  text,
  text,
  text,
  integer,
  integer
) from public;

grant execute on function public.cloud_catalog_integrity_page(
  text,
  text,
  text,
  text,
  integer,
  integer
) to authenticated;
