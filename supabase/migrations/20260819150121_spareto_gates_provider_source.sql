-- Register Gates and its reviewed Spareto source for the guarded provider
-- publication path. Collection uses robots-advertised product sitemap/detail
-- URLs only; the disallowed brand[] listing route is never used.
-- This migration does not write catalog_products.

insert into public.brands (
  organization_id,
  name
)
values (
  '1e4c5e99-e387-41aa-a6d3-cbe74558f766'::uuid,
  'Gates'
)
on conflict (organization_id, normalized_name)
do update set
  name = excluded.name,
  updated_at = now();

insert into public.catalog_external_sources (
  organization_id,
  source_key,
  display_name,
  source_owner,
  source_type,
  base_url,
  license_posture,
  robots_posture,
  rate_limit_posture,
  credential_boundary,
  is_active,
  metadata
)
values (
  '1e4c5e99-e387-41aa-a6d3-cbe74558f766'::uuid,
  'spareto_gates_product_catalog',
  'Spareto Gates Product Catalog',
  'Spareto / Gates product pages',
  'open_web',
  'https://spareto.com',
  'allowed',
  'allowed',
  'bounded',
  'none',
  true,
  jsonb_build_object(
    'access_mode', 'robots_sitemap_and_exact_product_identity',
    'brand_list_route_used', false,
    'automated_read_only_approved', true,
    'internal_catalog_persistence_allowed', true,
    'public_republication', false,
    'attribution', 'Spareto / Gates',
    'approval_actor', 'Next-Master Product Decision Owner (user)',
    'publication_approval_reference', 'user-request-2026-08-19-spareto-gates-production',
    'approved_at', '2026-08-19',
    'allowed_brands', jsonb_build_array('Gates'),
    'rate_limit', 'minimum 600ms between product detail requests',
    'robots_boundary', 'brand[] and per_page listing routes are not used; robots-advertised product sitemap and exact product pages only',
    'manifest_source', 'spareto.sitemap-manifest.v1'
  )
)
on conflict (organization_id, source_key)
do update set
  display_name = excluded.display_name,
  source_owner = excluded.source_owner,
  source_type = excluded.source_type,
  base_url = excluded.base_url,
  license_posture = excluded.license_posture,
  robots_posture = excluded.robots_posture,
  rate_limit_posture = excluded.rate_limit_posture,
  credential_boundary = excluded.credential_boundary,
  is_active = excluded.is_active,
  metadata = excluded.metadata,
  updated_at = now();
