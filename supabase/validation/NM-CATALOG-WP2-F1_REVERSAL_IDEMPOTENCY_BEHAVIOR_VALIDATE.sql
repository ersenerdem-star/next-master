begin;

set local statement_timeout = '10min';
set local lock_timeout = '10s';

create temporary table wp2f1_reversal_gate_results (
  gate text primary key,
  status text not null,
  detail text not null
) on commit drop;

do $wp2f1_reversal_behavior$
declare
  v_actor public.profiles%rowtype;
  v_other_actor public.profiles%rowtype;
  v_observation public.catalog_external_observations%rowtype;
  v_second_observation public.catalog_external_observations%rowtype;
  v_product public.catalog_products%rowtype;
  v_second_product public.catalog_products%rowtype;
  v_review_item_id text;
  v_second_review_item_id text;
  v_cross_org_review_item_id text;
  v_target_event_id uuid := gen_random_uuid();
  v_second_target_event_id uuid := gen_random_uuid();
  v_target_prior_version integer;
  v_target_decision_version integer;
  v_target_reversal_version integer;
  v_second_prior_version integer;
  v_second_decision_version integer;
  v_cross_version_before integer;
  v_cross_version_after integer;
  v_cross_reversal_count_before integer;
  v_cross_reversal_count_after integer;
  v_cross_current_event_id uuid;
  v_first_result jsonb;
  v_replay_result jsonb;
  v_first_event_id uuid;
  v_replay_event_id uuid;
  v_baseline_version integer;
  v_after_first_version integer;
  v_after_replay_version integer;
  v_baseline_reversal_count integer;
  v_after_first_reversal_count integer;
  v_after_replay_reversal_count integer;
  v_baseline_current_event_id uuid;
  v_after_first_current_event_id uuid;
  v_after_replay_current_event_id uuid;
  v_error text;
begin
  select p.*
  into v_actor
  from public.profiles p
  where coalesce(p.is_active, true)
    and lower(coalesce(p.role, '')) in ('admin', 'superadmin')
  order by p.created_at nulls last, p.id
  limit 1;

  if not found then
    raise exception 'BLOCKED: no active admin/superadmin profile available for controlled reversal validation';
  end if;

  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', v_actor.id::text, true);

  select o.*
  into v_observation
  from public.catalog_external_observations o
  join public.catalog_products cp
    on cp.id = o.catalog_product_id
   and cp.organization_id = o.organization_id
  where o.organization_id = v_actor.organization_id
    and o.catalog_product_id is not null
    and coalesce(o.field_family, '') <> ''
  order by o.ingested_at nulls last, o.id
  limit 1;

  if not found then
    raise exception 'BLOCKED: no controlled catalog observation/Product pair available for reversal validation';
  end if;

  select cp.*
  into v_product
  from public.catalog_products cp
  where cp.id = v_observation.catalog_product_id
    and cp.organization_id = v_observation.organization_id
  limit 1;

  if not found then
    raise exception 'BLOCKED: selected observation has no same-organization Product';
  end if;

  select o.*
  into v_second_observation
  from public.catalog_external_observations o
  join public.catalog_products cp
    on cp.id = o.catalog_product_id
   and cp.organization_id = o.organization_id
  where o.organization_id = v_actor.organization_id
    and o.catalog_product_id is not null
    and coalesce(o.field_family, '') <> ''
    and o.id <> v_observation.id
  order by o.ingested_at nulls last, o.id
  limit 1;

  if not found then
    raise exception 'BLOCKED: no second same-organization review item available for idempotency-key isolation validation';
  end if;

  select cp.*
  into v_second_product
  from public.catalog_products cp
  where cp.id = v_second_observation.catalog_product_id
    and cp.organization_id = v_second_observation.organization_id
  limit 1;

  if not found then
    raise exception 'BLOCKED: second selected observation has no same-organization Product';
  end if;

  v_review_item_id := concat_ws(':', v_observation.organization_id::text, v_observation.catalog_product_id::text, v_observation.id::text, v_observation.field_family);
  v_second_review_item_id := concat_ws(':', v_second_observation.organization_id::text, v_second_observation.catalog_product_id::text, v_second_observation.id::text, v_second_observation.field_family);
  v_cross_org_review_item_id := concat_ws(':', gen_random_uuid()::text, v_second_observation.catalog_product_id::text, v_second_observation.id::text, v_second_observation.field_family);

  perform 1
  from public.catalog_observation_review_decision_events e
  where e.organization_id = v_actor.organization_id
    and e.review_item_id = v_review_item_id
  for update;

  select coalesce(max(e.resulting_decision_version), 0)::integer
  into v_target_prior_version
  from public.catalog_observation_review_decision_events e
  where e.organization_id = v_actor.organization_id
    and e.review_item_id = v_review_item_id;

  v_target_decision_version := v_target_prior_version + 1;
  v_target_reversal_version := v_target_decision_version + 1;

  insert into public.catalog_observation_review_decision_events (
    event_id,
    organization_id,
    review_item_id,
    observation_id,
    catalog_product_id,
    field_family,
    event_type,
    decision_type,
    reason_code,
    reviewer_user_id,
    reviewer_role,
    reviewer_capability_snapshot,
    recommendation_fingerprint,
    review_item_fingerprint,
    observation_fingerprint,
    product_target_fingerprint,
    expected_prior_decision_version,
    resulting_decision_version,
    idempotency_key,
    idempotency_payload_hash,
    lifecycle_reason,
    apply_eligible,
    apply_block_reasons,
    field_risk
  ) values (
    v_target_event_id,
    v_actor.organization_id,
    v_review_item_id,
    v_observation.id,
    v_observation.catalog_product_id,
    v_observation.field_family,
    'DECISION_RECORDED',
    'ACCEPT_RECOMMENDATION',
    'EVIDENCE_SUFFICIENT',
    v_actor.id,
    lower(coalesce(v_actor.role, '')),
    jsonb_build_object('role', lower(coalesce(v_actor.role, '')), 'is_active', coalesce(v_actor.is_active, true)),
    public.catalog_review_hash('validation-recommendation', v_target_event_id::text),
    public.catalog_review_item_fingerprint(v_review_item_id, v_observation, v_product),
    public.catalog_review_observation_fingerprint(v_observation),
    public.catalog_review_product_target_fingerprint(v_observation.field_family, v_product),
    v_target_prior_version,
    v_target_decision_version,
    'wp2f1-validation-target-' || txid_current(),
    public.catalog_review_hash('validation-target-payload', v_target_event_id::text),
    'EVIDENCE_SUFFICIENT',
    true,
    array[]::text[],
    public.catalog_review_decision_field_risk(v_observation.field_family)
  );

  v_baseline_version := public.catalog_review_current_version(v_actor.organization_id, v_review_item_id);
  select count(*)::integer
  into v_baseline_reversal_count
  from public.catalog_observation_review_decision_events e
  where e.organization_id = v_actor.organization_id
    and e.review_item_id = v_review_item_id
    and e.event_type = 'DECISION_REVERSED';

  v_baseline_current_event_id := (public.get_catalog_observation_review_decision_state(v_review_item_id)->>'current_event_id')::uuid;

  if v_baseline_version <> v_target_decision_version or v_baseline_current_event_id <> v_target_event_id then
    raise exception 'BLOCKED: controlled target setup did not produce the expected reversible current decision';
  end if;

  insert into wp2f1_reversal_gate_results values
    ('01_initial_setup', 'PASS', 'controlled reversible decision event exists');

  insert into wp2f1_reversal_gate_results values
    ('02_baseline_recorded', 'PASS', format('version=%s reversal_count=%s current_event_id=%s', v_baseline_version, v_baseline_reversal_count, v_baseline_current_event_id));

  v_first_result := public.reverse_catalog_observation_review_decision(
    v_review_item_id,
    v_target_event_id,
    'DECISION_ENTERED_IN_ERROR',
    'controlled reversal validation',
    v_target_decision_version,
    'wp2f1-reversal-replay-key-' || txid_current()
  );

  v_first_event_id := (v_first_result->'event'->>'event_id')::uuid;
  v_after_first_version := public.catalog_review_current_version(v_actor.organization_id, v_review_item_id);
  select count(*)::integer
  into v_after_first_reversal_count
  from public.catalog_observation_review_decision_events e
  where e.organization_id = v_actor.organization_id
    and e.review_item_id = v_review_item_id
    and e.event_type = 'DECISION_REVERSED';
  v_after_first_current_event_id := (public.get_catalog_observation_review_decision_state(v_review_item_id)->>'current_event_id')::uuid;

  if (v_first_result->>'idempotency_replay')::boolean is not false
    or v_after_first_reversal_count <> v_baseline_reversal_count + 1
    or v_after_first_version <> v_baseline_version + 1
    or v_after_first_current_event_id <> v_first_event_id then
    raise exception 'BLOCKED: first reversal did not create exactly one new current reversal event';
  end if;

  insert into wp2f1_reversal_gate_results values
    ('03_first_reversal', 'PASS', format('event_id=%s version=%s', v_first_event_id, v_after_first_version));

  v_replay_result := public.reverse_catalog_observation_review_decision(
    v_review_item_id,
    v_target_event_id,
    'DECISION_ENTERED_IN_ERROR',
    'controlled reversal validation',
    v_target_decision_version,
    'wp2f1-reversal-replay-key-' || txid_current()
  );

  v_replay_event_id := (v_replay_result->'event'->>'event_id')::uuid;
  v_after_replay_version := public.catalog_review_current_version(v_actor.organization_id, v_review_item_id);
  select count(*)::integer
  into v_after_replay_reversal_count
  from public.catalog_observation_review_decision_events e
  where e.organization_id = v_actor.organization_id
    and e.review_item_id = v_review_item_id
    and e.event_type = 'DECISION_REVERSED';
  v_after_replay_current_event_id := (public.get_catalog_observation_review_decision_state(v_review_item_id)->>'current_event_id')::uuid;

  if (v_replay_result->>'idempotency_replay')::boolean is not true
    or v_replay_event_id <> v_first_event_id
    or (v_replay_result->'event'->>'resulting_decision_version')::integer <> v_after_first_version
    or v_after_replay_reversal_count <> v_after_first_reversal_count
    or v_after_replay_version <> v_after_first_version
    or v_after_replay_current_event_id <> v_after_first_current_event_id then
    raise exception 'BLOCKED: exact replay did not return the original reversal without state change';
  end if;

  insert into wp2f1_reversal_gate_results values
    ('04_exact_replay', 'PASS', 'same event/version returned and no duplicate event inserted');

  begin
    perform public.reverse_catalog_observation_review_decision(
      v_review_item_id,
      v_target_event_id,
      'NEW_EVIDENCE_RECEIVED',
      'controlled reversal validation',
      v_target_decision_version,
      'wp2f1-reversal-replay-key-' || txid_current()
    );
    raise exception 'BLOCKED: same idempotency key with different payload was accepted';
  exception when others then
    v_error := sqlerrm;
    if v_error not ilike '%CATALOG_REVIEW_DECISION_IDEMPOTENCY_MISMATCH%' then
      raise exception 'BLOCKED: expected IDEMPOTENCY_MISMATCH, got %', v_error;
    end if;
  end;

  insert into wp2f1_reversal_gate_results values
    ('05_payload_mismatch', 'PASS', 'same key with different reason is rejected as IDEMPOTENCY_MISMATCH');

  begin
    perform public.reverse_catalog_observation_review_decision(
      v_review_item_id,
      v_target_event_id,
      'DECISION_ENTERED_IN_ERROR',
      'controlled reversal validation',
      v_target_decision_version,
      'wp2f1-new-stale-key-' || txid_current()
    );
    raise exception 'BLOCKED: new key with stale expected version was accepted';
  exception when others then
    v_error := sqlerrm;
    if v_error not ilike '%CATALOG_REVIEW_DECISION_CONFLICT%' then
      raise exception 'BLOCKED: expected DECISION_CONFLICT, got %', v_error;
    end if;
  end;

  insert into wp2f1_reversal_gate_results values
    ('06_stale_new_key', 'PASS', 'new key with stale expected version is rejected as DECISION_CONFLICT');

  begin
    perform public.reverse_catalog_observation_review_decision(
      v_review_item_id,
      v_target_event_id,
      'DECISION_ENTERED_IN_ERROR',
      'controlled reversal validation',
      v_target_reversal_version,
      'wp2f1-new-current-key-' || txid_current()
    );
    raise exception 'BLOCKED: already-reversed target accepted a new reversal';
  exception when others then
    v_error := sqlerrm;
    if v_error not ilike '%CATALOG_REVIEW_DECISION_INVALID_TRANSITION%' then
      raise exception 'BLOCKED: expected INVALID_TRANSITION for already-reversed item, got %', v_error;
    end if;
  end;

  insert into wp2f1_reversal_gate_results values
    ('07_already_reversed_current_state', 'PASS', 'new current-version key cannot reverse an already-reversed target');

  perform 1
  from public.catalog_observation_review_decision_events e
  where e.organization_id = v_actor.organization_id
    and e.review_item_id = v_second_review_item_id
  for update;

  select coalesce(max(e.resulting_decision_version), 0)::integer
  into v_second_prior_version
  from public.catalog_observation_review_decision_events e
  where e.organization_id = v_actor.organization_id
    and e.review_item_id = v_second_review_item_id;

  v_second_decision_version := v_second_prior_version + 1;

  insert into public.catalog_observation_review_decision_events (
    event_id,
    organization_id,
    review_item_id,
    observation_id,
    catalog_product_id,
    field_family,
    event_type,
    decision_type,
    reason_code,
    reviewer_user_id,
    reviewer_role,
    reviewer_capability_snapshot,
    recommendation_fingerprint,
    review_item_fingerprint,
    observation_fingerprint,
    product_target_fingerprint,
    expected_prior_decision_version,
    resulting_decision_version,
    idempotency_key,
    idempotency_payload_hash,
    lifecycle_reason,
    apply_eligible,
    apply_block_reasons,
    field_risk
  ) values (
    v_second_target_event_id,
    v_actor.organization_id,
    v_second_review_item_id,
    v_second_observation.id,
    v_second_observation.catalog_product_id,
    v_second_observation.field_family,
    'DECISION_RECORDED',
    'ACCEPT_RECOMMENDATION',
    'EVIDENCE_SUFFICIENT',
    v_actor.id,
    lower(coalesce(v_actor.role, '')),
    jsonb_build_object('role', lower(coalesce(v_actor.role, '')), 'is_active', coalesce(v_actor.is_active, true)),
    public.catalog_review_hash('validation-recommendation', v_second_observation.id::text),
    public.catalog_review_item_fingerprint(v_second_review_item_id, v_second_observation, v_second_product),
    public.catalog_review_observation_fingerprint(v_second_observation),
    public.catalog_review_product_target_fingerprint(v_second_observation.field_family, v_second_product),
    v_second_prior_version,
    v_second_decision_version,
    'wp2f1-validation-second-target-' || txid_current(),
    public.catalog_review_hash('validation-second-target-payload', v_second_observation.id::text),
    'EVIDENCE_SUFFICIENT',
    true,
    array[]::text[],
    public.catalog_review_decision_field_risk(v_second_observation.field_family)
  );

  v_cross_version_before := public.catalog_review_current_version(v_actor.organization_id, v_second_review_item_id);
  v_cross_current_event_id := (public.get_catalog_observation_review_decision_state(v_second_review_item_id)->>'current_event_id')::uuid;
  select count(*)::integer
  into v_cross_reversal_count_before
  from public.catalog_observation_review_decision_events e
  where e.organization_id = v_actor.organization_id
    and e.review_item_id = v_second_review_item_id
    and e.event_type = 'DECISION_REVERSED';

  if v_second_target_event_id = v_target_event_id
    or v_cross_current_event_id <> v_second_target_event_id
    or v_cross_version_before <> v_second_decision_version then
    raise exception 'BLOCKED: cross-organization fixture is not an independent reversible target';
  end if;

  begin
    perform public.reverse_catalog_observation_review_decision(
      v_second_review_item_id,
      v_target_event_id,
      'DECISION_ENTERED_IN_ERROR',
      'controlled reversal validation',
      v_second_decision_version,
      'wp2f1-reversal-replay-key-' || txid_current()
    );
    raise exception 'BLOCKED: idempotency key reused for another review item replayed or crossed scope';
  exception when others then
    v_error := sqlerrm;
    if v_error not ilike '%CATALOG_REVIEW_DECISION_INVALID_TRANSITION%'
      and v_error not ilike '%CATALOG_REVIEW_DECISION_CONFLICT%'
      and v_error not ilike '%CATALOG_REVIEW_ITEM_MISSING%' then
      raise exception 'BLOCKED: expected scoped rejection for reused key on another item, got %', v_error;
    end if;
  end;

  insert into wp2f1_reversal_gate_results values
    ('08_idempotency_key_item_scope', 'PASS', 'same key cannot replay a different review item');

  select p.*
  into v_other_actor
  from public.profiles p
  where p.organization_id <> v_actor.organization_id
    and coalesce(p.is_active, true)
    and lower(coalesce(p.role, '')) in ('admin', 'superadmin')
  order by p.created_at nulls last, p.id
  limit 1;

  begin
    if v_other_actor.id is not null then
      perform set_config('request.jwt.claim.sub', v_other_actor.id::text, true);
      v_cross_org_review_item_id := v_second_review_item_id;
    end if;

    perform public.reverse_catalog_observation_review_decision(
      v_cross_org_review_item_id,
      v_second_target_event_id,
      'DECISION_ENTERED_IN_ERROR',
      'controlled reversal validation',
      v_second_decision_version,
      'wp2f1-cross-org-key-' || txid_current()
    );
    raise exception 'BLOCKED: cross-organization review item was accepted';
  exception when others then
    perform set_config('request.jwt.claim.sub', v_actor.id::text, true);
    v_error := sqlerrm;
    if v_error not ilike '%CATALOG_REVIEW_DECISION_INVALID_TRANSITION%' then
      raise exception 'BLOCKED: expected tenant-safe INVALID_TRANSITION for cross-organization boundary, got %', v_error;
    end if;
  end;

  v_cross_version_after := public.catalog_review_current_version(v_actor.organization_id, v_second_review_item_id);
  select count(*)::integer
  into v_cross_reversal_count_after
  from public.catalog_observation_review_decision_events e
  where e.organization_id = v_actor.organization_id
    and e.review_item_id = v_second_review_item_id
    and e.event_type = 'DECISION_REVERSED';

  if v_cross_version_after <> v_cross_version_before
    or v_cross_reversal_count_after <> v_cross_reversal_count_before then
    raise exception 'BLOCKED: cross-organization rejection changed event state';
  end if;

  insert into wp2f1_reversal_gate_results values
    ('09_cross_org_isolation', 'PASS', 'cross-organization boundary uses scoped target lookup and returns tenant-safe INVALID_TRANSITION without state change');

  select count(*)::integer
  into v_after_replay_reversal_count
  from public.catalog_observation_review_decision_events e
  where e.organization_id = v_actor.organization_id
    and e.review_item_id = v_review_item_id
    and e.event_type = 'DECISION_REVERSED';

  if v_after_replay_reversal_count <> v_after_first_reversal_count then
    raise exception 'BLOCKED: negative tests changed reversal event count';
  end if;

  insert into wp2f1_reversal_gate_results values
    ('10_no_extra_events_after_negative_tests', 'PASS', 'negative replay/conflict checks did not create more reversal rows');
end;
$wp2f1_reversal_behavior$;

select gate, status, detail
from wp2f1_reversal_gate_results
order by gate;

do $wp2f1_reversal_behavior_gate$
declare
  v_failed_gate text;
begin
  select gate
  into v_failed_gate
  from wp2f1_reversal_gate_results
  where status <> 'PASS'
  order by gate
  limit 1;

  if v_failed_gate is not null then
    raise exception 'BLOCKED: %', v_failed_gate;
  end if;
end;
$wp2f1_reversal_behavior_gate$;

select 'REVERSAL_IDEMPOTENCY_BEHAVIOR_VERIFIED' as result;

rollback;
