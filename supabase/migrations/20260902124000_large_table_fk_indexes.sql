-- Cover remaining foreign keys on the large catalog/import relation tables.
-- Composite tenant indexes do not cover a foreign key whose first key is a
-- different column, so keep these narrow indexes for delete/join planning.
create index if not exists idx_catalog_products_brand_fk
  on public.catalog_products (brand_id);
create index if not exists idx_supplier_prices_supplier_fk
  on public.supplier_prices (supplier_id);
create index if not exists idx_supplier_price_rollups_brand_fk
  on public.supplier_price_rollups (brand_id);
create index if not exists idx_catalog_product_attributes_product_org_fk
  on public.catalog_product_attributes (catalog_product_id, organization_id);
create index if not exists idx_catalog_product_attributes_source_org_fk
  on public.catalog_product_attributes (source_record_id, organization_id);
create index if not exists idx_catalog_product_identifiers_product_org_fk
  on public.catalog_product_identifiers (catalog_product_id, organization_id);
create index if not exists idx_catalog_product_identifiers_source_org_fk
  on public.catalog_product_identifiers (source_record_id, organization_id);
create index if not exists idx_catalog_external_observations_brand_fk
  on public.catalog_external_observations (brand_id);
create index if not exists idx_catalog_external_observations_catalog_product_fk
  on public.catalog_external_observations (catalog_product_id);
create index if not exists idx_catalog_external_observations_job_fk
  on public.catalog_external_observations (job_id);
create index if not exists idx_catalog_external_observations_run_fk
  on public.catalog_external_observations (run_id);
create index if not exists idx_catalog_external_observations_source_fk
  on public.catalog_external_observations (source_id);
create index if not exists idx_catalog_external_observations_trust_profile_fk
  on public.catalog_external_observations (trust_profile_id);
