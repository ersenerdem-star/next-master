-- Durable, resumable provider collection for catalog review staging.
--
-- Provider pages are collected into catalog_import_stage only. They are never
-- eligible for validate_catalog_import or finalize_catalog_import.

set lock_timeout = '5s';
set statement_timeout = '300s';

alter table public.catalog_import_runs
  drop constraint if exists catalog_import_runs_status_check;

alter table public.catalog_import_runs
  add constraint catalog_import_runs_status_check
  check (status in (
    'running',
    'provider_collecting',
    'staged',
    'validating',
    'validated',
    'validation_failed',
    'finalizing',
    'finalized',
    'succeeded',
    'failed',
    'cancelled'
  ));

alter table public.catalog_import_stage
  add column if not exists source_key text,
  add column if not exists source_product_id text,
  add column if not exists source_page integer,
  add column if not exists source_offset integer,
  add column if not exists source_payload jsonb;

alter table public.catalog_import_stage
  drop constraint if exists catalog_import_stage_source_page_check;

alter table public.catalog_import_stage
  add constraint catalog_import_stage_source_page_check
  check (source_page is null or source_page >= 0);

alter table public.catalog_import_stage
  drop constraint if exists catalog_import_stage_source_offset_check;

alter table public.catalog_import_stage
  add constraint catalog_import_stage_source_offset_check
  check (source_offset is null or source_offset >= 0);

alter table public.catalog_import_stage
  drop constraint if exists catalog_import_stage_provider_coordinate_check;

alter table public.catalog_import_stage
  add constraint catalog_import_stage_provider_coordinate_check
  check (
    (
      source_key is null
      and source_product_id is null
      and source_page is null
      and source_offset is null
    )
    or
    (
      nullif(trim(source_key), '') is not null
      and nullif(trim(source_product_id), '') is not null
      and source_page >= 0
      and source_offset >= 0
    )
  );

create unique index if not exists idx_catalog_import_stage_provider_identity_unique
  on public.catalog_import_stage (run_id, source_key, source_product_id)
  where source_key is not null
    and source_key <> ''
    and source_product_id is not null
    and source_product_id <> '';

create unique index if not exists idx_catalog_import_stage_provider_position_unique
  on public.catalog_import_stage (run_id, source_page, source_offset)
  where source_page is not null
    and source_offset is not null;

create unique index if not exists idx_catalog_import_stage_provider_code_unique
  on public.catalog_import_stage (run_id, normalized_code)
  where source_key is not null
    and source_key <> ''
    and normalized_code is not null
    and normalized_code <> '';

create unique index if not exists idx_catalog_import_runs_id_org_unique
  on public.catalog_import_runs (id, organization_id);

create unique index if not exists idx_catalog_import_runs_provider_collection_active_unique
  on public.catalog_import_runs (
    organization_id,
    (input_scope ->> 'source_key'),
    (input_scope ->> 'collection_key'),
    (input_scope ->> 'source_brand')
  )
  where status = 'provider_collecting'
    and input_scope ->> 'source' = 'provider_stage_only';

create table if not exists public.catalog_import_source_pages (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  run_id uuid not null,
  source_key text not null,
  page_number integer not null,
  page_size integer not null,
  fetched_rows integer not null,
  staged_rows integer not null,
  skipped_rows integer not null default 0,
  duplicate_rows integer not null default 0,
  total_elements integer not null,
  total_pages integer not null,
  response_fingerprint text not null,
  source_url text not null,
  retrieved_at timestamptz not null default now(),
  verified_at timestamptz,
  constraint catalog_import_source_pages_page_number_check
    check (page_number >= 0),
  constraint catalog_import_source_pages_page_size_check
    check (page_size > 0 and page_size <= 1000),
  constraint catalog_import_source_pages_row_counts_check
    check (
      fetched_rows >= 0
      and staged_rows >= 0
      and skipped_rows >= 0
      and duplicate_rows >= 0
    ),
  constraint catalog_import_source_pages_totals_check
    check (total_elements > 0 and total_pages > 0),
  constraint catalog_import_source_pages_fingerprint_check
    check (response_fingerprint ~ '^[0-9a-f]{64}$'),
  constraint catalog_import_source_pages_url_check
    check (source_url ~* '^https://'),
  constraint catalog_import_source_pages_run_org_fk
    foreign key (run_id, organization_id)
    references public.catalog_import_runs (id, organization_id)
    on delete cascade,
  constraint catalog_import_source_pages_count_balance_check
    check (fetched_rows = staged_rows + skipped_rows + duplicate_rows),
  unique (run_id, page_number)
);

create index if not exists idx_catalog_import_source_pages_run
  on public.catalog_import_source_pages (run_id, page_number);

alter table public.catalog_import_source_pages enable row level security;

drop policy if exists catalog_import_source_pages_select_ops
on public.catalog_import_source_pages;

create policy catalog_import_source_pages_select_ops
on public.catalog_import_source_pages
for select
using (
  organization_id = public.current_profile_org_id()
  and public.current_profile_role() in ('admin', 'superadmin')
);

grant select on public.catalog_import_source_pages to authenticated;
grant select on public.catalog_import_source_pages to service_role;

create or replace function public.catalog_provider_jsonb_sha256(input_value jsonb)
returns text
language sql
immutable
set search_path = pg_catalog, public, extensions
as $$
  select encode(
    extensions.digest(
      convert_to(coalesce(input_value, '{}'::jsonb)::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  );
$$;

revoke all on function public.catalog_provider_jsonb_sha256(jsonb)
  from public, anon, authenticated;
grant execute on function public.catalog_provider_jsonb_sha256(jsonb)
  to service_role;

create or replace function public.begin_or_resume_catalog_provider_stage(
  input_organization_id uuid,
  input_source_key text,
  input_collection_key text,
  input_brand text,
  input_scope jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
set statement_timeout = '30s'
as $$
declare
  v_source_key text := nullif(trim(coalesce(input_source_key, '')), '');
  v_collection_key text := nullif(trim(coalesce(input_collection_key, '')), '');
  v_brand_input text := nullif(trim(coalesce(input_brand, '')), '');
  v_brand_name text;
  v_scope jsonb := coalesce(input_scope, '{}'::jsonb);
  v_run public.catalog_import_runs%rowtype;
  v_next_page integer := 0;
  v_next_verify_page integer;
  v_page_count integer := 0;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Provider collection requires the service role';
  end if;

  if input_organization_id is null
     or v_source_key is null
     or v_collection_key is null
     or v_brand_input is null then
    raise exception 'Organization, source key, collection key, and brand are required';
  end if;

  if jsonb_typeof(v_scope) is distinct from 'object' then
    raise exception 'Provider collection scope must be a JSON object';
  end if;

  select b.name
    into v_brand_name
  from public.brands b
  where b.organization_id = input_organization_id
    and public.normalize_catalog_brand_key(b.name) =
      public.normalize_catalog_brand_key(v_brand_input)
  limit 1;

  if v_brand_name is null then
    raise exception 'Provider collection brand was not found';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      input_organization_id::text
      || ':provider_stage:'
      || v_source_key
      || ':'
      || v_collection_key
      || ':'
      || public.normalize_catalog_brand_key(v_brand_name),
      0
    )
  );

  select r.*
    into v_run
  from public.catalog_import_runs r
  where r.organization_id = input_organization_id
    and r.input_scope ->> 'source' = 'provider_stage_only'
    and r.input_scope ->> 'source_key' = v_source_key
    and r.input_scope ->> 'collection_key' = v_collection_key
    and public.normalize_catalog_brand_key(r.input_scope ->> 'source_brand') =
      public.normalize_catalog_brand_key(v_brand_name)
    and r.status in ('provider_collecting', 'staged')
  order by
    case when r.status = 'provider_collecting' then 0 else 1 end,
    r.started_at desc
  limit 1
  for update;

  if not found then
    v_scope := v_scope || jsonb_build_object(
      'source', 'provider_stage_only',
      'source_key', v_source_key,
      'collection_key', v_collection_key,
      'source_brand', upper(replace(v_brand_input, ' ', '_')),
      'brand_name', v_brand_name,
      'automatic_finalize', false,
      'canonical_write', false
    );

    insert into public.catalog_import_runs (
      organization_id,
      mode,
      status,
      input_scope,
      created_by
    )
    values (
      input_organization_id,
      'insert_only',
      'provider_collecting',
      v_scope,
      null
    )
    returning * into v_run;
  end if;

  select
    coalesce(max(p.page_number) + 1, 0),
    count(*)::integer
  into v_next_page, v_page_count
  from public.catalog_import_source_pages p
  where p.run_id = v_run.id
    and p.organization_id = v_run.organization_id;

  select min(p.page_number)
    into v_next_verify_page
  from public.catalog_import_source_pages p
  where p.run_id = v_run.id
    and p.organization_id = v_run.organization_id
    and p.verified_at is null;

  return jsonb_build_object(
    'run_id', v_run.id,
    'status', v_run.status,
    'brand', v_run.input_scope ->> 'brand_name',
    'source_brand', v_run.input_scope ->> 'source_brand',
    'source_key', v_run.input_scope ->> 'source_key',
    'collection_key', v_run.input_scope ->> 'collection_key',
    'next_page', v_next_page,
    'next_verify_page', v_next_verify_page,
    'collected_pages', v_page_count,
    'staged_rows', v_run.staged_rows,
    'total_elements', nullif(v_run.input_scope ->> 'total_elements', '')::integer,
    'total_pages', nullif(v_run.input_scope ->> 'total_pages', '')::integer,
    'page_size', nullif(v_run.input_scope ->> 'page_size', '')::integer
  );
end;
$$;

revoke all on function public.begin_or_resume_catalog_provider_stage(uuid, text, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.begin_or_resume_catalog_provider_stage(uuid, text, text, text, jsonb)
  to service_role;

create or replace function public.stage_catalog_provider_identity_page(
  input_run_id uuid,
  input_page_number integer,
  input_page_size integer,
  input_total_elements integer,
  input_total_pages integer,
  input_source_url text,
  input_retrieved_at timestamptz,
  payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
set statement_timeout = '120s'
as $$
declare
  v_run public.catalog_import_runs%rowtype;
  v_existing_page public.catalog_import_source_pages%rowtype;
  v_source_key text;
  v_brand_name text;
  v_payload_count integer := 0;
  v_distinct_identity_count integer := 0;
  v_invalid_count integer := 0;
  v_duplicate_count integer := 0;
  v_expected_page integer := 0;
  v_expected_rows integer := 0;
  v_staged_rows integer := 0;
  v_stage_total integer := 0;
  v_response_fingerprint text;
  v_retrieved_at timestamptz := coalesce(input_retrieved_at, clock_timestamp());
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Provider page staging requires the service role';
  end if;

  if input_run_id is null
     or input_page_number is null
     or input_page_number < 0
     or input_page_size is null
     or input_page_size <= 0
     or input_page_size > 1000
     or input_total_elements is null
     or input_total_elements <= 0
     or input_total_pages is null
     or input_total_pages <= 0 then
    raise exception 'Valid run, page, page size, and source totals are required';
  end if;

  if input_total_pages <> ceil(input_total_elements::numeric / input_page_size)::integer then
    raise exception 'Provider pagination totals are inconsistent';
  end if;

  if input_page_number >= input_total_pages then
    raise exception 'Provider page is outside the declared page range';
  end if;

  if nullif(trim(coalesce(input_source_url, '')), '') is null
     or input_source_url !~* '^https://' then
    raise exception 'Provider page source URL must use HTTPS';
  end if;

  if payload is null or jsonb_typeof(payload) <> 'array' then
    raise exception 'Provider page payload must be a JSON array';
  end if;

  select r.*
    into v_run
  from public.catalog_import_runs r
  where r.id = input_run_id
  for update;

  if not found then
    raise exception 'Provider collection run was not found';
  end if;

  if v_run.status <> 'provider_collecting'
     or v_run.input_scope ->> 'source' <> 'provider_stage_only' then
    raise exception 'Provider collection run is not accepting pages';
  end if;

  v_source_key := nullif(trim(coalesce(v_run.input_scope ->> 'source_key', '')), '');
  v_brand_name := nullif(trim(coalesce(v_run.input_scope ->> 'brand_name', '')), '');

  if v_source_key is null or v_brand_name is null then
    raise exception 'Provider collection run scope is incomplete';
  end if;

  v_response_fingerprint := public.catalog_provider_jsonb_sha256(
    jsonb_build_object(
      'source_key', v_source_key,
      'source_brand', v_run.input_scope ->> 'source_brand',
      'page_number', input_page_number,
      'page_size', input_page_size,
      'total_elements', input_total_elements,
      'total_pages', input_total_pages,
      'payload', payload
    )
  );

  select p.*
    into v_existing_page
  from public.catalog_import_source_pages p
  where p.run_id = v_run.id
    and p.page_number = input_page_number
  for update;

  if found then
    if v_existing_page.response_fingerprint <> v_response_fingerprint
       or v_existing_page.page_size <> input_page_size
       or v_existing_page.total_elements <> input_total_elements
       or v_existing_page.total_pages <> input_total_pages then
      raise exception 'Provider page changed after it was staged';
    end if;

    return jsonb_build_object(
      'run_id', v_run.id,
      'status', v_run.status,
      'page_number', v_existing_page.page_number,
      'staged_rows', v_existing_page.staged_rows,
      'next_page', v_existing_page.page_number + 1,
      'reused', true
    );
  end if;

  select coalesce(max(p.page_number) + 1, 0)
    into v_expected_page
  from public.catalog_import_source_pages p
  where p.run_id = v_run.id;

  if input_page_number <> v_expected_page then
    raise exception 'Provider pages must be staged sequentially; expected page %', v_expected_page;
  end if;

  if exists (
    select 1
    from public.catalog_import_source_pages p
    where p.run_id = v_run.id
      and (
        p.page_size <> input_page_size
        or p.total_elements <> input_total_elements
        or p.total_pages <> input_total_pages
      )
  ) then
    raise exception 'Provider pagination metadata changed during collection';
  end if;

  v_payload_count := jsonb_array_length(payload);
  v_expected_rows := least(
    input_page_size,
    input_total_elements - (input_page_number * input_page_size)
  );

  if v_expected_rows <= 0 or v_payload_count <> v_expected_rows then
    raise exception 'Provider page row count mismatch; expected %, received %',
      v_expected_rows,
      v_payload_count;
  end if;

  select
    count(distinct nullif(trim(coalesce(item.value ->> 'source_product_id', '')), ''))::integer,
    count(*) filter (
      where nullif(trim(coalesce(item.value ->> 'source_product_id', '')), '') is null
         or nullif(trim(coalesce(item.value ->> 'product_code', '')), '') is null
         or nullif(trim(coalesce(item.value ->> 'source_url', '')), '') is null
         or item.value ->> 'source_url' !~* '^https://'
    )::integer
  into v_distinct_identity_count, v_invalid_count
  from jsonb_array_elements(payload) as item(value);

  if v_invalid_count > 0 then
    raise exception 'Provider page contains invalid source identities or evidence fields';
  end if;

  if v_distinct_identity_count <> v_payload_count then
    raise exception 'Provider page contains duplicate source identities';
  end if;

  select count(*)::integer
    into v_duplicate_count
  from jsonb_array_elements(payload) as item(value)
  join public.catalog_import_stage s
    on s.run_id = v_run.id
   and s.source_key = v_source_key
   and s.source_product_id = trim(item.value ->> 'source_product_id');

  if v_duplicate_count > 0 then
    raise exception 'Provider identities repeated across source pages';
  end if;

  insert into public.catalog_import_stage (
    organization_id,
    run_id,
    row_index,
    brand,
    product_code,
    normalized_code,
    description,
    oem_no,
    lifecycle_status,
    lifecycle_note,
    validation_status,
    validation_message,
    conflict_summary,
    proposed_action,
    market_segment,
    source_url,
    source_retrieved_at,
    source_fingerprint,
    source_key,
    source_product_id,
    source_page,
    source_offset,
    source_payload
  )
  select
    v_run.organization_id,
    v_run.id,
    input_page_number * input_page_size + (item.ordinality::integer - 1),
    v_brand_name,
    trim(item.value ->> 'product_code'),
    public.normalize_part_code(
      public.normalize_catalog_display_code_for_brand(
        trim(item.value ->> 'product_code'),
        v_brand_name
      )
    ),
    nullif(trim(coalesce(item.value ->> 'description', '')), ''),
    nullif(trim(coalesce(item.value ->> 'oem_no', '')), ''),
    'active',
    'Official provider collection; review required before any canonical action.',
    'pending',
    null,
    jsonb_build_object(
      'brand_exists', true,
      'existing_product_exists', cp.id is not null,
      'existing_product_id', cp.id,
      'provider_stage_only', true,
      'source_page', input_page_number,
      'source_offset', item.ordinality::integer - 1
    ),
    case when cp.id is null then 'insert' else 'skip' end,
    public.normalize_catalog_market_segment(
      coalesce(nullif(trim(item.value ->> 'market_segment'), ''), 'aftermarket')
    ),
    trim(item.value ->> 'source_url'),
    v_retrieved_at,
    public.catalog_provider_jsonb_sha256(item.value),
    v_source_key,
    trim(item.value ->> 'source_product_id'),
    input_page_number,
    item.ordinality::integer - 1,
    coalesce(item.value -> 'source_payload', '{}'::jsonb)
  from jsonb_array_elements(payload) with ordinality as item(value, ordinality)
  left join public.brands b
    on b.organization_id = v_run.organization_id
   and public.normalize_catalog_brand_key(b.name) =
     public.normalize_catalog_brand_key(v_brand_name)
  left join public.catalog_products cp
    on cp.organization_id = v_run.organization_id
   and cp.brand_id = b.id
   and cp.normalized_code = public.normalize_part_code(
     public.normalize_catalog_display_code_for_brand(
       trim(item.value ->> 'product_code'),
       v_brand_name
     )
   );

  get diagnostics v_staged_rows = row_count;

  if v_staged_rows <> v_payload_count then
    raise exception 'Provider page did not stage every source identity';
  end if;

  insert into public.catalog_import_source_pages (
    organization_id,
    run_id,
    source_key,
    page_number,
    page_size,
    fetched_rows,
    staged_rows,
    skipped_rows,
    duplicate_rows,
    total_elements,
    total_pages,
    response_fingerprint,
    source_url,
    retrieved_at
  )
  values (
    v_run.organization_id,
    v_run.id,
    v_source_key,
    input_page_number,
    input_page_size,
    v_payload_count,
    v_staged_rows,
    0,
    0,
    input_total_elements,
    input_total_pages,
    v_response_fingerprint,
    trim(input_source_url),
    v_retrieved_at
  );

  select count(*)::integer
    into v_stage_total
  from public.catalog_import_stage s
  where s.run_id = v_run.id
    and s.organization_id = v_run.organization_id;

  update public.catalog_import_runs
  set staged_rows = v_stage_total,
      processed_rows = v_stage_total,
      input_scope = input_scope || jsonb_build_object(
        'total_elements', input_total_elements,
        'total_pages', input_total_pages,
        'page_size', input_page_size,
        'next_page', input_page_number + 1
      )
  where id = v_run.id;

  return jsonb_build_object(
    'run_id', v_run.id,
    'status', 'provider_collecting',
    'page_number', input_page_number,
    'staged_rows', v_staged_rows,
    'total_staged_rows', v_stage_total,
    'next_page', input_page_number + 1,
    'total_elements', input_total_elements,
    'total_pages', input_total_pages,
    'reused', false
  );
end;
$$;

revoke all on function public.stage_catalog_provider_identity_page(
  uuid, integer, integer, integer, integer, text, timestamptz, jsonb
) from public, anon, authenticated;
grant execute on function public.stage_catalog_provider_identity_page(
  uuid, integer, integer, integer, integer, text, timestamptz, jsonb
) to service_role;

create or replace function public.verify_catalog_provider_stage_page(
  input_run_id uuid,
  input_page_number integer,
  input_page_size integer,
  input_total_elements integer,
  input_total_pages integer,
  payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
set statement_timeout = '60s'
as $$
declare
  v_page public.catalog_import_source_pages%rowtype;
  v_run public.catalog_import_runs%rowtype;
  v_response_fingerprint text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Provider page verification requires the service role';
  end if;

  if payload is null or jsonb_typeof(payload) <> 'array' then
    raise exception 'Provider verification payload must be a JSON array';
  end if;

  select p.*
    into v_page
  from public.catalog_import_source_pages p
  join public.catalog_import_runs r
    on r.id = p.run_id
   and r.organization_id = p.organization_id
  where p.run_id = input_run_id
    and p.page_number = input_page_number
    and r.status = 'provider_collecting'
    and r.input_scope ->> 'source' = 'provider_stage_only'
  for update of p;

  if not found then
    raise exception 'Provider page receipt was not found';
  end if;

  select r.*
    into v_run
  from public.catalog_import_runs r
  where r.id = v_page.run_id;

  if v_page.page_size <> input_page_size
     or v_page.total_elements <> input_total_elements
     or v_page.total_pages <> input_total_pages then
    raise exception 'Provider page metadata changed during collection verification';
  end if;

  v_response_fingerprint := public.catalog_provider_jsonb_sha256(
    jsonb_build_object(
      'source_key', v_page.source_key,
      'source_brand', v_run.input_scope ->> 'source_brand',
      'page_number', input_page_number,
      'page_size', input_page_size,
      'total_elements', input_total_elements,
      'total_pages', input_total_pages,
      'payload', payload
    )
  );

  if v_page.response_fingerprint <> v_response_fingerprint then
    raise exception 'Provider page changed during collection verification';
  end if;

  update public.catalog_import_source_pages
  set verified_at = now()
  where id = v_page.id;

  return jsonb_build_object(
    'run_id', v_page.run_id,
    'page_number', v_page.page_number,
    'verified', true
  );
end;
$$;

revoke all on function public.verify_catalog_provider_stage_page(
  uuid, integer, integer, integer, integer, jsonb
)
  from public, anon, authenticated;
grant execute on function public.verify_catalog_provider_stage_page(
  uuid, integer, integer, integer, integer, jsonb
)
  to service_role;

create or replace function public.seal_catalog_provider_stage_strict(input_run_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
set statement_timeout = '120s'
as $$
declare
  v_run public.catalog_import_runs%rowtype;
  v_total_elements integer := 0;
  v_total_pages integer := 0;
  v_page_size integer := 0;
  v_page_count integer := 0;
  v_verified_page_count integer := 0;
  v_min_page integer := 0;
  v_max_page integer := 0;
  v_fetched_rows integer := 0;
  v_skipped_rows integer := 0;
  v_duplicate_rows integer := 0;
  v_stage_rows integer := 0;
  v_distinct_identities integer := 0;
  v_distinct_positions integer := 0;
  v_distinct_codes integer := 0;
  v_min_position integer := 0;
  v_max_position integer := 0;
  v_error_rows integer := 0;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Provider collection sealing requires the service role';
  end if;

  select r.*
    into v_run
  from public.catalog_import_runs r
  where r.id = input_run_id
  for update;

  if not found then
    raise exception 'Provider collection run was not found';
  end if;

  if v_run.input_scope ->> 'source' <> 'provider_stage_only' then
    raise exception 'Catalog import run is not a provider-stage collection';
  end if;

  if v_run.status = 'staged' then
    return jsonb_build_object(
      'run_id', v_run.id,
      'status', 'staged',
      'staged_count', v_run.staged_rows,
      'reused', true
    );
  end if;

  if v_run.status <> 'provider_collecting' then
    raise exception 'Provider collection run cannot be sealed';
  end if;

  if (
    select count(distinct (p.total_elements, p.total_pages, p.page_size))
    from public.catalog_import_source_pages p
    where p.run_id = v_run.id
  ) <> 1 then
    raise exception 'Provider page metadata is incomplete or inconsistent';
  end if;

  select
    min(p.total_elements),
    min(p.total_pages),
    min(p.page_size),
    count(*)::integer,
    count(*) filter (where p.verified_at is not null)::integer,
    min(p.page_number),
    max(p.page_number),
    sum(p.fetched_rows)::integer,
    sum(p.skipped_rows)::integer,
    sum(p.duplicate_rows)::integer
  into
    v_total_elements,
    v_total_pages,
    v_page_size,
    v_page_count,
    v_verified_page_count,
    v_min_page,
    v_max_page,
    v_fetched_rows,
    v_skipped_rows,
    v_duplicate_rows
  from public.catalog_import_source_pages p
  where p.run_id = v_run.id
    and p.organization_id = v_run.organization_id;

  if v_page_count <> v_total_pages
     or v_verified_page_count <> v_total_pages
     or v_min_page <> 0
     or v_max_page <> v_total_pages - 1 then
    raise exception 'Provider collection pages are not complete and verified';
  end if;

  if v_fetched_rows <> v_total_elements
     or v_skipped_rows <> 0
     or v_duplicate_rows <> 0 then
    raise exception 'Provider collection page counts do not match the source total';
  end if;

  select
    count(*)::integer,
    count(distinct s.source_product_id)::integer,
    count(distinct s.row_index)::integer,
    count(distinct s.normalized_code)::integer,
    min(s.row_index),
    max(s.row_index),
    count(*) filter (where s.validation_status = 'error')::integer
  into
    v_stage_rows,
    v_distinct_identities,
    v_distinct_positions,
    v_distinct_codes,
    v_min_position,
    v_max_position,
    v_error_rows
  from public.catalog_import_stage s
  where s.run_id = v_run.id
    and s.organization_id = v_run.organization_id
    and s.source_key = v_run.input_scope ->> 'source_key';

  if v_stage_rows <> v_total_elements
     or v_distinct_identities <> v_total_elements
     or v_distinct_positions <> v_total_elements
     or v_distinct_codes <> v_total_elements
     or v_min_position <> 0
     or v_max_position <> v_total_elements - 1
     or v_error_rows <> 0 then
    raise exception 'Provider collection identity coverage did not pass strict verification';
  end if;

  update public.catalog_import_runs
  set status = 'staged',
      finished_at = now(),
      error_message = null,
      staged_rows = v_stage_rows,
      valid_rows = 0,
      error_rows = 0,
      duplicate_rows = 0,
      insert_rows = 0,
      update_rows = 0,
      skip_rows = 0,
      processed_rows = v_stage_rows,
      input_scope = input_scope || jsonb_build_object(
        'total_elements', v_total_elements,
        'total_pages', v_total_pages,
        'page_size', v_page_size,
        'next_page', v_total_pages,
        'collection_verified', true,
        'automatic_finalize', false,
        'canonical_write', false
      )
  where id = v_run.id;

  return jsonb_build_object(
    'run_id', v_run.id,
    'status', 'staged',
    'staged_count', v_stage_rows,
    'total_elements', v_total_elements,
    'total_pages', v_total_pages,
    'verified_pages', v_verified_page_count,
    'canonical_products_changed', false,
    'reused', false
  );
end;
$$;

revoke all on function public.seal_catalog_provider_stage_strict(uuid)
  from public, anon, authenticated;
grant execute on function public.seal_catalog_provider_stage_strict(uuid)
  to service_role;

create or replace function public.cancel_catalog_provider_stage(
  input_run_id uuid,
  input_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
set statement_timeout = '30s'
as $$
declare
  v_run_id uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Provider collection cancellation requires the service role';
  end if;

  update public.catalog_import_runs r
  set status = 'cancelled',
      finished_at = now(),
      error_message = nullif(trim(coalesce(input_reason, '')), '')
  where r.id = input_run_id
    and r.status = 'provider_collecting'
    and r.input_scope ->> 'source' = 'provider_stage_only'
  returning r.id into v_run_id;

  if v_run_id is null then
    raise exception 'Provider collection run was not found or cannot be cancelled';
  end if;

  return jsonb_build_object(
    'run_id', v_run_id,
    'status', 'cancelled'
  );
end;
$$;

revoke all on function public.cancel_catalog_provider_stage(uuid, text)
  from public, anon, authenticated;
grant execute on function public.cancel_catalog_provider_stage(uuid, text)
  to service_role;

create or replace function public.guard_catalog_provider_stage_run()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.input_scope ->> 'source' = 'provider_stage_only' then
    if new.status not in ('provider_collecting', 'staged', 'failed', 'cancelled') then
      raise exception 'Provider-stage collections cannot validate, finalize, or apply';
    end if;

    if new.input_scope ->> 'source' is distinct from old.input_scope ->> 'source'
       or new.input_scope ->> 'source_key' is distinct from old.input_scope ->> 'source_key'
       or new.input_scope ->> 'collection_key' is distinct from old.input_scope ->> 'collection_key'
       or new.input_scope ->> 'source_brand' is distinct from old.input_scope ->> 'source_brand'
       or new.input_scope ->> 'brand_name' is distinct from old.input_scope ->> 'brand_name' then
      raise exception 'Provider-stage collection identity is immutable';
    end if;

    if old.status = 'staged' and new.status <> 'staged' then
      raise exception 'A sealed provider-stage collection is immutable';
    end if;
  elsif new.input_scope ->> 'source' = 'provider_stage_only' then
    raise exception 'An existing catalog import cannot be converted into a provider-stage collection';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_guard_catalog_provider_stage_run
  on public.catalog_import_runs;

create trigger trg_guard_catalog_provider_stage_run
before update on public.catalog_import_runs
for each row
execute function public.guard_catalog_provider_stage_run();

revoke all on function public.guard_catalog_provider_stage_run()
  from public, anon, authenticated, service_role;

alter function public.validate_catalog_import(uuid)
  rename to validate_catalog_import_pre_provider_stage_guard;

create or replace function public.validate_catalog_import(input_run_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_scope jsonb;
begin
  select r.input_scope
    into v_scope
  from public.catalog_import_runs r
  where r.id = input_run_id
    and r.organization_id = public.current_profile_org_id();

  if coalesce(v_scope ->> 'source', '') = 'provider_stage_only' then
    raise exception 'Provider-stage collections cannot be validated or finalized';
  end if;

  return public.validate_catalog_import_pre_provider_stage_guard(input_run_id);
end;
$$;

revoke all on function public.validate_catalog_import_pre_provider_stage_guard(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.validate_catalog_import(uuid)
  from public, anon;
grant execute on function public.validate_catalog_import(uuid)
  to authenticated, service_role;

alter function public.finalize_catalog_import(uuid)
  rename to finalize_catalog_import_pre_provider_stage_guard;

create or replace function public.finalize_catalog_import(input_run_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
set statement_timeout = '300s'
as $$
declare
  v_scope jsonb;
begin
  select r.input_scope
    into v_scope
  from public.catalog_import_runs r
  where r.id = input_run_id
    and r.organization_id = public.current_profile_org_id();

  if coalesce(v_scope ->> 'source', '') = 'provider_stage_only' then
    raise exception 'Provider-stage collections cannot be validated or finalized';
  end if;

  return public.finalize_catalog_import_pre_provider_stage_guard(input_run_id);
end;
$$;

revoke all on function public.finalize_catalog_import_pre_provider_stage_guard(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.finalize_catalog_import(uuid)
  from public, anon;
grant execute on function public.finalize_catalog_import(uuid)
  to authenticated, service_role;

comment on table public.catalog_import_source_pages is
  'Immutable provider page receipts used to resume and strictly verify review-only catalog staging.';

comment on function public.begin_or_resume_catalog_provider_stage(uuid, text, text, text, jsonb) is
  'Service-only begin/resume boundary for provider collection without canonical catalog writes.';

comment on function public.stage_catalog_provider_identity_page(
  uuid, integer, integer, integer, integer, text, timestamptz, jsonb
) is
  'Atomically stages one provider page and its immutable fingerprint receipt.';

comment on function public.seal_catalog_provider_stage_strict(uuid) is
  'Seals only complete, identity-unique, page-verified provider collections; never writes catalog_products.';
