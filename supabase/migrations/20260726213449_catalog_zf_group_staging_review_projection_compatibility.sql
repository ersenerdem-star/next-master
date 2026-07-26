-- NM-CATALOG-ZF-GROUP-STAGING-REVIEW-PROJECTION-COMPATIBILITY-DB-IMPLEMENTATION
-- View-only compatibility change. No route, write RPC, review, Guardian, Product,
-- provider, or Apply authority is created here.

create or replace view public.catalog_zf_new_product_staging_review_v
with (security_invoker = true)
as
select
  candidate.id,
  candidate.organization_id,
  candidate.brand_id,
  brand.name as brand,
  candidate.proposed_display_code,
  candidate.normalized_code,
  candidate.official_source_display_code,
  candidate.official_comparison_key,
  candidate.description,
  candidate.ean,
  candidate.hs_code,
  candidate.origin,
  candidate.weight_kg,
  candidate.oem_references,
  candidate.vehicle_applications,
  candidate.fitment_facts,
  candidate.engine_facts,
  candidate.lifecycle_status,
  candidate.lifecycle_note,
  candidate.replacement_candidates,
  candidate.supersession_candidates,
  candidate.official_image_candidate_url,
  candidate.official_image_evidence_reference,
  candidate.official_source_url,
  candidate.observed_at,
  candidate.evidence_hash,
  candidate.payload_fingerprint,
  candidate.observation_fingerprint,
  candidate.candidate_version,
  candidate.supersedes_candidate_id,
  candidate.quarantine_class,
  candidate.limitation_flags,
  candidate.source_schema_version,
  candidate.runtime_commit,
  candidate.deploy_id,
  candidate.created_at,
  latest_event.event_type as latest_event_type,
  latest_event.event_version as latest_event_version,
  latest_event.reason_code as latest_event_reason_code,
  latest_event.created_at as latest_event_at,
  candidate.run_id,
  candidate.job_id,
  candidate.source_id,
  candidate.contract_version
from public.catalog_new_product_staging_candidates candidate
join public.brands brand
  on brand.id = candidate.brand_id
 and brand.organization_id = candidate.organization_id
left join lateral (
  select event.event_type,
         event.event_version,
         event.reason_code,
         event.created_at
  from public.catalog_new_product_staging_events event
  where event.organization_id = candidate.organization_id
    and event.candidate_id = candidate.id
  order by event.event_version desc
  limit 1
) latest_event on true;

revoke all on table public.catalog_zf_new_product_staging_review_v
  from public, anon, authenticated, service_role;
grant select on table public.catalog_zf_new_product_staging_review_v
  to authenticated;

comment on view public.catalog_zf_new_product_staging_review_v is
  'Tenant-scoped security-invoker staging evidence projection, caller-token and RLS read only, no service-role read or Product Apply authority.';
