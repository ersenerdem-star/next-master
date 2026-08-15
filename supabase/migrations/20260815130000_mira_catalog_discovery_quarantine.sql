-- NM-MIRA-DISCOVERY-QUARANTINE v1
--
-- Durable, review-only intake for safe MIRA evidence that cannot yet resolve
-- to one approved Catalog observation scope or one existing catalog product.
-- This migration never inserts, updates, or deletes catalog_products.

create table if not exists public.mira_catalog_discovery_intake_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  mission_id uuid not null references public.mira_missions(id) on delete cascade,
  idempotency_key text not null,
  request_fingerprint text not null,
  status text not null default 'running'
    check (status in ('running', 'succeeded', 'completed_with_warnings', 'blocked')),
  response jsonb not null default '{}'::jsonb,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, idempotency_key)
);

create table if not exists public.mira_catalog_discovery_quarantine (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  mission_id uuid not null references public.mira_missions(id) on delete cascade,
  source_key text not null,
  brand_name text not null,
  product_code text,
  normalized_code text,
  external_product_ref text,
  field_family text not null
    check (field_family in ('image_reference', 'supplemental_description', 'oem_reference', 'technical_specification', 'ean_reference')),
  field_name text not null,
  raw_value text not null,
  normalized_value text not null,
  evidence_reference text not null,
  evidence_url text not null,
  evidence_hash text,
  evidence_payload jsonb not null default '{}'::jsonb,
  confidence numeric(5,4) not null default 0.5 check (confidence between 0 and 1),
  observed_at timestamptz not null,
  quarantine_reason text not null,
  review_status text not null
    check (review_status in ('pending_source_review', 'pending_brand_review', 'pending_product_review', 'pending_scope_review', 'accepted', 'rejected')),
  deduplication_key text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, deduplication_key)
);

create index if not exists idx_mira_catalog_discovery_request_status
  on public.mira_catalog_discovery_intake_requests (organization_id, status, updated_at desc);

create index if not exists idx_mira_catalog_discovery_quarantine_review
  on public.mira_catalog_discovery_quarantine (organization_id, review_status, created_at desc);

create index if not exists idx_mira_catalog_discovery_quarantine_mission
  on public.mira_catalog_discovery_quarantine (organization_id, mission_id, created_at desc);

create index if not exists idx_mira_catalog_discovery_quarantine_identity
  on public.mira_catalog_discovery_quarantine (organization_id, brand_name, normalized_code)
  where review_status not in ('accepted', 'rejected');

alter table public.mira_catalog_discovery_intake_requests enable row level security;
alter table public.mira_catalog_discovery_quarantine enable row level security;

revoke all privileges on table public.mira_catalog_discovery_intake_requests from public, anon, authenticated, service_role;
revoke all privileges on table public.mira_catalog_discovery_quarantine from public, anon, authenticated, service_role;

create or replace function public.ingest_mira_catalog_discovery_batch(
  input_organization_id uuid,
  input_mission_id uuid,
  input_source_key text,
  input_brand text,
  input_idempotency_key text,
  input_request_fingerprint text,
  input_quarantine_reason text,
  input_observations jsonb,
  input_metadata jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_existing public.mira_catalog_discovery_intake_requests%rowtype;
  v_mission public.mira_missions%rowtype;
  v_item jsonb;
  v_count integer;
  v_inserted integer := 0;
  v_deduped integer := 0;
  v_row_count integer := 0;
  v_review_status text;
  v_evidence_url text;
  v_evidence_host text;
  v_deduplication_key text;
  v_response jsonb;
begin
  perform public.require_catalog_observation_service_role();

  if input_organization_id is null or input_mission_id is null then
    raise exception 'MIRA discovery intake requires organization and mission';
  end if;
  if nullif(trim(input_source_key), '') is null
     or length(trim(input_source_key)) > 120
     or lower(trim(input_source_key)) !~ '^[a-z0-9][a-z0-9._:-]{0,119}$' then
    raise exception 'MIRA discovery source key is invalid';
  end if;
  if nullif(trim(input_brand), '') is null or length(trim(input_brand)) > 120 then
    raise exception 'MIRA discovery brand is invalid';
  end if;
  if nullif(trim(input_idempotency_key), '') is null or length(trim(input_idempotency_key)) > 200
     or nullif(trim(input_request_fingerprint), '') is null or length(trim(input_request_fingerprint)) > 256 then
    raise exception 'MIRA discovery idempotency input is invalid';
  end if;
  if nullif(trim(input_quarantine_reason), '') is null or length(trim(input_quarantine_reason)) > 160 then
    raise exception 'MIRA discovery quarantine reason is invalid';
  end if;
  if jsonb_typeof(coalesce(input_metadata, '{}'::jsonb)) <> 'object'
     or octet_length(coalesce(input_metadata, '{}'::jsonb)::text) > 16384
     or public.mira_jsonb_contains_restricted_key(coalesce(input_metadata, '{}'::jsonb)) then
    raise exception 'MIRA discovery metadata is invalid or contains restricted keys';
  end if;

  select * into v_mission
  from public.mira_missions
  where id = input_mission_id
    and organization_id = input_organization_id
    and status = 'processing'
  for share;
  if not found then
    raise exception 'Processing MIRA mission not found for organization';
  end if;

  if jsonb_typeof(input_observations) <> 'array' then
    raise exception 'MIRA discovery observations must be an array';
  end if;
  v_count := jsonb_array_length(input_observations);
  if v_count < 1 or v_count > 100 then
    raise exception 'MIRA discovery observations must contain 1-100 items';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(input_organization_id::text || '|' || trim(input_idempotency_key), 0));
  select * into v_existing
  from public.mira_catalog_discovery_intake_requests
  where organization_id = input_organization_id
    and idempotency_key = trim(input_idempotency_key);
  if found then
    if v_existing.request_fingerprint <> trim(input_request_fingerprint) then
      raise exception 'MIRA discovery idempotency key conflicts with a different payload';
    end if;
    return coalesce(v_existing.response, '{}'::jsonb) || jsonb_build_object('idempotent', true);
  end if;

  if input_quarantine_reason in ('SOURCE_MAPPING_MISSING', 'TRUST_MAPPING_MISSING', 'SOURCE_POLICY_BLOCKED') then
    v_review_status := 'pending_source_review';
  elsif input_quarantine_reason = 'BRAND_MAPPING_MISSING' then
    v_review_status := 'pending_brand_review';
  elsif input_quarantine_reason = 'PRODUCT_IDENTITY_MISSING' then
    v_review_status := 'pending_product_review';
  else
    v_review_status := 'pending_scope_review';
  end if;

  insert into public.mira_catalog_discovery_intake_requests (
    organization_id, mission_id, idempotency_key, request_fingerprint, status
  ) values (
    input_organization_id, input_mission_id, trim(input_idempotency_key), trim(input_request_fingerprint), 'running'
  );

  for v_item in select value from jsonb_array_elements(input_observations) loop
    if jsonb_typeof(v_item) <> 'object' then
      raise exception 'MIRA discovery observation must be an object';
    end if;
    if coalesce(v_item->>'writeDisposition', '') <> 'observation-staging-only' then
      raise exception 'MIRA discovery observation write disposition is blocked';
    end if;
    if coalesce(v_item->>'field_family', '') not in ('image_reference', 'supplemental_description', 'oem_reference', 'technical_specification', 'ean_reference')
       or coalesce(v_item->>'field_name', '') !~ '^[a-z][a-z0-9_.:-]{0,159}$' then
      raise exception 'MIRA discovery observation field is invalid';
    end if;
    if nullif(trim(coalesce(v_item->>'product_code', '')), '') is null
       and nullif(trim(coalesce(v_item->>'normalized_code', '')), '') is null
       and nullif(trim(coalesce(v_item->>'external_product_ref', '')), '') is null then
      raise exception 'MIRA discovery observation requires source product identity';
    end if;
    if length(coalesce(v_item->>'product_code', '')) > 300
       or length(coalesce(v_item->>'normalized_code', '')) > 300
       or length(coalesce(v_item->>'external_product_ref', '')) > 300
       or nullif(v_item->>'raw_value', '') is null or length(v_item->>'raw_value') > 12000
       or nullif(v_item->>'normalized_value', '') is null or length(v_item->>'normalized_value') > 12000
       or nullif(v_item->>'evidence_reference', '') is null or length(v_item->>'evidence_reference') > 2000 then
      raise exception 'MIRA discovery observation exceeds identity, value, or evidence bounds';
    end if;
    if (v_item->>'field_family') = 'ean_reference'
       and (v_item->>'normalized_value') !~ '^(\d{8}|\d{12,14})$' then
      raise exception 'MIRA discovery EAN/GTIN is invalid';
    end if;
    if nullif(v_item->>'observed_at', '') is null
       or (v_item->>'confidence') is null
       or (v_item->>'confidence')::numeric < 0
       or (v_item->>'confidence')::numeric > 1 then
      raise exception 'MIRA discovery timestamp or confidence is invalid';
    end if;
    if nullif(v_item->>'evidence_hash', '') is not null and (v_item->>'evidence_hash') !~ '^[0-9a-fA-F]{64}$' then
      raise exception 'MIRA discovery evidence hash is invalid';
    end if;
    if jsonb_typeof(coalesce(v_item->'evidence_payload', '{}'::jsonb)) not in ('object', 'array')
       or octet_length(coalesce(v_item->'evidence_payload', '{}'::jsonb)::text) > 16384
       or public.mira_jsonb_contains_restricted_key(coalesce(v_item->'evidence_payload', '{}'::jsonb)) then
      raise exception 'MIRA discovery evidence payload is invalid or contains restricted keys';
    end if;

    v_evidence_url := trim(coalesce(v_item->>'evidence_url', ''));
    v_evidence_host := lower(substring(v_evidence_url from '^https://([^/:?#]+)'));
    if v_evidence_url !~* '^https://[^[:space:]]+$'
       or nullif(v_evidence_host, '') is null
       or v_evidence_host = 'localhost'
       or v_evidence_host like '%.localhost'
       or v_evidence_host like '%.local'
       or v_evidence_host like '%.internal'
       or v_evidence_host like '[%'
       or v_evidence_host ~ '^(0|10|127|169\.254|172\.(1[6-9]|2[0-9]|3[01])|192\.168)(\.|$)' then
      raise exception 'MIRA discovery evidence URL is not an allowed public HTTPS origin';
    end if;

    v_deduplication_key := md5(concat_ws('|',
      input_organization_id::text,
      lower(trim(input_source_key)),
      lower(trim(input_brand)),
      trim(coalesce(v_item->>'product_code', '')),
      trim(coalesce(v_item->>'normalized_code', '')),
      trim(coalesce(v_item->>'external_product_ref', '')),
      v_item->>'field_family',
      v_item->>'field_name',
      v_item->>'normalized_value',
      v_evidence_url,
      coalesce(v_item->>'evidence_hash', '')
    ));

    insert into public.mira_catalog_discovery_quarantine (
      organization_id, mission_id, source_key, brand_name,
      product_code, normalized_code, external_product_ref,
      field_family, field_name, raw_value, normalized_value,
      evidence_reference, evidence_url, evidence_hash, evidence_payload,
      confidence, observed_at, quarantine_reason, review_status, deduplication_key
    ) values (
      input_organization_id, input_mission_id, lower(trim(input_source_key)), trim(input_brand),
      nullif(trim(coalesce(v_item->>'product_code', '')), ''),
      nullif(trim(coalesce(v_item->>'normalized_code', '')), ''),
      nullif(trim(coalesce(v_item->>'external_product_ref', '')), ''),
      v_item->>'field_family', v_item->>'field_name', v_item->>'raw_value', v_item->>'normalized_value',
      v_item->>'evidence_reference', v_evidence_url, nullif(lower(trim(coalesce(v_item->>'evidence_hash', ''))), ''),
      coalesce(v_item->'evidence_payload', '{}'::jsonb),
      (v_item->>'confidence')::numeric, (v_item->>'observed_at')::timestamptz,
      trim(input_quarantine_reason), v_review_status, v_deduplication_key
    ) on conflict (organization_id, deduplication_key) do nothing;
    get diagnostics v_row_count = row_count;
    if v_row_count = 1 then v_inserted := v_inserted + 1; else v_deduped := v_deduped + 1; end if;
  end loop;

  v_response := jsonb_build_object(
    'status', case when v_inserted > 0 then 'completed_with_warnings' else 'succeeded' end,
    'quarantined_count', v_inserted,
    'deduped_count', v_deduped,
    'review_status', v_review_status,
    'quarantine_reason', trim(input_quarantine_reason),
    'catalog_products_written', 0,
    'apply_performed', false,
    'idempotent', false
  );

  update public.mira_catalog_discovery_intake_requests
  set status = v_response->>'status', response = v_response, updated_at = now()
  where organization_id = input_organization_id and idempotency_key = trim(input_idempotency_key);

  return v_response;
end;
$$;

revoke all on function public.ingest_mira_catalog_discovery_batch(uuid, uuid, text, text, text, text, text, jsonb, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.ingest_mira_catalog_discovery_batch(uuid, uuid, text, text, text, text, text, jsonb, jsonb)
  to service_role;

comment on table public.mira_catalog_discovery_quarantine is
  'Review-only MIRA evidence awaiting source, brand, product, or observation-scope mapping. Never canonical Product data.';
comment on function public.ingest_mira_catalog_discovery_batch(uuid, uuid, text, text, text, text, text, jsonb, jsonb) is
  'Service-role-only, idempotent MIRA evidence quarantine. Never writes or applies catalog_products.';
