-- NM-CATALOG-WP2-F2-H2: harden browser-role Product writes for image_url.
-- This leaves service_role and DB-owned controlled Apply behavior unchanged.
-- Privileged source/import writer governance remains a separate follow-up.

revoke update on table public.catalog_products from authenticated;

grant update (
  brand_id,
  product_code,
  description,
  oem_no,
  vehicle,
  hs_code,
  origin,
  market_segment,
  weight_kg,
  lifecycle_status,
  lifecycle_note,
  updated_at
) on table public.catalog_products to authenticated;

revoke update on table public.catalog_products from anon, public;

comment on table public.catalog_products is
  'Catalog Product truth. Authenticated generic updates are restricted to explicit editor fields; image_url changes require a separately governed Catalog-owned path.';
