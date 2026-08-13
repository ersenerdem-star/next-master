-- Keep MIRA's observation gate separate from downstream publication policy.
-- This replaces the initial scope configurator so it does not force an
-- internal-only publication posture. Publication remains a separate,
-- source-owner/product decision; MIRA still has no publish/apply authority.
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
  if input_organization_id is null or input_source_id is null or input_trust_profile_id is null or input_job_id is null then
    raise exception 'MIRA observation scope requires organization, source, trust profile, and job';
  end if;
  select * into v_source from public.catalog_external_sources where id = input_source_id and organization_id = input_organization_id and is_active = true;
  if not found then raise exception 'Active MIRA observation source not found for organization'; end if;
  if v_source.license_posture <> 'allowed'
     or v_source.robots_posture not in ('allowed', 'not_applicable')
     or v_source.rate_limit_posture not in ('bounded', 'restricted', 'not_applicable')
     or coalesce(nullif(lower(trim(v_source.credential_boundary)), ''), 'none') <> 'none'
     or coalesce((v_source.metadata ->> 'automated_read_only_approved')::boolean, false) is distinct from true
     or coalesce((v_source.metadata ->> 'internal_observation_allowed')::boolean, false) is distinct from true then
    raise exception 'MIRA automatic observation is blocked by source trust/licence/robots/rate/credential policy';
  end if;
  select * into v_trust from public.catalog_external_source_trust_profiles where id = input_trust_profile_id and organization_id = input_organization_id and source_id = input_source_id and is_active = true;
  if not found then raise exception 'Active MIRA trust profile not found for organization'; end if;
  select * into v_job from public.catalog_observation_jobs where id = input_job_id and organization_id = input_organization_id and source_id = input_source_id and trust_profile_id = input_trust_profile_id and status = 'active';
  if not found then raise exception 'Active MIRA observation job not found for organization'; end if;
  select array_agg(distinct field_family order by field_family) into v_allowed
  from unnest(coalesce(input_allowed_field_families, array[]::text[])) field_family
  where field_family in ('image_reference', 'supplemental_description', 'oem_reference', 'technical_specification', 'ean_reference');
  if coalesce(array_length(v_allowed, 1), 0) = 0 or exists (
    select 1 from unnest(coalesce(input_allowed_field_families, array[]::text[])) field_family
    where field_family not in ('image_reference', 'supplemental_description', 'oem_reference', 'technical_specification', 'ean_reference')
  ) then raise exception 'MIRA observation scope contains an unsupported field family'; end if;
  update public.catalog_external_source_trust_profiles
  set allowed_field_families = v_allowed, human_review_required = true, evidence_required = true, updated_at = now()
  where id = v_trust.id;
  update public.catalog_observation_jobs
  set allowed_field_families = v_allowed, sync_mode = 'observation_only', metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('mira_intake_protocol', 'v1'), updated_at = now()
  where id = v_job.id;
  return jsonb_build_object('source_id', v_source.id, 'trust_profile_id', v_trust.id, 'job_id', v_job.id, 'allowed_field_families', v_allowed, 'mode', 'observation_only');
end;
$$;

revoke all on function public.configure_mira_observation_scope(uuid, uuid, uuid, uuid, text[]) from public, anon, authenticated, service_role;
grant execute on function public.configure_mira_observation_scope(uuid, uuid, uuid, uuid, text[]) to service_role;
