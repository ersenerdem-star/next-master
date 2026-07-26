-- NM-CATALOG-ZF-GROUP-DURABLE-PROVENANCE-AND-STAGING-DB-IMPLEMENTATION
--
-- Additive database boundary for Catalog-owned durable ZF run provenance,
-- immutable official-source aliases, per-item terminal outcomes, and
-- whole-product staging versions.
--
-- This migration deliberately creates no route, provider invocation,
-- credential, discovery enablement, Product write, review decision, Guardian
-- decision, or canonical Apply path.

set lock_timeout = '5s';
set statement_timeout = '300s';

create or replace function public.catalog_zf_jsonb_sha256(input_value jsonb)
returns text
language sql
immutable
set search_path = pg_catalog, public, extensions
as $$
  select encode(
    digest(
      convert_to(coalesce(input_value, '{}'::jsonb)::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  );
$$;

create or replace function public.catalog_zf_text_is_redaction_safe(input_value text)
returns boolean
language sql
immutable
set search_path = pg_catalog
as $$
  select input_value is null
    or (
      length(input_value) <= 4000
      and input_value !~* '(authorization|proxy-authorization|client[_-]?secret|private[_-]?key|api[_-]?key|password|set-cookie|cookie)[[:space:]]*[:=]'
      and input_value !~* 'bearer[[:space:]]+[a-z0-9._~+/=-]+'
      and input_value !~ 'eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.'
      and input_value !~* '-----BEGIN[[:space:]]+(RSA |EC |OPENSSH )?PRIVATE KEY-----'
    );
$$;

create or replace function public.catalog_zf_url_is_public_evidence(input_value text)
returns boolean
language sql
immutable
set search_path = pg_catalog
as $$
  select input_value is null
    or (
      input_value ~ '^https://'
      and input_value !~* '^https://(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)'
      and input_value !~* '([?&](token|access_token|id_token|secret|signature|sig|key|credential|authorization)=)'
      and public.catalog_zf_text_is_redaction_safe(input_value)
    );
$$;

revoke all on function public.catalog_zf_jsonb_sha256(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.catalog_zf_text_is_redaction_safe(text)
  from public, anon, authenticated, service_role;
revoke all on function public.catalog_zf_url_is_public_evidence(text)
  from public, anon, authenticated, service_role;
grant execute on function public.catalog_zf_jsonb_sha256(jsonb)
  to service_role;
grant execute on function public.catalog_zf_text_is_redaction_safe(text)
  to service_role;
grant execute on function public.catalog_zf_url_is_public_evidence(text)
  to service_role;

alter table public.catalog_observation_runs
  add column if not exists contract_version text,
  add column if not exists idempotency_key text,
  add column if not exists request_fingerprint text,
  add column if not exists provider_key text,
  add column if not exists runtime_commit text,
  add column if not exists deploy_id text,
  add column if not exists requested_candidate_limit integer,
  add column if not exists effective_candidate_limit integer,
  add column if not exists start_cursor text,
  add column if not exists safe_checkpoint_cursor text,
  add column if not exists redaction_profile_version text,
  add column if not exists runtime_policy_version text,
  add column if not exists completion_class text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'catalog_observation_runs_zf_envelope_check'
      and conrelid = 'public.catalog_observation_runs'::regclass
  ) then
    alter table public.catalog_observation_runs
      add constraint catalog_observation_runs_zf_envelope_check
      check (
        provider_key is distinct from 'zf_aftermarket'
        or (
          contract_version = '1.0.0'
          and nullif(trim(idempotency_key), '') is not null
          and request_fingerprint ~ '^[0-9a-f]{64}$'
          and runtime_commit ~ '^[0-9a-f]{40}$'
          and requested_candidate_limit = 1
          and effective_candidate_limit = 1
          and redaction_profile_version = 'catalog-source-evidence-redaction.v1'
          and nullif(trim(runtime_policy_version), '') is not null
          and completion_class in (
            'RUNNING',
            'SUCCEEDED',
            'COMPLETED_WITH_WARNINGS',
            'FAILED',
            'CANCELLED',
            'DEAD_LETTER'
          )
          and public.catalog_zf_text_is_redaction_safe(idempotency_key)
          and public.catalog_zf_text_is_redaction_safe(deploy_id)
          and public.catalog_zf_text_is_redaction_safe(start_cursor)
        )
      ) not valid;

    alter table public.catalog_observation_runs
      validate constraint catalog_observation_runs_zf_envelope_check;
  end if;
end
$$;

create unique index if not exists uq_catalog_observation_runs_durable_identity
  on public.catalog_observation_runs (
    organization_id,
    idempotency_key,
    contract_version
  )
  where idempotency_key is not null
    and contract_version is not null;

create index if not exists idx_catalog_observation_runs_tenant_job_started
  on public.catalog_observation_runs (
    organization_id,
    job_id,
    started_at desc
  );

create table if not exists public.catalog_new_product_staging_candidates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  source_id uuid not null references public.catalog_external_sources(id) on delete restrict,
  brand_id uuid not null references public.brands(id) on delete restrict,
  job_id uuid not null references public.catalog_observation_jobs(id) on delete restrict,
  run_id uuid not null references public.catalog_observation_runs(id) on delete restrict,
  sequence_no integer not null check (sequence_no > 0),
  contract_version text not null check (contract_version = '1.0.0'),
  candidate_version integer not null check (candidate_version > 0),
  proposed_display_code text not null,
  normalized_code text not null,
  official_source_display_code text not null,
  official_comparison_key text not null,
  official_source_reference text not null,
  description text,
  ean text,
  hs_code text,
  origin text check (origin is null or origin ~ '^[A-Z]{2}$'),
  weight_kg numeric(14,4) check (weight_kg is null or weight_kg > 0),
  oem_references jsonb not null default '[]'::jsonb
    check (jsonb_typeof(oem_references) = 'array'),
  vehicle_applications jsonb not null default '[]'::jsonb
    check (jsonb_typeof(vehicle_applications) = 'array'),
  fitment_facts jsonb not null default '[]'::jsonb
    check (jsonb_typeof(fitment_facts) = 'array'),
  engine_facts jsonb not null default '[]'::jsonb
    check (jsonb_typeof(engine_facts) = 'array'),
  lifecycle_status text not null default 'unknown'
    check (lifecycle_status in ('active', 'discontinued', 'unknown')),
  lifecycle_note text,
  replacement_candidates jsonb not null default '[]'::jsonb
    check (jsonb_typeof(replacement_candidates) = 'array'),
  supersession_candidates jsonb not null default '[]'::jsonb
    check (jsonb_typeof(supersession_candidates) = 'array'),
  official_image_candidate_url text,
  official_image_evidence_reference text,
  official_source_url text not null,
  observed_at timestamptz not null,
  evidence_hash text not null check (evidence_hash ~ '^[0-9a-f]{64}$'),
  payload_fingerprint text not null check (payload_fingerprint ~ '^[0-9a-f]{64}$'),
  observation_fingerprint text not null check (observation_fingerprint ~ '^[0-9a-f]{64}$'),
  supersedes_candidate_id uuid references public.catalog_new_product_staging_candidates(id) on delete restrict,
  quarantine_class text,
  limitation_flags text[] not null default array[]::text[],
  source_schema_version text not null,
  runtime_commit text not null check (runtime_commit ~ '^[0-9a-f]{40}$'),
  deploy_id text,
  redaction_profile_version text not null
    check (redaction_profile_version = 'catalog-source-evidence-redaction.v1'),
  created_at timestamptz not null default now(),
  constraint catalog_new_product_staging_candidate_codes_check
    check (
      nullif(trim(proposed_display_code), '') is not null
      and nullif(trim(normalized_code), '') is not null
      and nullif(trim(official_source_display_code), '') is not null
      and nullif(trim(official_comparison_key), '') is not null
      and public.catalog_zf_text_is_redaction_safe(official_source_reference)
      and public.catalog_zf_text_is_redaction_safe(lifecycle_note)
      and public.catalog_zf_text_is_redaction_safe(official_image_evidence_reference)
      and public.catalog_zf_text_is_redaction_safe(quarantine_class)
      and public.catalog_zf_text_is_redaction_safe(source_schema_version)
      and public.catalog_zf_text_is_redaction_safe(deploy_id)
      and public.catalog_zf_url_is_public_evidence(official_source_url)
      and public.catalog_zf_url_is_public_evidence(official_image_candidate_url)
    ),
  unique (organization_id, run_id, sequence_no),
  unique (
    organization_id,
    brand_id,
    normalized_code,
    source_id,
    payload_fingerprint,
    contract_version
  ),
  unique (
    organization_id,
    brand_id,
    normalized_code,
    source_id,
    contract_version,
    candidate_version
  )
);

create index if not exists idx_catalog_new_product_staging_tenant_brand_code
  on public.catalog_new_product_staging_candidates (
    organization_id,
    brand_id,
    normalized_code,
    created_at desc
  );

create index if not exists idx_catalog_new_product_staging_review_queue
  on public.catalog_new_product_staging_candidates (
    organization_id,
    created_at,
    id
  )
  where quarantine_class is null;

create index if not exists idx_catalog_new_product_staging_quarantine_queue
  on public.catalog_new_product_staging_candidates (
    organization_id,
    created_at,
    id
  )
  where quarantine_class is not null;

create index if not exists idx_catalog_new_product_staging_source_fk
  on public.catalog_new_product_staging_candidates (source_id);
create index if not exists idx_catalog_new_product_staging_brand_fk
  on public.catalog_new_product_staging_candidates (brand_id);
create index if not exists idx_catalog_new_product_staging_job_fk
  on public.catalog_new_product_staging_candidates (job_id);
create index if not exists idx_catalog_new_product_staging_run_fk
  on public.catalog_new_product_staging_candidates (run_id);
create index if not exists idx_catalog_new_product_staging_supersedes_fk
  on public.catalog_new_product_staging_candidates (supersedes_candidate_id)
  where supersedes_candidate_id is not null;

create table if not exists public.catalog_product_source_aliases (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  source_id uuid not null references public.catalog_external_sources(id) on delete restrict,
  brand_id uuid not null references public.brands(id) on delete restrict,
  catalog_product_id uuid not null references public.catalog_products(id) on delete restrict,
  run_id uuid not null references public.catalog_observation_runs(id) on delete restrict,
  canonical_product_display_code text not null,
  canonical_normalized_code text not null,
  official_source_display_code text not null,
  official_comparison_key text not null,
  official_source_reference text not null,
  observed_at timestamptz not null,
  evidence_hash text not null check (evidence_hash ~ '^[0-9a-f]{64}$'),
  payload_fingerprint text not null check (payload_fingerprint ~ '^[0-9a-f]{64}$'),
  contract_version text not null check (contract_version = '1.0.0'),
  runtime_commit text not null check (runtime_commit ~ '^[0-9a-f]{40}$'),
  deploy_id text,
  redaction_profile_version text not null
    check (redaction_profile_version = 'catalog-source-evidence-redaction.v1'),
  created_at timestamptz not null default now(),
  constraint catalog_product_source_aliases_safe_text_check
    check (
      nullif(trim(canonical_product_display_code), '') is not null
      and nullif(trim(canonical_normalized_code), '') is not null
      and nullif(trim(official_source_display_code), '') is not null
      and nullif(trim(official_comparison_key), '') is not null
      and public.catalog_zf_text_is_redaction_safe(official_source_reference)
      and public.catalog_zf_text_is_redaction_safe(deploy_id)
    ),
  unique (
    organization_id,
    source_id,
    brand_id,
    official_source_display_code
  )
);

create index if not exists idx_catalog_product_source_aliases_product
  on public.catalog_product_source_aliases (
    organization_id,
    catalog_product_id,
    created_at desc
  );

create index if not exists idx_catalog_product_source_aliases_source_fk
  on public.catalog_product_source_aliases (source_id);
create index if not exists idx_catalog_product_source_aliases_brand_fk
  on public.catalog_product_source_aliases (brand_id);
create index if not exists idx_catalog_product_source_aliases_product_fk
  on public.catalog_product_source_aliases (catalog_product_id);
create index if not exists idx_catalog_product_source_aliases_run_fk
  on public.catalog_product_source_aliases (run_id);

create table if not exists public.catalog_observation_item_outcomes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  run_id uuid not null references public.catalog_observation_runs(id) on delete restrict,
  job_id uuid not null references public.catalog_observation_jobs(id) on delete restrict,
  source_id uuid not null references public.catalog_external_sources(id) on delete restrict,
  brand_id uuid not null references public.brands(id) on delete restrict,
  sequence_no integer not null check (sequence_no > 0),
  requested_display_code text not null,
  requested_normalized_code text not null,
  official_source_display_code text,
  official_comparison_key text,
  official_source_reference text,
  catalog_product_id uuid references public.catalog_products(id) on delete restrict,
  staging_candidate_id uuid references public.catalog_new_product_staging_candidates(id) on delete restrict,
  source_alias_id uuid references public.catalog_product_source_aliases(id) on delete restrict,
  outcome_class text not null check (
    outcome_class in (
      'EXISTING_PRODUCT_UNCHANGED',
      'EXISTING_PRODUCT_ENRICHMENT_CANDIDATE',
      'EXISTING_PRODUCT_CONFLICT',
      'OFFICIAL_DISPLAY_ALIAS_RECORDED',
      'SOURCE_ALIAS_CONFLICT',
      'NEW_PRODUCT_STAGED',
      'STAGING_REPLAYED',
      'SEARCH_RETURNED_ZERO',
      'NONEXACT_RESULTS_REJECTED',
      'OFFICIAL_BRAND_MISMATCH',
      'SUSPECT_PROVIDER_BOUNDARY',
      'ARTICLE_DETAIL_MISSING',
      'PROVIDER_SCHEMA_CHANGED',
      'PROVIDER_TIMEOUT',
      'RETRY_EXHAUSTED',
      'QUARANTINED_IDENTITY',
      'CANCELLED'
    )
  ),
  terminal boolean not null default true check (terminal),
  retryable boolean not null default false,
  attempt_count integer not null default 1 check (attempt_count between 1 and 3),
  observed_at timestamptz,
  evidence_hash text check (evidence_hash is null or evidence_hash ~ '^[0-9a-f]{64}$'),
  observation_fingerprint text not null check (observation_fingerprint ~ '^[0-9a-f]{64}$'),
  payload_fingerprint text not null check (payload_fingerprint ~ '^[0-9a-f]{64}$'),
  contract_version text not null check (contract_version = '1.0.0'),
  runtime_commit text not null check (runtime_commit ~ '^[0-9a-f]{40}$'),
  deploy_id text,
  redaction_profile_version text not null
    check (redaction_profile_version = 'catalog-source-evidence-redaction.v1'),
  error_code text,
  error_summary text check (
    error_summary is null
    or (
      length(error_summary) <= 500
      and public.catalog_zf_text_is_redaction_safe(error_summary)
    )
  ),
  checkpoint_eligible boolean not null default false,
  checkpoint_cursor text,
  started_at timestamptz not null,
  completed_at timestamptz not null,
  persisted_at timestamptz not null default now(),
  constraint catalog_observation_item_outcomes_resolution_check
    check (
      not (catalog_product_id is not null and staging_candidate_id is not null)
      and (
        outcome_class not in (
          'EXISTING_PRODUCT_UNCHANGED',
          'EXISTING_PRODUCT_ENRICHMENT_CANDIDATE',
          'EXISTING_PRODUCT_CONFLICT',
          'OFFICIAL_DISPLAY_ALIAS_RECORDED'
        )
        or catalog_product_id is not null
      )
      and (
        outcome_class not in ('NEW_PRODUCT_STAGED', 'STAGING_REPLAYED')
        or staging_candidate_id is not null
      )
      and (
        outcome_class <> 'OFFICIAL_DISPLAY_ALIAS_RECORDED'
        or source_alias_id is not null
      )
      and (
        not checkpoint_eligible
        or nullif(trim(checkpoint_cursor), '') is not null
      )
      and public.catalog_zf_text_is_redaction_safe(requested_display_code)
      and public.catalog_zf_text_is_redaction_safe(official_source_display_code)
      and public.catalog_zf_text_is_redaction_safe(official_source_reference)
      and public.catalog_zf_text_is_redaction_safe(error_code)
      and public.catalog_zf_text_is_redaction_safe(deploy_id)
    ),
  unique (organization_id, run_id, sequence_no)
);

create index if not exists idx_catalog_observation_item_outcomes_run_page
  on public.catalog_observation_item_outcomes (
    organization_id,
    run_id,
    sequence_no
  );

create index if not exists idx_catalog_observation_item_outcomes_class
  on public.catalog_observation_item_outcomes (
    organization_id,
    outcome_class,
    persisted_at desc
  );

create index if not exists idx_catalog_observation_item_outcomes_run_fk
  on public.catalog_observation_item_outcomes (run_id);
create index if not exists idx_catalog_observation_item_outcomes_job_fk
  on public.catalog_observation_item_outcomes (job_id);
create index if not exists idx_catalog_observation_item_outcomes_source_fk
  on public.catalog_observation_item_outcomes (source_id);
create index if not exists idx_catalog_observation_item_outcomes_brand_fk
  on public.catalog_observation_item_outcomes (brand_id);
create index if not exists idx_catalog_observation_item_outcomes_product_fk
  on public.catalog_observation_item_outcomes (catalog_product_id)
  where catalog_product_id is not null;
create index if not exists idx_catalog_observation_item_outcomes_staging_fk
  on public.catalog_observation_item_outcomes (staging_candidate_id)
  where staging_candidate_id is not null;
create index if not exists idx_catalog_observation_item_outcomes_alias_fk
  on public.catalog_observation_item_outcomes (source_alias_id)
  where source_alias_id is not null;

create table if not exists public.catalog_new_product_staging_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  candidate_id uuid not null references public.catalog_new_product_staging_candidates(id) on delete restrict,
  event_version integer not null check (event_version > 0),
  expected_prior_version integer not null check (expected_prior_version >= 0),
  event_type text not null check (
    event_type in (
      'STAGED',
      'QUARANTINED',
      'REVIEW_REQUESTED',
      'REJECTED',
      'DEFERRED',
      'SUPERSEDED',
      'CANCELLED'
    )
  ),
  actor_id uuid,
  reason_code text not null,
  reviewer_note text,
  idempotency_key text not null,
  event_fingerprint text not null check (event_fingerprint ~ '^[0-9a-f]{64}$'),
  source_review_decision_reference text,
  created_at timestamptz not null default now(),
  constraint catalog_new_product_staging_events_safe_text_check
    check (
      public.catalog_zf_text_is_redaction_safe(reason_code)
      and public.catalog_zf_text_is_redaction_safe(reviewer_note)
      and public.catalog_zf_text_is_redaction_safe(idempotency_key)
      and public.catalog_zf_text_is_redaction_safe(source_review_decision_reference)
    ),
  unique (organization_id, candidate_id, event_version),
  unique (organization_id, candidate_id, idempotency_key)
);

create index if not exists idx_catalog_new_product_staging_events_history
  on public.catalog_new_product_staging_events (
    organization_id,
    candidate_id,
    event_version
  );

create index if not exists idx_catalog_new_product_staging_events_candidate_fk
  on public.catalog_new_product_staging_events (candidate_id);

alter table public.catalog_observation_audit_ledger
  add column if not exists item_outcome_id uuid
    references public.catalog_observation_item_outcomes(id) on delete restrict,
  add column if not exists staging_candidate_id uuid
    references public.catalog_new_product_staging_candidates(id) on delete restrict,
  add column if not exists staging_event_id uuid
    references public.catalog_new_product_staging_events(id) on delete restrict,
  add column if not exists source_alias_id uuid
    references public.catalog_product_source_aliases(id) on delete restrict;

create index if not exists idx_catalog_observation_audit_zf_run
  on public.catalog_observation_audit_ledger (
    organization_id,
    run_id,
    created_at,
    id
  )
  where item_outcome_id is not null
     or staging_candidate_id is not null
     or source_alias_id is not null;

create index if not exists idx_catalog_observation_audit_item_outcome_fk
  on public.catalog_observation_audit_ledger (item_outcome_id)
  where item_outcome_id is not null;
create index if not exists idx_catalog_observation_audit_staging_candidate_fk
  on public.catalog_observation_audit_ledger (staging_candidate_id)
  where staging_candidate_id is not null;
create index if not exists idx_catalog_observation_audit_staging_event_fk
  on public.catalog_observation_audit_ledger (staging_event_id)
  where staging_event_id is not null;
create index if not exists idx_catalog_observation_audit_source_alias_fk
  on public.catalog_observation_audit_ledger (source_alias_id)
  where source_alias_id is not null;

alter table public.catalog_new_product_staging_candidates enable row level security;
alter table public.catalog_product_source_aliases enable row level security;
alter table public.catalog_observation_item_outcomes enable row level security;
alter table public.catalog_new_product_staging_events enable row level security;

drop policy if exists catalog_new_product_staging_candidates_select_admin_org
  on public.catalog_new_product_staging_candidates;
create policy catalog_new_product_staging_candidates_select_admin_org
on public.catalog_new_product_staging_candidates
for select
to authenticated
using (
  auth.uid() is not null
  and public.is_superadmin()
  and organization_id = public.current_profile_org_id()
);

drop policy if exists catalog_product_source_aliases_select_admin_org
  on public.catalog_product_source_aliases;
create policy catalog_product_source_aliases_select_admin_org
on public.catalog_product_source_aliases
for select
to authenticated
using (
  auth.uid() is not null
  and public.is_superadmin()
  and organization_id = public.current_profile_org_id()
);

drop policy if exists catalog_observation_item_outcomes_select_admin_org
  on public.catalog_observation_item_outcomes;
create policy catalog_observation_item_outcomes_select_admin_org
on public.catalog_observation_item_outcomes
for select
to authenticated
using (
  auth.uid() is not null
  and public.is_superadmin()
  and organization_id = public.current_profile_org_id()
);

drop policy if exists catalog_new_product_staging_events_select_admin_org
  on public.catalog_new_product_staging_events;
create policy catalog_new_product_staging_events_select_admin_org
on public.catalog_new_product_staging_events
for select
to authenticated
using (
  auth.uid() is not null
  and public.is_superadmin()
  and organization_id = public.current_profile_org_id()
);

revoke all on table public.catalog_new_product_staging_candidates
  from public, anon, authenticated, service_role;
revoke all on table public.catalog_product_source_aliases
  from public, anon, authenticated, service_role;
revoke all on table public.catalog_observation_item_outcomes
  from public, anon, authenticated, service_role;
revoke all on table public.catalog_new_product_staging_events
  from public, anon, authenticated, service_role;

grant select on table public.catalog_new_product_staging_candidates
  to authenticated, service_role;
grant select on table public.catalog_product_source_aliases
  to authenticated, service_role;
grant select on table public.catalog_observation_item_outcomes
  to authenticated, service_role;
grant select on table public.catalog_new_product_staging_events
  to authenticated, service_role;

create or replace function public.prevent_catalog_zf_append_only_mutation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  raise exception using
    errcode = '55000',
    message = format('%s is append-only evidence', tg_table_name);
end;
$$;

revoke all on function public.prevent_catalog_zf_append_only_mutation()
  from public, anon, authenticated, service_role;

drop trigger if exists trg_catalog_new_product_staging_candidates_append_only
  on public.catalog_new_product_staging_candidates;
create trigger trg_catalog_new_product_staging_candidates_append_only
before update or delete on public.catalog_new_product_staging_candidates
for each row execute function public.prevent_catalog_zf_append_only_mutation();

drop trigger if exists trg_catalog_product_source_aliases_append_only
  on public.catalog_product_source_aliases;
create trigger trg_catalog_product_source_aliases_append_only
before update or delete on public.catalog_product_source_aliases
for each row execute function public.prevent_catalog_zf_append_only_mutation();

drop trigger if exists trg_catalog_observation_item_outcomes_append_only
  on public.catalog_observation_item_outcomes;
create trigger trg_catalog_observation_item_outcomes_append_only
before update or delete on public.catalog_observation_item_outcomes
for each row execute function public.prevent_catalog_zf_append_only_mutation();

drop trigger if exists trg_catalog_new_product_staging_events_append_only
  on public.catalog_new_product_staging_events;
create trigger trg_catalog_new_product_staging_events_append_only
before update or delete on public.catalog_new_product_staging_events
for each row execute function public.prevent_catalog_zf_append_only_mutation();

create or replace function public.prevent_catalog_zf_run_provenance_mutation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $$
begin
  if old.provider_key = 'zf_aftermarket'
     and (
       old.contract_version is distinct from new.contract_version
       or old.idempotency_key is distinct from new.idempotency_key
       or old.request_fingerprint is distinct from new.request_fingerprint
       or old.provider_key is distinct from new.provider_key
       or old.runtime_commit is distinct from new.runtime_commit
       or old.deploy_id is distinct from new.deploy_id
       or old.requested_candidate_limit is distinct from new.requested_candidate_limit
       or old.effective_candidate_limit is distinct from new.effective_candidate_limit
       or old.start_cursor is distinct from new.start_cursor
       or old.redaction_profile_version is distinct from new.redaction_profile_version
       or old.runtime_policy_version is distinct from new.runtime_policy_version
     ) then
    raise exception using
      errcode = '55000',
      message = 'ZF durable run provenance is immutable';
  end if;

  return new;
end;
$$;

revoke all on function public.prevent_catalog_zf_run_provenance_mutation()
  from public, anon, authenticated, service_role;

drop trigger if exists trg_catalog_observation_runs_zf_provenance_immutable
  on public.catalog_observation_runs;
create trigger trg_catalog_observation_runs_zf_provenance_immutable
before update on public.catalog_observation_runs
for each row execute function public.prevent_catalog_zf_run_provenance_mutation();

create or replace function public.validate_catalog_zf_durable_scope()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if tg_table_name = 'catalog_new_product_staging_candidates' then
    if not exists (
      select 1
      from public.catalog_observation_runs run
      where run.id = new.run_id
        and run.organization_id = new.organization_id
        and run.job_id = new.job_id
        and run.source_id = new.source_id
        and run.brand_id = new.brand_id
        and run.provider_key = 'zf_aftermarket'
    ) then
      raise exception 'ZF staging candidate run scope mismatch';
    end if;

    if new.supersedes_candidate_id is not null and not exists (
      select 1
      from public.catalog_new_product_staging_candidates prior
      where prior.id = new.supersedes_candidate_id
        and prior.organization_id = new.organization_id
        and prior.source_id = new.source_id
        and prior.brand_id = new.brand_id
        and prior.normalized_code = new.normalized_code
        and prior.contract_version = new.contract_version
        and prior.candidate_version + 1 = new.candidate_version
    ) then
      raise exception 'ZF staging candidate version lineage mismatch';
    end if;

  elsif tg_table_name = 'catalog_product_source_aliases' then
    if not exists (
      select 1
      from public.catalog_observation_runs run
      join public.catalog_products product
        on product.id = new.catalog_product_id
       and product.organization_id = run.organization_id
       and product.brand_id = run.brand_id
      where run.id = new.run_id
        and run.organization_id = new.organization_id
        and run.source_id = new.source_id
        and run.brand_id = new.brand_id
        and run.provider_key = 'zf_aftermarket'
    ) then
      raise exception 'ZF source alias run/Product scope mismatch';
    end if;

  elsif tg_table_name = 'catalog_observation_item_outcomes' then
    if not exists (
      select 1
      from public.catalog_observation_runs run
      where run.id = new.run_id
        and run.organization_id = new.organization_id
        and run.job_id = new.job_id
        and run.source_id = new.source_id
        and run.brand_id = new.brand_id
        and run.provider_key = 'zf_aftermarket'
    ) then
      raise exception 'ZF item outcome run scope mismatch';
    end if;

    if new.catalog_product_id is not null and not exists (
      select 1
      from public.catalog_products product
      where product.id = new.catalog_product_id
        and product.organization_id = new.organization_id
        and product.brand_id = new.brand_id
    ) then
      raise exception 'ZF item outcome Product scope mismatch';
    end if;

    if new.staging_candidate_id is not null and not exists (
      select 1
      from public.catalog_new_product_staging_candidates candidate
      where candidate.id = new.staging_candidate_id
        and candidate.organization_id = new.organization_id
        and candidate.source_id = new.source_id
        and candidate.brand_id = new.brand_id
        and candidate.normalized_code = new.requested_normalized_code
    ) then
      raise exception 'ZF item outcome staging scope mismatch';
    end if;

    if new.source_alias_id is not null and not exists (
      select 1
      from public.catalog_product_source_aliases alias
      where alias.id = new.source_alias_id
        and alias.organization_id = new.organization_id
        and alias.source_id = new.source_id
        and alias.brand_id = new.brand_id
        and alias.catalog_product_id = new.catalog_product_id
    ) then
      raise exception 'ZF item outcome source alias scope mismatch';
    end if;

  elsif tg_table_name = 'catalog_new_product_staging_events' then
    if not exists (
      select 1
      from public.catalog_new_product_staging_candidates candidate
      where candidate.id = new.candidate_id
        and candidate.organization_id = new.organization_id
    ) then
      raise exception 'ZF staging event candidate scope mismatch';
    end if;

  elsif tg_table_name = 'catalog_observation_audit_ledger' then
    if new.item_outcome_id is not null and not exists (
      select 1
      from public.catalog_observation_item_outcomes outcome
      where outcome.id = new.item_outcome_id
        and outcome.organization_id = new.organization_id
        and outcome.run_id is not distinct from new.run_id
    ) then
      raise exception 'ZF audit item outcome scope mismatch';
    end if;

    if new.staging_candidate_id is not null and not exists (
      select 1
      from public.catalog_new_product_staging_candidates candidate
      where candidate.id = new.staging_candidate_id
        and candidate.organization_id = new.organization_id
    ) then
      raise exception 'ZF audit staging candidate scope mismatch';
    end if;

    if new.staging_event_id is not null and not exists (
      select 1
      from public.catalog_new_product_staging_events event
      where event.id = new.staging_event_id
        and event.organization_id = new.organization_id
    ) then
      raise exception 'ZF audit staging event scope mismatch';
    end if;

    if new.source_alias_id is not null and not exists (
      select 1
      from public.catalog_product_source_aliases alias
      where alias.id = new.source_alias_id
        and alias.organization_id = new.organization_id
    ) then
      raise exception 'ZF audit source alias scope mismatch';
    end if;
  end if;

  return new;
end;
$$;

revoke all on function public.validate_catalog_zf_durable_scope()
  from public, anon, authenticated, service_role;

drop trigger if exists trg_catalog_new_product_staging_candidates_scope
  on public.catalog_new_product_staging_candidates;
create trigger trg_catalog_new_product_staging_candidates_scope
before insert on public.catalog_new_product_staging_candidates
for each row execute function public.validate_catalog_zf_durable_scope();

drop trigger if exists trg_catalog_product_source_aliases_scope
  on public.catalog_product_source_aliases;
create trigger trg_catalog_product_source_aliases_scope
before insert on public.catalog_product_source_aliases
for each row execute function public.validate_catalog_zf_durable_scope();

drop trigger if exists trg_catalog_observation_item_outcomes_scope
  on public.catalog_observation_item_outcomes;
create trigger trg_catalog_observation_item_outcomes_scope
before insert on public.catalog_observation_item_outcomes
for each row execute function public.validate_catalog_zf_durable_scope();

drop trigger if exists trg_catalog_new_product_staging_events_scope
  on public.catalog_new_product_staging_events;
create trigger trg_catalog_new_product_staging_events_scope
before insert on public.catalog_new_product_staging_events
for each row execute function public.validate_catalog_zf_durable_scope();

drop trigger if exists trg_catalog_observation_audit_zf_scope
  on public.catalog_observation_audit_ledger;
create trigger trg_catalog_observation_audit_zf_scope
before insert on public.catalog_observation_audit_ledger
for each row execute function public.validate_catalog_zf_durable_scope();

create or replace function public.catalog_zf_candidate_payload_fingerprint(
  input_organization_id uuid,
  input_source_id uuid,
  input_brand_id uuid,
  input_official_source_display_code text,
  input_official_comparison_key text,
  input_candidate jsonb,
  input_contract_version text default '1.0.0'
)
returns text
language sql
immutable
set search_path = pg_catalog, public, extensions
as $$
  select public.catalog_zf_jsonb_sha256(
    jsonb_build_object(
      'organizationId', input_organization_id,
      'sourceId', input_source_id,
      'brandId', input_brand_id,
      'contractVersion', input_contract_version,
      'officialSourceDisplayCode', input_official_source_display_code,
      'officialComparisonKey', input_official_comparison_key,
      'candidate', coalesce(input_candidate, '{}'::jsonb)
    )
  );
$$;

create or replace function public.catalog_zf_observation_fingerprint(
  input_payload_fingerprint text,
  input_source_revision text,
  input_observed_at timestamptz,
  input_evidence_hash text,
  input_official_source_reference text
)
returns text
language sql
immutable
set search_path = pg_catalog, public, extensions
as $$
  select public.catalog_zf_jsonb_sha256(
    jsonb_build_object(
      'payloadFingerprint', input_payload_fingerprint,
      'sourceRevision', input_source_revision,
      'observedAtUtc', to_char(
        input_observed_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ),
      'evidenceHash', input_evidence_hash,
      'officialSourceReference', input_official_source_reference
    )
  );
$$;

revoke all on function public.catalog_zf_candidate_payload_fingerprint(
  uuid, uuid, uuid, text, text, jsonb, text
) from public, anon, authenticated, service_role;
revoke all on function public.catalog_zf_observation_fingerprint(
  text, text, timestamptz, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.catalog_zf_candidate_payload_fingerprint(
  uuid, uuid, uuid, text, text, jsonb, text
) to service_role;
grant execute on function public.catalog_zf_observation_fingerprint(
  text, text, timestamptz, text, text
) to service_role;

create or replace function public.begin_catalog_zf_durable_run(
  input_job_id uuid,
  input_idempotency_key text,
  input_runtime_commit text,
  input_deploy_id text default null,
  input_candidate_limit integer default 1,
  input_start_cursor text default null,
  input_runtime_policy_version text default 'zf-durable-staging.v1',
  input_source_revision text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_job public.catalog_observation_jobs%rowtype;
  v_brand_name text;
  v_brand_key text;
  v_request_fingerprint text;
  v_existing public.catalog_observation_runs%rowtype;
  v_run_id uuid;
begin
  perform public.require_catalog_observation_service_role();

  if nullif(trim(input_idempotency_key), '') is null
     or not public.catalog_zf_text_is_redaction_safe(input_idempotency_key) then
    raise exception using errcode = '22023', message = 'INVALID_IDEMPOTENCY_KEY';
  end if;

  if input_runtime_commit !~ '^[0-9a-f]{40}$' then
    raise exception using errcode = '22023', message = 'INVALID_RUNTIME_COMMIT';
  end if;

  if input_candidate_limit <> 1 then
    raise exception using errcode = '22023', message = 'CANDIDATE_LIMIT_NOT_AUTHORIZED';
  end if;

  if not public.catalog_zf_text_is_redaction_safe(input_deploy_id)
     or not public.catalog_zf_text_is_redaction_safe(input_start_cursor)
     or not public.catalog_zf_text_is_redaction_safe(input_runtime_policy_version)
     or not public.catalog_zf_text_is_redaction_safe(input_source_revision) then
    raise exception using errcode = '22023', message = 'REDACTION_UNSAFE_RUN_ENVELOPE';
  end if;

  select job.*
  into v_job
  from public.catalog_observation_jobs job
  where job.id = input_job_id
    and job.status = 'active'
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'ACTIVE_ZF_OBSERVATION_JOB_NOT_FOUND';
  end if;

  perform 1
  from public.catalog_external_sources source
  where source.id = v_job.source_id
    and source.organization_id = v_job.organization_id
    and source.is_active
    and source.source_key = 'zf_aftermarket'
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'ACTIVE_ZF_OBSERVATION_JOB_NOT_FOUND';
  end if;

  select brand.name
  into v_brand_name
  from public.brands brand
  where brand.id = v_job.brand_id
    and brand.organization_id = v_job.organization_id;

  v_brand_key := public.normalize_catalog_brand_key(v_brand_name);
  if v_brand_key not in ('ZF', 'SACHS', 'LEMFORDER', 'TRW', 'WABCO', 'BOGE') then
    raise exception using errcode = '22023', message = 'ZF_BRAND_BOUNDARY_REJECTED';
  end if;

  v_request_fingerprint := public.catalog_zf_jsonb_sha256(
    jsonb_build_object(
      'organizationId', v_job.organization_id,
      'brandId', v_job.brand_id,
      'providerKey', 'zf_aftermarket',
      'sourceId', v_job.source_id,
      'startCursor', input_start_cursor,
      'requestedCandidateLimit', input_candidate_limit,
      'effectiveCandidateLimit', 1,
      'refreshPosture', 'fill_only',
      'discoveryPosture', 'disabled',
      'contractVersion', '1.0.0',
      'runtimePolicyVersion', input_runtime_policy_version
    )
  );

  perform pg_advisory_xact_lock(
    hashtextextended(
      concat_ws(
        ':',
        v_job.organization_id::text,
        input_idempotency_key,
        '1.0.0'
      ),
      0
    )
  );

  select *
  into v_existing
  from public.catalog_observation_runs run
  where run.organization_id = v_job.organization_id
    and run.idempotency_key = input_idempotency_key
    and run.contract_version = '1.0.0';

  if found then
    if v_existing.request_fingerprint = v_request_fingerprint then
      return jsonb_build_object(
        'success', true,
        'replayed', true,
        'run_id', v_existing.id,
        'request_fingerprint', v_existing.request_fingerprint,
        'status', v_existing.status
      );
    end if;

    return jsonb_build_object(
      'success', false,
      'replayed', false,
      'error_code', 'RUN_IDEMPOTENCY_CONFLICT'
    );
  end if;

  insert into public.catalog_observation_runs (
    organization_id,
    job_id,
    source_id,
    brand_id,
    status,
    input_metadata,
    source_revision,
    contract_version,
    idempotency_key,
    request_fingerprint,
    provider_key,
    runtime_commit,
    deploy_id,
    requested_candidate_limit,
    effective_candidate_limit,
    start_cursor,
    redaction_profile_version,
    runtime_policy_version,
    completion_class
  ) values (
    v_job.organization_id,
    v_job.id,
    v_job.source_id,
    v_job.brand_id,
    'running',
    jsonb_build_object(
      'sourceMode', 'zf_aftermarket_official_only',
      'refreshPosture', 'fill_only',
      'discoveryPosture', 'disabled'
    ),
    nullif(trim(input_source_revision), ''),
    '1.0.0',
    trim(input_idempotency_key),
    v_request_fingerprint,
    'zf_aftermarket',
    input_runtime_commit,
    nullif(trim(input_deploy_id), ''),
    1,
    1,
    nullif(trim(input_start_cursor), ''),
    'catalog-source-evidence-redaction.v1',
    input_runtime_policy_version,
    'RUNNING'
  )
  returning id into v_run_id;

  insert into public.catalog_observation_audit_ledger (
    organization_id,
    job_id,
    run_id,
    action,
    next_status,
    message,
    payload
  ) values (
    v_job.organization_id,
    v_job.id,
    v_run_id,
    'zf_durable_run_started',
    'RUNNING',
    'ZF durable run envelope committed',
    jsonb_build_object(
      'requestFingerprint', v_request_fingerprint,
      'runtimeCommit', input_runtime_commit,
      'deployId', input_deploy_id,
      'candidateLimit', 1,
      'contractVersion', '1.0.0'
    )
  );

  return jsonb_build_object(
    'success', true,
    'replayed', false,
    'run_id', v_run_id,
    'request_fingerprint', v_request_fingerprint,
    'status', 'running'
  );
end;
$$;

revoke all on function public.begin_catalog_zf_durable_run(
  uuid, text, text, text, integer, text, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.begin_catalog_zf_durable_run(
  uuid, text, text, text, integer, text, text, text
) to service_role;

create or replace function public.record_catalog_zf_durable_item(
  input_run_id uuid,
  input_sequence_no integer,
  input_item jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_run public.catalog_observation_runs%rowtype;
  v_brand_name text;
  v_brand_key text;
  v_requested_display_code text;
  v_requested_normalized_code text;
  v_official_brand text;
  v_official_display_code text;
  v_official_comparison_key text;
  v_official_source_reference text;
  v_official_source_url text;
  v_outcome_class text;
  v_actual_outcome_class text;
  v_retryable boolean;
  v_attempt_count integer;
  v_checkpoint_eligible boolean;
  v_checkpoint_cursor text;
  v_started_at timestamptz;
  v_completed_at timestamptz;
  v_observed_at timestamptz;
  v_evidence_hash text;
  v_payload_fingerprint text;
  v_observation_fingerprint text;
  v_error_code text;
  v_error_summary text;
  v_catalog_product_id uuid;
  v_product public.catalog_products%rowtype;
  v_candidate jsonb;
  v_candidate_payload jsonb;
  v_candidate_id uuid;
  v_candidate_replayed boolean := false;
  v_candidate_version integer;
  v_prior_candidate_id uuid;
  v_source_alias_id uuid;
  v_existing_alias public.catalog_product_source_aliases%rowtype;
  v_existing_outcome public.catalog_observation_item_outcomes%rowtype;
  v_item_outcome_id uuid;
  v_staging_event_id uuid;
  v_event_version integer;
  v_safe_sequence integer;
  v_safe_cursor text;
  v_unknown_key text;
  v_unknown_candidate_key text;
  v_quarantine_class text;
  v_official_image_url text;
  v_source_schema_version text;
begin
  perform public.require_catalog_observation_service_role();

  if input_sequence_no is null or input_sequence_no <= 0 then
    raise exception using errcode = '22023', message = 'INVALID_SEQUENCE';
  end if;

  if jsonb_typeof(input_item) <> 'object' then
    raise exception using errcode = '22023', message = 'ITEM_PAYLOAD_MUST_BE_OBJECT';
  end if;

  select key
  into v_unknown_key
  from jsonb_object_keys(input_item) key
  where key <> all(array[
    'requestedDisplayCode',
    'officialBrand',
    'officialDisplayCode',
    'officialComparisonKey',
    'officialSourceReference',
    'officialSourceUrl',
    'outcome',
    'retryable',
    'attemptCount',
    'checkpointEligible',
    'checkpointCursor',
    'startedAt',
    'completedAt',
    'observedAt',
    'evidenceHash',
    'payloadFingerprint',
    'observationFingerprint',
    'errorCode',
    'errorSummary',
    'existingCatalogProductId',
    'candidate'
  ]::text[])
  limit 1;

  if v_unknown_key is not null then
    raise exception using
      errcode = '22023',
      message = format('UNKNOWN_ITEM_FIELD:%s', v_unknown_key);
  end if;

  if not public.catalog_zf_text_is_redaction_safe(input_item::text) then
    raise exception using errcode = '22023', message = 'REDACTION_UNSAFE_ITEM_PAYLOAD';
  end if;

  select *
  into v_run
  from public.catalog_observation_runs run
  where run.id = input_run_id
    and run.status = 'running'
    and run.provider_key = 'zf_aftermarket'
    and run.contract_version = '1.0.0'
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'RUNNING_ZF_DURABLE_RUN_NOT_FOUND';
  end if;

  select brand.name
  into v_brand_name
  from public.brands brand
  where brand.id = v_run.brand_id
    and brand.organization_id = v_run.organization_id;

  v_brand_key := public.normalize_catalog_brand_key(v_brand_name);
  if v_brand_key not in ('ZF', 'SACHS', 'LEMFORDER', 'TRW', 'WABCO', 'BOGE') then
    raise exception using errcode = '22023', message = 'ZF_BRAND_BOUNDARY_REJECTED';
  end if;

  v_requested_display_code := input_item ->> 'requestedDisplayCode';
  v_requested_normalized_code := public.normalize_catalog_product_code(
    v_requested_display_code
  );
  v_official_brand := input_item ->> 'officialBrand';
  v_official_display_code := input_item ->> 'officialDisplayCode';
  v_official_comparison_key := input_item ->> 'officialComparisonKey';
  v_official_source_reference := input_item ->> 'officialSourceReference';
  v_official_source_url := input_item ->> 'officialSourceUrl';
  v_outcome_class := input_item ->> 'outcome';
  v_actual_outcome_class := v_outcome_class;
  v_retryable := coalesce((input_item ->> 'retryable')::boolean, false);
  v_attempt_count := coalesce((input_item ->> 'attemptCount')::integer, 1);
  v_checkpoint_eligible := coalesce(
    (input_item ->> 'checkpointEligible')::boolean,
    false
  );
  v_checkpoint_cursor := input_item ->> 'checkpointCursor';
  v_started_at := coalesce((input_item ->> 'startedAt')::timestamptz, now());
  v_completed_at := coalesce((input_item ->> 'completedAt')::timestamptz, now());
  v_observed_at := (input_item ->> 'observedAt')::timestamptz;
  v_evidence_hash := input_item ->> 'evidenceHash';
  v_payload_fingerprint := input_item ->> 'payloadFingerprint';
  v_observation_fingerprint := input_item ->> 'observationFingerprint';
  v_error_code := nullif(trim(input_item ->> 'errorCode'), '');
  v_error_summary := nullif(trim(input_item ->> 'errorSummary'), '');
  v_candidate := input_item -> 'candidate';

  if nullif(trim(v_requested_display_code), '') is null
     or nullif(v_requested_normalized_code, '') is null
     or v_outcome_class is null
     or v_outcome_class not in (
       'EXISTING_PRODUCT_UNCHANGED',
       'EXISTING_PRODUCT_ENRICHMENT_CANDIDATE',
       'EXISTING_PRODUCT_CONFLICT',
       'OFFICIAL_DISPLAY_ALIAS_RECORDED',
       'SOURCE_ALIAS_CONFLICT',
       'NEW_PRODUCT_STAGED',
       'STAGING_REPLAYED',
       'SEARCH_RETURNED_ZERO',
       'NONEXACT_RESULTS_REJECTED',
       'OFFICIAL_BRAND_MISMATCH',
       'SUSPECT_PROVIDER_BOUNDARY',
       'ARTICLE_DETAIL_MISSING',
       'PROVIDER_SCHEMA_CHANGED',
       'PROVIDER_TIMEOUT',
       'RETRY_EXHAUSTED',
       'QUARANTINED_IDENTITY',
       'CANCELLED'
     )
     or v_attempt_count not between 1 and 3
     or v_completed_at < v_started_at
     or v_payload_fingerprint !~ '^[0-9a-f]{64}$'
     or v_observation_fingerprint !~ '^[0-9a-f]{64}$'
     or (v_checkpoint_eligible and nullif(trim(v_checkpoint_cursor), '') is null)
     or not public.catalog_zf_text_is_redaction_safe(v_error_code)
     or not public.catalog_zf_text_is_redaction_safe(v_error_summary)
     or not public.catalog_zf_url_is_public_evidence(v_official_source_url) then
    raise exception using errcode = '22023', message = 'INVALID_ZF_ITEM_ENVELOPE';
  end if;

  if v_outcome_class = 'PROVIDER_TIMEOUT' and v_checkpoint_eligible then
    raise exception using errcode = '22023', message = 'TIMEOUT_CANNOT_ADVANCE_CHECKPOINT';
  end if;

  if v_retryable and v_outcome_class not in ('PROVIDER_TIMEOUT', 'RETRY_EXHAUSTED') then
    raise exception using errcode = '22023', message = 'OUTCOME_NOT_RETRYABLE';
  end if;

  select *
  into v_existing_outcome
  from public.catalog_observation_item_outcomes outcome
  where outcome.organization_id = v_run.organization_id
    and outcome.run_id = v_run.id
    and outcome.sequence_no = input_sequence_no;

  if found then
    if v_existing_outcome.payload_fingerprint = v_payload_fingerprint
       and v_existing_outcome.observation_fingerprint = v_observation_fingerprint
       and v_existing_outcome.requested_display_code = v_requested_display_code then
      return jsonb_build_object(
        'success', true,
        'replayed', true,
        'item_outcome_id', v_existing_outcome.id,
        'outcome', v_existing_outcome.outcome_class,
        'staging_candidate_id', v_existing_outcome.staging_candidate_id,
        'source_alias_id', v_existing_outcome.source_alias_id
      );
    end if;

    raise exception using errcode = '23505', message = 'SOURCE_PAYLOAD_CONFLICT';
  end if;

  if nullif(trim(v_official_brand), '') is not null
     and public.normalize_catalog_brand_key(v_official_brand) <> v_brand_key
     and v_outcome_class not in ('OFFICIAL_BRAND_MISMATCH', 'QUARANTINED_IDENTITY') then
    raise exception using errcode = '22023', message = 'OFFICIAL_BRAND_MISMATCH';
  end if;

  if v_brand_key = 'TRW'
     and coalesce(v_official_comparison_key, '') ~ '^105'
     and v_outcome_class not in ('SUSPECT_PROVIDER_BOUNDARY', 'QUARANTINED_IDENTITY') then
    raise exception using errcode = '22023', message = 'SUSPECT_PROVIDER_BOUNDARY';
  end if;

  if nullif(input_item ->> 'existingCatalogProductId', '') is not null then
    v_catalog_product_id := (input_item ->> 'existingCatalogProductId')::uuid;

    select *
    into v_product
    from public.catalog_products product
    where product.id = v_catalog_product_id
      and product.organization_id = v_run.organization_id
      and product.brand_id = v_run.brand_id;

    if not found then
      raise exception using errcode = '23503', message = 'CATALOG_PRODUCT_SCOPE_MISMATCH';
    end if;
  end if;

  if v_outcome_class in (
    'EXISTING_PRODUCT_UNCHANGED',
    'EXISTING_PRODUCT_ENRICHMENT_CANDIDATE',
    'EXISTING_PRODUCT_CONFLICT',
    'OFFICIAL_DISPLAY_ALIAS_RECORDED'
  ) and v_catalog_product_id is null then
    raise exception using errcode = '22023', message = 'EXISTING_PRODUCT_REQUIRED';
  end if;

  if v_outcome_class = 'OFFICIAL_DISPLAY_ALIAS_RECORDED' then
    if nullif(trim(v_official_display_code), '') is null
       or nullif(trim(v_official_comparison_key), '') is null
       or nullif(trim(v_official_source_reference), '') is null
       or v_observed_at is null
       or v_evidence_hash !~ '^[0-9a-f]{64}$'
       or public.normalize_catalog_compact_alnum(v_product.product_code)
          <> v_official_comparison_key then
      raise exception using errcode = '22023', message = 'INVALID_OFFICIAL_ALIAS_EVIDENCE';
    end if;

    perform pg_advisory_xact_lock(
      hashtextextended(
        concat_ws(
          ':',
          v_run.organization_id::text,
          v_run.source_id::text,
          v_run.brand_id::text,
          v_official_display_code
        ),
        0
      )
    );

    select *
    into v_existing_alias
    from public.catalog_product_source_aliases alias
    where alias.organization_id = v_run.organization_id
      and alias.source_id = v_run.source_id
      and alias.brand_id = v_run.brand_id
      and alias.official_source_display_code = v_official_display_code;

    if found and v_existing_alias.catalog_product_id <> v_catalog_product_id then
      v_actual_outcome_class := 'SOURCE_ALIAS_CONFLICT';
      v_catalog_product_id := null;
      v_source_alias_id := null;
      v_checkpoint_eligible := true;
    elsif found then
      v_source_alias_id := v_existing_alias.id;
    else
      insert into public.catalog_product_source_aliases (
        organization_id,
        source_id,
        brand_id,
        catalog_product_id,
        run_id,
        canonical_product_display_code,
        canonical_normalized_code,
        official_source_display_code,
        official_comparison_key,
        official_source_reference,
        observed_at,
        evidence_hash,
        payload_fingerprint,
        contract_version,
        runtime_commit,
        deploy_id,
        redaction_profile_version
      ) values (
        v_run.organization_id,
        v_run.source_id,
        v_run.brand_id,
        v_product.id,
        v_run.id,
        v_product.product_code,
        public.normalize_catalog_product_code(v_product.product_code),
        v_official_display_code,
        v_official_comparison_key,
        v_official_source_reference,
        v_observed_at,
        v_evidence_hash,
        v_payload_fingerprint,
        v_run.contract_version,
        v_run.runtime_commit,
        v_run.deploy_id,
        v_run.redaction_profile_version
      )
      returning id into v_source_alias_id;
    end if;
  end if;

  if v_candidate is not null then
    if jsonb_typeof(v_candidate) <> 'object' then
      raise exception using errcode = '22023', message = 'CANDIDATE_PAYLOAD_MUST_BE_OBJECT';
    end if;

    select key
    into v_unknown_candidate_key
    from jsonb_object_keys(v_candidate) key
    where key <> all(array[
      'proposedDisplayCode',
      'description',
      'ean',
      'hsCode',
      'origin',
      'weightKg',
      'oemReferences',
      'vehicleApplications',
      'fitmentFacts',
      'engineFacts',
      'lifecycleStatus',
      'lifecycleNote',
      'replacementCandidates',
      'supersessionCandidates',
      'officialImageCandidateUrl',
      'officialImageEvidenceReference',
      'limitationFlags',
      'sourceSchemaVersion',
      'quarantineClass'
    ]::text[])
    limit 1;

    if v_unknown_candidate_key is not null then
      raise exception using
        errcode = '22023',
        message = format('UNKNOWN_CANDIDATE_FIELD:%s', v_unknown_candidate_key);
    end if;

    v_candidate_payload := jsonb_build_object(
      'proposedDisplayCode', v_candidate -> 'proposedDisplayCode',
      'description', v_candidate -> 'description',
      'ean', v_candidate -> 'ean',
      'hsCode', v_candidate -> 'hsCode',
      'origin', case
        when nullif(trim(v_candidate ->> 'origin'), '') is null then null
        else to_jsonb(upper(trim(v_candidate ->> 'origin')))
      end,
      'weightKg', v_candidate -> 'weightKg',
      'oemReferences', coalesce(v_candidate -> 'oemReferences', '[]'::jsonb),
      'vehicleApplications', coalesce(v_candidate -> 'vehicleApplications', '[]'::jsonb),
      'fitmentFacts', coalesce(v_candidate -> 'fitmentFacts', '[]'::jsonb),
      'engineFacts', coalesce(v_candidate -> 'engineFacts', '[]'::jsonb),
      'lifecycleStatus', to_jsonb(coalesce(nullif(v_candidate ->> 'lifecycleStatus', ''), 'unknown')),
      'lifecycleNote', v_candidate -> 'lifecycleNote',
      'replacementCandidates', coalesce(v_candidate -> 'replacementCandidates', '[]'::jsonb),
      'supersessionCandidates', coalesce(v_candidate -> 'supersessionCandidates', '[]'::jsonb),
      'officialImageCandidateUrl', v_candidate -> 'officialImageCandidateUrl',
      'officialImageEvidenceReference', v_candidate -> 'officialImageEvidenceReference',
      'limitationFlags', coalesce(v_candidate -> 'limitationFlags', '[]'::jsonb),
      'sourceSchemaVersion', v_candidate -> 'sourceSchemaVersion',
      'quarantineClass', v_candidate -> 'quarantineClass'
    );

    v_quarantine_class := nullif(trim(v_candidate ->> 'quarantineClass'), '');
    v_official_image_url := nullif(trim(v_candidate ->> 'officialImageCandidateUrl'), '');
    v_source_schema_version := nullif(trim(v_candidate ->> 'sourceSchemaVersion'), '');

    if v_outcome_class not in (
      'NEW_PRODUCT_STAGED',
      'STAGING_REPLAYED',
      'QUARANTINED_IDENTITY'
    )
       or nullif(trim(v_official_display_code), '') is null
       or nullif(trim(v_official_comparison_key), '') is null
       or nullif(trim(v_official_source_reference), '') is null
       or v_official_source_url is null
       or v_observed_at is null
       or v_evidence_hash !~ '^[0-9a-f]{64}$'
       or v_source_schema_version is null
       or public.normalize_catalog_product_code(
            v_candidate ->> 'proposedDisplayCode'
          ) <> public.normalize_catalog_product_code(v_official_display_code)
       or jsonb_typeof(coalesce(v_candidate -> 'oemReferences', '[]'::jsonb)) <> 'array'
       or jsonb_typeof(coalesce(v_candidate -> 'vehicleApplications', '[]'::jsonb)) <> 'array'
       or jsonb_typeof(coalesce(v_candidate -> 'fitmentFacts', '[]'::jsonb)) <> 'array'
       or jsonb_typeof(coalesce(v_candidate -> 'engineFacts', '[]'::jsonb)) <> 'array'
       or jsonb_typeof(coalesce(v_candidate -> 'replacementCandidates', '[]'::jsonb)) <> 'array'
       or jsonb_typeof(coalesce(v_candidate -> 'supersessionCandidates', '[]'::jsonb)) <> 'array'
       or jsonb_typeof(coalesce(v_candidate -> 'limitationFlags', '[]'::jsonb)) <> 'array'
       or not public.catalog_zf_url_is_public_evidence(v_official_image_url) then
      raise exception using errcode = '22023', message = 'INVALID_STAGING_CANDIDATE';
    end if;

    if v_outcome_class in ('NEW_PRODUCT_STAGED', 'STAGING_REPLAYED')
       and v_quarantine_class is not null then
      raise exception using errcode = '22023', message = 'QUARANTINED_CANDIDATE_CANNOT_BE_ELIGIBLE';
    end if;

    if v_outcome_class = 'QUARANTINED_IDENTITY'
       and v_quarantine_class is null then
      raise exception using errcode = '22023', message = 'QUARANTINE_CLASS_REQUIRED';
    end if;

    v_payload_fingerprint := public.catalog_zf_candidate_payload_fingerprint(
      v_run.organization_id,
      v_run.source_id,
      v_run.brand_id,
      v_official_display_code,
      v_official_comparison_key,
      v_candidate_payload,
      v_run.contract_version
    );

    if v_payload_fingerprint <> input_item ->> 'payloadFingerprint' then
      raise exception using errcode = '22023', message = 'PAYLOAD_FINGERPRINT_MISMATCH';
    end if;

    v_observation_fingerprint := public.catalog_zf_observation_fingerprint(
      v_payload_fingerprint,
      v_run.source_revision,
      v_observed_at,
      v_evidence_hash,
      v_official_source_reference
    );

    if v_observation_fingerprint <> input_item ->> 'observationFingerprint' then
      raise exception using errcode = '22023', message = 'OBSERVATION_FINGERPRINT_MISMATCH';
    end if;

    if exists (
      select 1
      from public.catalog_products product
      where product.organization_id = v_run.organization_id
        and product.brand_id = v_run.brand_id
        and public.normalize_catalog_product_code(product.product_code)
          = public.normalize_catalog_product_code(v_candidate ->> 'proposedDisplayCode')
    ) then
      raise exception using errcode = '23505', message = 'CATALOG_PRODUCT_ALREADY_EXISTS';
    end if;

    perform pg_advisory_xact_lock(
      hashtextextended(
        concat_ws(
          ':',
          v_run.organization_id::text,
          v_run.source_id::text,
          v_run.brand_id::text,
          public.normalize_catalog_product_code(v_candidate ->> 'proposedDisplayCode'),
          v_run.contract_version
        ),
        0
      )
    );

    select candidate.id
    into v_candidate_id
    from public.catalog_new_product_staging_candidates candidate
    where candidate.organization_id = v_run.organization_id
      and candidate.source_id = v_run.source_id
      and candidate.brand_id = v_run.brand_id
      and candidate.normalized_code = public.normalize_catalog_product_code(
        v_candidate ->> 'proposedDisplayCode'
      )
      and candidate.payload_fingerprint = v_payload_fingerprint
      and candidate.contract_version = v_run.contract_version;

    if v_candidate_id is not null then
      v_candidate_replayed := true;
      v_actual_outcome_class := 'STAGING_REPLAYED';
    else
      select candidate.id, candidate.candidate_version
      into v_prior_candidate_id, v_candidate_version
      from public.catalog_new_product_staging_candidates candidate
      where candidate.organization_id = v_run.organization_id
        and candidate.source_id = v_run.source_id
        and candidate.brand_id = v_run.brand_id
        and candidate.normalized_code = public.normalize_catalog_product_code(
          v_candidate ->> 'proposedDisplayCode'
        )
        and candidate.contract_version = v_run.contract_version
      order by candidate.candidate_version desc
      limit 1;

      v_candidate_version := coalesce(v_candidate_version, 0) + 1;

      insert into public.catalog_new_product_staging_candidates (
        organization_id,
        source_id,
        brand_id,
        job_id,
        run_id,
        sequence_no,
        contract_version,
        candidate_version,
        proposed_display_code,
        normalized_code,
        official_source_display_code,
        official_comparison_key,
        official_source_reference,
        description,
        ean,
        hs_code,
        origin,
        weight_kg,
        oem_references,
        vehicle_applications,
        fitment_facts,
        engine_facts,
        lifecycle_status,
        lifecycle_note,
        replacement_candidates,
        supersession_candidates,
        official_image_candidate_url,
        official_image_evidence_reference,
        official_source_url,
        observed_at,
        evidence_hash,
        payload_fingerprint,
        observation_fingerprint,
        supersedes_candidate_id,
        quarantine_class,
        limitation_flags,
        source_schema_version,
        runtime_commit,
        deploy_id,
        redaction_profile_version
      ) values (
        v_run.organization_id,
        v_run.source_id,
        v_run.brand_id,
        v_run.job_id,
        v_run.id,
        input_sequence_no,
        v_run.contract_version,
        v_candidate_version,
        public.normalize_catalog_product_code(v_candidate ->> 'proposedDisplayCode'),
        public.normalize_catalog_product_code(v_candidate ->> 'proposedDisplayCode'),
        v_official_display_code,
        v_official_comparison_key,
        v_official_source_reference,
        nullif(v_candidate ->> 'description', ''),
        nullif(v_candidate ->> 'ean', ''),
        nullif(v_candidate ->> 'hsCode', ''),
        case
          when nullif(trim(v_candidate ->> 'origin'), '') is null then null
          else upper(trim(v_candidate ->> 'origin'))
        end,
        nullif(v_candidate ->> 'weightKg', '')::numeric,
        coalesce(v_candidate -> 'oemReferences', '[]'::jsonb),
        coalesce(v_candidate -> 'vehicleApplications', '[]'::jsonb),
        coalesce(v_candidate -> 'fitmentFacts', '[]'::jsonb),
        coalesce(v_candidate -> 'engineFacts', '[]'::jsonb),
        coalesce(nullif(v_candidate ->> 'lifecycleStatus', ''), 'unknown'),
        nullif(v_candidate ->> 'lifecycleNote', ''),
        coalesce(v_candidate -> 'replacementCandidates', '[]'::jsonb),
        coalesce(v_candidate -> 'supersessionCandidates', '[]'::jsonb),
        v_official_image_url,
        nullif(v_candidate ->> 'officialImageEvidenceReference', ''),
        v_official_source_url,
        v_observed_at,
        v_evidence_hash,
        v_payload_fingerprint,
        v_observation_fingerprint,
        v_prior_candidate_id,
        v_quarantine_class,
        array(
          select jsonb_array_elements_text(
            coalesce(v_candidate -> 'limitationFlags', '[]'::jsonb)
          )
        ),
        v_source_schema_version,
        v_run.runtime_commit,
        v_run.deploy_id,
        v_run.redaction_profile_version
      )
      returning id into v_candidate_id;

      if v_prior_candidate_id is not null then
        select coalesce(max(event.event_version), 0) + 1
        into v_event_version
        from public.catalog_new_product_staging_events event
        where event.organization_id = v_run.organization_id
          and event.candidate_id = v_prior_candidate_id;

        insert into public.catalog_new_product_staging_events (
          organization_id,
          candidate_id,
          event_version,
          expected_prior_version,
          event_type,
          reason_code,
          idempotency_key,
          event_fingerprint
        ) values (
          v_run.organization_id,
          v_prior_candidate_id,
          v_event_version,
          v_event_version - 1,
          'SUPERSEDED',
          'NEW_OFFICIAL_PAYLOAD_VERSION',
          concat('superseded:', v_prior_candidate_id::text, ':', v_candidate_id::text),
          public.catalog_zf_jsonb_sha256(
            jsonb_build_object(
              'candidateId', v_prior_candidate_id,
              'supersededByCandidateId', v_candidate_id,
              'eventVersion', v_event_version
            )
          )
        );
      end if;

      insert into public.catalog_new_product_staging_events (
        organization_id,
        candidate_id,
        event_version,
        expected_prior_version,
        event_type,
        reason_code,
        idempotency_key,
        event_fingerprint
      ) values (
        v_run.organization_id,
        v_candidate_id,
        1,
        0,
        case when v_quarantine_class is null then 'STAGED' else 'QUARANTINED' end,
        coalesce(v_quarantine_class, 'OFFICIAL_PRODUCT_ABSENT_FROM_CATALOG'),
        concat('initial:', v_candidate_id::text),
        public.catalog_zf_jsonb_sha256(
          jsonb_build_object(
            'candidateId', v_candidate_id,
            'eventVersion', 1,
            'eventType', case
              when v_quarantine_class is null then 'STAGED'
              else 'QUARANTINED'
            end,
            'payloadFingerprint', v_payload_fingerprint
          )
        )
      )
      returning id into v_staging_event_id;
    end if;
  elsif v_outcome_class in ('NEW_PRODUCT_STAGED', 'STAGING_REPLAYED') then
    raise exception using errcode = '22023', message = 'STAGING_CANDIDATE_REQUIRED';
  end if;

  insert into public.catalog_observation_item_outcomes (
    organization_id,
    run_id,
    job_id,
    source_id,
    brand_id,
    sequence_no,
    requested_display_code,
    requested_normalized_code,
    official_source_display_code,
    official_comparison_key,
    official_source_reference,
    catalog_product_id,
    staging_candidate_id,
    source_alias_id,
    outcome_class,
    retryable,
    attempt_count,
    observed_at,
    evidence_hash,
    observation_fingerprint,
    payload_fingerprint,
    contract_version,
    runtime_commit,
    deploy_id,
    redaction_profile_version,
    error_code,
    error_summary,
    checkpoint_eligible,
    checkpoint_cursor,
    started_at,
    completed_at
  ) values (
    v_run.organization_id,
    v_run.id,
    v_run.job_id,
    v_run.source_id,
    v_run.brand_id,
    input_sequence_no,
    v_requested_display_code,
    v_requested_normalized_code,
    nullif(trim(v_official_display_code), ''),
    nullif(trim(v_official_comparison_key), ''),
    nullif(trim(v_official_source_reference), ''),
    v_catalog_product_id,
    v_candidate_id,
    v_source_alias_id,
    v_actual_outcome_class,
    v_retryable,
    v_attempt_count,
    v_observed_at,
    nullif(trim(v_evidence_hash), ''),
    v_observation_fingerprint,
    v_payload_fingerprint,
    v_run.contract_version,
    v_run.runtime_commit,
    v_run.deploy_id,
    v_run.redaction_profile_version,
    v_error_code,
    v_error_summary,
    v_checkpoint_eligible,
    nullif(trim(v_checkpoint_cursor), ''),
    v_started_at,
    v_completed_at
  )
  returning id into v_item_outcome_id;

  insert into public.catalog_observation_audit_ledger (
    organization_id,
    job_id,
    run_id,
    item_outcome_id,
    staging_candidate_id,
    staging_event_id,
    source_alias_id,
    action,
    next_status,
    message,
    evidence_reference,
    payload
  ) values (
    v_run.organization_id,
    v_run.job_id,
    v_run.id,
    v_item_outcome_id,
    v_candidate_id,
    v_staging_event_id,
    v_source_alias_id,
    'zf_item_terminal_outcome',
    v_actual_outcome_class,
    coalesce(v_error_summary, 'ZF item terminal outcome committed'),
    v_official_source_reference,
    jsonb_build_object(
      'sequenceNo', input_sequence_no,
      'payloadFingerprint', v_payload_fingerprint,
      'observationFingerprint', v_observation_fingerprint,
      'attemptCount', v_attempt_count,
      'checkpointEligible', v_checkpoint_eligible
    )
  );

  select coalesce(
    (
      select min(g.sequence_no) - 1
      from generate_series(1, max_sequence.max_sequence) g(sequence_no)
      left join public.catalog_observation_item_outcomes outcome
        on outcome.organization_id = v_run.organization_id
       and outcome.run_id = v_run.id
       and outcome.sequence_no = g.sequence_no
      where outcome.id is null
         or not outcome.checkpoint_eligible
    ),
    max_sequence.max_sequence
  )
  into v_safe_sequence
  from (
    select coalesce(max(outcome.sequence_no), 0) as max_sequence
    from public.catalog_observation_item_outcomes outcome
    where outcome.organization_id = v_run.organization_id
      and outcome.run_id = v_run.id
  ) max_sequence;

  if coalesce(v_safe_sequence, 0) > 0 then
    select outcome.checkpoint_cursor
    into v_safe_cursor
    from public.catalog_observation_item_outcomes outcome
    where outcome.organization_id = v_run.organization_id
      and outcome.run_id = v_run.id
      and outcome.sequence_no = v_safe_sequence;
  end if;

  update public.catalog_observation_runs
  set safe_checkpoint_cursor = v_safe_cursor,
      observed_count = (
        select count(*)::integer
        from public.catalog_observation_item_outcomes outcome
        where outcome.organization_id = v_run.organization_id
          and outcome.run_id = v_run.id
      ),
      candidate_count = (
        select count(*)::integer
        from public.catalog_new_product_staging_candidates candidate
        where candidate.organization_id = v_run.organization_id
          and candidate.run_id = v_run.id
      ),
      deduped_count = (
        select count(*)::integer
        from public.catalog_observation_item_outcomes outcome
        where outcome.organization_id = v_run.organization_id
          and outcome.run_id = v_run.id
          and outcome.outcome_class = 'STAGING_REPLAYED'
      ),
      updated_at = now()
  where id = v_run.id;

  return jsonb_build_object(
    'success', true,
    'replayed', false,
    'item_outcome_id', v_item_outcome_id,
    'outcome', v_actual_outcome_class,
    'staging_candidate_id', v_candidate_id,
    'staging_replayed', v_candidate_replayed,
    'source_alias_id', v_source_alias_id,
    'safe_checkpoint_cursor', v_safe_cursor
  );
end;
$$;

revoke all on function public.record_catalog_zf_durable_item(uuid, integer, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.record_catalog_zf_durable_item(uuid, integer, jsonb)
  to service_role;

create or replace function public.finish_catalog_zf_durable_run(
  input_run_id uuid,
  input_status text,
  input_error_summary text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_run public.catalog_observation_runs%rowtype;
  v_status text := lower(trim(input_status));
  v_completion_class text;
  v_outcome_count integer;
  v_max_sequence integer;
  v_blocked_checkpoint_count integer;
  v_finished_at timestamptz := now();
begin
  perform public.require_catalog_observation_service_role();

  if v_status not in (
    'succeeded',
    'completed_with_warnings',
    'failed',
    'cancelled',
    'dead_letter'
  ) then
    raise exception using errcode = '22023', message = 'UNSUPPORTED_ZF_RUN_STATUS';
  end if;

  if not public.catalog_zf_text_is_redaction_safe(input_error_summary) then
    raise exception using errcode = '22023', message = 'REDACTION_UNSAFE_RUN_ERROR';
  end if;

  select *
  into v_run
  from public.catalog_observation_runs run
  where run.id = input_run_id
    and run.provider_key = 'zf_aftermarket'
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'ZF_DURABLE_RUN_NOT_FOUND';
  end if;

  if v_run.status <> 'running' then
    if v_run.status = v_status then
      return jsonb_build_object(
        'success', true,
        'replayed', true,
        'run_id', v_run.id,
        'status', v_run.status,
        'completion_class', v_run.completion_class,
        'safe_checkpoint_cursor', v_run.safe_checkpoint_cursor
      );
    end if;

    raise exception using errcode = '55000', message = 'ZF_RUN_ALREADY_TERMINAL';
  end if;

  select count(*)::integer,
         coalesce(max(outcome.sequence_no), 0)::integer,
         count(*) filter (where not outcome.checkpoint_eligible)::integer
  into v_outcome_count, v_max_sequence, v_blocked_checkpoint_count
  from public.catalog_observation_item_outcomes outcome
  where outcome.organization_id = v_run.organization_id
    and outcome.run_id = v_run.id;

  if v_status in ('succeeded', 'completed_with_warnings')
     and (
       v_outcome_count = 0
       or v_outcome_count <> v_max_sequence
       or v_blocked_checkpoint_count > 0
     ) then
    raise exception using errcode = '55000', message = 'ZF_RUN_OUTCOMES_NOT_RECONCILED';
  end if;

  v_completion_class := upper(v_status);

  update public.catalog_observation_runs
  set status = v_status,
      completion_class = v_completion_class,
      finished_at = v_finished_at,
      duration_ms = greatest(
        0,
        floor(extract(epoch from (v_finished_at - started_at)) * 1000)::integer
      ),
      error_message = case
        when v_status in ('failed', 'dead_letter') then left(input_error_summary, 500)
        else null
      end,
      updated_at = now()
  where id = v_run.id;

  insert into public.catalog_observation_audit_ledger (
    organization_id,
    job_id,
    run_id,
    action,
    prior_status,
    next_status,
    message,
    payload
  ) values (
    v_run.organization_id,
    v_run.job_id,
    v_run.id,
    'zf_durable_run_finished',
    'RUNNING',
    v_completion_class,
    coalesce(input_error_summary, 'ZF durable run reconciled'),
    jsonb_build_object(
      'outcomeCount', v_outcome_count,
      'maxSequence', v_max_sequence,
      'safeCheckpointCursor', v_run.safe_checkpoint_cursor
    )
  );

  return jsonb_build_object(
    'success', true,
    'replayed', false,
    'run_id', v_run.id,
    'status', v_status,
    'completion_class', v_completion_class,
    'outcome_count', v_outcome_count,
    'safe_checkpoint_cursor', (
      select run.safe_checkpoint_cursor
      from public.catalog_observation_runs run
      where run.id = v_run.id
    )
  );
end;
$$;

revoke all on function public.finish_catalog_zf_durable_run(uuid, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.finish_catalog_zf_durable_run(uuid, text, text)
  to service_role;

create or replace function public.advance_catalog_zf_durable_checkpoint(
  input_run_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_run public.catalog_observation_runs%rowtype;
begin
  perform public.require_catalog_observation_service_role();

  select *
  into v_run
  from public.catalog_observation_runs run
  where run.id = input_run_id
    and run.provider_key = 'zf_aftermarket'
    and run.status in ('succeeded', 'completed_with_warnings')
  for update;

  if not found then
    raise exception using
      errcode = '55000',
      message = 'ZF_CHECKPOINT_REQUIRES_RECONCILED_TERMINAL_RUN';
  end if;

  if nullif(trim(v_run.safe_checkpoint_cursor), '') is null then
    raise exception using errcode = '55000', message = 'ZF_SAFE_CHECKPOINT_ABSENT';
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
    v_run.safe_checkpoint_cursor,
    jsonb_build_object(
      'contractVersion', v_run.contract_version,
      'requestFingerprint', v_run.request_fingerprint
    ),
    (
      select max(outcome.observed_at)
      from public.catalog_observation_item_outcomes outcome
      where outcome.organization_id = v_run.organization_id
        and outcome.run_id = v_run.id
    ),
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

  insert into public.catalog_observation_audit_ledger (
    organization_id,
    job_id,
    run_id,
    action,
    next_status,
    message,
    payload
  ) values (
    v_run.organization_id,
    v_run.job_id,
    v_run.id,
    'zf_durable_checkpoint_advanced',
    'COMMITTED',
    'ZF durable checkpoint advanced from contiguous terminal outcomes',
    jsonb_build_object('safeCheckpointCursor', v_run.safe_checkpoint_cursor)
  );

  return jsonb_build_object(
    'success', true,
    'run_id', v_run.id,
    'job_id', v_run.job_id,
    'safe_checkpoint_cursor', v_run.safe_checkpoint_cursor
  );
end;
$$;

revoke all on function public.advance_catalog_zf_durable_checkpoint(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.advance_catalog_zf_durable_checkpoint(uuid)
  to service_role;

create or replace function public.append_catalog_zf_staging_event(
  input_candidate_id uuid,
  input_event_type text,
  input_expected_prior_version integer,
  input_idempotency_key text,
  input_reason_code text,
  input_actor_id uuid default null,
  input_reviewer_note text default null,
  input_source_review_decision_reference text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, extensions
as $$
declare
  v_candidate public.catalog_new_product_staging_candidates%rowtype;
  v_existing public.catalog_new_product_staging_events%rowtype;
  v_current_version integer;
  v_event_id uuid;
  v_event_fingerprint text;
begin
  perform public.require_catalog_observation_service_role();

  if input_event_type not in (
    'REVIEW_REQUESTED',
    'REJECTED',
    'DEFERRED',
    'CANCELLED'
  ) then
    raise exception using errcode = '22023', message = 'STAGING_EVENT_NOT_AUTHORIZED';
  end if;

  if nullif(trim(input_idempotency_key), '') is null
     or nullif(trim(input_reason_code), '') is null
     or not public.catalog_zf_text_is_redaction_safe(input_idempotency_key)
     or not public.catalog_zf_text_is_redaction_safe(input_reason_code)
     or not public.catalog_zf_text_is_redaction_safe(input_reviewer_note)
     or not public.catalog_zf_text_is_redaction_safe(
       input_source_review_decision_reference
     ) then
    raise exception using errcode = '22023', message = 'INVALID_STAGING_EVENT_ENVELOPE';
  end if;

  select *
  into v_candidate
  from public.catalog_new_product_staging_candidates candidate
  where candidate.id = input_candidate_id
  for update;

  if not found then
    raise exception using errcode = 'P0002', message = 'STAGING_CANDIDATE_NOT_FOUND';
  end if;

  select *
  into v_existing
  from public.catalog_new_product_staging_events event
  where event.organization_id = v_candidate.organization_id
    and event.candidate_id = v_candidate.id
    and event.idempotency_key = input_idempotency_key;

  v_event_fingerprint := public.catalog_zf_jsonb_sha256(
    jsonb_build_object(
      'candidateId', v_candidate.id,
      'eventType', input_event_type,
      'expectedPriorVersion', input_expected_prior_version,
      'reasonCode', input_reason_code,
      'actorId', input_actor_id,
      'reviewerNote', input_reviewer_note,
      'sourceReviewDecisionReference', input_source_review_decision_reference
    )
  );

  if found then
    if v_existing.event_fingerprint = v_event_fingerprint then
      return jsonb_build_object(
        'success', true,
        'replayed', true,
        'event_id', v_existing.id,
        'event_version', v_existing.event_version
      );
    end if;

    return jsonb_build_object(
      'success', false,
      'replayed', false,
      'error_code', 'STAGING_EVENT_IDEMPOTENCY_CONFLICT'
    );
  end if;

  select coalesce(max(event.event_version), 0)
  into v_current_version
  from public.catalog_new_product_staging_events event
  where event.organization_id = v_candidate.organization_id
    and event.candidate_id = v_candidate.id;

  if input_expected_prior_version <> v_current_version then
    return jsonb_build_object(
      'success', false,
      'replayed', false,
      'error_code', 'STAGING_EVENT_VERSION_CONFLICT',
      'current_version', v_current_version
    );
  end if;

  insert into public.catalog_new_product_staging_events (
    organization_id,
    candidate_id,
    event_version,
    expected_prior_version,
    event_type,
    actor_id,
    reason_code,
    reviewer_note,
    idempotency_key,
    event_fingerprint,
    source_review_decision_reference
  ) values (
    v_candidate.organization_id,
    v_candidate.id,
    v_current_version + 1,
    v_current_version,
    input_event_type,
    input_actor_id,
    input_reason_code,
    input_reviewer_note,
    input_idempotency_key,
    v_event_fingerprint,
    input_source_review_decision_reference
  )
  returning id into v_event_id;

  return jsonb_build_object(
    'success', true,
    'replayed', false,
    'event_id', v_event_id,
    'event_version', v_current_version + 1
  );
end;
$$;

revoke all on function public.append_catalog_zf_staging_event(
  uuid, text, integer, text, text, uuid, text, text
) from public, anon, authenticated, service_role;
grant execute on function public.append_catalog_zf_staging_event(
  uuid, text, integer, text, text, uuid, text, text
) to service_role;

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
  latest_event.created_at as latest_event_at
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
  to authenticated, service_role;

comment on table public.catalog_new_product_staging_candidates is
  'Immutable Catalog-owned whole-product staging versions; never canonical Products.';
comment on table public.catalog_observation_item_outcomes is
  'Append-only terminal ZF item outcomes for durable run reconciliation.';
comment on table public.catalog_product_source_aliases is
  'Immutable source-scoped official display aliases; never canonical Product-code rewrites.';
comment on table public.catalog_new_product_staging_events is
  'Append-only staging lifecycle events. Apply events are intentionally absent.';
comment on view public.catalog_zf_new_product_staging_review_v is
  'Tenant-scoped security-invoker review projection; no Product Apply authority.';
