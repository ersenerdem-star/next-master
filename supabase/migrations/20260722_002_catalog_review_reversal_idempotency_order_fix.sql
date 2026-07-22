-- NM-CATALOG-WP2-F1 hotfix: ensure reversal idempotency replay is resolved before stale-version rejection.
-- This preserves the append-only decision ledger contract and does not mutate Product, observations, or recommendations.

create or replace function public.reverse_catalog_observation_review_decision(
  input_review_item_id text,
  input_reversal_target_event_id uuid,
  input_reason_code text,
  input_reviewer_note text,
  input_expected_decision_version integer,
  input_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_id uuid := auth.uid();
  v_org_id uuid := public.current_profile_org_id();
  v_profile public.profiles%rowtype;
  v_target public.catalog_observation_review_decision_events%rowtype;
  v_existing public.catalog_observation_review_decision_events%rowtype;
  v_current_version integer;
  v_payload_hash text;
  v_event public.catalog_observation_review_decision_events%rowtype;
begin
  if v_actor_id is null or v_org_id is null then
    raise exception 'CATALOG_REVIEW_DECISION_UNAUTHORIZED: active profile required'
      using errcode = 'P0001';
  end if;

  select * into v_profile
  from public.profiles p
  where p.id = v_actor_id
    and p.organization_id = v_org_id
    and coalesce(p.is_active, true)
    and lower(coalesce(p.role, '')) in ('admin', 'superadmin')
  limit 1;

  if not found then
    raise exception 'CATALOG_REVIEW_DECISION_UNAUTHORIZED: admin or superadmin required'
      using errcode = 'P0001';
  end if;

  if not public.catalog_review_decision_reason_is_allowed('DECISION_REVERSED', null, input_reason_code) then
    raise exception 'CATALOG_REVIEW_DECISION_INVALID_REASON: reversal reason code is not allowed'
      using errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_org_id::text || ':' || input_review_item_id, 0));

  select * into v_target
  from public.catalog_observation_review_decision_events e
  where e.event_id = input_reversal_target_event_id
    and e.organization_id = v_org_id
    and e.review_item_id = input_review_item_id
  limit 1;

  if not found or v_target.event_type <> 'DECISION_RECORDED' then
    raise exception 'CATALOG_REVIEW_DECISION_INVALID_TRANSITION: invalid reversal target'
      using errcode = 'P0001';
  end if;

  v_payload_hash := public.catalog_review_hash(
    'reversal_payload',
    concat_ws('|',
      v_org_id::text,
      input_review_item_id,
      input_reversal_target_event_id::text,
      input_reason_code,
      coalesce(input_reviewer_note, ''),
      input_expected_decision_version::text,
      input_idempotency_key,
      v_actor_id::text
    )
  );

  select * into v_existing
  from public.catalog_observation_review_decision_events e
  where e.organization_id = v_org_id
    and e.review_item_id = input_review_item_id
    and e.idempotency_key = input_idempotency_key
  limit 1;

  if found then
    if v_existing.idempotency_payload_hash <> v_payload_hash then
      raise exception 'CATALOG_REVIEW_DECISION_IDEMPOTENCY_MISMATCH: idempotency key payload changed'
        using errcode = 'P0001';
    end if;
    return jsonb_build_object(
      'event', to_jsonb(v_existing),
      'current_state', public.get_catalog_observation_review_decision_state(input_review_item_id),
      'idempotency_replay', true
    );
  end if;

  v_current_version := public.catalog_review_current_version(v_org_id, input_review_item_id);
  if v_current_version <> input_expected_decision_version then
    raise exception 'CATALOG_REVIEW_DECISION_CONFLICT: expected version does not match current version'
      using errcode = 'P0001';
  end if;
  if v_target.resulting_decision_version <> v_current_version then
    raise exception 'CATALOG_REVIEW_DECISION_INVALID_TRANSITION: only current decision can be reversed'
      using errcode = 'P0001';
  end if;

  insert into public.catalog_observation_review_decision_events (
    organization_id,
    review_item_id,
    observation_id,
    catalog_product_id,
    field_family,
    event_type,
    decision_type,
    reason_code,
    reviewer_note,
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
    reversal_target_event_id,
    lifecycle_reason,
    apply_eligible,
    apply_block_reasons,
    field_risk
  ) values (
    v_org_id,
    input_review_item_id,
    v_target.observation_id,
    v_target.catalog_product_id,
    v_target.field_family,
    'DECISION_REVERSED',
    null,
    input_reason_code,
    nullif(input_reviewer_note, ''),
    v_actor_id,
    lower(coalesce(v_profile.role, '')),
    jsonb_build_object('role', lower(coalesce(v_profile.role, '')), 'is_active', coalesce(v_profile.is_active, true)),
    v_target.recommendation_fingerprint,
    v_target.review_item_fingerprint,
    v_target.observation_fingerprint,
    v_target.product_target_fingerprint,
    v_current_version,
    v_current_version + 1,
    input_idempotency_key,
    v_payload_hash,
    v_target.event_id,
    input_reason_code,
    false,
    array['DECISION_REVERSED']::text[],
    v_target.field_risk
  ) returning * into v_event;

  return jsonb_build_object(
    'event', to_jsonb(v_event),
    'current_state', public.get_catalog_observation_review_decision_state(input_review_item_id),
    'idempotency_replay', false
  );
end;
$$;

revoke all on function public.reverse_catalog_observation_review_decision(text, uuid, text, text, integer, text) from public, anon, authenticated, service_role;
grant execute on function public.reverse_catalog_observation_review_decision(text, uuid, text, text, integer, text) to authenticated, service_role;

comment on function public.reverse_catalog_observation_review_decision(text, uuid, text, text, integer, text) is
  'WP2-F1 append-only reversal command. Original decision events are preserved unchanged.';
