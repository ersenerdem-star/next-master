-- Register the Dayco official catalog as a governed, read-only source.
-- The source is intentionally not dispatchable until its public catalog access
-- and parser are verified (the endpoint currently returns HTTP 403).
insert into public.catalog_external_sources (
  id,
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
select
  gen_random_uuid(),
  '1e4c5e99-e387-41aa-a6d3-cbe74558f766'::uuid,
  'dayco_official',
  'Dayco · official EMEA catalog',
  'Dayco',
  'manufacturer',
  'https://www.dayco.com/emea-en/catalog/',
  'internal_review_required',
  'unknown',
  'bounded',
  'none',
  true,
  jsonb_build_object(
    'allowed_brands', jsonb_build_array('Dayco'),
    'allowed_evidence_hosts', jsonb_build_array('www.dayco.com'),
    'brand_engine_read_allowed', false,
    'brand_engine_enrichment_allowed', false,
    'automatic_apply', false,
    'approval_actor', 'system-registration',
    'activation_status', 'registered_pending_access_verification',
    'access_test_status', 'HTTP_403',
    'preferred_provider_key', 'dayco_official',
    'preferred_source_url', 'https://www.dayco.com/emea-en/catalog/',
    'parser_status', 'not_implemented',
    'publication_approval_reference', 'pending-dayco-access-and-parser-review'
  )
where not exists (
  select 1
  from public.catalog_external_sources
  where organization_id = '1e4c5e99-e387-41aa-a6d3-cbe74558f766'::uuid
    and source_key = 'dayco_official'
);
