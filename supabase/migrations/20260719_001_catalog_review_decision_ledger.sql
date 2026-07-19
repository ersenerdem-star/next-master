-- NM-CATALOG-WP2-F1-DB: Controlled Human Decision Ledger
-- Scope: decision recording only. No Product apply, Product mutation, observation mutation, or recommendation mutation.

create table if not exists public.catalog_observation_review_decision_events (
  event_id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  review_item_id text not null,
  observation_id uuid not null references public.catalog_external_observations(id) on delete restrict,
  catalog_product_id uuid not null references public.catalog_products(id) on delete restrict,
  field_family text not null,
  event_type text not null,
  decision_type text,
  reason_code text not null,
  reviewer_note text,
  reviewer_user_id uuid not null references public.profiles(id) on delete restrict,
  reviewer_role text not null,
  reviewer_capability_snapshot jsonb not null default '{}'::jsonb,
  recommendation_fingerprint text not null,
  review_item_fingerprint text not null,
  observation_fingerprint text not null,
  product_target_fingerprint text not null,
  expected_prior_decision_version integer not null,
  resulting_decision_version integer not null,
  idempotency_key text not null,
  idempotency_payload_hash text not null,
  supersedes_event_id uuid references public.catalog_observation_review_decision_events(event_id) on delete restrict,
  reversal_target_event_id uuid references public.catalog_observation_review_decision_events(event_id) on delete restrict,
  lifecycle_reason text,
  correlation_id text,
  apply_eligible boolean not null default false,
  apply_block_reasons text[] not null default array[]::text[],
  field_risk text not null,
  created_at timestamptz not null default now(),
  constraint catalog_review_decision_event_type_check check (
    event_type in ('DECISION_RECORDED', 'DECISION_REVERSED', 'DECISION_SUPERSEDED', 'DECISION_INVALIDATED')
  ),
  constraint catalog_review_decision_type_check check (
    decision_type is null
    or decision_type in ('ACCEPT_RECOMMENDATION', 'REJECT_RECOMMENDATION', 'DEFER', 'REQUEST_MORE_EVIDENCE')
  ),
  constraint catalog_review_decision_event_decision_shape_check check (
    (event_type = 'DECISION_RECORDED' and decision_type is not null)
    or (event_type <> 'DECISION_RECORDED' and decision_type is null)
  ),
  constraint catalog_review_decision_version_check check (
    expected_prior_decision_version >= 0 and resulting_decision_version > 0
  ),
  constraint catalog_review_decision_version_progression_check check (
    resulting_decision_version = expected_prior_decision_version + 1
  ),
  constraint catalog_review_decision_reason_present_check check (length(btrim(reason_code)) > 0),
  constraint catalog_review_decision_review_item_present_check check (length(btrim(review_item_id)) > 0),
  constraint catalog_review_decision_idempotency_present_check check (length(btrim(idempotency_key)) > 0),
  constraint catalog_review_decision_fingerprints_present_check check (
    length(btrim(recommendation_fingerprint)) > 0
    and length(btrim(review_item_fingerprint)) > 0
    and length(btrim(observation_fingerprint)) > 0
    and length(btrim(product_target_fingerprint)) > 0
  ),
  constraint catalog_review_decision_field_risk_check check (
    field_risk in ('LOW_RISK', 'GUARDED', 'HIGH_RISK_OR_PROHIBITED_FOR_APPLY')
  )
);

create unique index if not exists uq_catalog_review_decision_version
  on public.catalog_observation_review_decision_events (organization_id, review_item_id, resulting_decision_version);

create unique index if not exists uq_catalog_review_decision_idempotency
  on public.catalog_observation_review_decision_events (organization_id, review_item_id, idempotency_key);

create index if not exists idx_catalog_review_decision_current
  on public.catalog_observation_review_decision_events (organization_id, review_item_id, resulting_decision_version desc, created_at desc);

create index if not exists idx_catalog_review_decision_observation
  on public.catalog_observation_review_decision_events (organization_id, observation_id, created_at desc);

create index if not exists idx_catalog_review_decision_reviewer
  on public.catalog_observation_review_decision_events (organization_id, reviewer_user_id, created_at desc);

alter table public.catalog_observation_review_decision_events enable row level security;

revoke all privileges on table public.catalog_observation_review_decision_events from public, anon, authenticated, service_role;
grant select on public.catalog_observation_review_decision_events to authenticated, service_role;

drop policy if exists catalog_review_decision_events_select_admin_org on public.catalog_observation_review_decision_events;
create policy catalog_review_decision_events_select_admin_org
on public.catalog_observation_review_decision_events
for select
using (
  auth.uid() is not null
  and organization_id = public.current_profile_org_id()
  and exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.organization_id = catalog_observation_review_decision_events.organization_id
      and coalesce(p.is_active, true)
      and lower(coalesce(p.role, '')) in ('admin', 'superadmin')
  )
);

create or replace function public.prevent_catalog_review_decision_event_mutation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  raise exception 'Catalog review decision ledger is append-only'
    using errcode = 'P0001';
end;
$$;

revoke all on function public.prevent_catalog_review_decision_event_mutation() from public, anon, authenticated, service_role;

drop trigger if exists trg_catalog_review_decision_events_append_only on public.catalog_observation_review_decision_events;
create trigger trg_catalog_review_decision_events_append_only
before update or delete
on public.catalog_observation_review_decision_events
for each row
execute function public.prevent_catalog_review_decision_event_mutation();

create or replace function public.catalog_review_decision_field_risk(input_field_family text)
returns text
language sql
stable
set search_path = public
as $$
  select case
    when input_field_family in ('image_reference', 'supplemental_description') then 'LOW_RISK'
    when input_field_family in ('weight', 'origin', 'hs_code') then 'GUARDED'
    else 'HIGH_RISK_OR_PROHIBITED_FOR_APPLY'
  end;
$$;

revoke all on function public.catalog_review_decision_field_risk(text) from public, anon, authenticated, service_role;
grant execute on function public.catalog_review_decision_field_risk(text) to authenticated, service_role;

create or replace function public.catalog_review_decision_reason_is_allowed(input_event_type text, input_decision_type text, input_reason_code text)
returns boolean
language sql
stable
set search_path = public
as $$
  select case
    when input_event_type = 'DECISION_RECORDED' and input_decision_type = 'ACCEPT_RECOMMENDATION' then input_reason_code in (
      'EVIDENCE_SUFFICIENT',
      'VERIFIED_AGAINST_CURRENT_PRODUCT',
      'TRUSTED_OFFICIAL_SOURCE'
    )
    when input_event_type = 'DECISION_RECORDED' and input_decision_type = 'REJECT_RECOMMENDATION' then input_reason_code in (
      'INCORRECT_OBSERVATION',
      'INSUFFICIENT_EVIDENCE',
      'CONFLICTS_WITH_CANONICAL_DATA',
      'WRONG_PRODUCT_MATCH',
      'FIELD_NOT_APPLICABLE'
    )
    when input_event_type = 'DECISION_RECORDED' and input_decision_type = 'DEFER' then input_reason_code in (
      'NEEDS_SECOND_REVIEW',
      'WAITING_FOR_SOURCE_CONFIRMATION',
      'TEMPORARY_REVIEW_HOLD'
    )
    when input_event_type = 'DECISION_RECORDED' and input_decision_type = 'REQUEST_MORE_EVIDENCE' then input_reason_code in (
      'MISSING_PRIMARY_SOURCE',
      'CONFLICTING_SOURCES',
      'LOW_CONFIDENCE',
      'INCOMPLETE_PRODUCT_MATCH'
    )
    when input_event_type = 'DECISION_REVERSED' then input_reason_code in (
      'DECISION_ENTERED_IN_ERROR',
      'NEW_EVIDENCE_RECEIVED',
      'RECOMMENDATION_CHANGED',
      'PRODUCT_STATE_CHANGED'
    )
    when input_event_type in ('DECISION_SUPERSEDED', 'DECISION_INVALIDATED') then length(btrim(coalesce(input_reason_code, ''))) > 0
    else false
  end;
$$;

revoke all on function public.catalog_review_decision_reason_is_allowed(text, text, text) from public, anon, authenticated, service_role;
grant execute on function public.catalog_review_decision_reason_is_allowed(text, text, text) to authenticated, service_role;

create or replace function public.catalog_review_product_target_value(input_field_family text, input_product public.catalog_products)
returns text
language plpgsql
stable
set search_path = public
as $$
begin
  if input_field_family = 'image_reference' then
    return coalesce(input_product.image_url, '');
  elsif input_field_family = 'supplemental_description' then
    return coalesce(input_product.description, '');
  elsif input_field_family = 'weight' then
    return coalesce(input_product.weight_kg::text, '');
  elsif input_field_family = 'origin' then
    return coalesce(input_product.origin, '');
  elsif input_field_family = 'hs_code' then
    return coalesce(input_product.hs_code, '');
  end if;
  return '';
end;
$$;

revoke all on function public.catalog_review_product_target_value(text, public.catalog_products) from public, anon, authenticated, service_role;
grant execute on function public.catalog_review_product_target_value(text, public.catalog_products) to authenticated, service_role;

create or replace function public.catalog_review_hash(input_label text, input_payload text)
returns text
language sql
immutable
set search_path = public
as $$
  select md5(coalesce(input_label, '') || ':v1:' || coalesce(input_payload, ''));
$$;

revoke all on function public.catalog_review_hash(text, text) from public, anon, authenticated, service_role;
grant execute on function public.catalog_review_hash(text, text) to authenticated, service_role;

create or replace function public.catalog_review_observation_fingerprint(input_observation public.catalog_external_observations)
returns text
language sql
stable
set search_path = public
as $$
  select public.catalog_review_hash(
    'observation',
    concat_ws('|',
      input_observation.id::text,
      input_observation.organization_id::text,
      input_observation.catalog_product_id::text,
      coalesce(input_observation.field_family, ''),
      coalesce(input_observation.raw_value, ''),
      coalesce(input_observation.normalized_value, ''),
      coalesce(input_observation.evidence_reference, ''),
      coalesce(input_observation.evidence_hash, ''),
      coalesce(input_observation.evidence_url, ''),
      coalesce(input_observation.confidence::text, ''),
      coalesce(input_observation.deduplication_key, '')
    )
  );
$$;

revoke all on function public.catalog_review_observation_fingerprint(public.catalog_external_observations) from public, anon, authenticated, service_role;
grant execute on function public.catalog_review_observation_fingerprint(public.catalog_external_observations) to authenticated, service_role;

create or replace function public.catalog_review_product_target_fingerprint(input_field_family text, input_product public.catalog_products)
returns text
language sql
stable
set search_path = public
as $$
  select public.catalog_review_hash(
    'product_target',
    concat_ws('|',
      input_product.id::text,
      coalesce(input_field_family, ''),
      public.catalog_review_product_target_value(input_field_family, input_product),
      coalesce(input_product.updated_at::text, '')
    )
  );
$$;

revoke all on function public.catalog_review_product_target_fingerprint(text, public.catalog_products) from public, anon, authenticated, service_role;
grant execute on function public.catalog_review_product_target_fingerprint(text, public.catalog_products) to authenticated, service_role;

create or replace function public.catalog_review_item_fingerprint(
  input_review_item_id text,
  input_observation public.catalog_external_observations,
  input_product public.catalog_products
)
returns text
language sql
stable
set search_path = public
as $$
  select public.catalog_review_hash(
    'review_item',
    concat_ws('|',
      coalesce(input_review_item_id, ''),
      public.catalog_review_observation_fingerprint(input_observation),
      public.catalog_review_product_target_fingerprint(input_observation.field_family, input_product)
    )
  );
$$;

revoke all on function public.catalog_review_item_fingerprint(text, public.catalog_external_observations, public.catalog_products) from public, anon, authenticated, service_role;
grant execute on function public.catalog_review_item_fingerprint(text, public.catalog_external_observations, public.catalog_products) to authenticated, service_role;

create or replace function public.catalog_review_parse_review_item_id(input_review_item_id text)
returns table (
  organization_id uuid,
  catalog_product_id uuid,
  observation_id uuid,
  field_family text
)
language plpgsql
stable
set search_path = public
as $$
declare
  v_parts text[];
begin
  v_parts := string_to_array(coalesce(input_review_item_id, ''), ':');
  if array_length(v_parts, 1) <> 4 then
    raise exception 'CATALOG_REVIEW_ITEM_MISSING: invalid review item id'
      using errcode = 'P0001';
  end if;

  organization_id := v_parts[1]::uuid;
  catalog_product_id := v_parts[2]::uuid;
  observation_id := v_parts[3]::uuid;
  field_family := v_parts[4];
  return next;
exception
  when invalid_text_representation then
    raise exception 'CATALOG_REVIEW_ITEM_MISSING: invalid review item id'
      using errcode = 'P0001';
end;
$$;

revoke all on function public.catalog_review_parse_review_item_id(text) from public, anon, authenticated, service_role;
grant execute on function public.catalog_review_parse_review_item_id(text) to authenticated, service_role;

create or replace function public.catalog_review_current_version(input_organization_id uuid, input_review_item_id text)
returns integer
language sql
stable
set search_path = public
as $$
  select coalesce(max(e.resulting_decision_version), 0)::integer
  from public.catalog_observation_review_decision_events e
  where e.organization_id = input_organization_id
    and e.review_item_id = input_review_item_id;
$$;

revoke all on function public.catalog_review_current_version(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.catalog_review_current_version(uuid, text) to authenticated, service_role;

create or replace function public.get_catalog_observation_review_decision_state(
  input_review_item_id text,
  input_current_recommendation_fingerprint text default null,
  input_current_review_item_fingerprint text default null,
  input_current_product_target_fingerprint text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_id uuid := public.current_profile_org_id();
  v_event public.catalog_observation_review_decision_events%rowtype;
  v_state text := 'UNDECIDED';
  v_stale_reasons text[] := array[]::text[];
  v_apply_block_reasons text[] := array[]::text[];
  v_apply_eligible boolean := false;
begin
  if v_org_id is null then
    raise exception 'CATALOG_REVIEW_DECISION_UNAUTHORIZED: active profile required'
      using errcode = 'P0001';
  end if;

  select * into v_event
  from public.catalog_observation_review_decision_events e
  where e.organization_id = v_org_id
    and e.review_item_id = input_review_item_id
  order by e.resulting_decision_version desc, e.created_at desc, e.event_id desc
  limit 1;

  if not found then
    return jsonb_build_object(
      'organization_id', v_org_id,
      'review_item_id', input_review_item_id,
      'current_decision', 'UNDECIDED',
      'current_event_id', null,
      'reviewer_user_id', null,
      'reviewer_role', null,
      'decided_at', null,
      'decision_version', 0,
      'is_reversed', false,
      'is_superseded', false,
      'is_invalidated', false,
      'is_stale', false,
      'requires_re_review', false,
      'recommendation_fingerprint_at_decision', null,
      'current_recommendation_fingerprint', input_current_recommendation_fingerprint,
      'review_item_fingerprint_at_decision', null,
      'current_review_item_fingerprint', input_current_review_item_fingerprint,
      'product_target_fingerprint_at_decision', null,
      'current_product_target_fingerprint', input_current_product_target_fingerprint,
      'apply_eligible', false,
      'apply_block_reasons', array['NO_ACCEPT_DECISION']
    );
  end if;

  if input_current_recommendation_fingerprint is not null
    and input_current_recommendation_fingerprint <> v_event.recommendation_fingerprint then
    v_stale_reasons := array_append(v_stale_reasons, 'RECOMMENDATION_CHANGED');
  end if;
  if input_current_review_item_fingerprint is not null
    and input_current_review_item_fingerprint <> v_event.review_item_fingerprint then
    v_stale_reasons := array_append(v_stale_reasons, 'REVIEW_ITEM_CHANGED');
  end if;
  if input_current_product_target_fingerprint is not null
    and input_current_product_target_fingerprint <> v_event.product_target_fingerprint then
    v_stale_reasons := array_append(v_stale_reasons, 'PRODUCT_TARGET_CHANGED');
  end if;

  if v_event.event_type = 'DECISION_REVERSED' then
    v_state := 'REVERSED';
  elsif v_event.event_type = 'DECISION_SUPERSEDED' then
    v_state := 'SUPERSEDED';
  elsif v_event.event_type = 'DECISION_INVALIDATED' then
    v_state := 'INVALIDATED';
  elsif array_length(v_stale_reasons, 1) is not null then
    v_state := 'STALE';
  else
    v_state := v_event.decision_type;
  end if;

  if v_state <> 'ACCEPT_RECOMMENDATION' then
    v_apply_block_reasons := array_append(v_apply_block_reasons, 'NO_ACCEPT_DECISION');
  end if;
  if array_length(v_stale_reasons, 1) is not null then
    v_apply_block_reasons := v_apply_block_reasons || v_stale_reasons;
  end if;
  if v_event.event_type = 'DECISION_REVERSED' then
    v_apply_block_reasons := array_append(v_apply_block_reasons, 'DECISION_REVERSED');
  end if;
  if v_event.event_type = 'DECISION_SUPERSEDED' then
    v_apply_block_reasons := array_append(v_apply_block_reasons, 'DECISION_SUPERSEDED');
  end if;
  if v_event.event_type = 'DECISION_INVALIDATED' then
    v_apply_block_reasons := array_append(v_apply_block_reasons, 'DECISION_INVALIDATED');
  end if;
  if v_event.field_risk <> 'LOW_RISK' then
    v_apply_block_reasons := array_append(v_apply_block_reasons, 'FIELD_POLICY_PROHIBITS_APPLY');
  end if;

  v_apply_eligible := v_state = 'ACCEPT_RECOMMENDATION'
    and v_event.field_risk = 'LOW_RISK'
    and array_length(v_apply_block_reasons, 1) is null;

  return jsonb_build_object(
    'organization_id', v_event.organization_id,
    'review_item_id', v_event.review_item_id,
    'current_decision', v_state,
    'current_event_id', v_event.event_id,
    'reviewer_user_id', v_event.reviewer_user_id,
    'reviewer_role', v_event.reviewer_role,
    'decided_at', v_event.created_at,
    'decision_version', v_event.resulting_decision_version,
    'is_reversed', v_event.event_type = 'DECISION_REVERSED',
    'is_superseded', v_event.event_type = 'DECISION_SUPERSEDED',
    'is_invalidated', v_event.event_type = 'DECISION_INVALIDATED',
    'is_stale', array_length(v_stale_reasons, 1) is not null,
    'requires_re_review', array_length(v_stale_reasons, 1) is not null or v_event.event_type in ('DECISION_REVERSED', 'DECISION_INVALIDATED'),
    'recommendation_fingerprint_at_decision', v_event.recommendation_fingerprint,
    'current_recommendation_fingerprint', coalesce(input_current_recommendation_fingerprint, v_event.recommendation_fingerprint),
    'review_item_fingerprint_at_decision', v_event.review_item_fingerprint,
    'current_review_item_fingerprint', coalesce(input_current_review_item_fingerprint, v_event.review_item_fingerprint),
    'product_target_fingerprint_at_decision', v_event.product_target_fingerprint,
    'current_product_target_fingerprint', coalesce(input_current_product_target_fingerprint, v_event.product_target_fingerprint),
    'apply_eligible', v_apply_eligible,
    'apply_block_reasons', coalesce(v_apply_block_reasons, array[]::text[])
  );
end;
$$;

revoke all on function public.get_catalog_observation_review_decision_state(text, text, text, text) from public, anon, authenticated, service_role;
grant execute on function public.get_catalog_observation_review_decision_state(text, text, text, text) to authenticated, service_role;

create or replace function public.record_catalog_observation_review_decision(
  input_review_item_id text,
  input_decision_type text,
  input_reason_code text,
  input_reviewer_note text,
  input_expected_decision_version integer,
  input_expected_recommendation_fingerprint text,
  input_expected_review_item_fingerprint text,
  input_expected_product_target_fingerprint text,
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
  v_parsed record;
  v_observation public.catalog_external_observations%rowtype;
  v_product public.catalog_products%rowtype;
  v_current_version integer;
  v_next_version integer;
  v_event public.catalog_observation_review_decision_events%rowtype;
  v_existing public.catalog_observation_review_decision_events%rowtype;
  v_field_risk text;
  v_apply_eligible boolean := false;
  v_apply_block_reasons text[] := array[]::text[];
  v_observation_fingerprint text;
  v_product_target_fingerprint text;
  v_review_item_fingerprint text;
  v_payload_hash text;
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

  if input_decision_type not in ('ACCEPT_RECOMMENDATION', 'REJECT_RECOMMENDATION', 'DEFER', 'REQUEST_MORE_EVIDENCE') then
    raise exception 'CATALOG_REVIEW_DECISION_INVALID_TRANSITION: invalid decision type'
      using errcode = 'P0001';
  end if;

  if not public.catalog_review_decision_reason_is_allowed('DECISION_RECORDED', input_decision_type, input_reason_code) then
    raise exception 'CATALOG_REVIEW_DECISION_INVALID_REASON: reason code is not allowed for decision'
      using errcode = 'P0001';
  end if;

  if coalesce(input_expected_decision_version, -1) < 0 then
    raise exception 'CATALOG_REVIEW_DECISION_CONFLICT: expected version is required'
      using errcode = 'P0001';
  end if;

  if length(btrim(coalesce(input_expected_recommendation_fingerprint, ''))) = 0
    or length(btrim(coalesce(input_expected_review_item_fingerprint, ''))) = 0
    or length(btrim(coalesce(input_expected_product_target_fingerprint, ''))) = 0
    or length(btrim(coalesce(input_idempotency_key, ''))) = 0 then
    raise exception 'CATALOG_REVIEW_DECISION_CONFLICT: expected fingerprints and idempotency key are required'
      using errcode = 'P0001';
  end if;

  select * into v_parsed from public.catalog_review_parse_review_item_id(input_review_item_id);
  if v_parsed.organization_id <> v_org_id then
    raise exception 'CATALOG_REVIEW_DECISION_ORGANIZATION_MISMATCH: review item organization mismatch'
      using errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_org_id::text || ':' || input_review_item_id, 0));

  select * into v_observation
  from public.catalog_external_observations o
  where o.id = v_parsed.observation_id
    and o.organization_id = v_org_id
    and o.catalog_product_id = v_parsed.catalog_product_id
    and o.field_family = v_parsed.field_family
  limit 1;

  if not found then
    raise exception 'CATALOG_REVIEW_ITEM_MISSING: observation is not part of review item'
      using errcode = 'P0001';
  end if;

  select * into v_product
  from public.catalog_products p
  where p.id = v_parsed.catalog_product_id
    and p.organization_id = v_org_id
  limit 1;

  if not found then
    raise exception 'CATALOG_REVIEW_ITEM_MISSING: Product is not part of review item'
      using errcode = 'P0001';
  end if;

  v_observation_fingerprint := public.catalog_review_observation_fingerprint(v_observation);
  v_product_target_fingerprint := public.catalog_review_product_target_fingerprint(v_parsed.field_family, v_product);
  v_review_item_fingerprint := public.catalog_review_item_fingerprint(input_review_item_id, v_observation, v_product);

  if v_review_item_fingerprint <> input_expected_review_item_fingerprint then
    raise exception 'CATALOG_REVIEW_DECISION_REVIEW_FINGERPRINT_MISMATCH: review item changed'
      using errcode = 'P0001';
  end if;
  if v_product_target_fingerprint <> input_expected_product_target_fingerprint then
    raise exception 'CATALOG_REVIEW_DECISION_PRODUCT_TARGET_MISMATCH: Product target changed'
      using errcode = 'P0001';
  end if;

  v_payload_hash := public.catalog_review_hash(
    'decision_payload',
    concat_ws('|',
      v_org_id::text,
      input_review_item_id,
      input_decision_type,
      input_reason_code,
      coalesce(input_reviewer_note, ''),
      input_expected_decision_version::text,
      input_expected_recommendation_fingerprint,
      input_expected_review_item_fingerprint,
      input_expected_product_target_fingerprint,
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
      'current_state', public.get_catalog_observation_review_decision_state(
        input_review_item_id,
        input_expected_recommendation_fingerprint,
        input_expected_review_item_fingerprint,
        input_expected_product_target_fingerprint
      ),
      'idempotency_replay', true
    );
  end if;

  v_current_version := public.catalog_review_current_version(v_org_id, input_review_item_id);
  if v_current_version <> input_expected_decision_version then
    raise exception 'CATALOG_REVIEW_DECISION_CONFLICT: expected version does not match current version'
      using errcode = 'P0001';
  end if;

  v_next_version := v_current_version + 1;
  v_field_risk := public.catalog_review_decision_field_risk(v_parsed.field_family);

  if input_decision_type <> 'ACCEPT_RECOMMENDATION' then
    v_apply_block_reasons := array_append(v_apply_block_reasons, 'NO_ACCEPT_DECISION');
  end if;
  if v_field_risk <> 'LOW_RISK' then
    v_apply_block_reasons := array_append(v_apply_block_reasons, 'FIELD_POLICY_PROHIBITS_APPLY');
  end if;
  v_apply_eligible := input_decision_type = 'ACCEPT_RECOMMENDATION'
    and v_field_risk = 'LOW_RISK'
    and array_length(v_apply_block_reasons, 1) is null;

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
    lifecycle_reason,
    apply_eligible,
    apply_block_reasons,
    field_risk
  ) values (
    v_org_id,
    input_review_item_id,
    v_observation.id,
    v_product.id,
    v_parsed.field_family,
    'DECISION_RECORDED',
    input_decision_type,
    input_reason_code,
    nullif(input_reviewer_note, ''),
    v_actor_id,
    lower(coalesce(v_profile.role, '')),
    jsonb_build_object('role', lower(coalesce(v_profile.role, '')), 'is_active', coalesce(v_profile.is_active, true)),
    input_expected_recommendation_fingerprint,
    v_review_item_fingerprint,
    v_observation_fingerprint,
    v_product_target_fingerprint,
    v_current_version,
    v_next_version,
    input_idempotency_key,
    v_payload_hash,
    input_reason_code,
    v_apply_eligible,
    coalesce(v_apply_block_reasons, array[]::text[]),
    v_field_risk
  ) returning * into v_event;

  return jsonb_build_object(
    'event', to_jsonb(v_event),
    'current_state', public.get_catalog_observation_review_decision_state(
      input_review_item_id,
      input_expected_recommendation_fingerprint,
      v_review_item_fingerprint,
      v_product_target_fingerprint
    ),
    'idempotency_replay', false
  );
end;
$$;

revoke all on function public.record_catalog_observation_review_decision(text, text, text, text, integer, text, text, text, text) from public, anon, authenticated, service_role;
grant execute on function public.record_catalog_observation_review_decision(text, text, text, text, integer, text, text, text, text) to authenticated, service_role;

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
  v_current_version integer;
  v_payload_hash text;
  v_existing public.catalog_observation_review_decision_events%rowtype;
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

  v_current_version := public.catalog_review_current_version(v_org_id, input_review_item_id);
  if v_current_version <> input_expected_decision_version then
    raise exception 'CATALOG_REVIEW_DECISION_CONFLICT: expected version does not match current version'
      using errcode = 'P0001';
  end if;
  if v_target.resulting_decision_version <> v_current_version then
    raise exception 'CATALOG_REVIEW_DECISION_INVALID_TRANSITION: only current decision can be reversed'
      using errcode = 'P0001';
  end if;

  v_payload_hash := public.catalog_review_hash(
    'reversal_payload',
    concat_ws('|', v_org_id::text, input_review_item_id, input_reversal_target_event_id::text, input_reason_code, coalesce(input_reviewer_note, ''), input_expected_decision_version::text, input_idempotency_key, v_actor_id::text)
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
    return jsonb_build_object('event', to_jsonb(v_existing), 'current_state', public.get_catalog_observation_review_decision_state(input_review_item_id), 'idempotency_replay', true);
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

  return jsonb_build_object('event', to_jsonb(v_event), 'current_state', public.get_catalog_observation_review_decision_state(input_review_item_id), 'idempotency_replay', false);
end;
$$;

revoke all on function public.reverse_catalog_observation_review_decision(text, uuid, text, text, integer, text) from public, anon, authenticated, service_role;
grant execute on function public.reverse_catalog_observation_review_decision(text, uuid, text, text, integer, text) to authenticated, service_role;

comment on table public.catalog_observation_review_decision_events is
  'WP2-F1 append-only human decision ledger. This table records reviewer decisions only and never applies values to catalog_products.';
comment on function public.record_catalog_observation_review_decision(text, text, text, text, integer, text, text, text, text) is
  'WP2-F1 controlled command boundary for recording a human review decision. No Product, observation, or recommendation mutation is performed.';
comment on function public.reverse_catalog_observation_review_decision(text, uuid, text, text, integer, text) is
  'WP2-F1 append-only reversal command. Original decision events are preserved unchanged.';
comment on function public.get_catalog_observation_review_decision_state(text, text, text, text) is
  'WP2-F1 current-state projection derived from append-only decision events and caller-provided current fingerprints.';
