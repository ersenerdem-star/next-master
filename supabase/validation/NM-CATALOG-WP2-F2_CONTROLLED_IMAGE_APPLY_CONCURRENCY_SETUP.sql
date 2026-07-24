-- Local-only setup for the two-session F2 Apply concurrency proof.
-- It creates no production data. Run only against the disposable local database.

begin;

delete from public.organizations
where id = '10000000-0000-0000-0000-000000000001'::uuid;

insert into public.organizations (id, name)
values ('10000000-0000-0000-0000-000000000001', 'F2 local concurrency organization');

insert into public.profiles (id, organization_id, email, full_name, role, is_active)
values
  ('10000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001', 'f2-concurrency-reviewer@local.invalid', 'F2 concurrency reviewer', 'admin', true),
  ('10000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-000000000001', 'f2-concurrency-authorizer@local.invalid', 'F2 concurrency authorizer', 'admin', true);

insert into public.brands (id, organization_id, name)
values ('10000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000001', 'F2 Concurrency Brand');

insert into public.catalog_products (id, organization_id, brand_id, product_code, description)
values ('10000000-0000-0000-0000-000000000005', '10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000004', 'F2-CONCURRENCY', 'Local concurrency Product');

insert into public.catalog_external_sources (id, organization_id, source_key, display_name, source_type, base_url, license_posture, robots_posture, rate_limit_posture, is_active)
values ('10000000-0000-0000-0000-000000000006', '10000000-0000-0000-0000-000000000001', 'f2-concurrency-source', 'F2 concurrency manufacturer', 'manufacturer', 'https://manufacturer.local.invalid', 'allowed', 'allowed', 'bounded', true);

insert into public.catalog_external_source_trust_profiles (id, organization_id, source_id, trust_level, trust_score, allowed_field_families, human_review_required, downstream_publication_restriction, evidence_required, is_active)
values ('10000000-0000-0000-0000-000000000007', '10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000006', 'T1', 0.99000, array['image_reference']::text[], true, 'portal_allowed_after_apply', true, true);

insert into public.catalog_observation_jobs (id, organization_id, source_id, trust_profile_id, brand_id, job_key, status, observation_scope, sync_mode, allowed_field_families, created_by)
values ('10000000-0000-0000-0000-000000000008', '10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000006', '10000000-0000-0000-0000-000000000007', '10000000-0000-0000-0000-000000000004', 'f2-concurrency-job', 'active', 'single_product', 'observation_only', array['image_reference']::text[], '10000000-0000-0000-0000-000000000002');

insert into public.catalog_observation_runs (id, organization_id, job_id, source_id, brand_id, status, finished_at, actor_id, source_revision, observed_count, candidate_count, review_routed_count)
values ('10000000-0000-0000-0000-000000000009', '10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000008', '10000000-0000-0000-0000-000000000006', '10000000-0000-0000-0000-000000000004', 'succeeded', now(), '10000000-0000-0000-0000-000000000002', 'f2-concurrency-revision', 1, 1, 1);

insert into public.catalog_external_observations (id, organization_id, source_id, trust_profile_id, job_id, run_id, brand_id, catalog_product_id, product_code, normalized_code, external_product_ref, field_family, field_name, raw_value, normalized_value, evidence_url, evidence_reference, evidence_hash, confidence, freshness_status, license_posture, observed_at, collector_actor_id, deduplication_key, compare_status, compare_outcome, review_status, apply_eligibility)
values ('10000000-0000-0000-0000-00000000000a', '10000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000006', '10000000-0000-0000-0000-000000000007', '10000000-0000-0000-0000-000000000008', '10000000-0000-0000-0000-000000000009', '10000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000005', 'F2-CONCURRENCY', 'F2CONCURRENCY', 'f2-concurrency-fixture', 'image_reference', 'image_url', 'https://cdn.local.invalid/f2-concurrency.jpg', 'https://cdn.local.invalid/f2-concurrency.jpg', 'https://evidence.local.invalid/f2-concurrency', 'f2-concurrency-evidence', 'f2-concurrency-evidence-hash', 0.99000, 'fresh', 'allowed', now(), '10000000-0000-0000-0000-000000000002', 'f2-concurrency-observation', 'compared', 'guarded_enrichment_candidate', 'pending_review', 'eligible');

insert into public.catalog_observation_review_decision_events (
  event_id, organization_id, review_item_id, observation_id, catalog_product_id, field_family,
  event_type, decision_type, reason_code, reviewer_user_id, reviewer_role,
  reviewer_capability_snapshot, recommendation_fingerprint, review_item_fingerprint,
  observation_fingerprint, product_target_fingerprint, expected_prior_decision_version,
  resulting_decision_version, idempotency_key, idempotency_payload_hash, lifecycle_reason,
  apply_eligible, apply_block_reasons, field_risk
)
select
  '10000000-0000-0000-0000-00000000000b', o.organization_id,
  concat_ws(':', o.organization_id::text, o.catalog_product_id::text, o.id::text, 'image_reference'),
  o.id, p.id, 'image_reference', 'DECISION_RECORDED', 'ACCEPT_RECOMMENDATION',
  'EVIDENCE_SUFFICIENT', '10000000-0000-0000-0000-000000000002', 'admin',
  jsonb_build_object('role', 'admin', 'is_active', true),
  public.catalog_review_hash('f2-concurrency-recommendation', o.id::text),
  public.catalog_review_item_fingerprint(concat_ws(':', o.organization_id::text, o.catalog_product_id::text, o.id::text, 'image_reference'), o, p),
  public.catalog_review_observation_fingerprint(o),
  public.catalog_review_product_target_fingerprint('image_reference', p),
  0, 1, 'f2-concurrency-decision', public.catalog_review_hash('f2-concurrency-decision-payload', o.id::text),
  'EVIDENCE_SUFFICIENT', true, array[]::text[], public.catalog_review_decision_field_risk('image_reference')
from public.catalog_external_observations o
join public.catalog_products p on p.id = o.catalog_product_id and p.organization_id = o.organization_id
where o.id = '10000000-0000-0000-0000-00000000000a'::uuid;

commit;
