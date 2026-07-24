-- NM-CATALOG-WP2-F2-DB: Controlled Canonical Apply for one image_reference decision.
-- Scope: DB-only transaction and append-only audit foundation. This migration does not expose
-- an Apply command to browser/API roles; F2-API requires a separately approved grant and route.

create table if not exists public.catalog_observation_review_apply_events (
  apply_event_id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  review_item_id text not null,
  decision_event_id uuid not null references public.catalog_observation_review_decision_events(event_id) on delete restrict,
  observation_id uuid not null references public.catalog_external_observations(id) on delete restrict,
  catalog_product_id uuid not null references public.catalog_products(id) on delete restrict,
  field_family text not null check (field_family = 'image_reference'),
  target_field text not null check (target_field = 'image_url'),
  decision_version integer not null check (decision_version > 0),
  before_value text not null,
  requested_value text not null,
  resulting_value text not null,
  decision_fingerprint text not null,
  review_item_fingerprint text not null,
  observation_fingerprint text not null,
  product_target_fingerprint_before text not null,
  product_target_fingerprint_after text not null,
  candidate_fingerprint text not null,
  evidence_url text,
  evidence_reference text,
  evidence_hash text,
  source_id uuid not null references public.catalog_external_sources(id) on delete restrict,
  trust_profile_id uuid not null references public.catalog_external_source_trust_profiles(id) on delete restrict,
  apply_authorizer_user_id uuid not null references public.profiles(id) on delete restrict,
  apply_authorizer_role text not null,
  apply_authorizer_capability_snapshot jsonb not null default '{}'::jsonb,
  downstream_revalidation_reason text not null,
  downstream_revalidation_requested_at timestamptz not null default now(),
  idempotency_key text not null,
  idempotency_payload_hash text not null,
  outcome text not null default 'APPLIED' check (outcome = 'APPLIED'),
  created_at timestamptz not null default now(),
  constraint catalog_review_apply_review_item_present_check check (length(btrim(review_item_id)) > 0),
  constraint catalog_review_apply_idempotency_present_check check (length(btrim(idempotency_key)) > 0),
  constraint catalog_review_apply_requested_value_present_check check (length(btrim(requested_value)) > 0),
  constraint catalog_review_apply_result_matches_request_check check (resulting_value = requested_value),
  constraint catalog_review_apply_fingerprints_present_check check (
    length(btrim(decision_fingerprint)) > 0
    and length(btrim(review_item_fingerprint)) > 0
    and length(btrim(observation_fingerprint)) > 0
    and length(btrim(product_target_fingerprint_before)) > 0
    and length(btrim(product_target_fingerprint_after)) > 0
    and length(btrim(candidate_fingerprint)) > 0
  )
);

create unique index if not exists uq_catalog_review_apply_idempotency
  on public.catalog_observation_review_apply_events (organization_id, review_item_id, idempotency_key);

create unique index if not exists uq_catalog_review_apply_decision
  on public.catalog_observation_review_apply_events (organization_id, decision_event_id);

create index if not exists idx_catalog_review_apply_product
  on public.catalog_observation_review_apply_events (organization_id, catalog_product_id, created_at desc);

alter table public.catalog_observation_review_apply_events enable row level security;

revoke all privileges on table public.catalog_observation_review_apply_events from public, anon, authenticated, service_role;
grant select on public.catalog_observation_review_apply_events to authenticated, service_role;

drop policy if exists catalog_review_apply_events_select_admin_org on public.catalog_observation_review_apply_events;
create policy catalog_review_apply_events_select_admin_org
on public.catalog_observation_review_apply_events
for select
to authenticated
using (
  auth.uid() is not null
  and organization_id = public.current_profile_org_id()
  and exists (
    select 1
    from public.profiles p
    where p.id = auth.uid()
      and p.organization_id = catalog_observation_review_apply_events.organization_id
      and coalesce(p.is_active, true)
      and lower(coalesce(p.role, '')) in ('admin', 'superadmin')
  )
);

create or replace function public.prevent_catalog_review_apply_event_mutation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  raise exception 'Catalog review apply ledger is append-only'
    using errcode = 'P0001';
end;
$$;

revoke all on function public.prevent_catalog_review_apply_event_mutation() from public, anon, authenticated, service_role;

drop trigger if exists trg_catalog_review_apply_events_append_only on public.catalog_observation_review_apply_events;
create trigger trg_catalog_review_apply_events_append_only
before update or delete
on public.catalog_observation_review_apply_events
for each row
execute function public.prevent_catalog_review_apply_event_mutation();

create or replace function public.apply_catalog_observation_review_image(
  input_review_item_id text,
  input_decision_event_id uuid,
  input_expected_decision_version integer,
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
  v_existing public.catalog_observation_review_apply_events%rowtype;
  v_decision public.catalog_observation_review_decision_events%rowtype;
  v_observation public.catalog_external_observations%rowtype;
  v_product public.catalog_products%rowtype;
  v_product_after public.catalog_products%rowtype;
  v_source public.catalog_external_sources%rowtype;
  v_trust public.catalog_external_source_trust_profiles%rowtype;
  v_current_version integer;
  v_candidate text;
  v_payload_hash text;
  v_observation_fingerprint text;
  v_product_target_fingerprint_before text;
  v_product_target_fingerprint_after text;
  v_review_item_fingerprint text;
  v_decision_fingerprint text;
  v_candidate_fingerprint text;
  v_apply_event public.catalog_observation_review_apply_events%rowtype;
begin
  if v_actor_id is null or v_org_id is null then
    raise exception 'CATALOG_REVIEW_APPLY_UNAUTHORIZED: active profile required'
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
    raise exception 'CATALOG_REVIEW_APPLY_UNAUTHORIZED: admin or superadmin required'
      using errcode = 'P0001';
  end if;

  if input_decision_event_id is null
    or coalesce(input_expected_decision_version, -1) < 1
    or length(btrim(coalesce(input_expected_review_item_fingerprint, ''))) = 0
    or length(btrim(coalesce(input_expected_product_target_fingerprint, ''))) = 0
    or length(btrim(coalesce(input_idempotency_key, ''))) = 0 then
    raise exception 'CATALOG_REVIEW_APPLY_CONFLICT: decision, expected fingerprints, version, and idempotency key are required'
      using errcode = 'P0001';
  end if;

  select * into v_parsed from public.catalog_review_parse_review_item_id(input_review_item_id);
  if v_parsed.organization_id <> v_org_id then
    raise exception 'CATALOG_REVIEW_APPLY_ORGANIZATION_MISMATCH: review item organization mismatch'
      using errcode = 'P0001';
  end if;
  if v_parsed.field_family <> 'image_reference' then
    raise exception 'CATALOG_REVIEW_APPLY_FIELD_POLICY_BLOCKED: only image_reference is permitted'
      using errcode = 'P0001';
  end if;

  v_payload_hash := public.catalog_review_hash(
    'apply_image_payload',
    concat_ws('|',
      v_org_id::text,
      input_review_item_id,
      input_decision_event_id::text,
      input_expected_decision_version::text,
      input_expected_review_item_fingerprint,
      input_expected_product_target_fingerprint,
      input_idempotency_key,
      v_actor_id::text
    )
  );

  select * into v_existing
  from public.catalog_observation_review_apply_events e
  where e.organization_id = v_org_id
    and e.review_item_id = input_review_item_id
    and e.idempotency_key = input_idempotency_key
  limit 1;

  if found then
    if v_existing.idempotency_payload_hash <> v_payload_hash then
      raise exception 'CATALOG_REVIEW_APPLY_IDEMPOTENCY_MISMATCH: idempotency key payload changed'
        using errcode = 'P0001';
    end if;
    return jsonb_build_object('event', to_jsonb(v_existing), 'idempotency_replay', true);
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_org_id::text || ':' || input_review_item_id, 0));
  perform pg_advisory_xact_lock(hashtextextended(v_org_id::text || ':' || v_parsed.catalog_product_id::text || ':image_url', 0));

  select * into v_existing
  from public.catalog_observation_review_apply_events e
  where e.organization_id = v_org_id
    and e.review_item_id = input_review_item_id
    and e.idempotency_key = input_idempotency_key
  limit 1;

  if found then
    if v_existing.idempotency_payload_hash <> v_payload_hash then
      raise exception 'CATALOG_REVIEW_APPLY_IDEMPOTENCY_MISMATCH: idempotency key payload changed'
        using errcode = 'P0001';
    end if;
    return jsonb_build_object('event', to_jsonb(v_existing), 'idempotency_replay', true);
  end if;

  select * into v_observation
  from public.catalog_external_observations o
  where o.id = v_parsed.observation_id
    and o.organization_id = v_org_id
    and o.catalog_product_id = v_parsed.catalog_product_id
    and o.field_family = 'image_reference'
  limit 1;

  if not found then
    raise exception 'CATALOG_REVIEW_APPLY_ITEM_MISSING: observation is not part of review item'
      using errcode = 'P0001';
  end if;

  select * into v_product
  from public.catalog_products p
  where p.id = v_parsed.catalog_product_id
    and p.organization_id = v_org_id
  for update;

  if not found then
    raise exception 'CATALOG_REVIEW_APPLY_ITEM_MISSING: Product is not part of review item'
      using errcode = 'P0001';
  end if;

  select * into v_decision
  from public.catalog_observation_review_decision_events e
  where e.organization_id = v_org_id
    and e.review_item_id = input_review_item_id
  order by e.resulting_decision_version desc, e.created_at desc, e.event_id desc
  limit 1;

  if not found
    or v_decision.event_id <> input_decision_event_id
    or v_decision.event_type <> 'DECISION_RECORDED'
    or v_decision.decision_type <> 'ACCEPT_RECOMMENDATION'
    or not v_decision.apply_eligible
    or v_decision.field_family <> 'image_reference' then
    raise exception 'CATALOG_REVIEW_APPLY_DECISION_BLOCKED: current accepted eligible decision required'
      using errcode = 'P0001';
  end if;

  if v_decision.reviewer_user_id = v_actor_id then
    raise exception 'CATALOG_REVIEW_APPLY_AUTHORIZATION_BLOCKED: decision reviewer cannot self-authorize apply'
      using errcode = 'P0001';
  end if;

  v_current_version := public.catalog_review_current_version(v_org_id, input_review_item_id);
  if v_current_version <> input_expected_decision_version
    or v_decision.resulting_decision_version <> input_expected_decision_version then
    raise exception 'CATALOG_REVIEW_APPLY_CONFLICT: expected decision version does not match current version'
      using errcode = 'P0001';
  end if;

  v_observation_fingerprint := public.catalog_review_observation_fingerprint(v_observation);
  v_product_target_fingerprint_before := public.catalog_review_product_target_fingerprint('image_reference', v_product);
  v_review_item_fingerprint := public.catalog_review_item_fingerprint(input_review_item_id, v_observation, v_product);
  v_decision_fingerprint := public.catalog_review_hash(
    'accepted_decision',
    concat_ws('|',
      v_decision.event_id::text,
      v_decision.resulting_decision_version::text,
      v_decision.recommendation_fingerprint,
      v_decision.review_item_fingerprint,
      v_decision.observation_fingerprint,
      v_decision.product_target_fingerprint
    )
  );

  if v_observation_fingerprint <> v_decision.observation_fingerprint
    or v_review_item_fingerprint <> input_expected_review_item_fingerprint
    or v_review_item_fingerprint <> v_decision.review_item_fingerprint
    or v_product_target_fingerprint_before <> input_expected_product_target_fingerprint
    or v_product_target_fingerprint_before <> v_decision.product_target_fingerprint then
    raise exception 'CATALOG_REVIEW_APPLY_STALE: review, observation, or Product target changed'
      using errcode = 'P0001';
  end if;

  if nullif(btrim(coalesce(v_product.image_url, '')), '') is not null then
    raise exception 'CATALOG_REVIEW_APPLY_TARGET_NOT_EMPTY: image_url replacement is not permitted'
      using errcode = 'P0001';
  end if;

  select * into v_source
  from public.catalog_external_sources s
  where s.id = v_observation.source_id
    and s.organization_id = v_org_id
  limit 1;

  select * into v_trust
  from public.catalog_external_source_trust_profiles t
  where t.id = v_observation.trust_profile_id
    and t.organization_id = v_org_id
    and t.source_id = v_observation.source_id
  limit 1;

  if not found
    or not coalesce(v_source.is_active, false)
    or not coalesce(v_trust.is_active, false)
    or not coalesce(v_trust.evidence_required, false)
    or not ('image_reference' = any(coalesce(v_trust.allowed_field_families, array[]::text[])))
    -- Deliberately excludes `dimbax`, `open_web`, `internal_observation`, and
    -- `external_catalog`: Mira/Dimbax material remains a governed future intake,
    -- never a direct F2 Canonical Apply source.
    or v_source.source_type not in ('manufacturer', 'authorized_distributor', 'licensed_catalog')
    or v_source.license_posture <> 'allowed'
    or v_observation.license_posture <> 'allowed'
    or v_observation.freshness_status <> 'fresh'
    or v_trust.downstream_publication_restriction in ('restricted', 'blocked') then
    raise exception 'CATALOG_REVIEW_APPLY_SOURCE_POLICY_BLOCKED: source evidence is not eligible for canonical image apply'
      using errcode = 'P0001';
  end if;

  if nullif(btrim(coalesce(v_observation.evidence_url, '')), '') is null
    and nullif(btrim(coalesce(v_observation.evidence_reference, '')), '') is null
    and nullif(btrim(coalesce(v_observation.evidence_hash, '')), '') is null then
    raise exception 'CATALOG_REVIEW_APPLY_EVIDENCE_BLOCKED: evidence reference is required'
      using errcode = 'P0001';
  end if;

  v_candidate := btrim(coalesce(v_observation.normalized_value, ''));
  if v_candidate !~ '^https://[^/@?#[:space:]]+(?::[0-9]{1,5})?(?:/[^?#[:space:]]*)?$' then
    raise exception 'CATALOG_REVIEW_APPLY_URL_BLOCKED: candidate must be an absolute HTTPS URL without credentials, query, or fragment'
      using errcode = 'P0001';
  end if;

  v_candidate_fingerprint := public.catalog_review_hash(
    'image_candidate',
    concat_ws('|', v_candidate, coalesce(v_observation.evidence_url, ''), coalesce(v_observation.evidence_reference, ''), coalesce(v_observation.evidence_hash, ''))
  );

  update public.catalog_products
  set image_url = v_candidate,
      updated_at = now()
  where id = v_product.id
    and organization_id = v_org_id
    and nullif(btrim(coalesce(image_url, '')), '') is null
  returning * into v_product_after;

  if not found then
    raise exception 'CATALOG_REVIEW_APPLY_CONFLICT: image_url changed before apply'
      using errcode = 'P0001';
  end if;

  v_product_target_fingerprint_after := public.catalog_review_product_target_fingerprint('image_reference', v_product_after);

  -- The generic integrity trigger currently watches protected attribute fields,
  -- not image_url. Queue the bounded downstream revalidation explicitly and in
  -- the same transaction as the Product mutation and Apply audit event.
  perform public.enqueue_catalog_integrity_product(
    v_org_id,
    v_product_after.id,
    'controlled_image_apply',
    60
  );

  insert into public.catalog_observation_review_apply_events (
    organization_id,
    review_item_id,
    decision_event_id,
    observation_id,
    catalog_product_id,
    field_family,
    target_field,
    decision_version,
    before_value,
    requested_value,
    resulting_value,
    decision_fingerprint,
    review_item_fingerprint,
    observation_fingerprint,
    product_target_fingerprint_before,
    product_target_fingerprint_after,
    candidate_fingerprint,
    evidence_url,
    evidence_reference,
    evidence_hash,
    source_id,
    trust_profile_id,
    apply_authorizer_user_id,
    apply_authorizer_role,
    apply_authorizer_capability_snapshot,
    downstream_revalidation_reason,
    idempotency_key,
    idempotency_payload_hash,
    outcome
  ) values (
    v_org_id,
    input_review_item_id,
    v_decision.event_id,
    v_observation.id,
    v_product.id,
    'image_reference',
    'image_url',
    v_decision.resulting_decision_version,
    coalesce(v_product.image_url, ''),
    v_candidate,
    v_product_after.image_url,
    v_decision_fingerprint,
    v_review_item_fingerprint,
    v_observation_fingerprint,
    v_product_target_fingerprint_before,
    v_product_target_fingerprint_after,
    v_candidate_fingerprint,
    nullif(btrim(v_observation.evidence_url), ''),
    nullif(btrim(v_observation.evidence_reference), ''),
    nullif(btrim(v_observation.evidence_hash), ''),
    v_source.id,
    v_trust.id,
    v_actor_id,
    lower(coalesce(v_profile.role, '')),
    jsonb_build_object('role', lower(coalesce(v_profile.role, '')), 'is_active', coalesce(v_profile.is_active, true), 'separate_from_decision_reviewer', true),
    'controlled_image_apply',
    input_idempotency_key,
    v_payload_hash,
    'APPLIED'
  ) returning * into v_apply_event;

  return jsonb_build_object('event', to_jsonb(v_apply_event), 'idempotency_replay', false);
end;
$$;

revoke all on function public.apply_catalog_observation_review_image(text, uuid, integer, text, text, text) from public, anon, authenticated, service_role;

comment on table public.catalog_observation_review_apply_events is
  'WP2-F2 append-only controlled Apply audit ledger. Rows are created atomically with the permitted fill-only catalog_products.image_url mutation.';
comment on function public.apply_catalog_observation_review_image(text, uuid, integer, text, text, text) is
  'WP2-F2 DB-only controlled image apply transaction. It is intentionally not executable by browser or API roles until a separately approved F2-API grant and command boundary exist.';
