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
