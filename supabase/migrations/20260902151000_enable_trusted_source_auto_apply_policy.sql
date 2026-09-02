-- NM-CATALOG-WP2-F3 follow-up: opt eligible active source profiles into the
-- trusted fill-only path. This is not a blanket writer grant; source policy,
-- evidence, identity and target guards remain enforced by the F3 function.

update public.catalog_external_sources s
set metadata = coalesce(s.metadata, '{}'::jsonb)
  || jsonb_build_object(
       'internal_catalog_persistence_allowed', true,
       'automatic_apply', true,
       'auto_apply_policy', 'trusted_fill_only_v1',
       'auto_apply_approved_at', now()::text
     ),
    updated_at = now()
where s.is_active
  and s.license_posture = 'allowed'
  and s.robots_posture in ('allowed', 'not_applicable')
  and s.rate_limit_posture in ('bounded', 'not_applicable')
  and coalesce(s.credential_boundary, 'none') = 'none'
  and s.source_type in ('manufacturer', 'authorized_distributor', 'licensed_catalog', 'open_web', 'external_catalog', 'internal_observation')
  and s.source_key in (
    'tecalliance_corteco',
    'spareto_textar_product_catalog',
    'bilstein_group_partsfinder_observation'
  );

update public.catalog_external_source_trust_profiles t
set auto_apply_allowed = true,
    auto_enrichment_allowed_fields = array[
      'image_url',
      'ean',
      'description',
      'description_tr',
      'dimensions',
      'weight_kg',
      'hs_code',
      'origin',
      'vehicle_model',
      'market_segment'
    ]::text[],
    updated_at = now()
from public.catalog_external_sources s
where s.id = t.source_id
  and s.organization_id = t.organization_id
  and t.is_active
  and t.trust_score >= 0.80
  and s.is_active
  and s.license_posture = 'allowed'
  and s.robots_posture in ('allowed', 'not_applicable')
  and s.rate_limit_posture in ('bounded', 'not_applicable')
  and coalesce(s.credential_boundary, 'none') = 'none'
  and s.source_type in ('manufacturer', 'authorized_distributor', 'licensed_catalog', 'open_web', 'external_catalog', 'internal_observation')
  and coalesce(s.metadata ->> 'automated_read_only_approved', 'false') = 'true'
  and coalesce(s.metadata ->> 'internal_catalog_persistence_allowed', 'false') = 'true'
  and coalesce(s.metadata ->> 'automatic_apply', 'true') <> 'false';

-- Keep the credential boundary explicit at the trigger boundary as well as in
-- source configuration. A missing boundary means no credential was required;
-- any other value stays out of the autonomous path.
create or replace function public.auto_apply_catalog_observation_candidate_trigger()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_credential_boundary text;
begin
  if new.candidate_status in ('enrichment_candidate', 'guarded_enrichment_candidate', 'review_required', 'approved_for_apply') then
    select coalesce(s.credential_boundary, 'none')
    into v_credential_boundary
    from public.catalog_external_observations o
    join public.catalog_external_sources s on s.id = o.source_id
    where o.id = new.observation_id;

    if v_credential_boundary = 'none' then
      perform public.auto_apply_catalog_observation_if_trusted(new.observation_id, new.id);
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.auto_apply_catalog_observation_candidate_trigger() from public, anon, authenticated, service_role;

