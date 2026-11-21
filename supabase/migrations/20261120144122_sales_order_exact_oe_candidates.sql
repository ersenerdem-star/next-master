-- Read-only, exact-OE lookup for the existing sales-order workflow.  This is
-- SECURITY INVOKER: table grants and tenant RLS remain in force, and no price,
-- order, or catalog mutation is performed.
create function public.sales_order_exact_oe_candidates(
  input_oe text,
  input_brand text default '',
  input_page integer default 1,
  input_page_size integer default 50
)
returns table (
  product_id uuid,
  product_code text,
  brand text,
  description text,
  vehicle text,
  oem_no text,
  has_more boolean
)
language plpgsql
stable
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_org_id uuid := public.current_profile_org_id();
  v_oe text := public.normalize_part_code(coalesce(input_oe, ''));
  v_brand text := lower(btrim(coalesce(input_brand, '')));
  v_page integer := coalesce(input_page, 1);
  v_limit integer := coalesce(input_page_size, 50);
begin
  -- Match the existing save_sales_order_atomic role boundary and also honor
  -- explicit staff permissions and the office-IP guard; NULL is denied.
  if auth.uid() is null or v_org_id is null
     or not exists (select 1 from public.profiles p
       where p.id = auth.uid() and p.organization_id = v_org_id and p.is_active)
     or coalesce(public.current_profile_role(), '') not in ('admin', 'sales')
     or not coalesce(public.profile_has_permission('sales.orders'), false) then
    raise exception 'Active sales-order access required' using errcode = '42501';
  end if;
  if length(v_oe) < 3 or length(v_oe) > 100 or length(v_brand) > 100
     or v_page < 1 or v_page > 100 or v_limit < 1 or v_limit > 100 then
    raise exception 'Invalid OE search parameters' using errcode = '22023';
  end if;

  return query
  with matches as (
    -- Existing B-tree (organization_id, identifier_type, normalized_value).
    select i.catalog_product_id as id, i.value as oe
    from public.catalog_product_identifiers i
    where i.organization_id = v_org_id and i.identifier_type = 'oem' and i.normalized_value = v_oe
    union all
    -- Existing normalized_oem trigram index prefilters scalar/list candidates;
    -- compare each original list entry exactly before returning a product.
    select p.id, parts.oe
    from public.catalog_products p
    cross join lateral regexp_split_to_table(coalesce(p.oem_no, ''), '[,;|\n\r]+') as parts(oe)
    where p.organization_id = v_org_id and p.normalized_oem like '%' || v_oe || '%'
      and public.normalize_part_code(parts.oe) = v_oe
  ), unique_matches as (
    select m.id, min(m.oe) as oe from matches m group by m.id
  ), page_rows as materialized (
    select p.id, p.product_code, b.name as brand, p.description, p.vehicle, m.oe,
      row_number() over (order by lower(b.name), p.product_code, p.id) as rn
    from unique_matches m
    join public.catalog_products p on p.id = m.id and p.organization_id = v_org_id
    join public.brands b on b.id = p.brand_id and b.organization_id = v_org_id
    where v_brand = '' or lower(btrim(b.name)) = v_brand
    order by lower(b.name), p.product_code, p.id
    limit v_limit + 1 offset (v_page - 1) * v_limit
  )
  select r.id, r.product_code, r.brand, r.description, r.vehicle, r.oe,
    (select count(*) > v_limit from page_rows)
  from page_rows r
  order by r.rn
  limit v_limit;
end;
$$;

revoke all on function public.sales_order_exact_oe_candidates(text, text, integer, integer) from public, anon;
grant execute on function public.sales_order_exact_oe_candidates(text, text, integer, integer) to authenticated;
