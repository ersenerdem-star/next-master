-- Keep the browser-facing report under the caller's existing RLS policies.
-- Scope the product scan before matching identifiers, and use one indexed
-- existence lookup per candidate so the optimizer cannot start with all OEMs.
set local lock_timeout = '5s';

create or replace function public.catalog_titanx_oem_reference_correction(
  input_brand_id uuid default null
)
returns bigint
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with scope as materialized (
    select b.organization_id, b.id as brand_id
    from public.brands b
    where b.organization_id = (select public.current_profile_org_id())
      and lower(trim(b.name)) = 'titanx'
      and (input_brand_id is null or b.id = input_brand_id)
  ), products as materialized (
    select product.id, s.organization_id
    from scope s
    cross join lateral (
      select p.id
      from public.catalog_products p
      where p.organization_id = s.organization_id and p.brand_id = s.brand_id
        and nullif(trim(coalesce(p.oem_no, '')), '') is null
      offset 0
    ) product
  )
  select count(*)
  from products p
  cross join lateral (
    select 1
    from public.catalog_product_identifiers i
    where i.organization_id = p.organization_id and i.catalog_product_id = p.id
      and i.identifier_type = 'oem'
      and nullif(trim(i.normalized_value), '') is not null
    limit 1
  ) as matched;
$$;

revoke all on function public.catalog_titanx_oem_reference_correction(uuid) from public, anon;
grant execute on function public.catalog_titanx_oem_reference_correction(uuid) to authenticated, service_role;
