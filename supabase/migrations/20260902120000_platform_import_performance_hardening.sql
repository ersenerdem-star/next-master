-- Platform performance hardening for the large catalog/import workload.
-- This migration is intentionally idempotent so it is safe against the
-- existing production migration drift.

set lock_timeout = '5s';

-- portal_c_price_mode was never present in the production schema and is no
-- longer a supported pricing mode. Keep the drop conditional for old branches.
alter table if exists public.customers
  drop column if exists portal_c_price_mode;

-- user_presence had overlapping ALL and SELECT policies. Keep the same
-- tenant/self semantics while making each write operation explicit and
-- removing the redundant superadmin SELECT policy.
drop policy if exists user_presence_admin_manage_own_org on public.user_presence;
drop policy if exists user_presence_write_self on public.user_presence;
drop policy if exists user_presence_select_admin_org on public.user_presence;
drop policy if exists user_presence_admin_insert_own_org on public.user_presence;
drop policy if exists user_presence_admin_update_own_org on public.user_presence;
drop policy if exists user_presence_admin_delete_own_org on public.user_presence;
drop policy if exists user_presence_self_insert on public.user_presence;
drop policy if exists user_presence_self_update on public.user_presence;
drop policy if exists user_presence_self_delete on public.user_presence;
drop policy if exists user_presence_write_insert on public.user_presence;
drop policy if exists user_presence_write_update on public.user_presence;
drop policy if exists user_presence_write_delete on public.user_presence;

create policy user_presence_write_insert
  on public.user_presence for insert to public
  with check ((current_profile_role() = 'admin' and organization_id = current_profile_org_id())
    or (auth.uid() = user_id and organization_id = current_profile_org_id()));
create policy user_presence_write_update
  on public.user_presence for update to public
  using ((current_profile_role() = 'admin' and organization_id = current_profile_org_id())
    or (auth.uid() = user_id and organization_id = current_profile_org_id()))
  with check ((current_profile_role() = 'admin' and organization_id = current_profile_org_id())
    or (auth.uid() = user_id and organization_id = current_profile_org_id()));
create policy user_presence_write_delete
  on public.user_presence for delete to public
  using ((current_profile_role() = 'admin' and organization_id = current_profile_org_id())
    or (auth.uid() = user_id and organization_id = current_profile_org_id()));

-- Foreign-key indexes for the largest/highest-write tables. Existing
-- composite indexes are not a substitute for a leading FK index when the
-- planner validates/deletes referenced rows.
create index if not exists idx_supplier_prices_brand_fk
  on public.supplier_prices (brand_id);
create index if not exists idx_supplier_prices_catalog_product_fk
  on public.supplier_prices (catalog_product_id);
create index if not exists idx_supplier_prices_import_fk
  on public.supplier_prices (import_id);
create index if not exists idx_supplier_prices_organization_fk
  on public.supplier_prices (organization_id);
create index if not exists idx_catalog_import_stage_organization_fk
  on public.catalog_import_stage (organization_id);
create index if not exists idx_supplier_price_import_stage_organization_fk
  on public.supplier_price_import_stage (organization_id);
create index if not exists idx_supplier_price_rollups_cheapest_supplier_fk
  on public.supplier_price_rollups (cheapest_supplier_id);
create index if not exists idx_supplier_price_rollups_second_supplier_fk
  on public.supplier_price_rollups (second_supplier_id);
create index if not exists idx_catalog_product_attributes_organization_fk
  on public.catalog_product_attributes (organization_id);
create index if not exists idx_catalog_product_identifiers_organization_fk
  on public.catalog_product_identifiers (organization_id);

-- Make automatic maintenance react sooner to staged-import churn. VACUUM
-- itself cannot run inside a migration transaction; these settings let the
-- managed autovacuum perform it safely, while the operator runbook performs
-- the initial one-off VACUUM (ANALYZE).
alter table if exists public.catalog_products set (
  autovacuum_vacuum_scale_factor = 0.02,
  autovacuum_analyze_scale_factor = 0.01,
  autovacuum_vacuum_cost_limit = 2000
);
alter table if exists public.supplier_prices set (
  autovacuum_vacuum_scale_factor = 0.02,
  autovacuum_analyze_scale_factor = 0.01,
  autovacuum_vacuum_cost_limit = 2000
);
alter table if exists public.catalog_import_stage set (
  autovacuum_vacuum_scale_factor = 0.01,
  autovacuum_analyze_scale_factor = 0.005,
  autovacuum_vacuum_cost_limit = 2000
);
alter table if exists public.supplier_price_import_stage set (
  autovacuum_vacuum_scale_factor = 0.01,
  autovacuum_analyze_scale_factor = 0.005,
  autovacuum_vacuum_cost_limit = 2000
);
alter table if exists public.supplier_price_rollups set (
  autovacuum_vacuum_scale_factor = 0.02,
  autovacuum_analyze_scale_factor = 0.01,
  autovacuum_vacuum_cost_limit = 2000
);

-- Trigram search predicates are highly skewed by brand. A larger histogram
-- gives the planner a more realistic row estimate for prefix/substring search.
alter table if exists public.catalog_products
  alter column search_text set statistics 1000;
