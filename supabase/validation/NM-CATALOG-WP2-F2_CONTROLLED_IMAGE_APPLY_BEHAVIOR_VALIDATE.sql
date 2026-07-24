-- NM-CATALOG-WP2-F2: local, rollback-safe behavior validation for the DB-only
-- controlled image Apply transaction. Run only after the F2 migration in a
-- disposable/local database as a database owner. It intentionally does not
-- grant browser/API access and must never be used as production Apply tooling.

begin;

set local statement_timeout = '10min';
set local lock_timeout = '10s';

create temporary table wp2f2_apply_gate_results (
  gate text primary key,
  status text not null,
  detail text not null
) on commit drop;

-- The validator must not require production or copied customer data.  It creates
-- its entire eligible fixture inside this outer transaction, then the final
-- ROLLBACK removes the fixture, decision, Apply event, Product value, and queue row.
do $wp2f2_local_fixture$
declare
  v_org_id uuid := gen_random_uuid();
  v_reviewer_id uuid := gen_random_uuid();
  v_authorizer_id uuid := gen_random_uuid();
  v_brand_id uuid := gen_random_uuid();
  v_product_id uuid := gen_random_uuid();
  v_source_id uuid := gen_random_uuid();
  v_trust_profile_id uuid := gen_random_uuid();
  v_job_id uuid := gen_random_uuid();
  v_run_id uuid := gen_random_uuid();
  v_observation_id uuid := gen_random_uuid();
  v_fixture_key text := txid_current()::text;
begin
  insert into public.organizations (id, name)
  values (v_org_id, 'F2 local validation organization ' || v_fixture_key);

  insert into public.profiles (id, organization_id, email, full_name, role, is_active)
  values
    (v_reviewer_id, v_org_id, 'f2-reviewer-' || v_fixture_key || '@local.invalid', 'F2 validation reviewer', 'admin', true),
    (v_authorizer_id, v_org_id, 'f2-authorizer-' || v_fixture_key || '@local.invalid', 'F2 validation authorizer', 'admin', true);

  insert into public.brands (id, organization_id, name)
  values (v_brand_id, v_org_id, 'F2 Validation Brand ' || v_fixture_key);

  insert into public.catalog_products (id, organization_id, brand_id, product_code, description)
  values (v_product_id, v_org_id, v_brand_id, 'F2-VALIDATION-' || v_fixture_key, 'Rollback-safe local validation Product');

  insert into public.catalog_external_sources (
    id, organization_id, source_key, display_name, source_type, base_url,
    license_posture, robots_posture, rate_limit_posture, is_active
  ) values (
    v_source_id, v_org_id, 'f2-validation-source-' || v_fixture_key, 'F2 validation manufacturer',
    'manufacturer', 'https://manufacturer.local.invalid', 'allowed', 'allowed', 'bounded', true
  );

  insert into public.catalog_external_source_trust_profiles (
    id, organization_id, source_id, trust_level, trust_score, allowed_field_families,
    human_review_required, downstream_publication_restriction, evidence_required, is_active
  ) values (
    v_trust_profile_id, v_org_id, v_source_id, 'T1', 0.99000, array['image_reference']::text[],
    true, 'portal_allowed_after_apply', true, true
  );

  insert into public.catalog_observation_jobs (
    id, organization_id, source_id, trust_profile_id, brand_id, job_key, status,
    observation_scope, sync_mode, allowed_field_families, created_by
  ) values (
    v_job_id, v_org_id, v_source_id, v_trust_profile_id, v_brand_id, 'f2-validation-job-' || v_fixture_key,
    'active', 'single_product', 'observation_only', array['image_reference']::text[], v_reviewer_id
  );

  insert into public.catalog_observation_runs (
    id, organization_id, job_id, source_id, brand_id, status, finished_at, actor_id,
    source_revision, observed_count, candidate_count, review_routed_count
  ) values (
    v_run_id, v_org_id, v_job_id, v_source_id, v_brand_id, 'succeeded', now(), v_reviewer_id,
    'f2-validation-revision', 1, 1, 1
  );

  insert into public.catalog_external_observations (
    id, organization_id, source_id, trust_profile_id, job_id, run_id, brand_id, catalog_product_id,
    product_code, normalized_code, external_product_ref, field_family, field_name, raw_value,
    normalized_value, evidence_url, evidence_reference, evidence_hash, confidence, freshness_status,
    license_posture, observed_at, collector_actor_id, deduplication_key, compare_status, compare_outcome,
    review_status, apply_eligibility
  ) values (
    v_observation_id, v_org_id, v_source_id, v_trust_profile_id, v_job_id, v_run_id, v_brand_id, v_product_id,
    'F2-VALIDATION-' || v_fixture_key, 'F2VALIDATION' || v_fixture_key, 'f2-local-fixture',
    'image_reference', 'image_url', 'https://cdn.local.invalid/f2-validation-image.jpg',
    'https://cdn.local.invalid/f2-validation-image.jpg', 'https://evidence.local.invalid/f2-validation',
    'f2-local-evidence', 'f2-local-evidence-hash', 0.99000, 'fresh', 'allowed', now(), v_reviewer_id,
    'f2-validation-observation-' || v_fixture_key, 'compared', 'guarded_enrichment_candidate',
    'pending_review', 'eligible'
  );
end;
$wp2f2_local_fixture$;

do $wp2f2_apply_behavior$
declare
  v_reviewer public.profiles%rowtype;
  v_authorizer public.profiles%rowtype;
  v_observation public.catalog_external_observations%rowtype;
  v_product public.catalog_products%rowtype;
  v_review_item_id text;
  v_decision_event_id uuid := gen_random_uuid();
  v_prior_version integer;
  v_decision_version integer;
  v_review_fingerprint text;
  v_product_fingerprint text;
  v_first_result jsonb;
  v_replay_result jsonb;
  v_apply_event_id uuid;
  v_replay_event_id uuid;
  v_apply_count_before integer;
  v_apply_count_after_first integer;
  v_apply_count_after_replay integer;
  v_queue_reason text;
  v_image_after_first text;
  v_image_after_replay text;
  v_error text;
  v_key text := 'wp2f2-apply-validation-' || txid_current();
begin
  -- A separate review decision maker and Apply authorizer are a hard F2 gate.
  select reviewer.*
  into v_reviewer
  from public.profiles reviewer
  where coalesce(reviewer.is_active, true)
    and lower(coalesce(reviewer.role, '')) in ('admin', 'superadmin')
    and exists (
      select 1
      from public.profiles authorizer
      where authorizer.organization_id = reviewer.organization_id
        and authorizer.id <> reviewer.id
        and coalesce(authorizer.is_active, true)
        and lower(coalesce(authorizer.role, '')) in ('admin', 'superadmin')
    )
  order by reviewer.created_at nulls last, reviewer.id
  limit 1;

  if not found then
    raise exception 'BLOCKED: two distinct active admin/superadmin profiles in one organization are required';
  end if;

  select authorizer.*
  into v_authorizer
  from public.profiles authorizer
  where authorizer.organization_id = v_reviewer.organization_id
    and authorizer.id <> v_reviewer.id
    and coalesce(authorizer.is_active, true)
    and lower(coalesce(authorizer.role, '')) in ('admin', 'superadmin')
  order by authorizer.created_at nulls last, authorizer.id
  limit 1;

  -- Only use a source that the F2 function itself allows, with an empty target.
  select o.*
  into v_observation
  from public.catalog_external_observations o
  join public.catalog_products cp
    on cp.id = o.catalog_product_id
   and cp.organization_id = o.organization_id
  join public.catalog_external_sources s
    on s.id = o.source_id
   and s.organization_id = o.organization_id
  join public.catalog_external_source_trust_profiles t
    on t.id = o.trust_profile_id
   and t.organization_id = o.organization_id
   and t.source_id = o.source_id
  where o.organization_id = v_reviewer.organization_id
    and o.catalog_product_id is not null
    and o.field_family = 'image_reference'
    and nullif(btrim(coalesce(cp.image_url, '')), '') is null
    and s.is_active
    and s.source_type in ('manufacturer', 'authorized_distributor', 'licensed_catalog')
    and s.license_posture = 'allowed'
    and t.is_active
    and t.evidence_required
    and 'image_reference' = any(coalesce(t.allowed_field_families, array[]::text[]))
    and t.downstream_publication_restriction not in ('restricted', 'blocked')
    and o.license_posture = 'allowed'
    and o.freshness_status = 'fresh'
    and (
      nullif(btrim(coalesce(o.evidence_url, '')), '') is not null
      or nullif(btrim(coalesce(o.evidence_reference, '')), '') is not null
      or nullif(btrim(coalesce(o.evidence_hash, '')), '') is not null
    )
    and btrim(coalesce(o.normalized_value, '')) ~ '^https://[^/@?#[:space:]]+(?::[0-9]{1,5})?(?:/[^?#[:space:]]*)?$'
  order by o.ingested_at nulls last, o.id
  limit 1;

  if not found then
    raise exception 'BLOCKED: no eligible fresh, evidenced, allowed-source image observation with an empty Product image_url is available';
  end if;

  select cp.* into v_product
  from public.catalog_products cp
  where cp.id = v_observation.catalog_product_id
    and cp.organization_id = v_observation.organization_id
  for update;

  if not found then
    raise exception 'BLOCKED: selected observation has no same-organization Product';
  end if;

  v_review_item_id := concat_ws(':', v_observation.organization_id::text, v_observation.catalog_product_id::text, v_observation.id::text, 'image_reference');
  v_review_fingerprint := public.catalog_review_item_fingerprint(v_review_item_id, v_observation, v_product);
  v_product_fingerprint := public.catalog_review_product_target_fingerprint('image_reference', v_product);

  perform 1 from public.catalog_observation_review_decision_events e
  where e.organization_id = v_reviewer.organization_id and e.review_item_id = v_review_item_id
  for update;

  select coalesce(max(e.resulting_decision_version), 0)::integer into v_prior_version
  from public.catalog_observation_review_decision_events e
  where e.organization_id = v_reviewer.organization_id and e.review_item_id = v_review_item_id;

  v_decision_version := v_prior_version + 1;

  -- This fixture represents a completed F1 accepted decision. The outer rollback
  -- makes it non-persistent, and the reviewer remains distinct from the authorizer.
  insert into public.catalog_observation_review_decision_events (
    event_id, organization_id, review_item_id, observation_id, catalog_product_id, field_family,
    event_type, decision_type, reason_code, reviewer_user_id, reviewer_role,
    reviewer_capability_snapshot, recommendation_fingerprint, review_item_fingerprint,
    observation_fingerprint, product_target_fingerprint, expected_prior_decision_version,
    resulting_decision_version, idempotency_key, idempotency_payload_hash, lifecycle_reason,
    apply_eligible, apply_block_reasons, field_risk
  ) values (
    v_decision_event_id, v_reviewer.organization_id, v_review_item_id, v_observation.id,
    v_product.id, 'image_reference', 'DECISION_RECORDED', 'ACCEPT_RECOMMENDATION',
    'EVIDENCE_SUFFICIENT', v_reviewer.id, lower(coalesce(v_reviewer.role, '')),
    jsonb_build_object('role', lower(coalesce(v_reviewer.role, '')), 'is_active', coalesce(v_reviewer.is_active, true)),
    public.catalog_review_hash('wp2f2-validation-recommendation', v_observation.id::text),
    v_review_fingerprint, public.catalog_review_observation_fingerprint(v_observation),
    v_product_fingerprint, v_prior_version, v_decision_version,
    'wp2f2-validation-decision-' || txid_current(),
    public.catalog_review_hash('wp2f2-validation-decision-payload', v_observation.id::text),
    'EVIDENCE_SUFFICIENT', true, array[]::text[], public.catalog_review_decision_field_risk('image_reference')
  );

  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', v_authorizer.id::text, true);

  select count(*)::integer into v_apply_count_before
  from public.catalog_observation_review_apply_events e
  where e.organization_id = v_authorizer.organization_id and e.review_item_id = v_review_item_id;

  v_first_result := public.apply_catalog_observation_review_image(
    v_review_item_id, v_decision_event_id, v_decision_version, v_review_fingerprint,
    v_product_fingerprint, v_key
  );
  v_apply_event_id := (v_first_result->'event'->>'apply_event_id')::uuid;

  if coalesce((v_first_result->>'idempotency_replay')::boolean, true) or v_apply_event_id is null then
    raise exception 'BLOCKED: first controlled Apply did not return a new audit event';
  end if;

  select cp.image_url into v_image_after_first
  from public.catalog_products cp
  where cp.id = v_product.id and cp.organization_id = v_authorizer.organization_id;

  select count(*)::integer into v_apply_count_after_first
  from public.catalog_observation_review_apply_events e
  where e.organization_id = v_authorizer.organization_id and e.review_item_id = v_review_item_id;

  select q.reason into v_queue_reason
  from public.catalog_integrity_queue q
  where q.organization_id = v_authorizer.organization_id and q.product_id = v_product.id;

  if v_image_after_first <> btrim(v_observation.normalized_value)
    or v_apply_count_after_first <> v_apply_count_before + 1
    or v_queue_reason <> 'controlled_image_apply' then
    raise exception 'BLOCKED: first Apply did not atomically fill image_url, append one audit row, and queue downstream revalidation';
  end if;

  insert into wp2f2_apply_gate_results values
    ('01_first_apply_atomic', 'PASS', 'one accepted decision fills only the empty image_url, appends one Apply ledger row, and queues controlled_image_apply');

  v_replay_result := public.apply_catalog_observation_review_image(
    v_review_item_id, v_decision_event_id, v_decision_version, v_review_fingerprint,
    v_product_fingerprint, v_key
  );
  v_replay_event_id := (v_replay_result->'event'->>'apply_event_id')::uuid;

  select cp.image_url into v_image_after_replay
  from public.catalog_products cp
  where cp.id = v_product.id and cp.organization_id = v_authorizer.organization_id;

  select count(*)::integer into v_apply_count_after_replay
  from public.catalog_observation_review_apply_events e
  where e.organization_id = v_authorizer.organization_id and e.review_item_id = v_review_item_id;

  if not coalesce((v_replay_result->>'idempotency_replay')::boolean, false)
    or v_replay_event_id <> v_apply_event_id
    or v_apply_count_after_replay <> v_apply_count_after_first
    or v_image_after_replay <> v_image_after_first then
    raise exception 'BLOCKED: exact idempotency replay changed the Product or created another Apply event';
  end if;

  insert into wp2f2_apply_gate_results values
    ('02_exact_replay_stable', 'PASS', 'same authorizer and exact payload replay the same event without another mutation or ledger row');

  begin
    perform public.apply_catalog_observation_review_image(
      v_review_item_id, v_decision_event_id, v_decision_version + 1, v_review_fingerprint,
      v_product_fingerprint, v_key
    );
    raise exception 'BLOCKED: same idempotency key with different payload was accepted';
  exception when others then
    v_error := sqlerrm;
    if v_error not ilike '%CATALOG_REVIEW_APPLY_IDEMPOTENCY_MISMATCH%' then
      raise exception 'BLOCKED: expected idempotency mismatch, got %', v_error;
    end if;
  end;

  insert into wp2f2_apply_gate_results values
    ('03_payload_change_conflict', 'PASS', 'same idempotency key with a different expected version is rejected before any additional mutation');

  -- Reusing the now-stale target fingerprint under a new key must not replace the image.
  begin
    perform public.apply_catalog_observation_review_image(
      v_review_item_id, v_decision_event_id, v_decision_version, v_review_fingerprint,
      v_product_fingerprint, 'wp2f2-stale-validation-' || txid_current()
    );
    raise exception 'BLOCKED: stale Product target fingerprint was accepted';
  exception when others then
    v_error := sqlerrm;
    if v_error not ilike '%CATALOG_REVIEW_APPLY_STALE%' then
      raise exception 'BLOCKED: expected stale-target rejection, got %', v_error;
    end if;
  end;

  insert into wp2f2_apply_gate_results values
    ('04_stale_target_rejected', 'PASS', 'a new key cannot turn the already-filled image target into a replacement');

  perform set_config('request.jwt.claim.sub', v_reviewer.id::text, true);
  begin
    perform public.apply_catalog_observation_review_image(
      v_review_item_id, v_decision_event_id, v_decision_version, v_review_fingerprint,
      v_product_fingerprint, 'wp2f2-self-authorization-' || txid_current()
    );
    raise exception 'BLOCKED: decision reviewer self-authorized Apply';
  exception when others then
    v_error := sqlerrm;
    if v_error not ilike '%CATALOG_REVIEW_APPLY_AUTHORIZATION_BLOCKED%' then
      raise exception 'BLOCKED: expected self-authorization rejection, got %', v_error;
    end if;
  end;

  insert into wp2f2_apply_gate_results values
    ('05_separation_of_duties', 'PASS', 'the decision reviewer cannot self-authorize the controlled Apply');
end;
$wp2f2_apply_behavior$;

select gate, status, detail from wp2f2_apply_gate_results order by gate;

do $wp2f2_apply_behavior_gate$
declare v_failed_gate text;
begin
  select gate into v_failed_gate from wp2f2_apply_gate_results
  where status <> 'PASS' order by gate limit 1;
  if v_failed_gate is not null then
    raise exception 'BLOCKED: %', v_failed_gate;
  end if;
end;
$wp2f2_apply_behavior_gate$;

select 'CONTROLLED_IMAGE_APPLY_BEHAVIOR_VERIFIED' as result;

rollback;
