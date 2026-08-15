-- Correct the confidence validator introduced by the MIRA observation intake.
-- The previous regular expression treated a valid decimal such as 0.9 as
-- non-numeric. This migration changes only that validation expression;
-- observation-only, tenant, source, trust, product, and Apply guards remain.
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
    if v_item ? 'confidence' and (v_item->>'confidence') !~ '^[0-9]+([.][0-9]+)?$' then
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

