-- LOCAL-ONLY disposable fixture cleanup. Never run against a shared database.
begin;

-- The fixture exercises append-only and integrity-summary triggers. Suppress
-- trigger side effects only while removing these fixed local test identifiers.
set local session_replication_role = replica;

delete from public.catalog_observation_review_apply_events
where organization_id = '10000000-0000-0000-0000-000000000001';

delete from public.catalog_observation_review_decision_events
where organization_id = '10000000-0000-0000-0000-000000000001';

delete from public.catalog_observation_audit_ledger
where organization_id = '10000000-0000-0000-0000-000000000001';

delete from public.catalog_external_observations
where organization_id = '10000000-0000-0000-0000-000000000001';

delete from public.catalog_observation_runs
where organization_id = '10000000-0000-0000-0000-000000000001';

delete from public.catalog_observation_jobs
where organization_id = '10000000-0000-0000-0000-000000000001';

delete from public.catalog_external_source_trust_profiles
where organization_id = '10000000-0000-0000-0000-000000000001';

delete from public.catalog_external_sources
where organization_id = '10000000-0000-0000-0000-000000000001';

delete from public.catalog_integrity_queue
where organization_id = '10000000-0000-0000-0000-000000000001';

delete from public.catalog_product_integrity
where organization_id = '10000000-0000-0000-0000-000000000001';

delete from public.catalog_integrity_summary
where organization_id = '10000000-0000-0000-0000-000000000001';

delete from public.catalog_integrity_backfill_state
where organization_id = '10000000-0000-0000-0000-000000000001';

delete from public.catalog_products
where organization_id = '10000000-0000-0000-0000-000000000001';

delete from public.brands
where organization_id = '10000000-0000-0000-0000-000000000001';

delete from public.profiles
where organization_id = '10000000-0000-0000-0000-000000000001';

delete from public.organizations
where id = '10000000-0000-0000-0000-000000000001';

commit;
