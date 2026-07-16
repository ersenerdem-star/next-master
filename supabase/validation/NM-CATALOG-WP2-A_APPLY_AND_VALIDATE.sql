begin;

set local statement_timeout = '10min';
set local lock_timeout = '10s';

-- NM-CATALOG-WP2-A: single-source single-brand external observation pilot foundation.
-- Additive DB-only foundation. This migration does not mutate catalog_products.

create table if not exists public.catalog_external_sources (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  source_key text not null,
  display_name text not null,
  source_owner text,
  source_type text not null default 'external_catalog'
    check (source_type in ('manufacturer', 'authorized_distributor', 'licensed_catalog', 'internal_observation', 'open_web', 'dimbax', 'external_catalog')),
  base_url text,
  license_posture text not null default 'unknown'
    check (license_posture in ('unknown', 'allowed', 'restricted', 'internal_review_required', 'prohibited')),
  robots_posture text not null default 'unknown'
    check (robots_posture in ('unknown', 'allowed', 'restricted', 'blocked', 'not_applicable')),
  rate_limit_posture text not null default 'unknown'
    check (rate_limit_posture in ('unknown', 'bounded', 'restricted', 'blocked', 'not_applicable')),
  credential_boundary text,
  is_active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, source_key)
);

create table if not exists public.catalog_external_source_trust_profiles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  source_id uuid not null references public.catalog_external_sources(id) on delete cascade,
  trust_level text not null default 'T5'
    check (trust_level in ('T1', 'T2', 'T3', 'T4', 'T5', 'T6')),
  trust_score numeric(6,5) not null default 0.50000
    check (trust_score >= 0 and trust_score <= 1),
  allowed_field_families text[] not null default array['image_reference', 'supplemental_description']::text[],
  auto_enrichment_allowed_fields text[] not null default array[]::text[],
  protected_field_families text[] not null default array[
    'product_identity',
    'canonical_product_code',
    'brand_ownership',
    'oem_reference',
    'replacement',
    'supersession',
    'discontinued_state',
    'fitment',
    'supplier_linkage'
  ]::text[],
  human_review_required boolean not null default true,
  downstream_publication_restriction text not null default 'internal_only'
    check (downstream_publication_restriction in ('internal_only', 'restricted', 'portal_allowed_after_apply', 'blocked')),
  evidence_required boolean not null default true,
  is_active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, source_id)
);

create table if not exists public.catalog_observation_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  source_id uuid not null references public.catalog_external_sources(id) on delete restrict,
  trust_profile_id uuid not null references public.catalog_external_source_trust_profiles(id) on delete restrict,
  brand_id uuid not null references public.brands(id) on delete restrict,
  job_key text not null,
  status text not null default 'draft'
    check (status in ('draft', 'active', 'paused', 'disabled', 'completed', 'failed', 'cancelled')),
  observation_scope text not null default 'single_brand'
    check (observation_scope in ('single_brand', 'single_product', 'single_field_family')),
  sync_mode text not null default 'observation_only'
    check (sync_mode = 'observation_only'),
  allowed_field_families text[] not null default array['image_reference', 'supplemental_description']::text[],
  max_observations_per_run integer not null default 500
    check (max_observations_per_run > 0 and max_observations_per_run <= 10000),
  max_retry_attempts integer not null default 5
    check (max_retry_attempts >= 0 and max_retry_attempts <= 20),
  lock_timeout_seconds integer not null default 600
    check (lock_timeout_seconds >= 60 and lock_timeout_seconds <= 86400),
  checkpoint_cursor jsonb not null default '{}'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, source_id, brand_id, job_key)
);

create index if not exists idx_catalog_observation_jobs_org_status
  on public.catalog_observation_jobs (organization_id, status, updated_at desc);

create index if not exists idx_catalog_observation_jobs_scope
  on public.catalog_observation_jobs (organization_id, source_id, brand_id, status);

create table if not exists public.catalog_observation_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  job_id uuid not null references public.catalog_observation_jobs(id) on delete restrict,
  source_id uuid not null references public.catalog_external_sources(id) on delete restrict,
  brand_id uuid not null references public.brands(id) on delete restrict,
  status text not null default 'running'
    check (status in ('running', 'succeeded', 'completed_with_warnings', 'failed', 'cancelled', 'dead_letter')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  duration_ms integer,
  actor_id uuid,
  input_metadata jsonb not null default '{}'::jsonb,
  source_revision text,
  observed_count integer not null default 0 check (observed_count >= 0),
  deduped_count integer not null default 0 check (deduped_count >= 0),
  candidate_count integer not null default 0 check (candidate_count >= 0),
  review_routed_count integer not null default 0 check (review_routed_count >= 0),
  apply_event_count integer not null default 0 check (apply_event_count >= 0),
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists uq_catalog_observation_runs_running_job
  on public.catalog_observation_runs (organization_id, job_id)
  where status = 'running';

create index if not exists idx_catalog_observation_runs_org_status
  on public.catalog_observation_runs (organization_id, status, started_at desc);

create index if not exists idx_catalog_observation_runs_job_started
  on public.catalog_observation_runs (organization_id, job_id, started_at desc);

create table if not exists public.catalog_observation_checkpoints (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  job_id uuid not null references public.catalog_observation_jobs(id) on delete cascade,
  source_id uuid not null references public.catalog_external_sources(id) on delete restrict,
  brand_id uuid not null references public.brands(id) on delete restrict,
  last_successful_run_id uuid references public.catalog_observation_runs(id) on delete set null,
  cursor_value text,
  cursor_metadata jsonb not null default '{}'::jsonb,
  last_observed_at timestamptz,
  last_success_at timestamptz,
  last_error text,
  updated_at timestamptz not null default now(),
  primary key (organization_id, job_id)
);

create table if not exists public.catalog_external_observations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  source_id uuid not null references public.catalog_external_sources(id) on delete restrict,
  trust_profile_id uuid not null references public.catalog_external_source_trust_profiles(id) on delete restrict,
  job_id uuid not null references public.catalog_observation_jobs(id) on delete restrict,
  run_id uuid not null references public.catalog_observation_runs(id) on delete restrict,
  brand_id uuid not null references public.brands(id) on delete restrict,
  catalog_product_id uuid references public.catalog_products(id) on delete set null,
  product_code text not null,
  normalized_code text not null,
  external_product_ref text,
  field_family text not null,
  field_name text not null,
  raw_value text not null,
  normalized_value text not null,
  evidence_url text,
  evidence_reference text,
  evidence_hash text,
  evidence_payload jsonb not null default '{}'::jsonb,
  source_revision text,
  confidence numeric(6,5) not null default 0.50000
    check (confidence >= 0 and confidence <= 1),
  freshness_status text not null default 'unknown'
    check (freshness_status in ('unknown', 'fresh', 'stale', 'superseded')),
  license_posture text not null default 'unknown'
    check (license_posture in ('unknown', 'allowed', 'restricted', 'internal_review_required', 'prohibited')),
  limitation_notes text,
  observed_at timestamptz not null,
  ingested_at timestamptz not null default now(),
  collector_actor_id uuid,
  deduplication_key text not null,
  compare_status text not null default 'queued'
    check (compare_status in ('queued', 'claimed', 'compared', 'failed', 'dead_letter')),
  compare_outcome text not null default 'pending'
    check (compare_outcome in ('pending', 'no_product_match', 'no_change', 'enrichment_candidate', 'guarded_enrichment_candidate', 'protected_conflict', 'license_blocked', 'stale_source', 'failed')),
  review_status text not null default 'none'
    check (review_status in ('none', 'pending_review', 'approved', 'rejected', 'deferred', 'ignored')),
  apply_eligibility text not null default 'not_eligible'
    check (apply_eligibility in ('not_eligible', 'eligible', 'requires_review', 'blocked', 'applied')),
  retry_count integer not null default 0 check (retry_count >= 0),
  next_retry_at timestamptz not null default now(),
  locked_at timestamptz,
  lock_token uuid,
  locked_by text,
  last_error text,
  dead_letter_reason text,
  compared_at timestamptz,
  routed_at timestamptz,
  reviewed_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (organization_id, deduplication_key)
);

create index if not exists idx_catalog_external_observations_scope
  on public.catalog_external_observations (organization_id, source_id, brand_id, normalized_code, field_name);

create index if not exists idx_catalog_external_observations_run
  on public.catalog_external_observations (organization_id, run_id, ingested_at desc);

drop index if exists public.idx_catalog_external_observations_claim;
create index if not exists idx_catalog_external_observations_claim
  on public.catalog_external_observations (organization_id, job_id, next_retry_at, ingested_at, id)
  where compare_status in ('queued', 'failed');

create index if not exists idx_catalog_external_observations_review
  on public.catalog_external_observations (organization_id, routed_at desc, id)
  where review_status = 'pending_review';

create table if not exists public.catalog_observation_candidates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  observation_id uuid not null references public.catalog_external_observations(id) on delete restrict,
  job_id uuid not null references public.catalog_observation_jobs(id) on delete restrict,
  run_id uuid not null references public.catalog_observation_runs(id) on delete restrict,
  catalog_product_id uuid references public.catalog_products(id) on delete set null,
  field_name text not null,
  current_value text,
  proposed_value text not null,
  candidate_status text not null
    check (candidate_status in ('observed', 'no_change', 'enrichment_candidate', 'guarded_enrichment_candidate', 'protected_conflict', 'license_blocked', 'stale_source', 'review_required', 'approved_for_apply', 'rejected', 'deferred', 'applied', 'failed', 'dead_letter')),
  comparison_reason text,
  guardian_status text not null default 'not_evaluated'
    check (guardian_status in ('not_evaluated', 'passed', 'warning', 'blocked', 'failed')),
  downstream_impact jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, observation_id)
);

create index if not exists idx_catalog_observation_candidates_status
  on public.catalog_observation_candidates (organization_id, candidate_status, updated_at desc);

create table if not exists public.catalog_observation_review_decisions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  observation_id uuid not null references public.catalog_external_observations(id) on delete restrict,
  candidate_id uuid references public.catalog_observation_candidates(id) on delete set null,
  job_id uuid not null references public.catalog_observation_jobs(id) on delete restrict,
  run_id uuid not null references public.catalog_observation_runs(id) on delete restrict,
  catalog_product_id uuid references public.catalog_products(id) on delete set null,
  field_name text not null,
  decision text not null
    check (decision in ('approve_apply', 'reject_candidate', 'defer_candidate', 'request_more_evidence', 'accept_evidence_only')),
  reviewer_id uuid,
  previous_value text,
  proposed_value text not null,
  reason text,
  decided_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists idx_catalog_observation_review_decisions_obs
  on public.catalog_observation_review_decisions (organization_id, observation_id, decided_at desc);

create table if not exists public.catalog_apply_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  observation_id uuid not null references public.catalog_external_observations(id) on delete restrict,
  review_decision_id uuid references public.catalog_observation_review_decisions(id) on delete restrict,
  catalog_product_id uuid references public.catalog_products(id) on delete set null,
  field_name text not null,
  previous_value text,
  proposed_value text not null,
  apply_status text not null default 'recorded'
    check (apply_status in ('recorded', 'applied', 'not_applied', 'failed')),
  actor_id uuid,
  source_snapshot jsonb not null default '{}'::jsonb,
  downstream_impact jsonb not null default '{}'::jsonb,
  guardian_snapshot jsonb not null default '{}'::jsonb,
  reason text,
  created_at timestamptz not null default now(),
  unique (organization_id, observation_id, field_name, apply_status)
);

create index if not exists idx_catalog_apply_events_product
  on public.catalog_apply_events (organization_id, catalog_product_id, created_at desc);

create table if not exists public.catalog_observation_audit_ledger (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  job_id uuid references public.catalog_observation_jobs(id) on delete set null,
  run_id uuid references public.catalog_observation_runs(id) on delete set null,
  observation_id uuid references public.catalog_external_observations(id) on delete set null,
  candidate_id uuid references public.catalog_observation_candidates(id) on delete set null,
  review_decision_id uuid references public.catalog_observation_review_decisions(id) on delete set null,
  apply_event_id uuid references public.catalog_apply_events(id) on delete set null,
  actor_id uuid,
  action text not null,
  prior_status text,
  next_status text,
  message text,
  evidence_reference text,
  confidence numeric(6,5) check (confidence is null or (confidence >= 0 and confidence <= 1)),
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_catalog_observation_audit_ledger_scope
  on public.catalog_observation_audit_ledger (organization_id, job_id, created_at desc);

create table if not exists public.catalog_observation_scope_health (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  job_id uuid not null references public.catalog_observation_jobs(id) on delete cascade,
  source_id uuid not null references public.catalog_external_sources(id) on delete restrict,
  brand_id uuid not null references public.brands(id) on delete restrict,
  queued_count bigint not null default 0 check (queued_count >= 0),
  claimed_count bigint not null default 0 check (claimed_count >= 0),
  compared_count bigint not null default 0 check (compared_count >= 0),
  failed_count bigint not null default 0 check (failed_count >= 0),
  dead_letter_count bigint not null default 0 check (dead_letter_count >= 0),
  pending_review_count bigint not null default 0 check (pending_review_count >= 0),
  latest_run_id uuid references public.catalog_observation_runs(id) on delete set null,
  latest_run_status text,
  latest_success_at timestamptz,
  last_error text,
  updated_at timestamptz not null default now(),
  primary key (organization_id, job_id)
);

alter table public.catalog_external_sources enable row level security;
alter table public.catalog_external_source_trust_profiles enable row level security;
alter table public.catalog_observation_jobs enable row level security;
alter table public.catalog_observation_runs enable row level security;
alter table public.catalog_observation_checkpoints enable row level security;
alter table public.catalog_external_observations enable row level security;
alter table public.catalog_observation_candidates enable row level security;
alter table public.catalog_observation_review_decisions enable row level security;
alter table public.catalog_apply_events enable row level security;
alter table public.catalog_observation_audit_ledger enable row level security;
alter table public.catalog_observation_scope_health enable row level security;

drop policy if exists catalog_external_sources_select_admin_org on public.catalog_external_sources;
create policy catalog_external_sources_select_admin_org
on public.catalog_external_sources
for select
using (auth.uid() is not null and public.is_superadmin() and organization_id = public.current_profile_org_id());

drop policy if exists catalog_external_source_trust_profiles_select_admin_org on public.catalog_external_source_trust_profiles;
create policy catalog_external_source_trust_profiles_select_admin_org
on public.catalog_external_source_trust_profiles
for select
using (auth.uid() is not null and public.is_superadmin() and organization_id = public.current_profile_org_id());

drop policy if exists catalog_observation_jobs_select_admin_org on public.catalog_observation_jobs;
create policy catalog_observation_jobs_select_admin_org
on public.catalog_observation_jobs
for select
using (auth.uid() is not null and public.is_superadmin() and organization_id = public.current_profile_org_id());

drop policy if exists catalog_observation_runs_select_admin_org on public.catalog_observation_runs;
create policy catalog_observation_runs_select_admin_org
on public.catalog_observation_runs
for select
using (auth.uid() is not null and public.is_superadmin() and organization_id = public.current_profile_org_id());

drop policy if exists catalog_observation_checkpoints_select_admin_org on public.catalog_observation_checkpoints;
create policy catalog_observation_checkpoints_select_admin_org
on public.catalog_observation_checkpoints
for select
using (auth.uid() is not null and public.is_superadmin() and organization_id = public.current_profile_org_id());

drop policy if exists catalog_external_observations_select_admin_org on public.catalog_external_observations;
create policy catalog_external_observations_select_admin_org
on public.catalog_external_observations
for select
using (auth.uid() is not null and public.is_superadmin() and organization_id = public.current_profile_org_id());

drop policy if exists catalog_observation_candidates_select_admin_org on public.catalog_observation_candidates;
create policy catalog_observation_candidates_select_admin_org
on public.catalog_observation_candidates
for select
using (auth.uid() is not null and public.is_superadmin() and organization_id = public.current_profile_org_id());

drop policy if exists catalog_observation_review_decisions_select_admin_org on public.catalog_observation_review_decisions;
create policy catalog_observation_review_decisions_select_admin_org
on public.catalog_observation_review_decisions
for select
using (auth.uid() is not null and public.is_superadmin() and organization_id = public.current_profile_org_id());

drop policy if exists catalog_apply_events_select_admin_org on public.catalog_apply_events;
create policy catalog_apply_events_select_admin_org
on public.catalog_apply_events
for select
using (auth.uid() is not null and public.is_superadmin() and organization_id = public.current_profile_org_id());

drop policy if exists catalog_observation_audit_ledger_select_admin_org on public.catalog_observation_audit_ledger;
create policy catalog_observation_audit_ledger_select_admin_org
on public.catalog_observation_audit_ledger
for select
using (auth.uid() is not null and public.is_superadmin() and organization_id = public.current_profile_org_id());

drop policy if exists catalog_observation_scope_health_select_admin_org on public.catalog_observation_scope_health;
create policy catalog_observation_scope_health_select_admin_org
on public.catalog_observation_scope_health
for select
using (auth.uid() is not null and public.is_superadmin() and organization_id = public.current_profile_org_id());

revoke all privileges on table public.catalog_external_sources from public, anon, authenticated, service_role;
revoke all privileges on table public.catalog_external_source_trust_profiles from public, anon, authenticated, service_role;
revoke all privileges on table public.catalog_observation_jobs from public, anon, authenticated, service_role;
revoke all privileges on table public.catalog_observation_runs from public, anon, authenticated, service_role;
revoke all privileges on table public.catalog_observation_checkpoints from public, anon, authenticated, service_role;
revoke all privileges on table public.catalog_external_observations from public, anon, authenticated, service_role;
revoke all privileges on table public.catalog_observation_candidates from public, anon, authenticated, service_role;
revoke all privileges on table public.catalog_observation_review_decisions from public, anon, authenticated, service_role;
revoke all privileges on table public.catalog_apply_events from public, anon, authenticated, service_role;
revoke all privileges on table public.catalog_observation_audit_ledger from public, anon, authenticated, service_role;
revoke all privileges on table public.catalog_observation_scope_health from public, anon, authenticated, service_role;

grant select on public.catalog_external_sources to authenticated, service_role;
grant select on public.catalog_external_source_trust_profiles to authenticated, service_role;
grant select on public.catalog_observation_jobs to authenticated, service_role;
grant select on public.catalog_observation_runs to authenticated, service_role;
grant select on public.catalog_observation_checkpoints to authenticated, service_role;
grant select on public.catalog_external_observations to authenticated, service_role;
grant select on public.catalog_observation_candidates to authenticated, service_role;
grant select on public.catalog_observation_review_decisions to authenticated, service_role;
grant select on public.catalog_apply_events to authenticated, service_role;
grant select on public.catalog_observation_audit_ledger to authenticated, service_role;
grant select on public.catalog_observation_scope_health to authenticated, service_role;

create or replace function public.require_catalog_observation_service_role()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Catalog observation operation requires service role';
  end if;
end;
$$;

revoke all on function public.require_catalog_observation_service_role() from public, anon, authenticated, service_role;
grant execute on function public.require_catalog_observation_service_role() to service_role;

create or replace function public.prevent_catalog_external_observation_evidence_mutation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Catalog external observations are append-only evidence';
  end if;

  if old.organization_id is distinct from new.organization_id
     or old.source_id is distinct from new.source_id
     or old.trust_profile_id is distinct from new.trust_profile_id
     or old.job_id is distinct from new.job_id
     or old.run_id is distinct from new.run_id
     or old.brand_id is distinct from new.brand_id
     or old.product_code is distinct from new.product_code
     or old.normalized_code is distinct from new.normalized_code
     or old.external_product_ref is distinct from new.external_product_ref
     or old.field_family is distinct from new.field_family
     or old.field_name is distinct from new.field_name
     or old.raw_value is distinct from new.raw_value
     or old.normalized_value is distinct from new.normalized_value
     or old.evidence_url is distinct from new.evidence_url
     or old.evidence_reference is distinct from new.evidence_reference
     or old.evidence_hash is distinct from new.evidence_hash
     or old.evidence_payload is distinct from new.evidence_payload
     or old.source_revision is distinct from new.source_revision
     or old.confidence is distinct from new.confidence
     or old.freshness_status is distinct from new.freshness_status
     or old.license_posture is distinct from new.license_posture
     or old.limitation_notes is distinct from new.limitation_notes
     or old.observed_at is distinct from new.observed_at
     or old.ingested_at is distinct from new.ingested_at
     or old.collector_actor_id is distinct from new.collector_actor_id
     or old.deduplication_key is distinct from new.deduplication_key then
    raise exception 'Catalog external observation evidence fields are immutable';
  end if;

  new.updated_at := now();
  return new;
end;
$$;

revoke all on function public.prevent_catalog_external_observation_evidence_mutation() from public, anon, authenticated, service_role;

drop trigger if exists trg_catalog_external_observations_immutable_evidence on public.catalog_external_observations;
create trigger trg_catalog_external_observations_immutable_evidence
before update or delete
on public.catalog_external_observations
for each row
execute function public.prevent_catalog_external_observation_evidence_mutation();


create or replace function public.prevent_catalog_observation_audit_mutation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  raise exception 'Catalog observation audit ledger is append-only';
end;
$$;

revoke all on function public.prevent_catalog_observation_audit_mutation() from public, anon, authenticated, service_role;

drop trigger if exists trg_catalog_observation_audit_ledger_append_only on public.catalog_observation_audit_ledger;
create trigger trg_catalog_observation_audit_ledger_append_only
before update or delete
on public.catalog_observation_audit_ledger
for each row
execute function public.prevent_catalog_observation_audit_mutation();

create or replace function public.validate_catalog_observation_scope_consistency()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    return old;
  end if;

  if tg_table_name = 'catalog_external_source_trust_profiles' then
    if not exists (
      select 1
      from public.catalog_external_sources src
      where src.id = new.source_id
        and src.organization_id = new.organization_id
    ) then
      raise exception 'Catalog observation trust profile source organization mismatch';
    end if;

  elsif tg_table_name = 'catalog_observation_jobs' then
    if not exists (
      select 1
      from public.catalog_external_sources src
      join public.catalog_external_source_trust_profiles trust
        on trust.id = new.trust_profile_id
       and trust.source_id = src.id
       and trust.organization_id = src.organization_id
      join public.brands b
        on b.id = new.brand_id
       and b.organization_id = new.organization_id
      where src.id = new.source_id
        and src.organization_id = new.organization_id
    ) then
      raise exception 'Catalog observation job source, trust profile, or brand organization mismatch';
    end if;

  elsif tg_table_name = 'catalog_observation_runs' then
    if not exists (
      select 1
      from public.catalog_observation_jobs job
      where job.id = new.job_id
        and job.organization_id = new.organization_id
        and job.source_id = new.source_id
        and job.brand_id = new.brand_id
    ) then
      raise exception 'Catalog observation run job/source/brand organization mismatch';
    end if;

  elsif tg_table_name = 'catalog_observation_checkpoints' then
    if not exists (
      select 1
      from public.catalog_observation_jobs job
      where job.id = new.job_id
        and job.organization_id = new.organization_id
        and job.source_id = new.source_id
        and job.brand_id = new.brand_id
    ) then
      raise exception 'Catalog observation checkpoint job/source/brand organization mismatch';
    end if;

  elsif tg_table_name = 'catalog_external_observations' then
    if not exists (
      select 1
      from public.catalog_observation_runs run
      join public.catalog_observation_jobs job
        on job.id = run.job_id
       and job.organization_id = run.organization_id
       and job.source_id = run.source_id
       and job.brand_id = run.brand_id
      join public.catalog_external_source_trust_profiles trust
        on trust.id = new.trust_profile_id
       and trust.organization_id = run.organization_id
       and trust.source_id = run.source_id
      where run.id = new.run_id
        and run.organization_id = new.organization_id
        and run.job_id = new.job_id
        and run.source_id = new.source_id
        and run.brand_id = new.brand_id
    ) then
      raise exception 'Catalog external observation run/job/source/trust/brand organization mismatch';
    end if;

    if new.catalog_product_id is not null and not exists (
      select 1
      from public.catalog_products cp
      where cp.id = new.catalog_product_id
        and cp.organization_id = new.organization_id
        and cp.brand_id = new.brand_id
    ) then
      raise exception 'Catalog external observation Product organization or brand mismatch';
    end if;

  elsif tg_table_name = 'catalog_observation_candidates' then
    if not exists (
      select 1
      from public.catalog_external_observations obs
      where obs.id = new.observation_id
        and obs.organization_id = new.organization_id
        and obs.job_id = new.job_id
        and obs.run_id = new.run_id
        and new.catalog_product_id is not distinct from obs.catalog_product_id
    ) then
      raise exception 'Catalog observation candidate observation/job/run/Product organization mismatch';
    end if;

  elsif tg_table_name = 'catalog_observation_review_decisions' then
    if not exists (
      select 1
      from public.catalog_external_observations obs
      where obs.id = new.observation_id
        and obs.organization_id = new.organization_id
        and obs.job_id = new.job_id
        and obs.run_id = new.run_id
        and new.catalog_product_id is not distinct from obs.catalog_product_id
    ) then
      raise exception 'Catalog observation review observation/job/run/Product organization mismatch';
    end if;

    if new.candidate_id is not null and not exists (
      select 1
      from public.catalog_observation_candidates cand
      where cand.id = new.candidate_id
        and cand.organization_id = new.organization_id
        and cand.observation_id = new.observation_id
        and (
          cand.catalog_product_id is not distinct from new.catalog_product_id
          or (cand.catalog_product_id is null and new.catalog_product_id is null)
        )
    ) then
      raise exception 'Catalog observation review candidate organization mismatch';
    end if;

  elsif tg_table_name = 'catalog_apply_events' then
    if not exists (
      select 1
      from public.catalog_external_observations obs
      where obs.id = new.observation_id
        and obs.organization_id = new.organization_id
        and new.catalog_product_id is not distinct from obs.catalog_product_id
    ) then
      raise exception 'Catalog apply event observation Product organization mismatch';
    end if;

    if new.review_decision_id is not null and not exists (
      select 1
      from public.catalog_observation_review_decisions review
      where review.id = new.review_decision_id
        and review.organization_id = new.organization_id
        and review.observation_id = new.observation_id
        and review.catalog_product_id is not distinct from new.catalog_product_id
    ) then
      raise exception 'Catalog apply event review organization mismatch';
    end if;

  elsif tg_table_name = 'catalog_observation_audit_ledger' then
    if new.job_id is not null and not exists (
      select 1 from public.catalog_observation_jobs job
      where job.id = new.job_id
        and job.organization_id = new.organization_id
    ) then
      raise exception 'Catalog observation audit job organization mismatch';
    end if;

    if new.run_id is not null and not exists (
      select 1 from public.catalog_observation_runs run
      where run.id = new.run_id
        and run.organization_id = new.organization_id
    ) then
      raise exception 'Catalog observation audit run organization mismatch';
    end if;

    if new.observation_id is not null and not exists (
      select 1 from public.catalog_external_observations obs
      where obs.id = new.observation_id
        and obs.organization_id = new.organization_id
    ) then
      raise exception 'Catalog observation audit observation organization mismatch';
    end if;

    if new.candidate_id is not null and not exists (
      select 1 from public.catalog_observation_candidates cand
      where cand.id = new.candidate_id
        and cand.organization_id = new.organization_id
    ) then
      raise exception 'Catalog observation audit candidate organization mismatch';
    end if;

    if new.review_decision_id is not null and not exists (
      select 1 from public.catalog_observation_review_decisions review
      where review.id = new.review_decision_id
        and review.organization_id = new.organization_id
    ) then
      raise exception 'Catalog observation audit review organization mismatch';
    end if;

    if new.apply_event_id is not null and not exists (
      select 1 from public.catalog_apply_events apply_event
      where apply_event.id = new.apply_event_id
        and apply_event.organization_id = new.organization_id
    ) then
      raise exception 'Catalog observation audit apply event organization mismatch';
    end if;

  elsif tg_table_name = 'catalog_observation_scope_health' then
    if not exists (
      select 1
      from public.catalog_observation_jobs job
      where job.id = new.job_id
        and job.organization_id = new.organization_id
        and job.source_id = new.source_id
        and job.brand_id = new.brand_id
    ) then
      raise exception 'Catalog observation health job/source/brand organization mismatch';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.validate_catalog_observation_scope_consistency() from public, anon, authenticated, service_role;

drop trigger if exists trg_catalog_external_source_trust_profiles_scope_consistency on public.catalog_external_source_trust_profiles;
create trigger trg_catalog_external_source_trust_profiles_scope_consistency
before insert or update of organization_id, source_id
on public.catalog_external_source_trust_profiles
for each row
execute function public.validate_catalog_observation_scope_consistency();

drop trigger if exists trg_catalog_observation_jobs_scope_consistency on public.catalog_observation_jobs;
create trigger trg_catalog_observation_jobs_scope_consistency
before insert or update of organization_id, source_id, trust_profile_id, brand_id
on public.catalog_observation_jobs
for each row
execute function public.validate_catalog_observation_scope_consistency();

drop trigger if exists trg_catalog_observation_runs_scope_consistency on public.catalog_observation_runs;
create trigger trg_catalog_observation_runs_scope_consistency
before insert or update of organization_id, job_id, source_id, brand_id
on public.catalog_observation_runs
for each row
execute function public.validate_catalog_observation_scope_consistency();

drop trigger if exists trg_catalog_observation_checkpoints_scope_consistency on public.catalog_observation_checkpoints;
create trigger trg_catalog_observation_checkpoints_scope_consistency
before insert or update of organization_id, job_id, source_id, brand_id
on public.catalog_observation_checkpoints
for each row
execute function public.validate_catalog_observation_scope_consistency();

drop trigger if exists trg_catalog_external_observations_scope_consistency on public.catalog_external_observations;
create trigger trg_catalog_external_observations_scope_consistency
before insert or update of organization_id, source_id, trust_profile_id, job_id, run_id, brand_id, catalog_product_id
on public.catalog_external_observations
for each row
execute function public.validate_catalog_observation_scope_consistency();

drop trigger if exists trg_catalog_observation_candidates_scope_consistency on public.catalog_observation_candidates;
create trigger trg_catalog_observation_candidates_scope_consistency
before insert or update of organization_id, observation_id, job_id, run_id, catalog_product_id
on public.catalog_observation_candidates
for each row
execute function public.validate_catalog_observation_scope_consistency();

drop trigger if exists trg_catalog_observation_review_decisions_scope_consistency on public.catalog_observation_review_decisions;
create trigger trg_catalog_observation_review_decisions_scope_consistency
before insert or update of organization_id, observation_id, candidate_id, job_id, run_id, catalog_product_id
on public.catalog_observation_review_decisions
for each row
execute function public.validate_catalog_observation_scope_consistency();

drop trigger if exists trg_catalog_apply_events_scope_consistency on public.catalog_apply_events;
create trigger trg_catalog_apply_events_scope_consistency
before insert or update of organization_id, observation_id, review_decision_id, catalog_product_id
on public.catalog_apply_events
for each row
execute function public.validate_catalog_observation_scope_consistency();

drop trigger if exists trg_catalog_observation_audit_ledger_scope_consistency on public.catalog_observation_audit_ledger;
create trigger trg_catalog_observation_audit_ledger_scope_consistency
before insert or update of organization_id, job_id, run_id, observation_id, candidate_id, review_decision_id, apply_event_id
on public.catalog_observation_audit_ledger
for each row
execute function public.validate_catalog_observation_scope_consistency();

drop trigger if exists trg_catalog_observation_scope_health_scope_consistency on public.catalog_observation_scope_health;
create trigger trg_catalog_observation_scope_health_scope_consistency
before insert or update of organization_id, job_id, source_id, brand_id
on public.catalog_observation_scope_health
for each row
execute function public.validate_catalog_observation_scope_consistency();


create or replace function public.configure_catalog_external_source(
  input_organization_id uuid,
  input_source_key text,
  input_display_name text,
  input_source_owner text default null,
  input_source_type text default 'external_catalog',
  input_base_url text default null,
  input_license_posture text default 'unknown',
  input_robots_posture text default 'unknown',
  input_rate_limit_posture text default 'unknown',
  input_is_active boolean default true,
  input_metadata jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_source_id uuid;
begin
  perform public.require_catalog_observation_service_role();

  if input_organization_id is null or nullif(trim(input_source_key), '') is null or nullif(trim(input_display_name), '') is null then
    raise exception 'Catalog external source requires organization, source key, and display name';
  end if;

  insert into public.catalog_external_sources (
    organization_id, source_key, display_name, source_owner, source_type,
    base_url, license_posture, robots_posture, rate_limit_posture, is_active,
    metadata, updated_at
  ) values (
    input_organization_id,
    trim(input_source_key),
    trim(input_display_name),
    nullif(trim(input_source_owner), ''),
    coalesce(nullif(trim(input_source_type), ''), 'external_catalog'),
    nullif(trim(input_base_url), ''),
    coalesce(nullif(trim(input_license_posture), ''), 'unknown'),
    coalesce(nullif(trim(input_robots_posture), ''), 'unknown'),
    coalesce(nullif(trim(input_rate_limit_posture), ''), 'unknown'),
    coalesce(input_is_active, true),
    coalesce(input_metadata, '{}'::jsonb),
    now()
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
    is_active = excluded.is_active,
    metadata = excluded.metadata,
    updated_at = now()
  returning id into v_source_id;

  return v_source_id;
end;
$$;

revoke all on function public.configure_catalog_external_source(uuid, text, text, text, text, text, text, text, text, boolean, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.configure_catalog_external_source(uuid, text, text, text, text, text, text, text, text, boolean, jsonb) to service_role;

create or replace function public.configure_catalog_external_source_trust_profile(
  input_organization_id uuid,
  input_source_id uuid,
  input_trust_level text default 'T5',
  input_trust_score numeric default 0.5,
  input_allowed_field_families text[] default array['image_reference', 'supplemental_description']::text[],
  input_human_review_required boolean default true,
  input_downstream_publication_restriction text default 'internal_only',
  input_evidence_required boolean default true,
  input_is_active boolean default true,
  input_notes text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_trust_profile_id uuid;
begin
  perform public.require_catalog_observation_service_role();

  if input_organization_id is null or input_source_id is null then
    raise exception 'Catalog source trust profile requires organization and source';
  end if;

  if exists (
    select 1
    from unnest(coalesce(input_allowed_field_families, array[]::text[])) field_family
    where field_family not in ('image_reference', 'supplemental_description')
  ) then
    raise exception 'Catalog observation pilot only supports image_reference and supplemental_description';
  end if;

  insert into public.catalog_external_source_trust_profiles (
    organization_id, source_id, trust_level, trust_score, allowed_field_families,
    human_review_required, downstream_publication_restriction, evidence_required,
    is_active, notes, updated_at
  ) values (
    input_organization_id,
    input_source_id,
    coalesce(nullif(trim(input_trust_level), ''), 'T5'),
    least(greatest(coalesce(input_trust_score, 0.5), 0), 1),
    coalesce(input_allowed_field_families, array['image_reference', 'supplemental_description']::text[]),
    coalesce(input_human_review_required, true),
    coalesce(nullif(trim(input_downstream_publication_restriction), ''), 'internal_only'),
    coalesce(input_evidence_required, true),
    coalesce(input_is_active, true),
    input_notes,
    now()
  )
  on conflict (organization_id, source_id)
  do update set
    trust_level = excluded.trust_level,
    trust_score = excluded.trust_score,
    allowed_field_families = excluded.allowed_field_families,
    human_review_required = excluded.human_review_required,
    downstream_publication_restriction = excluded.downstream_publication_restriction,
    evidence_required = excluded.evidence_required,
    is_active = excluded.is_active,
    notes = excluded.notes,
    updated_at = now()
  returning id into v_trust_profile_id;

  return v_trust_profile_id;
end;
$$;

revoke all on function public.configure_catalog_external_source_trust_profile(uuid, uuid, text, numeric, text[], boolean, text, boolean, boolean, text) from public, anon, authenticated, service_role;
grant execute on function public.configure_catalog_external_source_trust_profile(uuid, uuid, text, numeric, text[], boolean, text, boolean, boolean, text) to service_role;

create or replace function public.configure_single_brand_catalog_observation_job(
  input_organization_id uuid,
  input_source_id uuid,
  input_trust_profile_id uuid,
  input_brand_id uuid,
  input_job_key text,
  input_allowed_field_families text[] default array['image_reference', 'supplemental_description']::text[],
  input_max_observations_per_run integer default 500,
  input_max_retry_attempts integer default 5,
  input_lock_timeout_seconds integer default 600,
  input_status text default 'active',
  input_metadata jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job_id uuid;
begin
  perform public.require_catalog_observation_service_role();

  if input_organization_id is null or input_source_id is null or input_trust_profile_id is null or input_brand_id is null or nullif(trim(input_job_key), '') is null then
    raise exception 'Catalog observation job requires organization, source, trust profile, brand, and job key';
  end if;

  if exists (
    select 1
    from unnest(coalesce(input_allowed_field_families, array[]::text[])) field_family
    where field_family not in ('image_reference', 'supplemental_description')
  ) then
    raise exception 'Catalog observation pilot only supports image_reference and supplemental_description';
  end if;

  insert into public.catalog_observation_jobs (
    organization_id, source_id, trust_profile_id, brand_id, job_key,
    status, observation_scope, sync_mode, allowed_field_families,
    max_observations_per_run, max_retry_attempts, lock_timeout_seconds,
    metadata, updated_at
  ) values (
    input_organization_id,
    input_source_id,
    input_trust_profile_id,
    input_brand_id,
    trim(input_job_key),
    coalesce(nullif(trim(input_status), ''), 'active'),
    'single_brand',
    'observation_only',
    coalesce(input_allowed_field_families, array['image_reference', 'supplemental_description']::text[]),
    least(greatest(coalesce(input_max_observations_per_run, 500), 1), 10000),
    least(greatest(coalesce(input_max_retry_attempts, 5), 0), 20),
    least(greatest(coalesce(input_lock_timeout_seconds, 600), 60), 86400),
    coalesce(input_metadata, '{}'::jsonb),
    now()
  )
  on conflict (organization_id, source_id, brand_id, job_key)
  do update set
    trust_profile_id = excluded.trust_profile_id,
    status = excluded.status,
    allowed_field_families = excluded.allowed_field_families,
    max_observations_per_run = excluded.max_observations_per_run,
    max_retry_attempts = excluded.max_retry_attempts,
    lock_timeout_seconds = excluded.lock_timeout_seconds,
    metadata = excluded.metadata,
    updated_at = now()
  returning id into v_job_id;

  return v_job_id;
end;
$$;

revoke all on function public.configure_single_brand_catalog_observation_job(uuid, uuid, uuid, uuid, text, text[], integer, integer, integer, text, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.configure_single_brand_catalog_observation_job(uuid, uuid, uuid, uuid, text, text[], integer, integer, integer, text, jsonb) to service_role;

create or replace function public.append_catalog_observation_audit_event(
  input_organization_id uuid,
  input_job_id uuid,
  input_run_id uuid,
  input_observation_id uuid,
  input_candidate_id uuid,
  input_review_decision_id uuid,
  input_apply_event_id uuid,
  input_actor_id uuid,
  input_action text,
  input_prior_status text default null,
  input_next_status text default null,
  input_message text default null,
  input_evidence_reference text default null,
  input_confidence numeric default null,
  input_payload jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  perform public.require_catalog_observation_service_role();

  insert into public.catalog_observation_audit_ledger (
    organization_id,
    job_id,
    run_id,
    observation_id,
    candidate_id,
    review_decision_id,
    apply_event_id,
    actor_id,
    action,
    prior_status,
    next_status,
    message,
    evidence_reference,
    confidence,
    payload
  ) values (
    input_organization_id,
    input_job_id,
    input_run_id,
    input_observation_id,
    input_candidate_id,
    input_review_decision_id,
    input_apply_event_id,
    input_actor_id,
    left(coalesce(nullif(trim(input_action), ''), 'catalog_observation_event'), 160),
    input_prior_status,
    input_next_status,
    input_message,
    input_evidence_reference,
    input_confidence,
    coalesce(input_payload, '{}'::jsonb)
  )
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function public.append_catalog_observation_audit_event(uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, text, text, text, text, text, numeric, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.append_catalog_observation_audit_event(uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, text, text, text, text, text, numeric, jsonb) to service_role;

create or replace function public.begin_catalog_observation_run(
  input_job_id uuid,
  input_actor_id uuid default null,
  input_metadata jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.catalog_observation_jobs%rowtype;
  v_run_id uuid;
begin
  perform public.require_catalog_observation_service_role();

  select *
  into v_job
  from public.catalog_observation_jobs
  where id = input_job_id
    and status = 'active'
  for update;

  if not found then
    raise exception 'Active catalog observation job not found';
  end if;

  insert into public.catalog_observation_runs (
    organization_id,
    job_id,
    source_id,
    brand_id,
    status,
    actor_id,
    input_metadata
  ) values (
    v_job.organization_id,
    v_job.id,
    v_job.source_id,
    v_job.brand_id,
    'running',
    input_actor_id,
    coalesce(input_metadata, '{}'::jsonb)
  )
  returning id into v_run_id;

  insert into public.catalog_observation_scope_health (
    organization_id,
    job_id,
    source_id,
    brand_id,
    latest_run_id,
    latest_run_status,
    updated_at
  ) values (
    v_job.organization_id,
    v_job.id,
    v_job.source_id,
    v_job.brand_id,
    v_run_id,
    'running',
    now()
  )
  on conflict (organization_id, job_id)
  do update set
    latest_run_id = excluded.latest_run_id,
    latest_run_status = excluded.latest_run_status,
    updated_at = now();

  perform public.append_catalog_observation_audit_event(
    v_job.organization_id,
    v_job.id,
    v_run_id,
    null,
    null,
    null,
    null,
    input_actor_id,
    'run_started',
    null,
    'running',
    null,
    null,
    null,
    input_metadata
  );

  return v_run_id;
end;
$$;

revoke all on function public.begin_catalog_observation_run(uuid, uuid, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.begin_catalog_observation_run(uuid, uuid, jsonb) to service_role;

create or replace function public.finish_catalog_observation_run(
  input_run_id uuid,
  input_status text,
  input_error_message text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run public.catalog_observation_runs%rowtype;
  v_finished_at timestamptz := now();
  v_status text := input_status;
  v_idempotent boolean := false;
begin
  perform public.require_catalog_observation_service_role();

  if v_status not in ('succeeded', 'completed_with_warnings', 'failed', 'cancelled', 'dead_letter') then
    raise exception 'Unsupported catalog observation run status: %', v_status;
  end if;

  select *
  into v_run
  from public.catalog_observation_runs
  where id = input_run_id
  for update;

  if not found then
    raise exception 'Catalog observation run not found';
  end if;

  if v_run.status <> 'running' then
    if v_run.status = v_status then
      v_idempotent := true;
      return jsonb_build_object(
        'run_id', v_run.id,
        'status', v_run.status,
        'duration_ms', v_run.duration_ms,
        'error_message', v_run.error_message,
        'idempotent', true
      );
    end if;

    raise exception 'Catalog observation run is already terminal with status %', v_run.status;
  end if;

  update public.catalog_observation_runs
  set status = v_status,
      finished_at = v_finished_at,
      duration_ms = greatest(0, floor(extract(epoch from (v_finished_at - started_at)) * 1000)::integer),
      error_message = case when v_status in ('failed', 'dead_letter') then input_error_message else null end,
      updated_at = now()
  where id = input_run_id
    and status = 'running'
  returning * into v_run;

  update public.catalog_observation_scope_health
  set latest_run_id = v_run.id,
      latest_run_status = v_run.status,
      latest_success_at = case when v_run.status in ('succeeded', 'completed_with_warnings') then v_run.finished_at else latest_success_at end,
      last_error = case when v_run.status in ('failed', 'dead_letter') then v_run.error_message else null end,
      updated_at = now()
  where organization_id = v_run.organization_id
    and job_id = v_run.job_id;

  perform public.append_catalog_observation_audit_event(
    v_run.organization_id,
    v_run.job_id,
    v_run.id,
    null,
    null,
    null,
    null,
    v_run.actor_id,
    'run_finished',
    'running',
    v_run.status,
    input_error_message,
    null,
    null,
    jsonb_build_object('duration_ms', v_run.duration_ms)
  );

  return jsonb_build_object(
    'run_id', v_run.id,
    'status', v_run.status,
    'duration_ms', v_run.duration_ms,
    'error_message', v_run.error_message,
    'idempotent', v_idempotent
  );
end;
$$;

revoke all on function public.finish_catalog_observation_run(uuid, text, text) from public, anon, authenticated, service_role;
grant execute on function public.finish_catalog_observation_run(uuid, text, text) to service_role;

create or replace function public.advance_catalog_observation_checkpoint(
  input_job_id uuid,
  input_run_id uuid,
  input_cursor_value text,
  input_cursor_metadata jsonb default '{}'::jsonb,
  input_last_observed_at timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run public.catalog_observation_runs%rowtype;
begin
  perform public.require_catalog_observation_service_role();

  select *
  into v_run
  from public.catalog_observation_runs
  where id = input_run_id
    and job_id = input_job_id
    and status in ('succeeded', 'completed_with_warnings')
  for update;

  if not found then
    raise exception 'Checkpoint can only advance from a successful terminal run';
  end if;

  insert into public.catalog_observation_checkpoints (
    organization_id,
    job_id,
    source_id,
    brand_id,
    last_successful_run_id,
    cursor_value,
    cursor_metadata,
    last_observed_at,
    last_success_at,
    last_error,
    updated_at
  ) values (
    v_run.organization_id,
    v_run.job_id,
    v_run.source_id,
    v_run.brand_id,
    v_run.id,
    input_cursor_value,
    coalesce(input_cursor_metadata, '{}'::jsonb),
    coalesce(input_last_observed_at, now()),
    now(),
    null,
    now()
  )
  on conflict (organization_id, job_id)
  do update set
    last_successful_run_id = excluded.last_successful_run_id,
    cursor_value = excluded.cursor_value,
    cursor_metadata = excluded.cursor_metadata,
    last_observed_at = excluded.last_observed_at,
    last_success_at = excluded.last_success_at,
    last_error = null,
    updated_at = now();

  perform public.append_catalog_observation_audit_event(
    v_run.organization_id,
    v_run.job_id,
    v_run.id,
    null,
    null,
    null,
    null,
    v_run.actor_id,
    'checkpoint_advanced',
    null,
    null,
    null,
    null,
    null,
    jsonb_build_object('cursor_value', input_cursor_value, 'cursor_metadata', coalesce(input_cursor_metadata, '{}'::jsonb))
  );

  return jsonb_build_object('job_id', v_run.job_id, 'run_id', v_run.id, 'cursor_value', input_cursor_value);
end;
$$;

revoke all on function public.advance_catalog_observation_checkpoint(uuid, uuid, text, jsonb, timestamptz) from public, anon, authenticated, service_role;
grant execute on function public.advance_catalog_observation_checkpoint(uuid, uuid, text, jsonb, timestamptz) to service_role;

create or replace function public.append_catalog_external_observation(
  input_run_id uuid,
  input_product_code text,
  input_normalized_code text,
  input_field_family text,
  input_field_name text,
  input_raw_value text,
  input_normalized_value text,
  input_evidence_reference text,
  input_evidence_url text default null,
  input_evidence_hash text default null,
  input_evidence_payload jsonb default '{}'::jsonb,
  input_external_product_ref text default null,
  input_confidence numeric default 0.5,
  input_observed_at timestamptz default now(),
  input_collector_actor_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_run public.catalog_observation_runs%rowtype;
  v_job public.catalog_observation_jobs%rowtype;
  v_source public.catalog_external_sources%rowtype;
  v_trust public.catalog_external_source_trust_profiles%rowtype;
  v_catalog_product_id uuid;
  v_deduplication_key text;
  v_observation_id uuid;
  v_existing_observation_id uuid;
  v_run_observation_count integer := 0;
  v_inserted boolean := false;
begin
  perform public.require_catalog_observation_service_role();

  if input_field_family not in ('image_reference', 'supplemental_description') then
    raise exception 'Catalog observation pilot only supports image_reference and supplemental_description';
  end if;

  if nullif(trim(input_product_code), '') is null
     or nullif(trim(input_normalized_code), '') is null
     or nullif(trim(input_field_family), '') is null
     or nullif(trim(input_field_name), '') is null
     or nullif(trim(input_raw_value), '') is null
     or nullif(trim(input_normalized_value), '') is null
     or nullif(trim(input_evidence_reference), '') is null then
    raise exception 'Observation requires product code, normalized code, field, value, and evidence reference';
  end if;

  select *
  into v_run
  from public.catalog_observation_runs
  where id = input_run_id
    and status = 'running'
  for update;

  if not found then
    raise exception 'Running catalog observation run not found';
  end if;

  select *
  into v_job
  from public.catalog_observation_jobs
  where id = v_run.job_id
    and status = 'active';

  if not found then
    raise exception 'Active catalog observation job not found';
  end if;

  select *
  into v_source
  from public.catalog_external_sources
  where id = v_run.source_id
    and is_active = true;

  if not found then
    raise exception 'Active external source not found';
  end if;

  select *
  into v_trust
  from public.catalog_external_source_trust_profiles
  where id = v_job.trust_profile_id
    and is_active = true;

  if not found then
    raise exception 'Active trust profile not found';
  end if;

  if not (input_field_family = any(v_job.allowed_field_families))
     or not (input_field_family = any(v_trust.allowed_field_families)) then
    raise exception 'Field family % is not allowed for this observation scope', input_field_family;
  end if;

  select cp.id
  into v_catalog_product_id
  from public.catalog_products cp
  where cp.organization_id = v_run.organization_id
    and cp.brand_id = v_run.brand_id
    and cp.normalized_code = input_normalized_code
  order by cp.product_code, cp.id
  limit 1;

  v_deduplication_key := md5(concat_ws(
    '|',
    v_run.organization_id::text,
    v_run.source_id::text,
    v_run.brand_id::text,
    v_job.id::text,
    coalesce(v_run.source_revision, ''),
    input_normalized_code,
    input_field_family,
    input_field_name,
    input_normalized_value,
    coalesce(input_evidence_hash, ''),
    input_evidence_reference,
    coalesce(input_external_product_ref, '')
  ));

  select id
  into v_existing_observation_id
  from public.catalog_external_observations
  where organization_id = v_run.organization_id
    and deduplication_key = v_deduplication_key;

  if v_existing_observation_id is not null then
    update public.catalog_observation_runs
    set deduped_count = deduped_count + 1,
        updated_at = now()
    where id = v_run.id;

    perform public.append_catalog_observation_audit_event(
      v_run.organization_id,
      v_run.job_id,
      v_run.id,
      v_existing_observation_id,
      null,
      null,
      null,
      input_collector_actor_id,
      'observation_deduped',
      null,
      'queued',
      null,
      input_evidence_reference,
      least(greatest(coalesce(input_confidence, 0.5), 0), 1),
      jsonb_build_object('field_family', input_field_family, 'field_name', input_field_name)
    );

    return v_existing_observation_id;
  end if;

  select count(*)::integer
  into v_run_observation_count
  from public.catalog_external_observations
  where organization_id = v_run.organization_id
    and run_id = v_run.id;

  if v_run_observation_count >= v_job.max_observations_per_run then
    raise exception 'Catalog observation run limit reached: %', v_job.max_observations_per_run;
  end if;

  insert into public.catalog_external_observations (
    organization_id,
    source_id,
    trust_profile_id,
    job_id,
    run_id,
    brand_id,
    catalog_product_id,
    product_code,
    normalized_code,
    external_product_ref,
    field_family,
    field_name,
    raw_value,
    normalized_value,
    evidence_url,
    evidence_reference,
    evidence_hash,
    evidence_payload,
    source_revision,
    confidence,
    freshness_status,
    license_posture,
    observed_at,
    collector_actor_id,
    deduplication_key
  ) values (
    v_run.organization_id,
    v_run.source_id,
    v_job.trust_profile_id,
    v_run.job_id,
    v_run.id,
    v_run.brand_id,
    v_catalog_product_id,
    trim(input_product_code),
    trim(input_normalized_code),
    nullif(trim(input_external_product_ref), ''),
    trim(input_field_family),
    trim(input_field_name),
    input_raw_value,
    input_normalized_value,
    nullif(trim(input_evidence_url), ''),
    trim(input_evidence_reference),
    nullif(trim(input_evidence_hash), ''),
    coalesce(input_evidence_payload, '{}'::jsonb),
    v_run.source_revision,
    least(greatest(coalesce(input_confidence, 0.5), 0), 1),
    'unknown',
    v_source.license_posture,
    coalesce(input_observed_at, now()),
    input_collector_actor_id,
    v_deduplication_key
  )
  returning id into v_observation_id;

  v_inserted := true;

  update public.catalog_observation_runs
  set observed_count = observed_count + 1,
      updated_at = now()
  where id = v_run.id;

  insert into public.catalog_observation_scope_health (
    organization_id,
    job_id,
    source_id,
    brand_id,
    queued_count,
    latest_run_id,
    latest_run_status,
    updated_at
  ) values (
    v_run.organization_id,
    v_run.job_id,
    v_run.source_id,
    v_run.brand_id,
    1,
    v_run.id,
    'running',
    now()
  )
  on conflict (organization_id, job_id)
  do update set
    queued_count = public.catalog_observation_scope_health.queued_count + 1,
    latest_run_id = excluded.latest_run_id,
    latest_run_status = excluded.latest_run_status,
    updated_at = now();

  perform public.append_catalog_observation_audit_event(
    v_run.organization_id,
    v_run.job_id,
    v_run.id,
    v_observation_id,
    null,
    null,
    null,
    input_collector_actor_id,
    'observation_appended',
    null,
    'queued',
    null,
    input_evidence_reference,
    least(greatest(coalesce(input_confidence, 0.5), 0), 1),
    jsonb_build_object('field_family', input_field_family, 'field_name', input_field_name)
  );

  return v_observation_id;
end;
$$;

revoke all on function public.append_catalog_external_observation(uuid, text, text, text, text, text, text, text, text, text, jsonb, text, numeric, timestamptz, uuid) from public, anon, authenticated, service_role;
grant execute on function public.append_catalog_external_observation(uuid, text, text, text, text, text, text, text, text, text, jsonb, text, numeric, timestamptz, uuid) to service_role;

create or replace function public.claim_catalog_observation_compare_batch(
  input_job_id uuid,
  input_batch_size integer default 50,
  input_worker_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.catalog_observation_jobs%rowtype;
  v_batch_size integer := least(greatest(coalesce(input_batch_size, 50), 1), 100);
  v_lock_token uuid := gen_random_uuid();
  v_claimed jsonb := '[]'::jsonb;
  v_claimed_count integer := 0;
  v_released_count integer := 0;
  v_queued_claimed_count integer := 0;
  v_failed_claimed_count integer := 0;
begin
  perform public.require_catalog_observation_service_role();

  select *
  into v_job
  from public.catalog_observation_jobs
  where id = input_job_id
    and status = 'active';

  if not found then
    raise exception 'Active catalog observation job not found';
  end if;

  with released as (
    update public.catalog_external_observations ceo
    set compare_status = 'queued',
        locked_at = null,
        lock_token = null,
        locked_by = null,
        next_retry_at = now(),
        updated_at = now()
    where ceo.organization_id = v_job.organization_id
      and ceo.job_id = v_job.id
      and ceo.compare_status = 'claimed'
      and ceo.locked_at < now() - make_interval(secs => v_job.lock_timeout_seconds)
    returning ceo.organization_id, ceo.job_id
  )
  select count(*)::integer into v_released_count
  from released;

  if v_released_count > 0 then
    update public.catalog_observation_scope_health h
    set claimed_count = greatest(0, h.claimed_count - v_released_count),
        queued_count = h.queued_count + v_released_count,
        updated_at = now()
    where h.organization_id = v_job.organization_id
      and h.job_id = v_job.id;
  end if;

  create temporary table if not exists pg_temp.wp2a_claimed_observations (
    id uuid,
    prior_compare_status text,
    product_code text,
    normalized_code text,
    field_family text,
    field_name text,
    normalized_value text,
    catalog_product_id uuid
  ) on commit drop;

  truncate table pg_temp.wp2a_claimed_observations;

  with next_batch as (
    select ceo.id, ceo.compare_status as prior_compare_status
    from public.catalog_external_observations ceo
    where ceo.organization_id = v_job.organization_id
      and ceo.job_id = v_job.id
      and ceo.compare_status in ('queued', 'failed')
      and ceo.next_retry_at <= now()
      and ceo.retry_count <= v_job.max_retry_attempts
    order by ceo.next_retry_at, ceo.ingested_at, ceo.id
    limit v_batch_size
    for update skip locked
  ), claimed as (
    update public.catalog_external_observations ceo
    set compare_status = 'claimed',
        locked_at = now(),
        lock_token = v_lock_token,
        locked_by = coalesce(nullif(trim(input_worker_id), ''), 'catalog-observation-worker'),
        updated_at = now()
    from next_batch
    where ceo.id = next_batch.id
    returning ceo.id,
              next_batch.prior_compare_status,
              ceo.product_code,
              ceo.normalized_code,
              ceo.field_family,
              ceo.field_name,
              ceo.normalized_value,
              ceo.catalog_product_id
  )
  insert into pg_temp.wp2a_claimed_observations
  select * from claimed;

  select count(*)::integer,
         count(*) filter (where prior_compare_status = 'queued')::integer,
         count(*) filter (where prior_compare_status = 'failed')::integer,
         coalesce(jsonb_agg(to_jsonb(c) - 'prior_compare_status' order by c.id), '[]'::jsonb)
  into v_claimed_count, v_queued_claimed_count, v_failed_claimed_count, v_claimed
  from pg_temp.wp2a_claimed_observations c;

  if v_claimed_count > 0 then
    update public.catalog_observation_scope_health
    set queued_count = greatest(0, queued_count - v_queued_claimed_count),
        failed_count = greatest(0, failed_count - v_failed_claimed_count),
        claimed_count = claimed_count + v_claimed_count,
        updated_at = now()
    where organization_id = v_job.organization_id
      and job_id = v_job.id;
  end if;

  return jsonb_build_object(
    'job_id', input_job_id,
    'lock_token', v_lock_token,
    'released_stale_count', v_released_count,
    'claimed_count', v_claimed_count,
    'queued_claimed_count', v_queued_claimed_count,
    'failed_claimed_count', v_failed_claimed_count,
    'observations', v_claimed
  );
end;
$$;

revoke all on function public.claim_catalog_observation_compare_batch(uuid, integer, text) from public, anon, authenticated, service_role;
grant execute on function public.claim_catalog_observation_compare_batch(uuid, integer, text) to service_role;

create or replace function public.complete_catalog_observation_compare(
  input_observation_ids uuid[],
  input_lock_token uuid,
  input_compare_outcome text,
  input_candidate_status text,
  input_apply_eligibility text default 'not_eligible',
  input_current_value text default null,
  input_reason text default null,
  input_downstream_impact jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_requested_count integer := coalesce(array_length(input_observation_ids, 1), 0);
  v_updated_count integer := 0;
  v_review_count integer := 0;
begin
  perform public.require_catalog_observation_service_role();

  if input_lock_token is null then
    raise exception 'Complete compare requires lock token';
  end if;

  if input_compare_outcome not in ('no_product_match', 'no_change', 'enrichment_candidate', 'guarded_enrichment_candidate', 'protected_conflict', 'license_blocked', 'stale_source', 'failed') then
    raise exception 'Unsupported compare outcome: %', input_compare_outcome;
  end if;

  if input_candidate_status not in ('observed', 'no_change', 'enrichment_candidate', 'guarded_enrichment_candidate', 'protected_conflict', 'license_blocked', 'stale_source', 'review_required', 'approved_for_apply', 'rejected', 'deferred', 'applied', 'failed', 'dead_letter') then
    raise exception 'Unsupported candidate status: %', input_candidate_status;
  end if;

  create temporary table if not exists pg_temp.wp2a_completed_observations (
    id uuid,
    organization_id uuid,
    job_id uuid,
    run_id uuid,
    catalog_product_id uuid,
    field_name text,
    normalized_value text,
    apply_eligibility text
  ) on commit drop;

  truncate table pg_temp.wp2a_completed_observations;

  with updated as (
    update public.catalog_external_observations ceo
    set compare_status = 'compared',
        compare_outcome = input_compare_outcome,
        apply_eligibility = input_apply_eligibility,
        review_status = case
          when input_apply_eligibility = 'requires_review' then 'pending_review'
          else ceo.review_status
        end,
        routed_at = case
          when input_apply_eligibility = 'requires_review' then now()
          else ceo.routed_at
        end,
        locked_at = null,
        lock_token = null,
        locked_by = null,
        last_error = null,
        compared_at = now(),
        updated_at = now()
    where ceo.id = any(input_observation_ids)
      and ceo.compare_status = 'claimed'
      and ceo.lock_token = input_lock_token
    returning ceo.id,
              ceo.organization_id,
              ceo.job_id,
              ceo.run_id,
              ceo.catalog_product_id,
              ceo.field_name,
              ceo.normalized_value,
              ceo.apply_eligibility
  )
  insert into pg_temp.wp2a_completed_observations
  select * from updated;

  select count(*)::integer,
         count(*) filter (where apply_eligibility = 'requires_review')::integer
  into v_updated_count, v_review_count
  from pg_temp.wp2a_completed_observations;

  insert into public.catalog_observation_candidates (
    organization_id,
    observation_id,
    job_id,
    run_id,
    catalog_product_id,
    field_name,
    current_value,
    proposed_value,
    candidate_status,
    comparison_reason,
    downstream_impact,
    updated_at
  )
  select
    completed.organization_id,
    completed.id,
    completed.job_id,
    completed.run_id,
    completed.catalog_product_id,
    completed.field_name,
    input_current_value,
    completed.normalized_value,
    input_candidate_status,
    input_reason,
    coalesce(input_downstream_impact, '{}'::jsonb),
    now()
  from pg_temp.wp2a_completed_observations completed
  on conflict (organization_id, observation_id)
  do update set
    current_value = excluded.current_value,
    proposed_value = excluded.proposed_value,
    candidate_status = excluded.candidate_status,
    comparison_reason = excluded.comparison_reason,
    downstream_impact = excluded.downstream_impact,
    updated_at = now();

  update public.catalog_observation_runs r
  set candidate_count = candidate_count + counts.count_value,
      review_routed_count = review_routed_count + counts.review_count,
      updated_at = now()
  from (
    select run_id,
           count(*)::integer as count_value,
           count(*) filter (where apply_eligibility = 'requires_review')::integer as review_count
    from pg_temp.wp2a_completed_observations
    group by run_id
  ) counts
  where r.id = counts.run_id;

  update public.catalog_observation_scope_health h
  set claimed_count = greatest(0, h.claimed_count - counts.count_value),
      compared_count = h.compared_count + counts.count_value,
      pending_review_count = h.pending_review_count + counts.review_count,
      updated_at = now()
  from (
    select organization_id,
           job_id,
           count(*)::bigint as count_value,
           count(*) filter (where apply_eligibility = 'requires_review')::bigint as review_count
    from pg_temp.wp2a_completed_observations
    group by organization_id, job_id
  ) counts
  where h.organization_id = counts.organization_id
    and h.job_id = counts.job_id;

  return jsonb_build_object(
    'requested_count', v_requested_count,
    'updated_count', v_updated_count,
    'rejected_count', greatest(0, v_requested_count - v_updated_count)
  );
end;
$$;

revoke all on function public.complete_catalog_observation_compare(uuid[], uuid, text, text, text, text, text, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.complete_catalog_observation_compare(uuid[], uuid, text, text, text, text, text, jsonb) to service_role;

create or replace function public.fail_catalog_observation_compare(
  input_observation_ids uuid[],
  input_lock_token uuid,
  input_error_message text,
  input_retry boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_requested_count integer := coalesce(array_length(input_observation_ids, 1), 0);
  v_updated_count integer := 0;
begin
  perform public.require_catalog_observation_service_role();

  if input_lock_token is null then
    raise exception 'Fail compare requires lock token';
  end if;

  create temporary table if not exists pg_temp.wp2a_failed_observations (
    organization_id uuid,
    job_id uuid,
    compare_status text
  ) on commit drop;

  truncate table pg_temp.wp2a_failed_observations;

  with updated as (
    update public.catalog_external_observations ceo
    set compare_status = case
          when input_retry and ceo.retry_count < job.max_retry_attempts then 'failed'
          else 'dead_letter'
        end,
        retry_count = ceo.retry_count + 1,
        next_retry_at = case
          when input_retry and ceo.retry_count < job.max_retry_attempts
            then now() + make_interval(secs => least(600, 15 * greatest(1, ceo.retry_count + 1)))
          else ceo.next_retry_at
        end,
        locked_at = null,
        lock_token = null,
        locked_by = null,
        last_error = left(coalesce(input_error_message, 'compare failed'), 2000),
        dead_letter_reason = case
          when input_retry and ceo.retry_count < job.max_retry_attempts then null
          else left(coalesce(input_error_message, 'compare failed'), 2000)
        end,
        updated_at = now()
    from public.catalog_observation_jobs job
    where ceo.id = any(input_observation_ids)
      and ceo.job_id = job.id
      and ceo.compare_status = 'claimed'
      and ceo.lock_token = input_lock_token
    returning ceo.organization_id, ceo.job_id, ceo.compare_status
  )
  insert into pg_temp.wp2a_failed_observations
  select * from updated;

  select count(*)::integer into v_updated_count
  from pg_temp.wp2a_failed_observations;

  update public.catalog_observation_scope_health h
  set claimed_count = greatest(0, h.claimed_count - counts.count_value),
      failed_count = h.failed_count + counts.failed_count,
      dead_letter_count = h.dead_letter_count + counts.dead_letter_count,
      last_error = left(coalesce(input_error_message, 'compare failed'), 2000),
      updated_at = now()
  from (
    select organization_id,
           job_id,
           count(*)::bigint as count_value,
           count(*) filter (where compare_status = 'failed')::bigint as failed_count,
           count(*) filter (where compare_status = 'dead_letter')::bigint as dead_letter_count
    from pg_temp.wp2a_failed_observations
    group by organization_id, job_id
  ) counts
  where h.organization_id = counts.organization_id
    and h.job_id = counts.job_id;

  return jsonb_build_object(
    'requested_count', v_requested_count,
    'updated_count', v_updated_count,
    'rejected_count', greatest(0, v_requested_count - v_updated_count)
  );
end;
$$;

revoke all on function public.fail_catalog_observation_compare(uuid[], uuid, text, boolean) from public, anon, authenticated, service_role;
grant execute on function public.fail_catalog_observation_compare(uuid[], uuid, text, boolean) to service_role;

create or replace function public.record_catalog_observation_review_decision(
  input_observation_id uuid,
  input_decision text,
  input_reviewer_id uuid,
  input_reason text,
  input_previous_value text default null,
  input_proposed_value text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_observation public.catalog_external_observations%rowtype;
  v_candidate public.catalog_observation_candidates%rowtype;
  v_review_id uuid;
  v_review_status text;
  v_apply_eligibility text;
  v_candidate_status text;
begin
  perform public.require_catalog_observation_service_role();

  if input_decision not in ('approve_apply', 'reject_candidate', 'defer_candidate', 'request_more_evidence', 'accept_evidence_only') then
    raise exception 'Unsupported review decision: %', input_decision;
  end if;

  if input_reviewer_id is null then
    raise exception 'Catalog observation review requires reviewer_id';
  end if;

  if input_decision in ('approve_apply', 'reject_candidate', 'defer_candidate', 'request_more_evidence') and nullif(trim(input_reason), '') is null then
    raise exception 'Catalog observation review decision requires reason';
  end if;

  select *
  into v_observation
  from public.catalog_external_observations
  where id = input_observation_id
  for update;

  if not found then
    raise exception 'Catalog external observation not found';
  end if;

  if not exists (
    select 1
    from public.profiles p
    where p.id = input_reviewer_id
      and p.organization_id = v_observation.organization_id
      and p.is_active
      and lower(coalesce(p.role, '')) in ('admin', 'superadmin')
  ) then
    raise exception 'Catalog observation reviewer must be an active admin profile in the observation organization';
  end if;

  if v_observation.compare_status <> 'compared'
     or v_observation.review_status <> 'pending_review'
     or v_observation.apply_eligibility <> 'requires_review' then
    raise exception 'Observation is not pending eligible human review';
  end if;

  select *
  into v_candidate
  from public.catalog_observation_candidates
  where organization_id = v_observation.organization_id
    and observation_id = v_observation.id
    and candidate_status in ('review_required', 'guarded_enrichment_candidate', 'enrichment_candidate', 'protected_conflict')
  order by updated_at desc
  limit 1;

  if not found then
    raise exception 'Compatible catalog observation candidate is required before review';
  end if;

  v_review_status := case
    when input_decision = 'approve_apply' then 'approved'
    when input_decision = 'reject_candidate' then 'rejected'
    when input_decision = 'defer_candidate' then 'deferred'
    when input_decision = 'request_more_evidence' then 'pending_review'
    else 'ignored'
  end;

  v_apply_eligibility := case
    when input_decision = 'approve_apply' then 'eligible'
    when input_decision = 'request_more_evidence' then 'requires_review'
    when input_decision = 'reject_candidate' then 'blocked'
    else 'not_eligible'
  end;

  v_candidate_status := case
    when input_decision = 'approve_apply' then 'approved_for_apply'
    when input_decision = 'reject_candidate' then 'rejected'
    when input_decision = 'defer_candidate' then 'deferred'
    when input_decision = 'request_more_evidence' then 'review_required'
    else 'rejected'
  end;

  insert into public.catalog_observation_review_decisions (
    organization_id,
    observation_id,
    candidate_id,
    job_id,
    run_id,
    catalog_product_id,
    field_name,
    decision,
    reviewer_id,
    previous_value,
    proposed_value,
    reason
  ) values (
    v_observation.organization_id,
    v_observation.id,
    v_candidate.id,
    v_observation.job_id,
    v_observation.run_id,
    v_observation.catalog_product_id,
    v_observation.field_name,
    input_decision,
    input_reviewer_id,
    input_previous_value,
    coalesce(input_proposed_value, v_observation.normalized_value),
    input_reason
  )
  returning id into v_review_id;

  update public.catalog_observation_candidates
  set candidate_status = v_candidate_status,
      updated_at = now()
  where id = v_candidate.id;

  update public.catalog_external_observations
  set review_status = v_review_status,
      apply_eligibility = v_apply_eligibility,
      reviewed_at = now(),
      updated_at = now()
  where id = v_observation.id;

  update public.catalog_observation_scope_health
  set pending_review_count = greatest(
        0,
        pending_review_count + case
          when v_observation.review_status = 'pending_review' and v_review_status = 'pending_review' then 0
          when v_observation.review_status = 'pending_review' and v_review_status <> 'pending_review' then -1
          when v_observation.review_status <> 'pending_review' and v_review_status = 'pending_review' then 1
          else 0
        end
      ),
      updated_at = now()
  where organization_id = v_observation.organization_id
    and job_id = v_observation.job_id;

  perform public.append_catalog_observation_audit_event(
    v_observation.organization_id,
    v_observation.job_id,
    v_observation.run_id,
    v_observation.id,
    v_candidate.id,
    v_review_id,
    null,
    input_reviewer_id,
    'review_decision_recorded',
    v_observation.review_status,
    v_review_status,
    input_reason,
    v_observation.evidence_reference,
    v_observation.confidence,
    jsonb_build_object('decision', input_decision)
  );

  return v_review_id;
end;
$$;

revoke all on function public.record_catalog_observation_review_decision(uuid, text, uuid, text, text, text) from public, anon, authenticated, service_role;
grant execute on function public.record_catalog_observation_review_decision(uuid, text, uuid, text, text, text) to service_role;

create or replace function public.record_catalog_observation_apply_event(
  input_review_decision_id uuid,
  input_actor_id uuid,
  input_downstream_impact jsonb,
  input_guardian_snapshot jsonb,
  input_reason text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_review public.catalog_observation_review_decisions%rowtype;
  v_observation public.catalog_external_observations%rowtype;
  v_apply_event_id uuid;
begin
  perform public.require_catalog_observation_service_role();

  if input_actor_id is null then
    raise exception 'Catalog observation apply event requires actor_id';
  end if;

  if nullif(trim(input_reason), '') is null then
    raise exception 'Catalog observation apply event requires reason';
  end if;

  select *
  into v_review
  from public.catalog_observation_review_decisions
  where id = input_review_decision_id;

  if not found then
    raise exception 'Catalog observation review decision not found';
  end if;

  if v_review.decision <> 'approve_apply' then
    raise exception 'Only approve_apply review decisions can create apply events';
  end if;

  select *
  into v_observation
  from public.catalog_external_observations
  where id = v_review.observation_id
  for update;

  if not found then
    raise exception 'Catalog external observation not found';
  end if;

  if v_observation.apply_eligibility <> 'eligible' or v_observation.review_status <> 'approved' then
    raise exception 'Observation is not approved and eligible for apply event';
  end if;

  if not exists (
    select 1
    from public.profiles p
    where p.id = input_actor_id
      and p.organization_id = v_observation.organization_id
      and p.is_active
  ) then
    raise exception 'Catalog observation apply actor must be an active profile in the observation organization';
  end if;

  if v_observation.source_id is null
     or v_observation.trust_profile_id is null
     or nullif(trim(v_observation.evidence_reference), '') is null
     or v_observation.confidence is null
     or nullif(trim(v_observation.license_posture), '') is null then
    raise exception 'Observation source evidence snapshot is incomplete';
  end if;

  insert into public.catalog_apply_events (
    organization_id,
    observation_id,
    review_decision_id,
    catalog_product_id,
    field_name,
    previous_value,
    proposed_value,
    apply_status,
    actor_id,
    source_snapshot,
    downstream_impact,
    guardian_snapshot,
    reason
  ) values (
    v_review.organization_id,
    v_review.observation_id,
    v_review.id,
    v_review.catalog_product_id,
    v_review.field_name,
    v_review.previous_value,
    v_review.proposed_value,
    'recorded',
    input_actor_id,
    jsonb_build_object(
      'source_id', v_observation.source_id,
      'trust_profile_id', v_observation.trust_profile_id,
      'source_revision', v_observation.source_revision,
      'evidence_reference', v_observation.evidence_reference,
      'evidence_url', v_observation.evidence_url,
      'evidence_hash', v_observation.evidence_hash,
      'confidence', v_observation.confidence,
      'license_posture', v_observation.license_posture,
      'observed_at', v_observation.observed_at
    ),
    coalesce(input_downstream_impact, '{}'::jsonb),
    coalesce(input_guardian_snapshot, '{}'::jsonb),
    input_reason
  )
  on conflict (organization_id, observation_id, field_name, apply_status)
  do nothing
  returning id into v_apply_event_id;

  if v_apply_event_id is null then
    select id
    into v_apply_event_id
    from public.catalog_apply_events
    where organization_id = v_review.organization_id
      and observation_id = v_review.observation_id
      and field_name = v_review.field_name
      and apply_status = 'recorded';

    return v_apply_event_id;
  end if;

  update public.catalog_observation_runs
  set apply_event_count = apply_event_count + 1,
      updated_at = now()
  where id = v_observation.run_id;

  perform public.append_catalog_observation_audit_event(
    v_observation.organization_id,
    v_observation.job_id,
    v_observation.run_id,
    v_observation.id,
    null,
    v_review.id,
    v_apply_event_id,
    input_actor_id,
    'apply_event_recorded',
    null,
    'recorded',
    input_reason,
    v_observation.evidence_reference,
    v_observation.confidence,
    jsonb_build_object('field_name', v_observation.field_name)
  );

  return v_apply_event_id;
end;
$$;

revoke all on function public.record_catalog_observation_apply_event(uuid, uuid, jsonb, jsonb, text) from public, anon, authenticated, service_role;
grant execute on function public.record_catalog_observation_apply_event(uuid, uuid, jsonb, jsonb, text) to service_role;

create or replace function public.get_catalog_observation_scope_health(input_job_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_id uuid := public.current_profile_org_id();
  v_health public.catalog_observation_scope_health%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_org_id is null or not public.is_superadmin() then
      raise exception 'Catalog observation health requires an active admin profile';
    end if;
  end if;

  select *
  into v_health
  from public.catalog_observation_scope_health
  where job_id = input_job_id
    and (
      coalesce(auth.role(), '') = 'service_role'
      or organization_id = v_org_id
    );

  if not found then
    return jsonb_build_object(
      'job_id', input_job_id,
      'status', 'NO_HEALTH',
      'generated_at', now()
    );
  end if;

  return jsonb_build_object(
    'organization_id', v_health.organization_id,
    'job_id', v_health.job_id,
    'source_id', v_health.source_id,
    'brand_id', v_health.brand_id,
    'queued_count', v_health.queued_count,
    'claimed_count', v_health.claimed_count,
    'compared_count', v_health.compared_count,
    'failed_count', v_health.failed_count,
    'dead_letter_count', v_health.dead_letter_count,
    'pending_review_count', v_health.pending_review_count,
    'latest_run_id', v_health.latest_run_id,
    'latest_run_status', v_health.latest_run_status,
    'latest_success_at', v_health.latest_success_at,
    'last_error', v_health.last_error,
    'generated_at', now()
  );
end;
$$;

revoke all on function public.get_catalog_observation_scope_health(uuid) from public, anon, authenticated, service_role;
grant execute on function public.get_catalog_observation_scope_health(uuid) to authenticated;
grant execute on function public.get_catalog_observation_scope_health(uuid) to service_role;

create temporary table wp2a_validation_prefix (
  prefix text primary key
) on commit drop;

insert into wp2a_validation_prefix(prefix)
values ('wp2a-validation-' || txid_current());

create temporary table wp2a_validation_context (
  prefix text primary key,
  organization_id uuid,
  brand_id uuid,
  product_id uuid,
  source_id uuid,
  trust_profile_id uuid,
  job_id uuid,
  run_id uuid,
  observation_id uuid,
  deduplication_key text,
  bounded_job_id uuid
) on commit drop;

do $wp2a_zero_side_effect_gate$
declare
  v_new_table_rows bigint;
  v_catalog_integrity_backfill_running bigint := 0;
begin
  select
    (select count(*) from public.catalog_external_sources) +
    (select count(*) from public.catalog_external_source_trust_profiles) +
    (select count(*) from public.catalog_observation_jobs) +
    (select count(*) from public.catalog_observation_runs) +
    (select count(*) from public.catalog_observation_checkpoints) +
    (select count(*) from public.catalog_external_observations) +
    (select count(*) from public.catalog_observation_candidates) +
    (select count(*) from public.catalog_observation_review_decisions) +
    (select count(*) from public.catalog_apply_events) +
    (select count(*) from public.catalog_observation_audit_ledger) +
    (select count(*) from public.catalog_observation_scope_health)
  into v_new_table_rows;

  if v_new_table_rows <> 0 then
    raise exception
      'BLOCKED: migration created or found % rows in new observation tables before fixtures',
      v_new_table_rows;
  end if;

  if to_regclass('public.catalog_integrity_backfill_state') is not null then
    execute
      'select count(*) from public.catalog_integrity_backfill_state where status = ''running'''
    into v_catalog_integrity_backfill_running;
  end if;

  if v_catalog_integrity_backfill_running <> 0 then
    raise exception
      'BLOCKED: Catalog Integrity backfill is running before controlled validation';
  end if;
end;
$wp2a_zero_side_effect_gate$;

savepoint wp2a_fixture_scope;

set local "request.jwt.claim.role" = 'service_role';

do $wp2a_validation$
declare
  v_prefix text;
  v_org_id uuid;
  v_other_org_id uuid;
  v_brand_id uuid;
  v_other_brand_id uuid;
  v_product_id uuid;
  v_other_product_id uuid;
  v_product_code text;
  v_normalized_code text;
  v_product_before jsonb;
  v_product_after jsonb;
  v_source_id uuid;
  v_other_source_id uuid;
  v_trust_id uuid;
  v_other_trust_id uuid;
  v_job_id uuid;
  v_other_job_id uuid;
  v_run_id uuid;
  v_second_job_id uuid;
  v_second_run_id uuid;
  v_observation_id uuid;
  v_observation_id_again uuid;
  v_dedup_key text;
  v_dedup_count integer;
  v_claim jsonb;
  v_claim2 jsonb;
  v_result jsonb;
  v_lock_token uuid;
  v_review_id uuid;
  v_apply_event_id uuid;
  v_apply_event_id_again uuid;
  v_actor_id uuid;
  v_public_table_acl_count integer;
  v_table_name text;
  v_role_name text;
  v_priv text;
  v_initial_integrity_queue_count bigint;
  v_final_integrity_queue_count bigint;
  v_initial_backfill_state jsonb;
  v_final_backfill_state jsonb;
  v_retry_job_id uuid;
  v_retry_run_id uuid;
  v_retry_observation_id uuid;
  v_retry_status text;
  v_retry_count integer;
  v_retry_next_at timestamptz;
  v_dead_letter_claim jsonb;
  v_stale_job_id uuid;
  v_stale_run_id uuid;
  v_stale_observation_id uuid;
  v_fresh_locked_observation_id uuid;
  v_old_lock_token uuid;
  v_new_lock_token uuid;
  v_bounded_job_id uuid;
  v_bounded_run_id uuid;
  v_bounded_claim jsonb;
  v_bounded_claim2 jsonb;
  v_bounded_ids uuid[];
  v_bounded_ids2 uuid[];
  v_health jsonb;
  v_health_before jsonb;
  v_health_after jsonb;
  v_low_limit_job_id uuid;
  v_low_limit_run_id uuid;
  v_low_limit_observation_id uuid;
  v_other_org_product_id uuid;
  v_profile_a_id uuid;
  v_profile_b_id uuid;
  v_inactive_profile_id uuid;
  v_paused_job_id uuid;
  v_paused_run_id uuid;
  v_mixed_job_id uuid;
  v_mixed_run_id uuid;
  v_mixed_queued_observation_id uuid;
  v_mixed_failed_observation_id uuid;
  v_request_review_id uuid;
  v_review_state text;
  v_apply_state text;
  v_candidate_state text;
  v_plan_json jsonb;
  v_plan_text text;
  v_expected_index text;
  v_actual_status_counts jsonb;
  v_structural_org_isolation_ok boolean := false;
  v_anon_role_oid oid;
  v_authenticated_role_oid oid;
  v_service_role_oid oid;
  v_function_signature text;
  v_expected_public boolean;
  v_expected_anon boolean;
  v_expected_authenticated boolean;
  v_expected_service_role boolean;
  v_actual_public boolean;
  v_actual_anon boolean;
  v_actual_authenticated boolean;
  v_actual_service_role boolean;
begin
  select prefix into strict v_prefix from wp2a_validation_prefix;

  with deterministic_fixture as (
    select
      p.id as profile_id,
      p.organization_id,
      cp.brand_id,
      cp.id as product_id,
      cp.product_code,
      cp.normalized_code
    from public.profiles p
    join public.catalog_products cp
      on cp.organization_id = p.organization_id
    where p.is_active
      and lower(coalesce(p.role, '')) = 'superadmin'
      and cp.brand_id is not null
      and nullif(cp.product_code, '') is not null
      and nullif(cp.normalized_code, '') is not null
    order by p.id, cp.created_at desc nulls last, cp.id
    limit 1
  )
  select organization_id, brand_id, product_id, product_code, normalized_code, profile_id
  into v_org_id, v_brand_id, v_product_id, v_product_code, v_normalized_code, v_profile_a_id
  from deterministic_fixture;

  if v_org_id is null then
    raise exception 'BLOCKED: no active superadmin profile with a matching catalog product fixture exists';
  end if;

  select cp.brand_id, cp.id
  into v_other_brand_id, v_other_product_id
  from public.catalog_products cp
  where cp.organization_id = v_org_id
    and cp.brand_id is distinct from v_brand_id
  order by cp.created_at desc nulls last, cp.id
  limit 1;

  select o.id into v_other_org_id
  from public.organizations o
  where o.id <> v_org_id
  order by o.id
  limit 1;

  v_actor_id := v_profile_a_id;

  select p.id
  into v_inactive_profile_id
  from public.profiles p
  where p.organization_id = v_org_id
    and not p.is_active
  order by p.id
  limit 1;

  select cp.id
  into v_other_org_product_id
  from public.catalog_products cp
  where cp.organization_id is distinct from v_org_id
  order by cp.created_at desc nulls last, cp.id
  limit 1;

  if v_other_org_id is not null then
    select p.id
    into v_profile_b_id
    from public.profiles p
    where p.organization_id = v_other_org_id
      and p.is_active
      and lower(coalesce(p.role, '')) = 'superadmin'
    order by p.id
    limit 1;
  end if;

  select to_jsonb(cp.*) into v_product_before
  from public.catalog_products cp
  where cp.id = v_product_id;

  select count(*) into v_initial_integrity_queue_count
  from public.catalog_integrity_queue
  where product_id = v_product_id;

  if to_regclass('public.catalog_integrity_backfill_state') is not null then
    execute 'select coalesce(jsonb_agg(to_jsonb(s) order by s.organization_id), ''[]''::jsonb) from public.catalog_integrity_backfill_state s'
    into v_initial_backfill_state;
  else
    v_initial_backfill_state := '[]'::jsonb;
  end if;

  select oid into strict v_anon_role_oid from pg_roles where rolname = 'anon';
  select oid into strict v_authenticated_role_oid from pg_roles where rolname = 'authenticated';
  select oid into strict v_service_role_oid from pg_roles where rolname = 'service_role';

  for v_function_signature, v_expected_public, v_expected_anon, v_expected_authenticated, v_expected_service_role in
    select * from (
      values
        ('public.require_catalog_observation_service_role()'::text, false, false, false, true),
        ('public.prevent_catalog_external_observation_evidence_mutation()'::text, false, false, false, false),
        ('public.prevent_catalog_observation_audit_mutation()'::text, false, false, false, false),
        ('public.validate_catalog_observation_scope_consistency()'::text, false, false, false, false),
        ('public.configure_catalog_external_source(uuid, text, text, text, text, text, text, text, text, boolean, jsonb)'::text, false, false, false, true),
        ('public.configure_catalog_external_source_trust_profile(uuid, uuid, text, numeric, text[], boolean, text, boolean, boolean, text)'::text, false, false, false, true),
        ('public.configure_single_brand_catalog_observation_job(uuid, uuid, uuid, uuid, text, text[], integer, integer, integer, text, jsonb)'::text, false, false, false, true),
        ('public.append_catalog_observation_audit_event(uuid, uuid, uuid, uuid, uuid, uuid, uuid, uuid, text, text, text, text, text, numeric, jsonb)'::text, false, false, false, true),
        ('public.begin_catalog_observation_run(uuid, uuid, jsonb)'::text, false, false, false, true),
        ('public.finish_catalog_observation_run(uuid, text, text)'::text, false, false, false, true),
        ('public.advance_catalog_observation_checkpoint(uuid, uuid, text, jsonb, timestamptz)'::text, false, false, false, true),
        ('public.append_catalog_external_observation(uuid, text, text, text, text, text, text, text, text, text, jsonb, text, numeric, timestamptz, uuid)'::text, false, false, false, true),
        ('public.claim_catalog_observation_compare_batch(uuid, integer, text)'::text, false, false, false, true),
        ('public.complete_catalog_observation_compare(uuid[], uuid, text, text, text, text, text, jsonb)'::text, false, false, false, true),
        ('public.fail_catalog_observation_compare(uuid[], uuid, text, boolean)'::text, false, false, false, true),
        ('public.record_catalog_observation_review_decision(uuid, text, uuid, text, text, text)'::text, false, false, false, true),
        ('public.record_catalog_observation_apply_event(uuid, uuid, jsonb, jsonb, text)'::text, false, false, false, true),
        ('public.get_catalog_observation_scope_health(uuid)'::text, false, false, true, true)
    ) as function_acl(signature, expect_public, expect_anon, expect_authenticated, expect_service_role)
  loop
    if to_regprocedure(v_function_signature) is null then
      raise exception 'BLOCKED: missing function signature %', v_function_signature;
    end if;

    select
      exists (
        select 1
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl on true
        where n.nspname = 'public'
          and p.oid = to_regprocedure(v_function_signature)
          and acl.grantee = 0
          and acl.privilege_type = 'EXECUTE'
      ),
      exists (
        select 1
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl on true
        where n.nspname = 'public'
          and p.oid = to_regprocedure(v_function_signature)
          and acl.grantee = v_anon_role_oid
          and acl.privilege_type = 'EXECUTE'
      ),
      exists (
        select 1
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl on true
        where n.nspname = 'public'
          and p.oid = to_regprocedure(v_function_signature)
          and acl.grantee = v_authenticated_role_oid
          and acl.privilege_type = 'EXECUTE'
      ),
      exists (
        select 1
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) acl on true
        where n.nspname = 'public'
          and p.oid = to_regprocedure(v_function_signature)
          and acl.grantee = v_service_role_oid
          and acl.privilege_type = 'EXECUTE'
      )
    into v_actual_public, v_actual_anon, v_actual_authenticated, v_actual_service_role;

    if v_actual_public is distinct from v_expected_public then
      raise exception 'BLOCKED: explicit EXECUTE ACL mismatch for % role PUBLIC expected %, got %', v_function_signature, v_expected_public, v_actual_public;
    end if;

    if v_actual_anon is distinct from v_expected_anon then
      raise exception 'BLOCKED: explicit EXECUTE ACL mismatch for % role anon expected %, got %', v_function_signature, v_expected_anon, v_actual_anon;
    end if;

    if v_actual_authenticated is distinct from v_expected_authenticated then
      raise exception 'BLOCKED: explicit EXECUTE ACL mismatch for % role authenticated expected %, got %', v_function_signature, v_expected_authenticated, v_actual_authenticated;
    end if;

    if v_actual_service_role is distinct from v_expected_service_role then
      raise exception 'BLOCKED: explicit EXECUTE ACL mismatch for % role service_role expected %, got %', v_function_signature, v_expected_service_role, v_actual_service_role;
    end if;

    if has_function_privilege('anon', v_function_signature, 'EXECUTE') is distinct from v_expected_anon then
      raise exception 'BLOCKED: effective EXECUTE ACL mismatch for % role anon expected %, got %', v_function_signature, v_expected_anon, has_function_privilege('anon', v_function_signature, 'EXECUTE');
    end if;

    if has_function_privilege('authenticated', v_function_signature, 'EXECUTE') is distinct from v_expected_authenticated then
      raise exception 'BLOCKED: effective EXECUTE ACL mismatch for % role authenticated expected %, got %', v_function_signature, v_expected_authenticated, has_function_privilege('authenticated', v_function_signature, 'EXECUTE');
    end if;

    if has_function_privilege('service_role', v_function_signature, 'EXECUTE') is distinct from v_expected_service_role then
      raise exception 'BLOCKED: effective EXECUTE ACL mismatch for % role service_role expected %, got %', v_function_signature, v_expected_service_role, has_function_privilege('service_role', v_function_signature, 'EXECUTE');
    end if;
  end loop;

  select count(*) into v_public_table_acl_count
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) acl on true
  where n.nspname = 'public'
    and c.relkind in ('r', 'p')
    and c.relname = any(array[
      'catalog_external_sources',
      'catalog_external_source_trust_profiles',
      'catalog_observation_jobs',
      'catalog_observation_runs',
      'catalog_observation_checkpoints',
      'catalog_external_observations',
      'catalog_observation_candidates',
      'catalog_observation_review_decisions',
      'catalog_apply_events',
      'catalog_observation_audit_ledger',
      'catalog_observation_scope_health'
    ])
    and acl.grantee = 0;

  if v_public_table_acl_count <> 0 then
    raise exception 'BLOCKED: PUBLIC table privileges exist on % new tables', v_public_table_acl_count;
  end if;

  foreach v_table_name in array array[
    'catalog_external_sources',
    'catalog_external_source_trust_profiles',
    'catalog_observation_jobs',
    'catalog_observation_runs',
    'catalog_observation_checkpoints',
    'catalog_external_observations',
    'catalog_observation_candidates',
    'catalog_observation_review_decisions',
    'catalog_apply_events',
    'catalog_observation_audit_ledger',
    'catalog_observation_scope_health'
  ] loop
    foreach v_priv in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] loop
      if has_table_privilege('anon', 'public.' || v_table_name, v_priv) then
        raise exception 'BLOCKED: anon has % on %', v_priv, v_table_name;
      end if;
    end loop;

    if not has_table_privilege('authenticated', 'public.' || v_table_name, 'SELECT') then
      raise exception 'BLOCKED: authenticated missing SELECT on %', v_table_name;
    end if;

    if not has_table_privilege('service_role', 'public.' || v_table_name, 'SELECT') then
      raise exception 'BLOCKED: service_role missing SELECT on %', v_table_name;
    end if;

    foreach v_role_name in array array['authenticated', 'service_role'] loop
      foreach v_priv in array array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] loop
        if has_table_privilege(v_role_name, 'public.' || v_table_name, v_priv) then
          raise exception 'BLOCKED: % has direct % on %', v_role_name, v_priv, v_table_name;
        end if;
      end loop;
    end loop;
  end loop;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and tablename = 'catalog_external_observations'
      and policyname = 'catalog_external_observations_select_admin_org'
      and qual ilike '%current_profile_org_id%'
      and qual ilike '%is_superadmin%'
  ) then
    raise exception 'BLOCKED: observation RLS policy is not admin/org scoped';
  end if;

  if position('current_profile_org_id' in pg_get_functiondef('public.get_catalog_observation_scope_health(uuid)'::regprocedure)) = 0
     or position('is_superadmin' in pg_get_functiondef('public.get_catalog_observation_scope_health(uuid)'::regprocedure)) = 0 then
    raise exception 'BLOCKED: health function is not admin/org scoped';
  end if;

  v_structural_org_isolation_ok := true;

  begin
    perform public.configure_catalog_external_source_trust_profile(
      v_org_id, gen_random_uuid(), 'T3', 0.70000,
      array['origin']::text[], true, 'internal_only', true, true, null
    );
    raise exception 'BLOCKED: trust profile accepted non-pilot origin field family';
  exception when others then
    if sqlerrm not ilike '%pilot only supports%' and sqlerrm not ilike '%foreign key%' then
      raise;
    end if;
  end;

  v_source_id := public.configure_catalog_external_source(
    v_org_id,
    v_prefix || '-source-a',
    'WP2A Validation Source A',
    'Next-Master Validation',
    'external_catalog',
    'https://validation.invalid/a',
    'internal_review_required',
    'not_applicable',
    'bounded',
    true,
    '{}'::jsonb
  );

  v_trust_id := public.configure_catalog_external_source_trust_profile(
    v_org_id,
    v_source_id,
    'T3',
    0.70000,
    array['image_reference', 'supplemental_description']::text[],
    true,
    'internal_only',
    true,
    true,
    null
  );

  begin
    perform public.configure_single_brand_catalog_observation_job(
      v_org_id, v_source_id, v_trust_id, v_brand_id, v_prefix || '-bad-origin-job',
      array['origin']::text[], 500, 5, 600, 'active', '{}'::jsonb
    );
    raise exception 'BLOCKED: job accepted non-pilot origin field family';
  exception when others then
    if sqlerrm not ilike '%pilot only supports%' then
      raise;
    end if;
  end;

  begin
    perform public.configure_single_brand_catalog_observation_job(
      v_org_id, v_source_id, v_trust_id, v_brand_id, v_prefix || '-bad-hs-job',
      array['hs_code']::text[], 500, 5, 600, 'active', '{}'::jsonb
    );
    raise exception 'BLOCKED: job accepted non-pilot hs_code field family';
  exception when others then
    if sqlerrm not ilike '%pilot only supports%' then
      raise;
    end if;
  end;

  begin
    perform public.configure_single_brand_catalog_observation_job(
      v_org_id, v_source_id, v_trust_id, v_brand_id, v_prefix || '-bad-oem-job',
      array['oem_reference']::text[], 500, 5, 600, 'active', '{}'::jsonb
    );
    raise exception 'BLOCKED: job accepted non-pilot oem_reference field family';
  exception when others then
    if sqlerrm not ilike '%pilot only supports%' then
      raise;
    end if;
  end;

  v_job_id := public.configure_single_brand_catalog_observation_job(
    v_org_id,
    v_source_id,
    v_trust_id,
    v_brand_id,
    v_prefix || '-main-job',
    array['image_reference', 'supplemental_description']::text[],
    500,
    5,
    600,
    'active',
    '{}'::jsonb
  );

  v_run_id := public.begin_catalog_observation_run(v_job_id, v_actor_id, jsonb_build_object('validation', 'main'));

  begin
    perform public.append_catalog_external_observation(
      v_run_id, v_product_code, v_normalized_code,
      'origin', 'origin', 'bad raw', 'bad normalized',
      v_prefix || '-bad-origin-evidence', null, 'bad-origin-hash',
      '{}'::jsonb, v_prefix || '-bad-origin-ref', 0.65, now(), v_actor_id
    );
    raise exception 'BLOCKED: append accepted non-pilot origin field family';
  exception when others then
    if sqlerrm not ilike '%pilot only supports%' then
      raise;
    end if;
  end;

  begin
    perform public.append_catalog_external_observation(
      v_run_id, v_product_code, v_normalized_code,
      'hs_code', 'hs_code', 'bad raw', 'bad normalized',
      v_prefix || '-bad-hs-evidence', null, 'bad-hs-hash',
      '{}'::jsonb, v_prefix || '-bad-hs-ref', 0.65, now(), v_actor_id
    );
    raise exception 'BLOCKED: append accepted non-pilot hs_code field family';
  exception when others then
    if sqlerrm not ilike '%pilot only supports%' then
      raise;
    end if;
  end;

  begin
    perform public.append_catalog_external_observation(
      v_run_id, v_product_code, v_normalized_code,
      'oem_reference', 'oem_reference', 'bad raw', 'bad normalized',
      v_prefix || '-bad-oem-evidence', null, 'bad-oem-hash',
      '{}'::jsonb, v_prefix || '-bad-oem-ref', 0.65, now(), v_actor_id
    );
    raise exception 'BLOCKED: append accepted non-pilot oem_reference field family';
  exception when others then
    if sqlerrm not ilike '%pilot only supports%' then
      raise;
    end if;
  end;

  v_observation_id := public.append_catalog_external_observation(
    v_run_id,
    v_product_code,
    v_normalized_code,
    'supplemental_description',
    'description',
    'Controlled raw description',
    'Controlled normalized description',
    v_prefix || '-dedup-evidence',
    'https://validation.invalid/evidence/dedup',
    'wp2a-dedup-hash',
    jsonb_build_object('fixture', 'dedup'),
    v_prefix || '-external-ref',
    0.75,
    '2026-07-15 00:00:00+00'::timestamptz,
    v_actor_id
  );

  select ceo.deduplication_key
  into v_dedup_key
  from public.catalog_external_observations ceo
  where ceo.id = v_observation_id;

  v_observation_id_again := public.append_catalog_external_observation(
    v_run_id,
    v_product_code,
    v_normalized_code,
    'supplemental_description',
    'description',
    'Controlled raw description',
    'Controlled normalized description',
    v_prefix || '-dedup-evidence',
    'https://validation.invalid/evidence/dedup',
    'wp2a-dedup-hash',
    jsonb_build_object('fixture', 'dedup'),
    v_prefix || '-external-ref',
    0.75,
    '2026-07-15 00:00:00+00'::timestamptz,
    v_actor_id
  );

  if v_observation_id_again is distinct from v_observation_id then
    raise exception 'BLOCKED: dedup append returned different observation id';
  end if;

  select count(*) into v_dedup_count
  from public.catalog_external_observations
  where organization_id = v_org_id
    and deduplication_key = v_dedup_key;

  if v_dedup_count <> 1 then
    raise exception 'BLOCKED: dedup identity count expected 1, got %', v_dedup_count;
  end if;

  v_observation_id_again := public.append_catalog_external_observation(
    v_run_id,
    v_product_code,
    v_normalized_code,
    'supplemental_description',
    'description',
    'Bypass raw description',
    'Bypass normalized description',
    v_prefix || '-bypass-evidence',
    'https://validation.invalid/evidence/bypass',
    'wp2a-bypass-hash',
    jsonb_build_object('fixture', 'bypass-review'),
    v_prefix || '-bypass-ref',
    0.75,
    '2026-07-15 00:00:00+00'::timestamptz,
    v_actor_id
  );

  begin
    perform public.record_catalog_observation_review_decision(
      v_observation_id_again,
      'approve_apply',
      v_actor_id,
      'bypassed compare should fail',
      null,
      'Bypass normalized description'
    );
    raise exception 'BLOCKED: review accepted observation that bypassed compare/review routing';
  exception when others then
    if sqlerrm not ilike '%pending eligible human review%' then
      raise;
    end if;
  end;

  update public.catalog_external_observations
  set next_retry_at = now() + interval '1 day'
  where id = v_observation_id_again;

  v_claim := public.claim_catalog_observation_compare_batch(v_job_id, 1, 'wp2a-main');
  if (v_claim->>'claimed_count')::integer <> 1 then
    raise exception 'BLOCKED: main claim expected 1';
  end if;
  v_lock_token := (v_claim->>'lock_token')::uuid;

  v_result := public.complete_catalog_observation_compare(
    array[v_observation_id]::uuid[],
    gen_random_uuid(),
    'guarded_enrichment_candidate',
    'review_required',
    'requires_review',
    null,
    'wrong worker must be rejected',
    jsonb_build_object('catalog_products_mutated', false)
  );

  if (v_result->>'updated_count')::integer <> 0 or (v_result->>'rejected_count')::integer <> 1 then
    raise exception 'BLOCKED: wrong lock completion updated another worker claim: %', v_result;
  end if;

  v_result := public.complete_catalog_observation_compare(
    array[v_observation_id]::uuid[],
    v_lock_token,
    'guarded_enrichment_candidate',
    'review_required',
    'requires_review',
    null,
    'controlled validation routes candidate to review',
    jsonb_build_object('catalog_products_mutated', false)
  );

  if (v_result->>'requested_count')::integer <> 1 or (v_result->>'updated_count')::integer <> 1 or (v_result->>'rejected_count')::integer <> 0 then
    raise exception 'BLOCKED: completion ownership result invalid: %', v_result;
  end if;

  v_health_before := public.get_catalog_observation_scope_health(v_job_id);
  select candidate_count into v_dedup_count
  from public.catalog_observation_runs
  where id = v_run_id;

  v_result := public.complete_catalog_observation_compare(
    array[v_observation_id]::uuid[],
    v_lock_token,
    'guarded_enrichment_candidate',
    'review_required',
    'requires_review',
    null,
    'repeated completion must not change counters',
    jsonb_build_object('catalog_products_mutated', false)
  );

  if (v_result->>'updated_count')::integer <> 0 or (v_result->>'rejected_count')::integer <> 1 then
    raise exception 'BLOCKED: repeated completion was not idempotent: %', v_result;
  end if;

  v_health_after := public.get_catalog_observation_scope_health(v_job_id);
  if (v_health_after->>'compared_count')::bigint <> (v_health_before->>'compared_count')::bigint
     or (v_health_after->>'pending_review_count')::bigint <> (v_health_before->>'pending_review_count')::bigint then
    raise exception 'BLOCKED: repeated completion changed health counters: before %, after %', v_health_before, v_health_after;
  end if;

  select candidate_count into v_retry_count
  from public.catalog_observation_runs
  where id = v_run_id;

  if v_retry_count <> v_dedup_count then
    raise exception 'BLOCKED: repeated completion changed candidate_count from % to %', v_dedup_count, v_retry_count;
  end if;

  select ceo.review_status into v_retry_status
  from public.catalog_external_observations ceo
  where ceo.id = v_observation_id;

  if v_retry_status <> 'pending_review' then
    raise exception 'BLOCKED: review_status expected pending_review, got %', v_retry_status;
  end if;

  begin
    perform public.record_catalog_observation_review_decision(
      v_observation_id,
      'request_more_evidence',
      v_actor_id,
      '   ',
      null,
      'Controlled normalized description'
    );
    raise exception 'BLOCKED: request_more_evidence accepted empty reason';
  exception when others then
    if sqlerrm not ilike '%requires reason%' then
      raise;
    end if;
  end;

  v_health_before := public.get_catalog_observation_scope_health(v_job_id);

  v_request_review_id := public.record_catalog_observation_review_decision(
    v_observation_id,
    'request_more_evidence',
    v_actor_id,
    'need additional controlled evidence',
    null,
    'Controlled normalized description'
  );

  if v_request_review_id is null then
    raise exception 'BLOCKED: request_more_evidence did not return a review id';
  end if;

  v_health_after := public.get_catalog_observation_scope_health(v_job_id);
  if (v_health_after->>'pending_review_count')::bigint <> (v_health_before->>'pending_review_count')::bigint then
    raise exception 'BLOCKED: request_more_evidence changed pending_review_count: before %, after %', v_health_before, v_health_after;
  end if;

  select review_status, apply_eligibility
  into strict v_review_state, v_apply_state
  from public.catalog_external_observations
  where id = v_observation_id;

  if v_review_state <> 'pending_review' or v_apply_state <> 'requires_review' then
    raise exception 'BLOCKED: request_more_evidence did not preserve pending review routing: review %, apply %', v_review_state, v_apply_state;
  end if;

  select candidate_status
  into strict v_candidate_state
  from public.catalog_observation_candidates
  where observation_id = v_observation_id;

  if v_candidate_state <> 'review_required' then
    raise exception 'BLOCKED: request_more_evidence did not preserve candidate state: %', v_candidate_state;
  end if;

  begin
    perform public.record_catalog_observation_review_decision(
      v_observation_id,
      'approve_apply',
      gen_random_uuid(),
      'random reviewer should fail',
      null,
      'Controlled normalized description'
    );
    raise exception 'BLOCKED: review accepted random reviewer UUID';
  exception when others then
    if sqlerrm not ilike '%active admin profile%' then
      raise;
    end if;
  end;

  if v_inactive_profile_id is not null then
    begin
      perform public.record_catalog_observation_review_decision(
        v_observation_id,
        'approve_apply',
        v_inactive_profile_id,
        'inactive reviewer should fail',
        null,
        'Controlled normalized description'
      );
      raise exception 'BLOCKED: review accepted inactive reviewer';
    exception when others then
      if sqlerrm not ilike '%active admin profile%' then
        raise;
      end if;
    end;
  end if;

  if v_profile_b_id is not null then
    begin
      perform public.record_catalog_observation_review_decision(
        v_observation_id,
        'approve_apply',
        v_profile_b_id,
        'other org reviewer should fail',
        null,
        'Controlled normalized description'
      );
      raise exception 'BLOCKED: review accepted other-org reviewer';
    exception when others then
      if sqlerrm not ilike '%active admin profile%' then
        raise;
      end if;
    end;
  end if;

  begin
    perform public.record_catalog_observation_review_decision(
      v_observation_id,
      'approve_apply',
      null,
      'missing reviewer should fail',
      null,
      'Controlled normalized description'
    );
    raise exception 'BLOCKED: review accepted null reviewer';
  exception when others then
    if sqlerrm not ilike '%reviewer_id%' then
      raise;
    end if;
  end;

  v_review_id := public.record_catalog_observation_review_decision(
    v_observation_id,
    'approve_apply',
    v_actor_id,
    'controlled validation approval only',
    null,
    'Controlled normalized description'
  );

  v_health_after := public.get_catalog_observation_scope_health(v_job_id);
  if (v_health_after->>'pending_review_count')::bigint <> (v_health_before->>'pending_review_count')::bigint - 1 then
    raise exception 'BLOCKED: approve_apply did not decrement pending_review_count exactly once: before %, after %', v_health_before, v_health_after;
  end if;

  if not exists (
    select 1
    from public.catalog_observation_candidates c
    where c.observation_id = v_observation_id
      and c.candidate_status = 'approved_for_apply'
  ) then
    raise exception 'BLOCKED: approve_apply did not converge candidate status to approved_for_apply';
  end if;

  begin
    perform public.record_catalog_observation_apply_event(
      v_review_id,
      gen_random_uuid(),
      jsonb_build_object('catalog_products_mutated', false),
      jsonb_build_object('guardian_validation', 'controlled'),
      'random actor should fail'
    );
    raise exception 'BLOCKED: apply event accepted random actor UUID';
  exception when others then
    if sqlerrm not ilike '%active profile%' then
      raise;
    end if;
  end;

  if v_inactive_profile_id is not null then
    begin
      perform public.record_catalog_observation_apply_event(
        v_review_id,
        v_inactive_profile_id,
        jsonb_build_object('catalog_products_mutated', false),
        jsonb_build_object('guardian_validation', 'controlled'),
        'inactive actor should fail'
      );
      raise exception 'BLOCKED: apply event accepted inactive actor';
    exception when others then
      if sqlerrm not ilike '%active profile%' then
        raise;
      end if;
    end;
  end if;

  if v_profile_b_id is not null then
    begin
      perform public.record_catalog_observation_apply_event(
        v_review_id,
        v_profile_b_id,
        jsonb_build_object('catalog_products_mutated', false),
        jsonb_build_object('guardian_validation', 'controlled'),
        'other org actor should fail'
      );
      raise exception 'BLOCKED: apply event accepted other-org actor';
    exception when others then
      if sqlerrm not ilike '%active profile%' then
        raise;
      end if;
    end;
  end if;

  begin
    perform public.record_catalog_observation_apply_event(
      v_review_id,
      null,
      jsonb_build_object('catalog_products_mutated', false),
      jsonb_build_object('guardian_validation', 'controlled'),
      'missing actor should fail'
    );
    raise exception 'BLOCKED: apply event accepted null actor';
  exception when others then
    if sqlerrm not ilike '%actor_id%' then
      raise;
    end if;
  end;

  v_apply_event_id := public.record_catalog_observation_apply_event(
    v_review_id,
    v_actor_id,
    jsonb_build_object('catalog_products_mutated', false),
    jsonb_build_object('guardian_validation', 'controlled'),
    'controlled validation creates audit event only'
  );

  v_apply_event_id_again := public.record_catalog_observation_apply_event(
    v_review_id,
    v_actor_id,
    jsonb_build_object('catalog_products_mutated', true),
    jsonb_build_object('guardian_validation', 'mutated'),
    'attempted duplicate apply mutation'
  );

  if v_apply_event_id_again is distinct from v_apply_event_id then
    raise exception 'BLOCKED: repeated apply event did not return existing id';
  end if;

  if exists (
    select 1
    from public.catalog_apply_events ae
    where ae.id = v_apply_event_id
      and (
        ae.actor_id is distinct from v_actor_id
        or ae.reason <> 'controlled validation creates audit event only'
        or ae.downstream_impact <> jsonb_build_object('catalog_products_mutated', false)
      )
  ) then
    raise exception 'BLOCKED: repeated apply event mutated immutable facts';
  end if;

  begin
    update public.catalog_observation_audit_ledger
    set message = 'mutated'
    where observation_id = v_observation_id;
    raise exception 'BLOCKED: audit ledger UPDATE unexpectedly succeeded';
  exception when others then
    if sqlerrm not ilike '%append-only%' then
      raise;
    end if;
  end;

  begin
    delete from public.catalog_observation_audit_ledger
    where observation_id = v_observation_id;
    raise exception 'BLOCKED: audit ledger DELETE unexpectedly succeeded';
  exception when others then
    if sqlerrm not ilike '%append-only%' then
      raise;
    end if;
  end;

  if not exists (
    select 1
    from public.catalog_external_observations ceo
    join public.catalog_observation_review_decisions rd on rd.observation_id = ceo.id
    join public.catalog_apply_events ae on ae.observation_id = ceo.id
    where ceo.id = v_observation_id
      and ceo.organization_id = v_org_id
      and ceo.source_id = v_source_id
      and ceo.brand_id = v_brand_id
      and ceo.product_code = v_product_code
      and ceo.normalized_code = v_normalized_code
      and ceo.field_family = 'supplemental_description'
      and ceo.field_name = 'description'
      and ceo.raw_value = 'Controlled raw description'
      and ceo.normalized_value = 'Controlled normalized description'
      and ceo.evidence_reference = v_prefix || '-dedup-evidence'
      and ceo.evidence_hash = 'wp2a-dedup-hash'
      and ceo.confidence = 0.75000
      and ceo.observed_at is not null
      and ceo.ingested_at is not null
      and ceo.run_id = v_run_id
      and rd.previous_value is null
      and rd.proposed_value = 'Controlled normalized description'
      and rd.decision = 'approve_apply'
      and rd.reviewer_id = v_actor_id
      and rd.reason is not null
      and rd.decided_at is not null
      and ae.review_decision_id = rd.id
      and ae.actor_id = v_actor_id
      and ae.reason is not null
      and ae.source_snapshot ? 'evidence_reference'
  ) then
    raise exception 'BLOCKED: review/apply provenance is incomplete';
  end if;

  begin
    update public.catalog_external_observations
    set raw_value = 'mutated'
    where id = v_observation_id;
    raise exception 'BLOCKED: evidence UPDATE unexpectedly succeeded';
  exception when others then
    if sqlerrm not ilike '%immutable%' then
      raise;
    end if;
  end;

  begin
    delete from public.catalog_external_observations
    where id = v_observation_id;
    raise exception 'BLOCKED: evidence DELETE unexpectedly succeeded';
  exception when others then
    if sqlerrm not ilike '%append-only%' then
      raise;
    end if;
  end;

  v_second_job_id := public.configure_single_brand_catalog_observation_job(
    v_org_id, v_source_id, v_trust_id, v_brand_id, v_prefix || '-checkpoint-job',
    array['supplemental_description']::text[], 20, 5, 600, 'active', '{}'::jsonb
  );

  v_second_run_id := public.begin_catalog_observation_run(v_second_job_id, v_actor_id, '{}'::jsonb);

  begin
    insert into public.catalog_observation_runs (
      organization_id, job_id, source_id, brand_id, status
    ) values (
      v_org_id, v_second_job_id, v_source_id, v_brand_id, 'running'
    );
    raise exception 'BLOCKED: duplicate running run for same job was accepted';
  exception when unique_violation then
    null;
  end;

  begin
    perform public.advance_catalog_observation_checkpoint(
      v_job_id,
      v_run_id,
      v_prefix || '-running-cursor',
      '{}'::jsonb,
      now()
    );
    raise exception 'BLOCKED: checkpoint accepted running run';
  exception when others then
    if sqlerrm not ilike '%successful terminal run%' then
      raise;
    end if;
  end;

  v_result := public.finish_catalog_observation_run(v_run_id, 'succeeded', null);
  if (v_result->>'status') <> 'succeeded' or coalesce((v_result->>'idempotent')::boolean, false) then
    raise exception 'BLOCKED: run finish did not succeed deterministically: %', v_result;
  end if;

  v_result := public.finish_catalog_observation_run(v_run_id, 'succeeded', null);
  if coalesce((v_result->>'idempotent')::boolean, false) is not true then
    raise exception 'BLOCKED: repeated matching run finish was not idempotent: %', v_result;
  end if;

  begin
    perform public.finish_catalog_observation_run(v_run_id, 'failed', 'terminal rewrite should fail');
    raise exception 'BLOCKED: terminal run was rewritten to another terminal status';
  exception when others then
    if sqlerrm not ilike '%already terminal%' then
      raise;
    end if;
  end;

  begin
    perform public.advance_catalog_observation_checkpoint(
      v_second_job_id,
      v_run_id,
      v_prefix || '-bad-cursor',
      '{}'::jsonb,
      now()
    );
    raise exception 'BLOCKED: checkpoint accepted run from another job';
  exception when others then
    if sqlerrm not ilike '%successful terminal run%' then
      raise;
    end if;
  end;

  perform public.advance_catalog_observation_checkpoint(
    v_job_id,
    v_run_id,
    v_prefix || '-cursor',
    jsonb_build_object('validation', true),
    now()
  );

  v_result := public.finish_catalog_observation_run(v_second_run_id, 'failed', 'controlled failed run');
  begin
    perform public.advance_catalog_observation_checkpoint(
      v_second_job_id,
      v_second_run_id,
      v_prefix || '-failed-cursor',
      '{}'::jsonb,
      now()
    );
    raise exception 'BLOCKED: checkpoint accepted failed run';
  exception when others then
    if sqlerrm not ilike '%successful terminal run%' then
      raise;
    end if;
  end;

  if v_other_brand_id is not null and v_other_product_id is not null then
    begin
      insert into public.catalog_external_observations (
        organization_id, source_id, trust_profile_id, job_id, run_id, brand_id,
        catalog_product_id, product_code, normalized_code, field_family,
        field_name, raw_value, normalized_value, evidence_reference,
        observed_at, deduplication_key
      ) values (
        v_org_id, v_source_id, v_trust_id, v_job_id, v_run_id, v_brand_id,
        v_other_product_id, 'BAD-SCOPE', 'BADSCOPE',
        'supplemental_description', 'description', 'bad', 'bad',
        v_prefix || '-bad-scope', now(), md5(v_prefix || '-bad-scope')
      );
      raise exception 'BLOCKED: out-of-brand Product link was accepted';
    exception when others then
      if sqlerrm not ilike '%Product organization or brand mismatch%' then
        raise;
      end if;
    end;

    begin
      insert into public.catalog_observation_candidates (
        organization_id, observation_id, job_id, run_id, catalog_product_id,
        field_name, proposed_value, candidate_status
      ) values (
        v_org_id, v_observation_id, v_job_id, v_run_id, v_other_product_id,
        'description', 'bad', 'review_required'
      );
      raise exception 'BLOCKED: cross-brand candidate Product link was accepted';
    exception when others then
      if sqlerrm not ilike '%Product organization mismatch%' and sqlerrm not ilike '%Product organization%' then
        raise;
      end if;
    end;
  end if;

  if v_other_org_product_id is not null then
    begin
      insert into public.catalog_apply_events (
        organization_id, observation_id, review_decision_id, catalog_product_id,
        field_name, proposed_value, apply_status, actor_id, source_snapshot, reason
      ) values (
        v_org_id, v_observation_id, v_review_id, v_other_org_product_id,
        'description', 'bad', 'recorded', v_actor_id, '{}'::jsonb, 'bad product'
      );
      raise exception 'BLOCKED: cross-organization apply Product link was accepted';
    exception when others then
      if sqlerrm not ilike '%Product organization mismatch%' and sqlerrm not ilike '%Product organization%' then
        raise;
      end if;
    end;
  end if;

  if v_other_org_id is not null then
    select b.id into v_other_brand_id
    from public.brands b
    where b.organization_id = v_other_org_id
    order by b.id
    limit 1;

    if v_other_brand_id is not null then
      v_other_source_id := public.configure_catalog_external_source(
        v_other_org_id, v_prefix || '-source-b', 'WP2A Validation Source B',
        null, 'external_catalog', null, 'internal_review_required', 'unknown', 'unknown', true, '{}'::jsonb
      );

      v_other_trust_id := public.configure_catalog_external_source_trust_profile(
        v_other_org_id, v_other_source_id, 'T3', 0.70000,
        array['supplemental_description']::text[], true, 'internal_only', true, true, null
      );

      begin
        perform public.configure_single_brand_catalog_observation_job(
          v_org_id, v_other_source_id, v_other_trust_id, v_brand_id,
          v_prefix || '-bad-org-job', array['supplemental_description']::text[],
          500, 5, 600, 'active', '{}'::jsonb
        );
        raise exception 'BLOCKED: mismatched source/trust organization job was accepted';
      exception when others then
        if sqlerrm not ilike '%mismatch%' then
          raise;
        end if;
      end;

      v_other_job_id := public.configure_single_brand_catalog_observation_job(
        v_other_org_id, v_other_source_id, v_other_trust_id, v_other_brand_id,
        v_prefix || '-org-b-job', array['supplemental_description']::text[],
        500, 5, 600, 'active', '{}'::jsonb
      );

      perform public.begin_catalog_observation_run(v_other_job_id, v_profile_b_id, '{}'::jsonb);

      if v_profile_a_id is not null then
        perform set_config('request.jwt.claim.role', 'authenticated', true);
        perform set_config('request.jwt.claim.sub', v_profile_a_id::text, true);

        v_health := public.get_catalog_observation_scope_health(v_other_job_id);

        if v_health->>'status' is distinct from 'NO_HEALTH' then
          raise exception 'BLOCKED: org A authenticated context read org B health';
        end if;

        perform set_config('request.jwt.claim.role', 'service_role', true);
        perform set_config('request.jwt.claim.sub', '', true);
      elsif not v_structural_org_isolation_ok then
        raise exception 'BLOCKED: no runtime or structural organization isolation proof available';
      end if;
    end if;
  elsif not v_structural_org_isolation_ok then
    raise exception 'BLOCKED: no second organization and structural organization isolation proof failed';
  end if;

  v_paused_job_id := public.configure_single_brand_catalog_observation_job(
    v_org_id, v_source_id, v_trust_id, v_brand_id, v_prefix || '-paused-job',
    array['supplemental_description']::text[], 500, 5, 600, 'active', '{}'::jsonb
  );
  v_paused_run_id := public.begin_catalog_observation_run(v_paused_job_id, v_actor_id, '{}'::jsonb);
  update public.catalog_observation_jobs set status = 'paused' where id = v_paused_job_id;
  begin
    perform public.append_catalog_external_observation(
      v_paused_run_id, v_product_code, v_normalized_code,
      'supplemental_description', 'description', 'paused raw', 'paused normalized',
      v_prefix || '-paused-evidence', null, 'paused-hash', '{}'::jsonb,
      v_prefix || '-paused-ref', 0.65, now(), v_actor_id
    );
    raise exception 'BLOCKED: paused job accepted new observation append';
  exception when others then
    if sqlerrm not ilike '%Active catalog observation job%' then
      raise;
    end if;
  end;
  begin
    perform public.claim_catalog_observation_compare_batch(v_paused_job_id, 1, 'wp2a-paused');
    raise exception 'BLOCKED: paused job allowed comparison claim';
  exception when others then
    if sqlerrm not ilike '%Active catalog observation job%' then
      raise;
    end if;
  end;

  v_retry_job_id := public.configure_single_brand_catalog_observation_job(
    v_org_id, v_source_id, v_trust_id, v_brand_id, v_prefix || '-retry-job',
    array['supplemental_description']::text[], 500, 2, 600, 'active', '{}'::jsonb
  );

  v_retry_run_id := public.begin_catalog_observation_run(v_retry_job_id, v_actor_id, '{}'::jsonb);

  v_retry_observation_id := public.append_catalog_external_observation(
    v_retry_run_id, v_product_code, v_normalized_code,
    'supplemental_description', 'description',
    'retry raw', 'retry normalized',
    v_prefix || '-retry-evidence', null, 'retry-hash',
    '{}'::jsonb, v_prefix || '-retry-ref', 0.65, now(), v_actor_id
  );

  v_claim := public.claim_catalog_observation_compare_batch(v_retry_job_id, 1, 'wp2a-retry');
  v_result := public.fail_catalog_observation_compare(array[v_retry_observation_id]::uuid[], gen_random_uuid(), 'wrong lock failure', true);
  if (v_result->>'updated_count')::integer <> 0 then
    raise exception 'BLOCKED: wrong lock failure updated a claim';
  end if;

  v_result := public.fail_catalog_observation_compare(array[v_retry_observation_id]::uuid[], (v_claim->>'lock_token')::uuid, 'first retry failure', true);
  if (v_result->>'updated_count')::integer <> 1 then
    raise exception 'BLOCKED: first retry failure did not update claim';
  end if;

  select compare_status, retry_count, next_retry_at
  into v_retry_status, v_retry_count, v_retry_next_at
  from public.catalog_external_observations
  where id = v_retry_observation_id;

  if v_retry_status <> 'failed' or v_retry_count <> 1 or v_retry_next_at <= now() or v_retry_next_at > now() + interval '10 minutes' then
    raise exception 'BLOCKED: first retry state invalid';
  end if;

  v_mixed_job_id := public.configure_single_brand_catalog_observation_job(
    v_org_id, v_source_id, v_trust_id, v_brand_id, v_prefix || '-mixed-job',
    array['supplemental_description']::text[], 500, 5, 600, 'active', '{}'::jsonb
  );
  v_mixed_run_id := public.begin_catalog_observation_run(v_mixed_job_id, v_actor_id, '{}'::jsonb);
  v_mixed_failed_observation_id := public.append_catalog_external_observation(
    v_mixed_run_id, v_product_code, v_normalized_code,
    'supplemental_description', 'description', 'mixed failed raw', 'mixed failed normalized',
    v_prefix || '-mixed-failed-evidence', null, 'mixed-failed-hash', '{}'::jsonb,
    v_prefix || '-mixed-failed-ref', 0.65, now(), v_actor_id
  );
  v_mixed_queued_observation_id := public.append_catalog_external_observation(
    v_mixed_run_id, v_product_code, v_normalized_code,
    'supplemental_description', 'description', 'mixed queued raw', 'mixed queued normalized',
    v_prefix || '-mixed-queued-evidence', null, 'mixed-queued-hash', '{}'::jsonb,
    v_prefix || '-mixed-queued-ref', 0.65, now(), v_actor_id
  );

  update public.catalog_external_observations
  set next_retry_at = now() - interval '2 minutes'
  where id = v_mixed_failed_observation_id;

  update public.catalog_external_observations
  set next_retry_at = now() + interval '1 day'
  where id = v_mixed_queued_observation_id;

  v_claim := public.claim_catalog_observation_compare_batch(v_mixed_job_id, 1, 'wp2a-mixed-fail');
  if (v_claim->>'claimed_count')::integer <> 1 then
    raise exception 'BLOCKED: mixed first claim expected exactly one observation: %', v_claim;
  end if;

  if not exists (
    select 1
    from jsonb_array_elements(coalesce(v_claim->'observations', '[]'::jsonb)) item
    where (item->>'id')::uuid = v_mixed_failed_observation_id
  ) then
    raise exception 'BLOCKED: mixed first claim did not select intended failed observation: %', v_claim;
  end if;

  v_result := public.fail_catalog_observation_compare(array[v_mixed_failed_observation_id]::uuid[], (v_claim->>'lock_token')::uuid, 'mixed first failure', true);
  if (v_result->>'updated_count')::integer <> 1 then
    raise exception 'BLOCKED: mixed first failure did not update one observation: %', v_result;
  end if;

  update public.catalog_external_observations
  set next_retry_at = case
        when id = v_mixed_failed_observation_id then now() - interval '2 minutes'
        else now() - interval '1 minute'
      end
  where id in (v_mixed_failed_observation_id, v_mixed_queued_observation_id);

  v_claim := public.claim_catalog_observation_compare_batch(v_mixed_job_id, 2, 'wp2a-mixed-claim');
  if (v_claim->>'queued_claimed_count')::integer <> 1 or (v_claim->>'failed_claimed_count')::integer <> 1 then
    raise exception 'BLOCKED: mixed queued/failed claim counters invalid: %', v_claim;
  end if;
  v_health := public.get_catalog_observation_scope_health(v_mixed_job_id);
  if (v_health->>'queued_count')::bigint <> 0 or (v_health->>'failed_count')::bigint <> 0 or (v_health->>'claimed_count')::bigint <> 2 then
    raise exception 'BLOCKED: mixed claim health counters do not match actual state: %', v_health;
  end if;
  perform public.complete_catalog_observation_compare(
    array[v_mixed_queued_observation_id]::uuid[], (v_claim->>'lock_token')::uuid,
    'no_change', 'no_change', 'not_eligible', null, 'mixed completion', '{}'::jsonb
  );
  perform public.fail_catalog_observation_compare(array[v_mixed_failed_observation_id]::uuid[], (v_claim->>'lock_token')::uuid, 'mixed dead letter', false);
  select jsonb_object_agg(compare_status, row_count)
  into v_actual_status_counts
  from (
    select compare_status, count(*)::bigint as row_count
    from public.catalog_external_observations
    where job_id = v_mixed_job_id
    group by compare_status
  ) grouped;
  v_health := public.get_catalog_observation_scope_health(v_mixed_job_id);
  if coalesce((v_actual_status_counts->>'compared')::bigint, 0) <> (v_health->>'compared_count')::bigint
     or coalesce((v_actual_status_counts->>'dead_letter')::bigint, 0) <> (v_health->>'dead_letter_count')::bigint
     or coalesce((v_actual_status_counts->>'claimed')::bigint, 0) <> (v_health->>'claimed_count')::bigint
     or coalesce((v_actual_status_counts->>'queued')::bigint, 0) <> (v_health->>'queued_count')::bigint
     or coalesce((v_actual_status_counts->>'failed')::bigint, 0) <> (v_health->>'failed_count')::bigint then
    raise exception 'BLOCKED: mixed status GROUP BY does not reconcile with health: statuses %, health %', v_actual_status_counts, v_health;
  end if;

  for v_retry_count in 1..3 loop
    update public.catalog_external_observations
    set next_retry_at = now() - interval '1 minute'
    where id = v_retry_observation_id
      and compare_status = 'failed';

    v_claim := public.claim_catalog_observation_compare_batch(v_retry_job_id, 1, 'wp2a-retry');
    exit when (v_claim->>'claimed_count')::integer = 0;

    perform public.fail_catalog_observation_compare(array[v_retry_observation_id]::uuid[], (v_claim->>'lock_token')::uuid, 'repeat retry failure', true);
  end loop;

  select compare_status into v_retry_status
  from public.catalog_external_observations
  where id = v_retry_observation_id;

  if v_retry_status <> 'dead_letter' then
    raise exception 'BLOCKED: repeated failures did not dead-letter observation';
  end if;

  v_dead_letter_claim := public.claim_catalog_observation_compare_batch(v_retry_job_id, 1, 'wp2a-retry');
  if exists (
    select 1
    from jsonb_array_elements(coalesce(v_dead_letter_claim->'observations', '[]'::jsonb)) item
    where (item->>'id')::uuid = v_retry_observation_id
  ) then
    raise exception 'BLOCKED: dead-letter observation was claimable';
  end if;

  v_stale_job_id := public.configure_single_brand_catalog_observation_job(
    v_org_id, v_source_id, v_trust_id, v_brand_id, v_prefix || '-stale-job',
    array['supplemental_description']::text[], 500, 5, 600, 'active', '{}'::jsonb
  );

  v_stale_run_id := public.begin_catalog_observation_run(v_stale_job_id, v_actor_id, '{}'::jsonb);

  v_stale_observation_id := public.append_catalog_external_observation(
    v_stale_run_id, v_product_code, v_normalized_code,
    'supplemental_description', 'description',
    'stale raw 1', 'stale normalized 1',
    v_prefix || '-stale-evidence-1', null, 'stale-hash-1',
    '{}'::jsonb, v_prefix || '-stale-ref-1', 0.65, now(), v_actor_id
  );

  v_fresh_locked_observation_id := public.append_catalog_external_observation(
    v_stale_run_id, v_product_code, v_normalized_code,
    'supplemental_description', 'description',
    'stale raw 2', 'stale normalized 2',
    v_prefix || '-stale-evidence-2', null, 'stale-hash-2',
    '{}'::jsonb, v_prefix || '-stale-ref-2', 0.65, now(), v_actor_id
  );

  v_claim := public.claim_catalog_observation_compare_batch(v_stale_job_id, 2, 'wp2a-stale-initial');
  v_health_before := public.get_catalog_observation_scope_health(v_stale_job_id);

  update public.catalog_external_observations
  set locked_at = now() - interval '11 minutes'
  where id = v_stale_observation_id
  returning lock_token into v_old_lock_token;

  v_claim2 := public.claim_catalog_observation_compare_batch(v_stale_job_id, 2, 'wp2a-stale-reclaim');
  v_health_after := public.get_catalog_observation_scope_health(v_stale_job_id);

  if (v_claim2->>'released_stale_count')::integer <> 1 or (v_claim2->>'claimed_count')::integer <> 1 then
    raise exception 'BLOCKED: stale reclaim expected release 1 and claim 1: %', v_claim2;
  end if;

  if (v_health_after->>'claimed_count')::bigint <> 2 or (v_health_after->>'queued_count')::bigint <> 0 then
    raise exception 'BLOCKED: stale reclaim health counters inconsistent: %', v_health_after;
  end if;

  if not exists (
    select 1
    from jsonb_array_elements(v_claim2->'observations') item
    where (item->>'id')::uuid = v_stale_observation_id
  ) then
    raise exception 'BLOCKED: stale locked row was not reclaimed';
  end if;

  select lock_token into v_new_lock_token
  from public.catalog_external_observations
  where id = v_stale_observation_id;

  if v_new_lock_token is null or v_new_lock_token = v_old_lock_token then
    raise exception 'BLOCKED: stale reclaim did not issue a new lock token';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(v_claim2->'observations') item
    where (item->>'id')::uuid = v_fresh_locked_observation_id
  ) then
    raise exception 'BLOCKED: non-stale processing row was stolen';
  end if;

  v_low_limit_job_id := public.configure_single_brand_catalog_observation_job(
    v_org_id, v_source_id, v_trust_id, v_brand_id, v_prefix || '-low-limit-job',
    array['supplemental_description']::text[], 1, 5, 600, 'active', '{}'::jsonb
  );
  v_low_limit_run_id := public.begin_catalog_observation_run(v_low_limit_job_id, v_actor_id, '{}'::jsonb);
  v_low_limit_observation_id := public.append_catalog_external_observation(
    v_low_limit_run_id, v_product_code, v_normalized_code,
    'supplemental_description', 'description',
    'low raw', 'low normalized', v_prefix || '-low-evidence-1', null, 'low-hash-1',
    '{}'::jsonb, v_prefix || '-low-ref-1', 0.65, now(), v_actor_id
  );
  v_observation_id_again := public.append_catalog_external_observation(
    v_low_limit_run_id, v_product_code, v_normalized_code,
    'supplemental_description', 'description',
    'low raw', 'low normalized', v_prefix || '-low-evidence-1', null, 'low-hash-1',
    '{}'::jsonb, v_prefix || '-low-ref-1', 0.65, now(), v_actor_id
  );
  if v_observation_id_again is distinct from v_low_limit_observation_id then
    raise exception 'BLOCKED: low-limit duplicate did not return existing observation';
  end if;
  begin
    perform public.append_catalog_external_observation(
      v_low_limit_run_id, v_product_code, v_normalized_code,
      'supplemental_description', 'description',
      'low raw 2', 'low normalized 2', v_prefix || '-low-evidence-2', null, 'low-hash-2',
      '{}'::jsonb, v_prefix || '-low-ref-2', 0.65, now(), v_actor_id
    );
    raise exception 'BLOCKED: low-limit run accepted a new observation after full';
  exception when others then
    if sqlerrm not ilike '%run limit reached%' then
      raise;
    end if;
  end;

  v_bounded_job_id := public.configure_single_brand_catalog_observation_job(
    v_org_id, v_source_id, v_trust_id, v_brand_id, v_prefix || '-bounded-job',
    array['supplemental_description']::text[], 500, 5, 600, 'active', '{}'::jsonb
  );

  v_bounded_run_id := public.begin_catalog_observation_run(v_bounded_job_id, v_actor_id, '{}'::jsonb);

  for v_retry_count in 1..105 loop
    perform public.append_catalog_external_observation(
      v_bounded_run_id, v_product_code, v_normalized_code,
      'supplemental_description', 'description',
      'bounded raw ' || v_retry_count, 'bounded normalized ' || v_retry_count,
      v_prefix || '-bounded-evidence-' || v_retry_count,
      null, 'bounded-hash-' || v_retry_count,
      '{}'::jsonb, v_prefix || '-bounded-ref-' || v_retry_count,
      0.65, now(), v_actor_id
    );
  end loop;

  v_bounded_claim := public.claim_catalog_observation_compare_batch(v_bounded_job_id, 2, 'wp2a-bounded-2');
  if (v_bounded_claim->>'claimed_count')::integer <> 2 then
    raise exception 'BLOCKED: bounded claim of 2 did not return exactly 2';
  end if;

  select array_agg((item->>'id')::uuid) into v_bounded_ids
  from jsonb_array_elements(v_bounded_claim->'observations') item;

  v_bounded_claim2 := public.claim_catalog_observation_compare_batch(v_bounded_job_id, 1000, 'wp2a-bounded-100');
  if (v_bounded_claim2->>'claimed_count')::integer > 100 then
    raise exception 'BLOCKED: claim cap exceeded 100';
  end if;

  select array_agg((item->>'id')::uuid) into v_bounded_ids2
  from jsonb_array_elements(v_bounded_claim2->'observations') item;

  if exists (
    select 1
    from unnest(coalesce(v_bounded_ids, array[]::uuid[])) a(id)
    join unnest(coalesce(v_bounded_ids2, array[]::uuid[])) b(id) using (id)
  ) then
    raise exception 'BLOCKED: same row returned twice in claim cycle';
  end if;

  if position('for update skip locked' in lower(pg_get_functiondef('public.claim_catalog_observation_compare_batch(uuid, integer, text)'::regprocedure))) = 0 then
    raise exception 'BLOCKED: claim function does not use FOR UPDATE SKIP LOCKED';
  end if;

  select to_jsonb(cp.*) into v_product_after
  from public.catalog_products cp
  where cp.id = v_product_id;

  if v_product_after is distinct from v_product_before then
    raise exception 'BLOCKED: catalog_products row changed during observation/apply-event flow';
  end if;

  select count(*) into v_final_integrity_queue_count
  from public.catalog_integrity_queue
  where product_id = v_product_id;

  if v_final_integrity_queue_count <> v_initial_integrity_queue_count then
    raise exception 'BLOCKED: validation queued existing Catalog Product';
  end if;

  if to_regclass('public.catalog_integrity_backfill_state') is not null then
    execute 'select coalesce(jsonb_agg(to_jsonb(s) order by s.organization_id), ''[]''::jsonb) from public.catalog_integrity_backfill_state s'
    into v_final_backfill_state;
  else
    v_final_backfill_state := '[]'::jsonb;
  end if;

  if v_final_backfill_state is distinct from v_initial_backfill_state then
    raise exception 'BLOCKED: validation changed catalog integrity backfill state';
  end if;

  insert into wp2a_validation_context (
    prefix, organization_id, brand_id, product_id, source_id, trust_profile_id,
    job_id, run_id, observation_id, deduplication_key, bounded_job_id
  ) values (
    v_prefix, v_org_id, v_brand_id, v_product_id, v_source_id, v_trust_id,
    v_job_id, v_run_id, v_observation_id, v_dedup_key, v_bounded_job_id
  );
end;
$wp2a_validation$;

explain (analyze, buffers)
select ceo.id
from public.catalog_external_observations ceo
join wp2a_validation_context ctx on ctx.organization_id = ceo.organization_id
where ceo.organization_id = ctx.organization_id
  and ceo.deduplication_key = ctx.deduplication_key;

explain (analyze, buffers)
select ceo.id
from public.catalog_external_observations ceo
join wp2a_validation_context ctx on ctx.organization_id = ceo.organization_id
where ceo.organization_id = ctx.organization_id
  and ceo.job_id = ctx.bounded_job_id
  and ceo.compare_status in ('queued', 'failed')
  and ceo.next_retry_at <= now()
order by ceo.next_retry_at, ceo.ingested_at, ceo.id
limit 10;

explain (analyze, buffers)
select ceo.id
from public.catalog_external_observations ceo
join wp2a_validation_context ctx on ctx.organization_id = ceo.organization_id
where ceo.organization_id = ctx.organization_id
  and ceo.source_id = ctx.source_id
  and ceo.brand_id = ctx.brand_id
  and ceo.normalized_code is not null
order by ceo.normalized_code, ceo.field_name
limit 10;

explain (analyze, buffers)
select ceo.id
from public.catalog_external_observations ceo
join wp2a_validation_context ctx on ctx.organization_id = ceo.organization_id
where ceo.organization_id = ctx.organization_id
  and ceo.review_status = 'pending_review'
order by ceo.routed_at desc, ceo.id
limit 10;

explain (analyze, buffers)
select ceo.*
from public.catalog_external_observations ceo
join wp2a_validation_context ctx on ctx.observation_id = ceo.id
where ceo.id = ctx.observation_id;

set local enable_seqscan = off;

explain (analyze, buffers)
select ceo.id
from public.catalog_external_observations ceo
join wp2a_validation_context ctx on ctx.organization_id = ceo.organization_id
where ceo.organization_id = ctx.organization_id
  and ceo.deduplication_key = ctx.deduplication_key;

explain (analyze, buffers)
select ceo.id
from public.catalog_external_observations ceo
join wp2a_validation_context ctx on ctx.organization_id = ceo.organization_id
where ceo.organization_id = ctx.organization_id
  and ceo.job_id = ctx.bounded_job_id
  and ceo.compare_status in ('queued', 'failed')
  and ceo.next_retry_at <= now()
order by ceo.next_retry_at, ceo.ingested_at, ceo.id
limit 10;

explain (analyze, buffers)
select ceo.id
from public.catalog_external_observations ceo
join wp2a_validation_context ctx on ctx.organization_id = ceo.organization_id
where ceo.organization_id = ctx.organization_id
  and ceo.source_id = ctx.source_id
  and ceo.brand_id = ctx.brand_id
  and ceo.normalized_code is not null
order by ceo.normalized_code, ceo.field_name
limit 10;

explain (analyze, buffers)
select ceo.id
from public.catalog_external_observations ceo
join wp2a_validation_context ctx on ctx.organization_id = ceo.organization_id
where ceo.organization_id = ctx.organization_id
  and ceo.review_status = 'pending_review'
order by ceo.routed_at desc, ceo.id
limit 10;

explain (analyze, buffers)
select ceo.*
from public.catalog_external_observations ceo
join wp2a_validation_context ctx on ctx.observation_id = ceo.id
where ceo.id = ctx.observation_id;

do $wp2a_explain_gate$
declare
  v_dedup_index_name text;
  v_claim_definition text;
  v_scope_definition text;
  v_review_definition text;
  v_primary_key_valid boolean := false;
begin
  /*
   * Planner choice is not a correctness contract. On small controlled
   * fixtures PostgreSQL may legally choose another valid index.
   *
   * This gate therefore verifies index structure, readiness, validity,
   * uniqueness, column order and partial predicates directly from pg_index.
   */

  select idx.relname
  into v_dedup_index_name
  from pg_index i
  join pg_class tbl
    on tbl.oid = i.indrelid
  join pg_namespace ns
    on ns.oid = tbl.relnamespace
  join pg_class idx
    on idx.oid = i.indexrelid
  where ns.nspname = 'public'
    and tbl.relname = 'catalog_external_observations'
    and i.indisunique
    and i.indisvalid
    and i.indisready
    and i.indnkeyatts = 2
    and pg_get_indexdef(i.indexrelid, 1, true) = 'organization_id'
    and pg_get_indexdef(i.indexrelid, 2, true) = 'deduplication_key'
  order by idx.relname
  limit 1;

  if v_dedup_index_name is null then
    raise exception
      'BLOCKED: valid unique index on organization_id,deduplication_key is absent';
  end if;

  select lower(
    regexp_replace(
      pg_get_indexdef(i.indexrelid),
      '[[:space:]]+',
      ' ',
      'g'
    )
  )
  into v_claim_definition
  from pg_index i
  join pg_class idx
    on idx.oid = i.indexrelid
  join pg_class tbl
    on tbl.oid = i.indrelid
  join pg_namespace ns
    on ns.oid = tbl.relnamespace
  where ns.nspname = 'public'
    and tbl.relname = 'catalog_external_observations'
    and idx.relname = 'idx_catalog_external_observations_claim'
    and i.indisvalid
    and i.indisready;

  if v_claim_definition is null
     or position(
       '(organization_id, job_id, next_retry_at, ingested_at, id)'
       in v_claim_definition
     ) = 0
     or position('compare_status' in v_claim_definition) = 0
     or position('queued' in v_claim_definition) = 0
     or position('failed' in v_claim_definition) = 0 then
    raise exception
      'BLOCKED: claim index structure or partial predicate is invalid: %',
      coalesce(v_claim_definition, '<missing>');
  end if;

  select lower(
    regexp_replace(
      pg_get_indexdef(i.indexrelid),
      '[[:space:]]+',
      ' ',
      'g'
    )
  )
  into v_scope_definition
  from pg_index i
  join pg_class idx
    on idx.oid = i.indexrelid
  join pg_class tbl
    on tbl.oid = i.indrelid
  join pg_namespace ns
    on ns.oid = tbl.relnamespace
  where ns.nspname = 'public'
    and tbl.relname = 'catalog_external_observations'
    and idx.relname = 'idx_catalog_external_observations_scope'
    and i.indisvalid
    and i.indisready;

  if v_scope_definition is null
     or position(
       '(organization_id, source_id, brand_id, normalized_code, field_name)'
       in v_scope_definition
     ) = 0 then
    raise exception
      'BLOCKED: scope index structure is invalid: %',
      coalesce(v_scope_definition, '<missing>');
  end if;

  select lower(
    regexp_replace(
      pg_get_indexdef(i.indexrelid),
      '[[:space:]]+',
      ' ',
      'g'
    )
  )
  into v_review_definition
  from pg_index i
  join pg_class idx
    on idx.oid = i.indexrelid
  join pg_class tbl
    on tbl.oid = i.indrelid
  join pg_namespace ns
    on ns.oid = tbl.relnamespace
  where ns.nspname = 'public'
    and tbl.relname = 'catalog_external_observations'
    and idx.relname = 'idx_catalog_external_observations_review'
    and i.indisvalid
    and i.indisready;

  if v_review_definition is null
     or position(
       '(organization_id, routed_at desc, id)'
       in v_review_definition
     ) = 0
     or position('review_status' in v_review_definition) = 0
     or position('pending_review' in v_review_definition) = 0 then
    raise exception
      'BLOCKED: review index structure or partial predicate is invalid: %',
      coalesce(v_review_definition, '<missing>');
  end if;

  select exists (
    select 1
    from pg_index i
    join pg_class idx
      on idx.oid = i.indexrelid
    join pg_class tbl
      on tbl.oid = i.indrelid
    join pg_namespace ns
      on ns.oid = tbl.relnamespace
    where ns.nspname = 'public'
      and tbl.relname = 'catalog_external_observations'
      and idx.relname = 'catalog_external_observations_pkey'
      and i.indisprimary
      and i.indisunique
      and i.indisvalid
      and i.indisready
      and i.indnkeyatts = 1
      and pg_get_indexdef(i.indexrelid, 1, true) = 'id'
  )
  into v_primary_key_valid;

  if not v_primary_key_valid then
    raise exception
      'BLOCKED: catalog_external_observations primary key index is invalid';
  end if;
end;
$wp2a_explain_gate$;

set local enable_seqscan = on;

rollback to savepoint wp2a_fixture_scope;

do $wp2a_cleanup$
declare
  v_prefix text;
  v_remaining bigint;
begin
  select prefix into strict v_prefix from wp2a_validation_prefix;

  select
    (select count(*) from public.catalog_external_sources where source_key like v_prefix || '%') +
    (select count(*) from public.catalog_observation_jobs where job_key like v_prefix || '%') +
    (select count(*) from public.catalog_observation_runs r join public.catalog_observation_jobs j on j.id = r.job_id where j.job_key like v_prefix || '%') +
    (select count(*) from public.catalog_observation_checkpoints c join public.catalog_observation_jobs j on j.id = c.job_id where j.job_key like v_prefix || '%') +
    (select count(*) from public.catalog_external_observations where evidence_reference like v_prefix || '%') +
    (select count(*) from public.catalog_observation_candidates c join public.catalog_external_observations o on o.id = c.observation_id where o.evidence_reference like v_prefix || '%') +
    (select count(*) from public.catalog_observation_review_decisions r join public.catalog_external_observations o on o.id = r.observation_id where o.evidence_reference like v_prefix || '%') +
    (select count(*) from public.catalog_apply_events ae join public.catalog_external_observations o on o.id = ae.observation_id where o.evidence_reference like v_prefix || '%') +
    (select count(*) from public.catalog_observation_audit_ledger where payload::text like '%' || v_prefix || '%') +
    (select count(*) from public.catalog_observation_scope_health h join public.catalog_observation_jobs j on j.id = h.job_id where j.job_key like v_prefix || '%')
  into v_remaining;

  if v_remaining <> 0 then
    raise exception 'BLOCKED: rollback cleanup left % controlled rows', v_remaining;
  end if;
end;
$wp2a_cleanup$;

commit;

select 'READY_FOR_CONTROLLED_DEPLOY' as result;
