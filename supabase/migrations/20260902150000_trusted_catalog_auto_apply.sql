-- NM-CATALOG-WP2-F3: controlled auto-apply for high-trust observations.
--
-- This is deliberately narrower than a general Catalog writer:
--   * trust score must be >= 0.80 and the profile must explicitly opt in;
--   * source/license/robots/rate/evidence/identity checks must all pass;
--   * only fill-only enrichment fields are allowed (never price, lifecycle,
--     replacement, fitment, supplier linkage, or an existing value);
--   * every mutation is recorded in the existing append-only apply/audit ledgers.

alter table public.catalog_external_source_trust_profiles
  add column if not exists auto_apply_allowed boolean not null default false;

comment on column public.catalog_external_source_trust_profiles.auto_apply_allowed is
  'Explicit opt-in for guarded fill-only enrichment when trust_score >= 0.80. Does not grant price, lifecycle, replacement, fitment, or public publication authority.';

-- Enable only sources that already have an explicit internal persistence approval.
-- An explicit automatic_apply=false remains a hard veto. Existing observation-only
-- profiles therefore remain review-only until their source policy opts in.
update public.catalog_external_source_trust_profiles t
set auto_apply_allowed = (
      t.trust_score >= 0.80
      and t.is_active
      and s.is_active
      and s.license_posture = 'allowed'
      and s.robots_posture in ('allowed', 'not_applicable')
      and s.rate_limit_posture in ('bounded', 'not_applicable')
      and coalesce(s.metadata ->> 'automated_read_only_approved', 'false') = 'true'
      and coalesce(s.metadata ->> 'internal_catalog_persistence_allowed', 'false') = 'true'
      and coalesce(s.metadata ->> 'automatic_apply', 'true') <> 'false'
    ),
    auto_enrichment_allowed_fields = case
      when t.trust_score >= 0.80
       and t.is_active
       and s.is_active
       and s.license_posture = 'allowed'
       and s.robots_posture in ('allowed', 'not_applicable')
       and s.rate_limit_posture in ('bounded', 'not_applicable')
       and coalesce(s.metadata ->> 'automated_read_only_approved', 'false') = 'true'
       and coalesce(s.metadata ->> 'internal_catalog_persistence_allowed', 'false') = 'true'
       and coalesce(s.metadata ->> 'automatic_apply', 'true') <> 'false'
      then array[
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
      ]::text[]
      else t.auto_enrichment_allowed_fields
    end,
    updated_at = now()
from public.catalog_external_sources s
where s.id = t.source_id
  and s.organization_id = t.organization_id;

create or replace function public.auto_apply_catalog_observation_if_trusted(
  input_observation_id uuid,
  input_candidate_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_observation public.catalog_external_observations%rowtype;
  v_candidate public.catalog_observation_candidates%rowtype;
  v_source public.catalog_external_sources%rowtype;
  v_trust public.catalog_external_source_trust_profiles%rowtype;
  v_job public.catalog_observation_jobs%rowtype;
  v_product public.catalog_products%rowtype;
  v_product_after public.catalog_products%rowtype;
  v_apply_event_id uuid;
  v_value text := null;
  v_before text := null;
  v_after text := null;
  v_target_field text := null;
  v_reason text := null;
  v_was_pending_review boolean := false;
  v_dimensions jsonb;
  v_weight numeric;
  v_normalized_ean text;
begin
  if input_observation_id is null then
    return jsonb_build_object('status', 'skipped', 'reason', 'observation_id_required');
  end if;

  select * into v_observation
  from public.catalog_external_observations
  where id = input_observation_id
  for update;

  if not found then
    return jsonb_build_object('status', 'skipped', 'reason', 'observation_not_found');
  end if;

  select * into v_candidate
  from public.catalog_observation_candidates
  where id = coalesce(input_candidate_id, id)
    and observation_id = v_observation.id
  order by updated_at desc
  limit 1;

  if not found then
    return jsonb_build_object('status', 'skipped', 'reason', 'candidate_not_found');
  end if;

  if v_candidate.candidate_status in ('applied', 'rejected', 'deferred', 'no_change', 'observed')
     or v_observation.apply_eligibility = 'applied' then
    return jsonb_build_object('status', 'skipped', 'reason', 'candidate_not_auto_applicable');
  end if;

  select * into v_source
  from public.catalog_external_sources
  where id = v_observation.source_id
    and organization_id = v_observation.organization_id;

  select * into v_trust
  from public.catalog_external_source_trust_profiles
  where id = v_observation.trust_profile_id
    and organization_id = v_observation.organization_id
    and source_id = v_observation.source_id;

  select * into v_job
  from public.catalog_observation_jobs
  where id = v_observation.job_id
    and organization_id = v_observation.organization_id
    and source_id = v_observation.source_id
    and brand_id = v_observation.brand_id;

  if not found or v_source.id is null or v_trust.id is null then
    return jsonb_build_object('status', 'blocked', 'reason', 'scope_not_consistent');
  end if;

  if v_observation.compare_status <> 'compared'
     or v_candidate.candidate_status not in (
       'enrichment_candidate',
       'guarded_enrichment_candidate',
       'review_required',
       'approved_for_apply'
     ) then
    return jsonb_build_object('status', 'skipped', 'reason', 'observation_not_compared_candidate_not_enrichment');
  end if;

  if v_trust.trust_score < 0.80
     or not coalesce(v_trust.is_active, false)
     or not coalesce(v_trust.auto_apply_allowed, false)
     or not (v_observation.field_family = any(coalesce(v_trust.allowed_field_families, array[]::text[])))
     or not (v_observation.field_family = any(coalesce(v_job.allowed_field_families, array[]::text[])))
     or v_observation.field_family = any(coalesce(v_trust.protected_field_families, array[]::text[]))
     or not (v_observation.field_name = any(coalesce(v_trust.auto_enrichment_allowed_fields, array[]::text[]))) then
    return jsonb_build_object('status', 'blocked', 'reason', 'trust_or_field_policy');
  end if;

  if not coalesce(v_source.is_active, false)
     or v_source.license_posture <> 'allowed'
     or v_source.robots_posture not in ('allowed', 'not_applicable')
     or v_source.rate_limit_posture not in ('bounded', 'not_applicable')
     or coalesce(v_source.metadata ->> 'automated_read_only_approved', 'false') <> 'true'
     or coalesce(v_source.metadata ->> 'internal_catalog_persistence_allowed', 'false') <> 'true'
     or coalesce(v_source.metadata ->> 'automatic_apply', 'true') = 'false'
     or v_trust.downstream_publication_restriction in ('restricted', 'blocked')
     or v_observation.license_posture <> 'allowed'
     or v_observation.freshness_status <> 'fresh'
     or v_observation.confidence < 0.80
     or (
       nullif(btrim(coalesce(v_observation.evidence_url, '')), '') is null
       and nullif(btrim(coalesce(v_observation.evidence_reference, '')), '') is null
       and nullif(btrim(coalesce(v_observation.evidence_hash, '')), '') is null
     ) then
    return jsonb_build_object('status', 'blocked', 'reason', 'source_evidence_policy');
  end if;

  if v_observation.catalog_product_id is null then
    return jsonb_build_object('status', 'blocked', 'reason', 'exact_product_match_required');
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(v_observation.organization_id::text || ':' || v_observation.catalog_product_id::text, 0)
  );

  select * into v_product
  from public.catalog_products
  where id = v_observation.catalog_product_id
    and organization_id = v_observation.organization_id
    and brand_id = v_observation.brand_id
    and normalized_code = v_observation.normalized_code
  for update;

  if not found then
    return jsonb_build_object('status', 'blocked', 'reason', 'exact_product_identity_mismatch');
  end if;

  v_value := nullif(btrim(v_observation.normalized_value), '');
  if v_value is null then
    return jsonb_build_object('status', 'blocked', 'reason', 'empty_normalized_value');
  end if;

  -- Map only canonical fill-only fields. OEM, vehicle/fitment, lifecycle,
  -- replacement and pricing deliberately have no branch here.
  if v_observation.field_family = 'image_reference' and v_observation.field_name = 'image_url' then
    if v_value !~ '^https://[^/@?#[:space:]]+(?::[0-9]{1,5})?(?:/[^?#[:space:]]*)?$' then
      return jsonb_build_object('status', 'blocked', 'reason', 'image_url_must_be_https_without_query');
    end if;
    if nullif(btrim(coalesce(v_product.image_url, '')), '') is not null then
      return jsonb_build_object('status', 'skipped', 'reason', 'target_already_filled');
    end if;
    v_target_field := 'image_url';
    v_before := v_product.image_url;
    v_after := v_value;
    update public.catalog_products
    set image_url = v_value, updated_at = now()
    where id = v_product.id
      and nullif(btrim(coalesce(image_url, '')), '') is null
    returning * into v_product_after;

  elsif v_observation.field_family = 'ean_reference' and v_observation.field_name in ('ean', 'normalized_ean') then
    if nullif(btrim(coalesce(v_product.ean, '')), '') is not null then
      return jsonb_build_object('status', 'skipped', 'reason', 'target_already_filled');
    end if;
    v_normalized_ean := regexp_replace(v_value, '[^0-9]', '', 'g');
    if v_normalized_ean !~ '^[0-9]{8,14}$' then
      return jsonb_build_object('status', 'blocked', 'reason', 'invalid_ean');
    end if;
    v_target_field := 'ean';
    v_before := v_product.ean;
    v_after := v_normalized_ean;
    update public.catalog_products
    set ean = v_normalized_ean,
        normalized_ean = v_normalized_ean,
        updated_at = now()
    where id = v_product.id
      and nullif(btrim(coalesce(ean, '')), '') is null
    returning * into v_product_after;

  elsif v_observation.field_family = 'supplemental_description' and v_observation.field_name in ('description', 'description_tr') then
    if v_observation.field_name = 'description' then
      if nullif(btrim(coalesce(v_product.description, '')), '') is not null then
        return jsonb_build_object('status', 'skipped', 'reason', 'target_already_filled');
      end if;
      v_target_field := 'description';
      v_before := v_product.description;
      update public.catalog_products
      set description = v_value, updated_at = now()
      where id = v_product.id
        and nullif(btrim(coalesce(description, '')), '') is null
      returning * into v_product_after;
    else
      if nullif(btrim(coalesce(v_product.description_tr, '')), '') is not null then
        return jsonb_build_object('status', 'skipped', 'reason', 'target_already_filled');
      end if;
      v_target_field := 'description_tr';
      v_before := v_product.description_tr;
      update public.catalog_products
      set description_tr = v_value, updated_at = now()
      where id = v_product.id
        and nullif(btrim(coalesce(description_tr, '')), '') is null
      returning * into v_product_after;
    end if;
    v_after := v_value;

  elsif v_observation.field_family = 'technical_specification' and v_observation.field_name = 'dimensions' then
    if v_product.dimensions is not null then
      return jsonb_build_object('status', 'skipped', 'reason', 'target_already_filled');
    end if;
    begin
      v_dimensions := v_value::jsonb;
    exception when others then
      return jsonb_build_object('status', 'blocked', 'reason', 'dimensions_must_be_valid_json');
    end;
    if jsonb_typeof(v_dimensions) not in ('object', 'array') then
      return jsonb_build_object('status', 'blocked', 'reason', 'dimensions_must_be_object_or_array');
    end if;
    v_target_field := 'dimensions';
    v_before := null;
    v_after := v_dimensions::text;
    update public.catalog_products
    set dimensions = v_dimensions, updated_at = now()
    where id = v_product.id and dimensions is null
    returning * into v_product_after;

  elsif v_observation.field_family = 'technical_specification' and v_observation.field_name = 'weight_kg' then
    if v_product.weight_kg is not null then
      return jsonb_build_object('status', 'skipped', 'reason', 'target_already_filled');
    end if;
    begin
      v_weight := v_value::numeric;
    exception when others then
      return jsonb_build_object('status', 'blocked', 'reason', 'weight_must_be_numeric');
    end;
    if v_weight <= 0 or v_weight > 100000 then
      return jsonb_build_object('status', 'blocked', 'reason', 'weight_out_of_range');
    end if;
    v_target_field := 'weight_kg';
    v_before := null;
    v_after := v_weight::text;
    update public.catalog_products
    set weight_kg = v_weight, updated_at = now()
    where id = v_product.id and weight_kg is null
    returning * into v_product_after;

  elsif v_observation.field_family = 'technical_specification'
        and v_observation.field_name in ('hs_code', 'origin', 'vehicle_model', 'market_segment') then
    if v_observation.field_name = 'hs_code' then
      v_before := v_product.hs_code;
      if nullif(btrim(coalesce(v_product.hs_code, '')), '') is not null then
        return jsonb_build_object('status', 'skipped', 'reason', 'target_already_filled');
      end if;
      update public.catalog_products set hs_code = v_value, updated_at = now()
      where id = v_product.id and nullif(btrim(coalesce(hs_code, '')), '') is null
      returning * into v_product_after;
    elsif v_observation.field_name = 'origin' then
      v_before := v_product.origin;
      if nullif(btrim(coalesce(v_product.origin, '')), '') is not null then
        return jsonb_build_object('status', 'skipped', 'reason', 'target_already_filled');
      end if;
      update public.catalog_products set origin = v_value, updated_at = now()
      where id = v_product.id and nullif(btrim(coalesce(origin, '')), '') is null
      returning * into v_product_after;
    elsif v_observation.field_name = 'vehicle_model' then
      v_before := v_product.vehicle_model;
      if nullif(btrim(coalesce(v_product.vehicle_model, '')), '') is not null then
        return jsonb_build_object('status', 'skipped', 'reason', 'target_already_filled');
      end if;
      update public.catalog_products set vehicle_model = v_value, updated_at = now()
      where id = v_product.id and nullif(btrim(coalesce(vehicle_model, '')), '') is null
      returning * into v_product_after;
    else
      v_before := v_product.market_segment;
      if nullif(btrim(coalesce(v_product.market_segment, '')), '') is not null then
        return jsonb_build_object('status', 'skipped', 'reason', 'target_already_filled');
      end if;
      update public.catalog_products set market_segment = v_value, updated_at = now()
      where id = v_product.id and nullif(btrim(coalesce(market_segment, '')), '') is null
      returning * into v_product_after;
    end if;
    v_target_field := v_observation.field_name;
    v_after := v_value;
  else
    return jsonb_build_object('status', 'blocked', 'reason', 'field_not_in_fill_only_allowlist');
  end if;

  if v_product_after.id is null then
    return jsonb_build_object('status', 'skipped', 'reason', 'target_changed_before_apply');
  end if;

  select id into v_apply_event_id
  from public.catalog_apply_events
  where organization_id = v_observation.organization_id
    and observation_id = v_observation.id
    and field_name = v_target_field
    and apply_status = 'applied'
  limit 1;

  if v_apply_event_id is not null then
    return jsonb_build_object('status', 'already_applied', 'apply_event_id', v_apply_event_id);
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
    v_observation.organization_id,
    v_observation.id,
    null,
    v_product_after.id,
    v_target_field,
    v_before,
    v_after,
    'applied',
    null,
    jsonb_build_object(
      'source_id', v_observation.source_id,
      'trust_profile_id', v_observation.trust_profile_id,
      'source_revision', v_observation.source_revision,
      'source_trust_score', v_trust.trust_score,
      'evidence_url', v_observation.evidence_url,
      'evidence_reference', v_observation.evidence_reference,
      'evidence_hash', v_observation.evidence_hash,
      'confidence', v_observation.confidence,
      'license_posture', v_observation.license_posture,
      'observed_at', v_observation.observed_at,
      'automatic', true
    ),
    jsonb_build_object('fill_only', true, 'public_publication', false),
    jsonb_build_object('trust_threshold', 0.80, 'exact_identity', true, 'conflict_guard', true),
    'trusted source auto-apply'
  )
  returning id into v_apply_event_id;

  v_was_pending_review := v_observation.review_status = 'pending_review';
  update public.catalog_external_observations
  set apply_eligibility = 'applied',
      review_status = 'ignored',
      last_error = null,
      updated_at = now()
  where id = v_observation.id;

  update public.catalog_observation_candidates
  set candidate_status = 'applied',
      guardian_status = 'passed',
      comparison_reason = left(concat_ws('; ', comparison_reason, 'trusted_auto_apply'), 2000),
      downstream_impact = coalesce(downstream_impact, '{}'::jsonb)
        || jsonb_build_object('automatic', true, 'trust_score', v_trust.trust_score, 'target_field', v_target_field),
      updated_at = now()
  where id = v_candidate.id;

  update public.catalog_observation_runs
  set apply_event_count = apply_event_count + 1,
      updated_at = now()
  where id = v_observation.run_id;

  update public.catalog_observation_scope_health
  set pending_review_count = greatest(0, pending_review_count - case when v_was_pending_review then 1 else 0 end),
      updated_at = now()
  where organization_id = v_observation.organization_id
    and job_id = v_observation.job_id;

  perform public.enqueue_catalog_integrity_product(
    v_observation.organization_id,
    v_product_after.id,
    'trusted_observation_auto_apply',
    50
  );

  perform public.append_catalog_observation_audit_event(
    v_observation.organization_id,
    v_observation.job_id,
    v_observation.run_id,
    v_observation.id,
    v_candidate.id,
    null,
    v_apply_event_id,
    null,
    'trusted_observation_auto_applied',
    v_candidate.candidate_status,
    'applied',
    'fill-only enrichment applied without Catalog Observation Review',
    coalesce(v_observation.evidence_reference, v_observation.evidence_url, v_observation.evidence_hash),
    v_observation.confidence,
    jsonb_build_object('field_name', v_target_field, 'trust_score', v_trust.trust_score, 'automatic', true)
  );

  return jsonb_build_object(
    'status', 'applied',
    'apply_event_id', v_apply_event_id,
    'observation_id', v_observation.id,
    'catalog_product_id', v_product_after.id,
    'field_name', v_target_field,
    'trust_score', v_trust.trust_score
  );
end;
$$;

revoke all on function public.auto_apply_catalog_observation_if_trusted(uuid, uuid)
  from public, anon, authenticated, service_role;

create or replace function public.auto_apply_catalog_observation_candidate_trigger()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.candidate_status in ('enrichment_candidate', 'guarded_enrichment_candidate', 'review_required', 'approved_for_apply') then
    perform public.auto_apply_catalog_observation_if_trusted(new.observation_id, new.id);
  end if;
  return new;
end;
$$;

revoke all on function public.auto_apply_catalog_observation_candidate_trigger() from public, anon, authenticated, service_role;

drop trigger if exists trg_catalog_observation_candidate_trusted_auto_apply
  on public.catalog_observation_candidates;
create trigger trg_catalog_observation_candidate_trusted_auto_apply
after insert or update of candidate_status
on public.catalog_observation_candidates
for each row
execute function public.auto_apply_catalog_observation_candidate_trigger();

