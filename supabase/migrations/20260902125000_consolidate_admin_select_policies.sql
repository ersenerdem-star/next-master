-- Admin ALL policies already grant administrators their reads. Excluding
-- admins from the broad SELECT policies removes duplicate permissive paths
-- without changing access for staff/customer roles.
alter policy brands_select_own_org on public.brands
  using (organization_id = current_profile_org_id() and not is_admin());
alter policy suppliers_select_own_org on public.suppliers
  using (organization_id = current_profile_org_id() and not is_admin());
alter policy catalog_select_own_org on public.catalog_products
  using (organization_id = current_profile_org_id() and not is_admin());
alter policy imports_select_own_org on public.imports
  using (organization_id = current_profile_org_id() and not is_admin());
alter policy supplier_prices_select_own_org on public.supplier_prices
  using (organization_id = current_profile_org_id() and not is_admin());
alter policy customer_price_lists_select_own_org on public.customer_price_lists
  using (organization_id = current_profile_org_id() and not is_admin());
alter policy customer_price_items_select_own_org on public.customer_price_list_items
  using (organization_id = current_profile_org_id() and not is_admin());
alter policy profiles_select_own_org on public.profiles
  using (id = auth.uid() and not is_admin());
alter policy import_jobs_select_own_org on public.import_jobs
  using (organization_id = current_profile_org_id() and not is_admin());
alter policy item_code_references_select_own_org on public.item_code_references
  using (organization_id = current_profile_org_id() and not is_admin());
