-- Register Corteco's bounded TecAlliance observation channel for MIRA.
-- This is observation-only: no catalog_products write and no Apply authority.

insert into public.catalog_external_sources (
  organization_id, source_key, display_name, source_owner, source_type, base_url,
  license_posture, robots_posture, rate_limit_posture, credential_boundary,
  is_active, metadata
)
values (
  '1e4c5e99-e387-41aa-a6d3-cbe74558f766'::uuid,
  'tecalliance_corteco',
  'Corteco TecAlliance official catalog',
  'TecAlliance / Corteco',
  'external_catalog',
  'https://web.tecalliance.net/ecatcorteco/en/home',
  'allowed', 'allowed', 'bounded', 'none', true,
  jsonb_build_object(
    'automated_read_only_approved', true,
    'internal_observation_allowed', true,
    'internal_catalog_persistence_allowed', false,
    'public_republication', false,
    'allowed_brands', jsonb_build_array('Corteco'),
    'provider_id', 25647,
    'data_supplier_id', 140,
    'rate_limit', 'minimum 1000ms between bounded requests',
    'robots_url', 'https://web.tecalliance.net/robots.txt',
    'approval_reference', 'user-request-2026-09-01-corteco-mira-review-only'
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

insert into public.catalog_external_source_trust_profiles (
  organization_id, source_id, trust_level, trust_score, allowed_field_families,
  auto_enrichment_allowed_fields, protected_field_families,
  human_review_required, downstream_publication_restriction, evidence_required,
  is_active, notes
)
select
  s.organization_id, s.id, 'T4', 0.92,
  array['ean_reference','supplemental_description','oem_reference','technical_specification']::text[],
  array[]::text[],
  array['product_identity','canonical_product_code','brand_ownership','oem_reference','replacement','supersession','discontinued_state','fitment','supplier_linkage']::text[],
  true, 'internal_only', true, true,
  'MIRA staged observation only; canonical publication requires human review.'
from public.catalog_external_sources s
where s.organization_id = '1e4c5e99-e387-41aa-a6d3-cbe74558f766'::uuid
  and s.source_key = 'tecalliance_corteco'
on conflict (organization_id, source_id)
do update set
  trust_level = excluded.trust_level,
  trust_score = excluded.trust_score,
  allowed_field_families = excluded.allowed_field_families,
  auto_enrichment_allowed_fields = excluded.auto_enrichment_allowed_fields,
  human_review_required = true,
  downstream_publication_restriction = 'internal_only',
  evidence_required = true,
  is_active = true,
  notes = excluded.notes,
  updated_at = now();

insert into public.catalog_observation_jobs (
  organization_id, source_id, trust_profile_id, brand_id, job_key, status,
  observation_scope, sync_mode, allowed_field_families, max_observations_per_run,
  max_retry_attempts, lock_timeout_seconds, metadata
)
select
  s.organization_id, s.id, t.id, b.id, 'mira_corteco_tecalliance', 'active',
  'single_brand', 'observation_only',
  array['ean_reference','supplemental_description','oem_reference','technical_specification']::text[],
  500, 3, 600,
  jsonb_build_object('mira_intake_protocol','v1','collector','tecalliance-catalog-discovery.v1')
from public.catalog_external_sources s
join public.catalog_external_source_trust_profiles t
  on t.organization_id = s.organization_id and t.source_id = s.id and t.is_active
join public.brands b
  on b.organization_id = s.organization_id and lower(b.name) = 'corteco'
where s.organization_id = '1e4c5e99-e387-41aa-a6d3-cbe74558f766'::uuid
  and s.source_key = 'tecalliance_corteco'
on conflict (organization_id, source_id, brand_id, job_key)
do update set
  status = 'active',
  sync_mode = 'observation_only',
  allowed_field_families = excluded.allowed_field_families,
  metadata = excluded.metadata,
  updated_at = now();
