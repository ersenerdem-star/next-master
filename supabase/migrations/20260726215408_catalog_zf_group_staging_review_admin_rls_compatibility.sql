-- NM-CATALOG-ZF-GROUP-STAGING-REVIEW-ADMIN-RLS-COMPATIBILITY-DB-IMPLEMENTATION
-- Policy-only compatibility change. No view, grant, table, function, RPC,
-- trigger, index, write, review, Guardian, Product, or Apply authority.

drop policy if exists catalog_new_product_staging_candidates_select_admin_org
  on public.catalog_new_product_staging_candidates;
create policy catalog_new_product_staging_candidates_select_admin_org
on public.catalog_new_product_staging_candidates
for select
to authenticated
using (
  (select auth.uid()) is not null
  and (
    (select public.current_profile_role()) = 'admin'
    or (select public.is_superadmin())
  )
  and organization_id = (select public.current_profile_org_id())
);

drop policy if exists catalog_new_product_staging_events_select_admin_org
  on public.catalog_new_product_staging_events;
create policy catalog_new_product_staging_events_select_admin_org
on public.catalog_new_product_staging_events
for select
to authenticated
using (
  (select auth.uid()) is not null
  and (
    (select public.current_profile_role()) = 'admin'
    or (select public.is_superadmin())
  )
  and organization_id = (select public.current_profile_org_id())
);
