-- Bilstein Group detail evidence is review-only. These fields intentionally
-- have no canonical Catalog Product write path in this migration.

create or replace function public.configure_catalog_detail_observation_scope(
  input_organization_id uuid,
  input_source_id uuid,
  input_trust_profile_id uuid,
  input_job_id uuid,
  input_allowed_field_families text[] default array['oem_reference', 'technical_specification']::text[]
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_allowed_field_families text[];
begin
  perform public.require_catalog_observation_service_role();

  if input_organization_id is null
    or input_source_id is null
    or input_trust_profile_id is null
    or input_job_id is null then
    raise exception 'Catalog detail observation scope requires organization, source, trust profile, and job';
  end if;

  if exists (
    select 1
    from unnest(coalesce(input_allowed_field_families, array[]::text[])) field_family
    where field_family not in ('oem_reference', 'technical_specification')
  ) then
    raise exception 'Catalog detail observation scope supports only oem_reference and technical_specification';
  end if;

  select array_agg(distinct field_family order by field_family)
  into v_allowed_field_families
  from unnest(
    array['supplemental_description']::text[]
    || coalesce(input_allowed_field_families, array[]::text[])
  ) field_family;

  update public.catalog_external_source_trust_profiles
  set allowed_field_families = v_allowed_field_families,
      human_review_required = true,
      downstream_publication_restriction = 'internal_only',
      evidence_required = true,
      updated_at = now()
  where id = input_trust_profile_id
    and organization_id = input_organization_id
    and source_id = input_source_id
    and is_active = true;

  if not found then
    raise exception 'Active source trust profile not found for detail observation scope';
  end if;

  update public.catalog_observation_jobs
  set allowed_field_families = v_allowed_field_families,
      sync_mode = 'observation_only',
      updated_at = now()
  where id = input_job_id
    and organization_id = input_organization_id
    and source_id = input_source_id
    and trust_profile_id = input_trust_profile_id
    and status = 'active';

  if not found then
    raise exception 'Active observation job not found for detail observation scope';
  end if;
end;
$$;

revoke all on function public.configure_catalog_detail_observation_scope(uuid, uuid, uuid, uuid, text[]) from public, anon, authenticated, service_role;
grant execute on function public.configure_catalog_detail_observation_scope(uuid, uuid, uuid, uuid, text[]) to service_role;

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

  if input_field_family not in (
    'image_reference',
    'supplemental_description',
    'oem_reference',
    'technical_specification'
  ) then
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
    v_job.id,
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
