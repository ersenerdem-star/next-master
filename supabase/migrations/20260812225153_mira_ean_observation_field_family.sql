-- NM-MIRA-OBSERVATION-INTAKE v1
--
-- A bounded, service-role-only handoff from MIRA into the existing Catalog
-- observation pipeline. This migration intentionally never writes to
-- catalog_products and never grants MIRA a canonical Product mutation path.

create table if not exists public.mira_catalog_observation_intake_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  idempotency_key text not null,
  request_fingerprint text not null,
  source_id uuid references public.catalog_external_sources(id) on delete restrict,
  job_id uuid references public.catalog_observation_jobs(id) on delete restrict,
  run_id uuid references public.catalog_observation_runs(id) on delete set null,
  status text not null default 'running'
    check (status in ('running', 'succeeded', 'completed_with_warnings', 'failed', 'blocked')),
  response jsonb not null default '{}'::jsonb,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, idempotency_key)
);

create index if not exists idx_mira_catalog_observation_intake_status
  on public.mira_catalog_observation_intake_requests (organization_id, status, updated_at desc);

alter table public.mira_catalog_observation_intake_requests enable row level security;
revoke all privileges on table public.mira_catalog_observation_intake_requests from public, anon, authenticated, service_role;

create or replace function public.configure_mira_observation_scope(
  input_organization_id uuid,
  input_source_id uuid,
  input_trust_profile_id uuid,
  input_job_id uuid,
  input_allowed_field_families text[] default array['image_reference', 'supplemental_description', 'oem_reference', 'technical_specification', 'ean_reference']::text[]
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_source public.catalog_external_sources%rowtype;
  v_trust public.catalog_external_source_trust_profiles%rowtype;
  v_job public.catalog_observation_jobs%rowtype;
  v_allowed text[];
begin
  perform public.require_catalog_observation_service_role();

  if input_organization_id is null or input_source_id is null
     or input_trust_profile_id is null or input_job_id is null then
    raise exception 'MIRA observation scope requires organization, source, trust profile, and job';
  end if;

  select * into v_source
  from public.catalog_external_sources
  where id = input_source_id and organization_id = input_organization_id and is_active = true;
  if not found then raise exception 'Active MIRA observation source not found for organization'; end if;

  if v_source.license_posture <> 'allowed'
     or v_source.robots_posture not in ('allowed', 'not_applicable')
     or v_source.rate_limit_posture not in ('bounded', 'restricted', 'not_applicable')
     or coalesce(nullif(lower(trim(v_source.credential_boundary)), ''), 'none') <> 'none'
     or coalesce((v_source.metadata ->> 'automated_read_only_approved')::boolean, false) is distinct from true
     or coalesce((v_source.metadata ->> 'internal_observation_allowed')::boolean, false) is distinct from true then
    raise exception 'MIRA automatic observation is blocked by source trust/licence/robots/rate/credential policy';
  end if;

  select * into v_trust
  from public.catalog_external_source_trust_profiles
  where id = input_trust_profile_id
    and organization_id = input_organization_id
    and source_id = input_source_id
    and is_active = true;
  if not found then raise exception 'Active MIRA trust profile not found for organization'; end if;

  select * into v_job
  from public.catalog_observation_jobs
  where id = input_job_id
    and organization_id = input_organization_id
    and source_id = input_source_id
    and trust_profile_id = input_trust_profile_id
    and status = 'active';
  if not found then raise exception 'Active MIRA observation job not found for organization'; end if;

  select array_agg(distinct field_family order by field_family)
  into v_allowed
  from unnest(coalesce(input_allowed_field_families, array[]::text[])) field_family
  where field_family in ('image_reference', 'supplemental_description', 'oem_reference', 'technical_specification', 'ean_reference');

  if coalesce(array_length(v_allowed, 1), 0) = 0
     or exists (
       select 1 from unnest(coalesce(input_allowed_field_families, array[]::text[])) field_family
       where field_family not in ('image_reference', 'supplemental_description', 'oem_reference', 'technical_specification', 'ean_reference')
     ) then
    raise exception 'MIRA observation scope contains an unsupported field family';
  end if;

  update public.catalog_external_source_trust_profiles
  set allowed_field_families = v_allowed,
      human_review_required = true,
      downstream_publication_restriction = 'internal_only',
      evidence_required = true,
      updated_at = now()
  where id = v_trust.id;

  update public.catalog_observation_jobs
  set allowed_field_families = v_allowed,
      sync_mode = 'observation_only',
      metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('mira_intake_protocol', 'v1'),
      updated_at = now()
  where id = v_job.id;

  return jsonb_build_object('source_id', v_source.id, 'trust_profile_id', v_trust.id, 'job_id', v_job.id, 'allowed_field_families', v_allowed, 'mode', 'observation_only');
end;
$$;

revoke all on function public.configure_mira_observation_scope(uuid, uuid, uuid, uuid, text[]) from public, anon, authenticated, service_role;
grant execute on function public.configure_mira_observation_scope(uuid, uuid, uuid, uuid, text[]) to service_role;

create or replace function public.mira_jsonb_contains_restricted_key(input_value jsonb)
returns boolean
language plpgsql
immutable
parallel safe
set search_path = public
as $$
declare
  v_pair record;
begin
  if input_value is null then
    return false;
  end if;
  if jsonb_typeof(input_value) = 'object' then
    for v_pair in select key, value from jsonb_each(input_value) loop
      if lower(v_pair.key) in ('authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'password', 'token', 'access_token', 'id_token', 'refresh_token', 'secret', 'client_secret', 'private_key', 'api_key', 'credential') then
        return true;
      end if;
      if public.mira_jsonb_contains_restricted_key(v_pair.value) then
        return true;
      end if;
    end loop;
  elsif jsonb_typeof(input_value) = 'array' then
    for v_pair in select value from jsonb_array_elements(input_value) loop
      if public.mira_jsonb_contains_restricted_key(v_pair.value) then
        return true;
      end if;
    end loop;
  end if;
  return false;
end;
$$;

revoke all on function public.mira_jsonb_contains_restricted_key(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.mira_jsonb_contains_restricted_key(jsonb) to service_role;

-- Replace the append RPC with the same guarded implementation plus the
-- versioned ean_reference family. No Product columns are touched here.
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
begin
  perform public.require_catalog_observation_service_role();

  if input_field_family not in ('image_reference', 'supplemental_description', 'oem_reference', 'technical_specification', 'ean_reference') then
    raise exception 'Catalog observation scope does not support field family %', input_field_family;
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
  select * into v_run from public.catalog_observation_runs where id = input_run_id and status = 'running' for update;
  if not found then raise exception 'Running catalog observation run not found'; end if;
  select * into v_job from public.catalog_observation_jobs where id = v_run.job_id and status = 'active';
  if not found then raise exception 'Active catalog observation job not found'; end if;
  select * into v_source from public.catalog_external_sources where id = v_run.source_id and organization_id = v_run.organization_id and is_active = true;
  if not found then raise exception 'Active external source not found'; end if;
  select * into v_trust from public.catalog_external_source_trust_profiles where id = v_job.trust_profile_id and organization_id = v_run.organization_id and source_id = v_run.source_id and is_active = true;
  if not found then raise exception 'Active trust profile not found'; end if;
  if not (input_field_family = any(v_job.allowed_field_families)) or not (input_field_family = any(v_trust.allowed_field_families)) then
    raise exception 'Field family % is not allowed for this observation scope', input_field_family;
  end if;

  select cp.id into v_catalog_product_id
  from public.catalog_products cp
  where cp.organization_id = v_run.organization_id and cp.brand_id = v_run.brand_id and cp.normalized_code = trim(input_normalized_code)
  order by cp.product_code, cp.id limit 1;

  if v_catalog_product_id is null then
    raise exception 'Catalog product identity is not available for normalized code %', trim(input_normalized_code);
  end if;

  v_deduplication_key := md5(concat_ws('|', v_run.organization_id::text, v_run.source_id::text, v_run.brand_id::text, v_job.id::text, coalesce(v_run.source_revision, ''), trim(input_normalized_code), trim(input_field_family), trim(input_field_name), input_normalized_value, coalesce(input_evidence_hash, ''), input_evidence_reference, coalesce(input_external_product_ref, '')));
  select id into v_existing_observation_id from public.catalog_external_observations where organization_id = v_run.organization_id and deduplication_key = v_deduplication_key;
  if v_existing_observation_id is not null then
    update public.catalog_observation_runs set deduped_count = deduped_count + 1, updated_at = now() where id = v_run.id;
    perform public.append_catalog_observation_audit_event(v_run.organization_id, v_run.job_id, v_run.id, v_existing_observation_id, null, null, null, input_collector_actor_id, 'observation_deduped', null, 'queued', null, input_evidence_reference, least(greatest(coalesce(input_confidence, 0.5), 0), 1), jsonb_build_object('field_family', input_field_family, 'field_name', input_field_name));
    return v_existing_observation_id;
  end if;

  select count(*)::integer into v_run_observation_count from public.catalog_external_observations where organization_id = v_run.organization_id and run_id = v_run.id;
  if v_run_observation_count >= v_job.max_observations_per_run then raise exception 'Catalog observation run limit reached: %', v_job.max_observations_per_run; end if;

  insert into public.catalog_external_observations (organization_id, source_id, trust_profile_id, job_id, run_id, brand_id, catalog_product_id, product_code, normalized_code, external_product_ref, field_family, field_name, raw_value, normalized_value, evidence_url, evidence_reference, evidence_hash, evidence_payload, source_revision, confidence, freshness_status, license_posture, observed_at, collector_actor_id, deduplication_key)
  values (v_run.organization_id, v_run.source_id, v_job.trust_profile_id, v_job.id, v_run.id, v_run.brand_id, v_catalog_product_id, trim(input_product_code), trim(input_normalized_code), nullif(trim(input_external_product_ref), ''), trim(input_field_family), trim(input_field_name), input_raw_value, input_normalized_value, nullif(trim(input_evidence_url), ''), trim(input_evidence_reference), nullif(trim(input_evidence_hash), ''), coalesce(input_evidence_payload, '{}'::jsonb), v_run.source_revision, least(greatest(coalesce(input_confidence, 0.5), 0), 1), 'unknown', v_source.license_posture, coalesce(input_observed_at, now()), input_collector_actor_id, v_deduplication_key)
  returning id into v_observation_id;

  update public.catalog_observation_runs set observed_count = observed_count + 1, updated_at = now() where id = v_run.id;
  insert into public.catalog_observation_scope_health (organization_id, job_id, source_id, brand_id, queued_count, latest_run_id, latest_run_status, updated_at)
  values (v_run.organization_id, v_run.job_id, v_run.source_id, v_run.brand_id, 1, v_run.id, 'running', now())
  on conflict (organization_id, job_id) do update set queued_count = public.catalog_observation_scope_health.queued_count + 1, latest_run_id = excluded.latest_run_id, latest_run_status = excluded.latest_run_status, updated_at = now();
  perform public.append_catalog_observation_audit_event(v_run.organization_id, v_run.job_id, v_run.id, v_observation_id, null, null, null, input_collector_actor_id, 'observation_appended', null, 'queued', null, input_evidence_reference, least(greatest(coalesce(input_confidence, 0.5), 0), 1), jsonb_build_object('field_family', input_field_family, 'field_name', input_field_name));
  return v_observation_id;
end;
$$;

revoke all on function public.append_catalog_external_observation(uuid, text, text, text, text, text, text, text, text, text, jsonb, text, numeric, timestamptz, uuid) from public, anon, authenticated, service_role;
grant execute on function public.append_catalog_external_observation(uuid, text, text, text, text, text, text, text, text, text, jsonb, text, numeric, timestamptz, uuid) to service_role;

create or replace function public.ingest_mira_catalog_observation_batch(
  input_organization_id uuid,
  input_source_id uuid,
  input_trust_profile_id uuid,
  input_job_id uuid,
  input_brand_id uuid,
  input_idempotency_key text,
  input_request_fingerprint text,
  input_observations jsonb,
  input_actor_id uuid default null,
  input_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing public.mira_catalog_observation_intake_requests%rowtype;
  v_source public.catalog_external_sources%rowtype;
  v_trust public.catalog_external_source_trust_profiles%rowtype;
  v_job public.catalog_observation_jobs%rowtype;
  v_brand public.brands%rowtype;
  v_run_id uuid;
  v_item jsonb;
  v_count integer := 0;
  v_appended integer := 0;
  v_deduped integer := 0;
  v_observed integer := 0;
  v_status text := 'succeeded';
  v_error text;
  v_response jsonb;
begin
  perform public.require_catalog_observation_service_role();
  if input_organization_id is null or input_source_id is null or input_trust_profile_id is null or input_job_id is null or input_brand_id is null then raise exception 'MIRA intake scope identifiers are required'; end if;
  if nullif(trim(input_idempotency_key), '') is null or length(trim(input_idempotency_key)) > 200 then raise exception 'MIRA intake idempotency key is invalid'; end if;
  if nullif(trim(input_request_fingerprint), '') is null or length(trim(input_request_fingerprint)) > 256 then raise exception 'MIRA intake request fingerprint is invalid'; end if;
  if jsonb_typeof(input_observations) <> 'array' or jsonb_array_length(input_observations) = 0 or jsonb_array_length(input_observations) > 100 then raise exception 'MIRA intake observations must contain between 1 and 100 items'; end if;

  -- Serialize the idempotency check so two workers cannot open two runs for
  -- the same tenant/key concurrently.
  perform pg_advisory_xact_lock(hashtextextended(input_organization_id::text || '|' || trim(input_idempotency_key), 0));

  select * into v_existing from public.mira_catalog_observation_intake_requests where organization_id = input_organization_id and idempotency_key = trim(input_idempotency_key) for update;
  if found then
    if v_existing.request_fingerprint <> trim(input_request_fingerprint) then raise exception 'MIRA idempotency key was reused with a different request'; end if;
    if v_existing.status = 'running' then raise exception 'MIRA intake request is already running'; end if;
    return coalesce(v_existing.response, '{}'::jsonb)
      || jsonb_build_object('status', v_existing.status, 'idempotent', true);
  end if;

  select * into v_source from public.catalog_external_sources where id = input_source_id and organization_id = input_organization_id and is_active = true;
  if not found then raise exception 'MIRA source is not active in the supplied organization'; end if;
  if v_source.license_posture <> 'allowed' or v_source.robots_posture not in ('allowed', 'not_applicable') or v_source.rate_limit_posture not in ('bounded', 'restricted', 'not_applicable') or coalesce(nullif(lower(trim(v_source.credential_boundary)), ''), 'none') <> 'none' or coalesce((v_source.metadata ->> 'automated_read_only_approved')::boolean, false) is distinct from true or coalesce((v_source.metadata ->> 'internal_observation_allowed')::boolean, false) is distinct from true then raise exception 'MIRA source is not approved for automatic read-only observation'; end if;
  select * into v_trust from public.catalog_external_source_trust_profiles where id = input_trust_profile_id and organization_id = input_organization_id and source_id = input_source_id and is_active = true;
  if not found then raise exception 'MIRA trust profile is not active for the supplied source'; end if;
  select * into v_job from public.catalog_observation_jobs where id = input_job_id and organization_id = input_organization_id and source_id = input_source_id and trust_profile_id = input_trust_profile_id and brand_id = input_brand_id and status = 'active';
  if not found then raise exception 'MIRA observation job is not active for the supplied scope'; end if;
  select * into v_brand from public.brands where id = input_brand_id and organization_id = input_organization_id;
  if not found then raise exception 'MIRA brand is not in the supplied organization'; end if;

  insert into public.mira_catalog_observation_intake_requests (organization_id, idempotency_key, request_fingerprint, source_id, job_id, status, response)
  values (input_organization_id, trim(input_idempotency_key), trim(input_request_fingerprint), input_source_id, input_job_id, 'running', jsonb_build_object('status', 'running'));

  -- Validate every item before opening a run; this prevents partial batches.
  for v_item in select value from jsonb_array_elements(input_observations) loop
    v_count := v_count + 1;
    if jsonb_typeof(v_item) <> 'object' or nullif(trim(v_item->>'product_code'), '') is null or nullif(trim(v_item->>'normalized_code'), '') is null or nullif(trim(v_item->>'field_family'), '') is null or nullif(trim(v_item->>'field_name'), '') is null or nullif(trim(v_item->>'raw_value'), '') is null or nullif(trim(v_item->>'normalized_value'), '') is null or nullif(trim(v_item->>'evidence_reference'), '') is null then raise exception 'MIRA observation % is missing required identity, value, or evidence', v_count; end if;
    if not (v_item->>'field_family' = any(v_job.allowed_field_families))
       or not (v_item->>'field_family' = any(v_trust.allowed_field_families)) then
      raise exception 'MIRA observation % field family is outside the approved scope', v_count;
    end if;
    if v_item ? 'confidence' and (v_item->>'confidence') !~ '^[0-9]+(\\.[0-9]+)?$' then
      raise exception 'MIRA observation % confidence must be numeric', v_count;
    end if;
    if v_item ? 'confidence' and ((v_item->>'confidence')::numeric < 0 or (v_item->>'confidence')::numeric > 1) then
      raise exception 'MIRA observation % confidence must be between 0 and 1', v_count;
    end if;
    if nullif(trim(v_item->>'evidence_url'), '') is not null
       and (v_item->>'evidence_url') !~* '^https://[^[:space:]]+$' then
      raise exception 'MIRA observation % evidence URL must use HTTPS', v_count;
    end if;
    if jsonb_typeof(coalesce(v_item->'evidence_payload', '{}'::jsonb)) not in ('object', 'array')
       or octet_length(coalesce(v_item->'evidence_payload', '{}'::jsonb)::text) > 16384 then
      raise exception 'MIRA observation % evidence payload is invalid or too large', v_count;
    end if;
    if public.mira_jsonb_contains_restricted_key(coalesce(v_item->'evidence_payload', '{}'::jsonb)) then
      raise exception 'MIRA observation % evidence payload contains a restricted key', v_count;
    end if;
    if length(coalesce(v_item->>'raw_value', '')) > 12000
       or length(coalesce(v_item->>'normalized_value', '')) > 12000
       or length(coalesce(v_item->>'evidence_reference', '')) > 2000 then
      raise exception 'MIRA observation % exceeds the bounded value/evidence size', v_count;
    end if;
    if v_item->>'field_family' = 'ean_reference'
       and (v_item->>'normalized_value') !~ '^([0-9]{8}|[0-9]{12,14})$' then
      raise exception 'MIRA observation % EAN/GTIN value must contain 8, 12, 13, or 14 digits', v_count;
    end if;
    if not exists (select 1 from public.catalog_products cp where cp.organization_id = input_organization_id and cp.brand_id = input_brand_id and cp.normalized_code = trim(v_item->>'normalized_code')) then raise exception 'MIRA observation % product identity is not in the organization catalog', v_count; end if;
  end loop;

  v_run_id := public.begin_catalog_observation_run(input_job_id, input_actor_id, coalesce(input_metadata, '{}'::jsonb) || jsonb_build_object('mira_intake', true, 'idempotency_key', trim(input_idempotency_key), 'request_fingerprint', trim(input_request_fingerprint)));
  begin
    for v_item in select value from jsonb_array_elements(input_observations) loop
      perform public.append_catalog_external_observation(v_run_id, trim(v_item->>'product_code'), trim(v_item->>'normalized_code'), trim(v_item->>'field_family'), trim(v_item->>'field_name'), trim(v_item->>'raw_value'), trim(v_item->>'normalized_value'), trim(v_item->>'evidence_reference'), nullif(trim(v_item->>'evidence_url'), ''), nullif(trim(v_item->>'evidence_hash'), ''), coalesce(v_item->'evidence_payload', '{}'::jsonb), nullif(trim(v_item->>'external_product_ref'), ''), coalesce((v_item->>'confidence')::numeric, 0.5), coalesce((v_item->>'observed_at')::timestamptz, now()), input_actor_id);
      v_appended := v_appended + 1;
    end loop;
  exception when others then
    v_error := left(sqlerrm, 1000);
    v_status := 'failed';
  end;

  if v_status = 'failed' then
    perform public.finish_catalog_observation_run(v_run_id, 'failed', v_error);
  else
    perform public.finish_catalog_observation_run(v_run_id, 'succeeded', null);
  end if;

  select observed_count, deduped_count
  into v_observed, v_deduped
  from public.catalog_observation_runs
  where id = v_run_id;

  v_response := jsonb_build_object('status', v_status, 'run_id', v_run_id, 'source_id', input_source_id, 'job_id', input_job_id, 'brand_id', input_brand_id, 'observations_received', v_count, 'observations_appended', v_observed, 'observations_deduped', v_deduped, 'catalog_products_written', 0, 'catalog_products_updated', 0, 'apply_performed', false, 'idempotent', false);
  update public.mira_catalog_observation_intake_requests set run_id = v_run_id, status = v_status, response = v_response, error_message = v_error, updated_at = now() where organization_id = input_organization_id and idempotency_key = trim(input_idempotency_key);
  return v_response;
exception when others then
  v_error := left(sqlerrm, 1000);
  update public.mira_catalog_observation_intake_requests set status = 'blocked', response = jsonb_build_object('status', 'blocked', 'reason', v_error, 'catalog_products_written', 0, 'catalog_products_updated', 0, 'apply_performed', false), error_message = v_error, updated_at = now() where organization_id = input_organization_id and idempotency_key = trim(input_idempotency_key);
  return jsonb_build_object('status', 'blocked', 'reason', v_error, 'catalog_products_written', 0, 'catalog_products_updated', 0, 'apply_performed', false);
end;
$$;

revoke all on function public.ingest_mira_catalog_observation_batch(uuid, uuid, uuid, uuid, uuid, text, text, jsonb, uuid, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.ingest_mira_catalog_observation_batch(uuid, uuid, uuid, uuid, uuid, text, text, jsonb, uuid, jsonb) to service_role;
