-- Portal browse and SKU-prefix search for a published brand that has not yet
-- entered the governed product catalog. The catalog remains authoritative for
-- brands with catalog rows, and release rows remain price-only product offers.
-- The C collation makes prefix bounds deterministic even when the database's
-- default locale sorts punctuation after DEL.
create index if not exists idx_supplier_price_release_rows_portal_prefix
  on public.supplier_price_release_rows (release_id, normalized_code collate "C", id);

create or replace function public.cloud_portal_published_price_search_page_v3(
  input_organization_id uuid,
  input_brand_id uuid,
  input_code_prefix text,
  input_limit integer
)
returns table (
  product_code text,
  normalized_code text,
  description text,
  buy_price numeric,
  price_date date
)
language plpgsql
stable
security invoker
set search_path to ''
as $function$
declare
  v_prefix text;
  v_limit integer;
begin
  v_prefix := pg_catalog.upper(pg_catalog.regexp_replace(
    pg_catalog.btrim(coalesce(input_code_prefix, '')),
    '[[:space:]]+', '', 'g'
  ));
  v_limit := least(greatest(coalesce(input_limit, 24), 1), 24);
  if input_organization_id is null or input_brand_id is null
    or pg_catalog.length(v_prefix) > 64
    or (v_prefix <> '' and v_prefix !~ '^[A-Z0-9][A-Z0-9._/+-]*$') then
    raise exception 'PORTAL_PUBLISHED_SEARCH_INPUT_INVALID';
  end if;

  return query
  with current_releases as materialized (
    select ptr.release_id
    from public.supplier_current_price_pointers ptr
    join public.supplier_price_publications pub
      on pub.id = ptr.publication_id
      and pub.release_id = ptr.release_id
      and pub.organization_id = ptr.organization_id
      and pub.supplier_id = ptr.supplier_id
      and pub.brand_id = ptr.brand_id
      and pub.status = 'published'
    where ptr.organization_id = input_organization_id
      and ptr.brand_id = input_brand_id
      and not exists (
        select 1 from public.catalog_products cp
        where cp.organization_id = input_organization_id
          and cp.brand_id = input_brand_id
      )
  ),
  candidates as materialized (
    select r.normalized_code, r.product_code, r.description,
      r.buy_price, r.valid_from, r.id
    from current_releases cr
    cross join lateral (
      select r.normalized_code, r.product_code, r.description,
        r.buy_price, r.valid_from, r.id
      from public.supplier_price_release_rows r
      where r.release_id = cr.release_id
        and (v_prefix = '' or (
          r.normalized_code collate "C" >= v_prefix collate "C"
          and r.normalized_code collate "C" < (v_prefix || pg_catalog.chr(127)) collate "C"
          and pg_catalog.left(r.normalized_code, pg_catalog.length(v_prefix)) = v_prefix
        ))
        and r.row_status = 'accepted'
        and r.buy_price > 0
        and r.currency = 'EUR'
        and r.valid_from <= current_date
        and r.normalized_code ~ '[A-Z0-9]'
        and r.normalized_code = pg_catalog.upper(pg_catalog.regexp_replace(
          r.product_code, '[[:space:]]+', '', 'g'
        ))
      order by r.normalized_code collate "C", r.id
      limit 96
    ) r
  ),
  winners as (
    select distinct on (c.normalized_code) c.normalized_code,
      c.product_code, c.description, c.buy_price, c.valid_from
    from candidates c
    order by c.normalized_code, c.buy_price, c.valid_from desc, c.id
  )
  select w.product_code, w.normalized_code, w.description,
    w.buy_price, w.valid_from
  from winners w
  order by w.normalized_code
  limit v_limit;
end;
$function$;

revoke all on function public.cloud_portal_published_price_search_page_v3(uuid,uuid,text,integer)
  from public, anon, authenticated;
grant execute on function public.cloud_portal_published_price_search_page_v3(uuid,uuid,text,integer)
  to service_role;
