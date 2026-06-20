-- Catalog search hardening for admin and portal part lookups.
-- These indexes target normalized OEM/code contains searches and segment-scoped browsing.

create extension if not exists pg_trgm;

create index if not exists idx_catalog_products_product_code_trgm
  on public.catalog_products using gin (product_code gin_trgm_ops);

create index if not exists idx_catalog_products_normalized_code_trgm
  on public.catalog_products using gin (normalized_code gin_trgm_ops);

create index if not exists idx_catalog_products_normalized_oem_trgm
  on public.catalog_products using gin (normalized_oem gin_trgm_ops);

create index if not exists idx_catalog_products_vehicle_trgm
  on public.catalog_products using gin (vehicle gin_trgm_ops);

create index if not exists idx_catalog_products_org_brand_segment_normcode
  on public.catalog_products (organization_id, brand_id, market_segment, normalized_code);
