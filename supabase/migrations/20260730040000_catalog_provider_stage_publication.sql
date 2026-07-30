-- Explicit, resumable publication boundary for strictly sealed provider stages.
--
-- This does not reuse the generic catalog import finalizer. The provider run
-- remains immutable, publication is insert-only, and provenance is written
-- with the provider's exact source key.

set lock_timeout = '5s';
set statement_timeout = '300s';

insert into public.catalog_external_sources (
  organization_id,
  source_key,
  display_name,
  source_owner,
  source_type,
  base_url,
  license_posture,
  robots_posture,
  rate_limit_posture,
  credential_boundary,
  is_active,
  metadata
) select distinct
  r.organization_id,
  'bilstein_group_partsfinder_list',
  'Bilstein Group PartsFinder Official Catalog List',
  'Bilstein Group',
  'manufacturer',
  'https://partsfinder.bilsteingroup.com',
  'allowed',
  'not_applicable',
  'bounded',
  'none',
  true,
  jsonb_build_object(
    'authorization', 'product_decision_owner_explicit_production_approval',
    'authorized_at', '2026-07-30',
    'approval_actor', 'Next-Master Product Decision Owner',
    'publication_approval_reference',
      'codex-task-2026-07-30-febi-blue-print-production',
    'allowed_brands', jsonb_build_array('FEBI', 'BLUE_PRINT'),
    'country', 'TR',
    'vehicle_type', 'CAR',
    'access_mode', 'official_json_api',
    'retention', 'canonical_catalog_with_source_provenance',
    'attribution', 'Bilstein Group PartsFinder'
  )
from public.catalog_import_runs r
where r.input_scope ->> 'source' = 'provider_stage_only'
  and r.input_scope ->> 'source_key' = 'bilstein_group_partsfinder_list'
on conflict (organization_id, source_key)
do update set
  display_name = excluded.display_name,
  source_owner = excluded.source_owner,
  source_type = excluded.source_type,
  base_url = excluded.base_url,
  license_posture = excluded.license_posture,
  robots_posture = excluded.robots_posture,
  rate_limit_posture = excluded.rate_limit_posture,
  credential_boundary = excluded.credential_boundary,
  is_active = excluded.is_active,
  metadata = excluded.metadata,
  updated_at = now();

create table if not exists public.catalog_provider_stage_publications (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  run_id uuid not null,
  brand_id uuid not null references public.brands(id),
  source_id uuid not null references public.catalog_external_sources(id),
  approval_actor text not null,
  approval_reference text not null,
  expected_rows integer not null,
  processed_rows integer not null default 0,
  inserted_rows integer not null default 0,
  provenance_rows integer not null default 0,
  last_row_index integer not null default -1,
  status text not null default 'publishing',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint catalog_provider_stage_publications_run_org_fk
    foreign key (run_id, organization_id)
    references public.catalog_import_runs (id, organization_id)
    on delete restrict,
  constraint catalog_provider_stage_publications_expected_rows_check
    check (expected_rows > 0),
  constraint catalog_provider_stage_publications_progress_check
    check (
      processed_rows >= 0
      and inserted_rows >= 0
      and provenance_rows >= 0
      and processed_rows <= expected_rows
      and inserted_rows <= processed_rows
      and provenance_rows <= processed_rows
    ),
  constraint catalog_provider_stage_publications_status_check
    check (status in ('publishing', 'completed', 'failed')),
  unique (run_id)
);

create index if not exists idx_catalog_provider_stage_publications_org_status
  on public.catalog_provider_stage_publications (
    organization_id,
    status,
    updated_at desc
  );

alter table public.catalog_provider_stage_publications enable row level security;

drop policy if exists catalog_provider_stage_publications_select_ops
on public.catalog_provider_stage_publications;

create policy catalog_provider_stage_publications_select_ops
on public.catalog_provider_stage_publications
for select
using (
  organization_id = public.current_profile_org_id()
  and public.current_profile_role() in ('admin', 'superadmin')
);

revoke all on public.catalog_provider_stage_publications
  from public, anon, authenticated;
grant select on public.catalog_provider_stage_publications
  to authenticated, service_role;

-- The ordinary row triggers remain active for every normal catalog write.
-- Only a transaction that deliberately sets this local publication marker
-- skips the two expensive per-row side effects; the publisher performs the
-- same work set-wise before committing.
drop trigger if exists trg_catalog_products_integrity_summary_total
on public.catalog_products;

create trigger trg_catalog_products_integrity_summary_total
after insert or delete or update of
  organization_id,
  brand_id,
  description,
  origin,
  hs_code,
  weight_kg,
  ean,
  oem_no,
  vehicle,
  vehicle_model,
  image_url
on public.catalog_products
for each row
when (
  current_setting('next_master.catalog_bulk_load', true)
    is distinct from 'provider_stage_publication'
)
execute function public.apply_catalog_product_operations_delta();

drop trigger if exists trg_catalog_products_queue_integrity
on public.catalog_products;

create trigger trg_catalog_products_queue_integrity
after insert or update of description, origin, hs_code, weight_kg, ean
on public.catalog_products
for each row
when (
  current_setting('next_master.catalog_bulk_load', true)
    is distinct from 'provider_stage_publication'
)
execute function public.queue_catalog_product_integrity_change();

create or replace function public.publish_catalog_provider_stage_batch(
  input_run_id uuid,
  input_brand_id uuid,
  input_expected_rows integer,
  input_approval_actor text,
  input_approval_reference text,
  input_batch_size integer default 500
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
set statement_timeout = '180s'
as $$
declare
  v_run public.catalog_import_runs%rowtype;
  v_source public.catalog_external_sources%rowtype;
  v_publication public.catalog_provider_stage_publications%rowtype;
  v_brand_name text;
  v_source_key text;
  v_total_pages integer;
  v_total_elements integer;
  v_stage_rows integer;
  v_distinct_source_ids integer;
  v_distinct_codes integer;
  v_bad_rows integer;
  v_page_rows integer;
  v_verified_pages integer;
  v_receipt_rows integer;
  v_batch_rows integer;
  v_batch_last_row integer;
  v_inserted_rows integer;
  v_provenance_rows integer;
  v_complete_rows integer;
  v_incomplete_rows integer;
  v_missing_description integer;
  v_missing_origin integer;
  v_missing_hs_code integer;
  v_missing_weight integer;
  v_missing_ean integer;
  v_missing_oem integer;
  v_missing_vehicle integer;
  v_missing_image integer;
  v_canonical_matches integer;
  v_provenance_matches integer;
  v_status text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Provider-stage publication requires the service role';
  end if;

  if input_run_id is null or input_brand_id is null then
    raise exception 'run_id and brand_id are required';
  end if;

  if input_expected_rows is null or input_expected_rows <= 0 then
    raise exception 'expected_rows must be positive';
  end if;

  if input_batch_size is null or input_batch_size < 1 or input_batch_size > 1000 then
    raise exception 'batch_size must be between 1 and 1000';
  end if;

  if nullif(trim(coalesce(input_approval_actor, '')), '') is null
     or nullif(trim(coalesce(input_approval_reference, '')), '') is null then
    raise exception 'approval actor and reference are required';
  end if;

  select r.*
    into v_run
  from public.catalog_import_runs r
  where r.id = input_run_id
  for share;

  if v_run.id is null then
    raise exception 'Provider-stage run was not found';
  end if;

  if v_run.status <> 'staged'
     or v_run.input_scope ->> 'source' <> 'provider_stage_only'
     or coalesce((v_run.input_scope ->> 'collection_verified')::boolean, false) is not true then
    raise exception 'Provider-stage run is not strictly sealed and verified';
  end if;

  v_source_key := nullif(trim(v_run.input_scope ->> 'source_key'), '');
  v_total_pages := nullif(v_run.input_scope ->> 'total_pages', '')::integer;
  v_total_elements := nullif(v_run.input_scope ->> 'total_elements', '')::integer;

  if v_source_key is null
     or v_total_pages is null
     or v_total_elements is null
     or v_total_elements <> input_expected_rows
     or v_run.staged_rows <> input_expected_rows then
    raise exception 'Provider-stage run cardinality does not match explicit publication expectation';
  end if;

  select b.name
    into v_brand_name
  from public.brands b
  where b.id = input_brand_id
    and b.organization_id = v_run.organization_id;

  if v_brand_name is null
     or lower(trim(v_brand_name)) <> lower(trim(v_run.input_scope ->> 'brand_name')) then
    raise exception 'Provider-stage brand does not match the target canonical brand';
  end if;

  select s.*
    into v_source
  from public.catalog_external_sources s
  where s.organization_id = v_run.organization_id
    and s.source_key = v_source_key
    and s.is_active is true;

  if v_source.id is null
     or v_source.license_posture <> 'allowed'
     or coalesce(v_source.credential_boundary, '') <> 'none'
     or v_source.rate_limit_posture <> 'bounded' then
    raise exception 'Exact provider source metadata is not active and publication-eligible';
  end if;

  if trim(input_approval_actor)
       <> coalesce(v_source.metadata ->> 'approval_actor', '')
     or trim(input_approval_reference)
       <> coalesce(v_source.metadata ->> 'publication_approval_reference', '') then
    raise exception 'Publication approval does not match the authorized source decision';
  end if;

  select p.*
    into v_publication
  from public.catalog_provider_stage_publications p
  where p.run_id = input_run_id
  for update;

  if v_publication.id is null then
    select
      count(*)::integer,
      count(distinct s.source_product_id)::integer,
      count(distinct s.normalized_code)::integer,
      count(*) filter (
        where coalesce(trim(s.product_code), '') = ''
           or coalesce(trim(s.normalized_code), '') = ''
           or coalesce(trim(s.source_product_id), '') = ''
           or coalesce(trim(s.source_url), '') = ''
           or coalesce(trim(s.source_fingerprint), '') = ''
           or s.source_key is distinct from v_source_key
           or lower(trim(coalesce(s.brand, '')))
                <> lower(trim(v_run.input_scope ->> 'brand_name'))
      )::integer
      into
        v_stage_rows,
        v_distinct_source_ids,
        v_distinct_codes,
        v_bad_rows
    from public.catalog_import_stage s
    where s.run_id = input_run_id
      and s.organization_id = v_run.organization_id;

    select
      count(*)::integer,
      count(*) filter (where p.verified_at is not null)::integer,
      coalesce(sum(p.staged_rows), 0)::integer
      into v_page_rows, v_verified_pages, v_receipt_rows
    from public.catalog_import_source_pages p
    where p.run_id = input_run_id
      and p.organization_id = v_run.organization_id
      and p.source_key = v_source_key;

    if v_stage_rows <> input_expected_rows
       or v_distinct_source_ids <> input_expected_rows
       or v_distinct_codes <> input_expected_rows
       or v_bad_rows <> 0
       or v_page_rows <> v_total_pages
       or v_verified_pages <> v_total_pages
       or v_receipt_rows <> input_expected_rows then
      raise exception 'Provider-stage publication preflight failed';
    end if;

    insert into public.catalog_provider_stage_publications (
      organization_id,
      run_id,
      brand_id,
      source_id,
      approval_actor,
      approval_reference,
      expected_rows
    ) values (
      v_run.organization_id,
      input_run_id,
      input_brand_id,
      v_source.id,
      trim(input_approval_actor),
      trim(input_approval_reference),
      input_expected_rows
    )
    returning * into v_publication;
  else
    if v_publication.organization_id <> v_run.organization_id
       or v_publication.brand_id <> input_brand_id
       or v_publication.source_id <> v_source.id
       or v_publication.expected_rows <> input_expected_rows
       or v_publication.approval_actor <> trim(input_approval_actor)
       or v_publication.approval_reference <> trim(input_approval_reference) then
      raise exception 'Existing publication identity or approval does not match';
    end if;
  end if;

  if v_publication.status = 'completed' then
    return jsonb_build_object(
      'publication_id', v_publication.id,
      'run_id', v_publication.run_id,
      'brand', v_brand_name,
      'status', v_publication.status,
      'expected_rows', v_publication.expected_rows,
      'processed_rows', v_publication.processed_rows,
      'inserted_rows', v_publication.inserted_rows,
      'provenance_rows', v_publication.provenance_rows,
      'remaining_rows', 0,
      'reused', true
    );
  end if;

  create temporary table provider_publication_batch
  on commit drop
  as
  select s.*
  from public.catalog_import_stage s
  where s.run_id = input_run_id
    and s.organization_id = v_run.organization_id
    and s.row_index > v_publication.last_row_index
  order by s.row_index
  limit input_batch_size;

  select count(*)::integer, max(row_index)
    into v_batch_rows, v_batch_last_row
  from provider_publication_batch;

  if v_batch_rows = 0 then
    raise exception 'Publication has no remaining rows but is not complete';
  end if;

  perform set_config(
    'next_master.catalog_bulk_load',
    'provider_stage_publication',
    true
  );

  create temporary table provider_publication_inserted
  on commit drop
  as
  with inserted as (
    insert into public.catalog_products (
      organization_id,
      brand_id,
      product_code,
      description,
      oem_no,
      hs_code,
      origin,
      weight_kg,
      lifecycle_status,
      lifecycle_note,
      image_url,
      vehicle,
      ean,
      market_segment,
      vehicle_model
    )
    select
      s.organization_id,
      input_brand_id,
      s.product_code,
      s.description,
      s.oem_no,
      s.hs_code,
      s.origin,
      s.weight_kg,
      coalesce(nullif(trim(s.lifecycle_status), ''), 'active'),
      s.lifecycle_note,
      s.image_url,
      s.vehicle,
      s.ean,
      s.market_segment,
      s.vehicle_model
    from provider_publication_batch s
    order by s.row_index
    on conflict (organization_id, brand_id, normalized_code) do nothing
    returning
      id,
      organization_id,
      brand_id,
      description,
      origin,
      hs_code,
      weight_kg,
      ean,
      oem_no,
      vehicle,
      vehicle_model,
      image_url
  )
  select * from inserted;

  perform set_config('next_master.catalog_bulk_load', 'off', true);

  select
    count(*)::integer,
    count(*) filter (
      where nullif(trim(coalesce(description, '')), '') is not null
        and nullif(trim(coalesce(origin, '')), '') is not null
        and nullif(trim(coalesce(hs_code, '')), '') is not null
        and weight_kg is not null
    )::integer,
    count(*) filter (
      where nullif(trim(coalesce(description, '')), '') is null
         or nullif(trim(coalesce(origin, '')), '') is null
         or nullif(trim(coalesce(hs_code, '')), '') is null
         or weight_kg is null
    )::integer,
    count(*) filter (where nullif(trim(coalesce(description, '')), '') is null)::integer,
    count(*) filter (where nullif(trim(coalesce(origin, '')), '') is null)::integer,
    count(*) filter (where nullif(trim(coalesce(hs_code, '')), '') is null)::integer,
    count(*) filter (where weight_kg is null)::integer,
    count(*) filter (where nullif(trim(coalesce(ean, '')), '') is null)::integer,
    count(*) filter (where nullif(trim(coalesce(oem_no, '')), '') is null)::integer,
    count(*) filter (
      where nullif(trim(coalesce(vehicle, '')), '') is null
        and nullif(trim(coalesce(vehicle_model, '')), '') is null
    )::integer,
    count(*) filter (where nullif(trim(coalesce(image_url, '')), '') is null)::integer
    into
      v_inserted_rows,
      v_complete_rows,
      v_incomplete_rows,
      v_missing_description,
      v_missing_origin,
      v_missing_hs_code,
      v_missing_weight,
      v_missing_ean,
      v_missing_oem,
      v_missing_vehicle,
      v_missing_image
  from provider_publication_inserted;

  if v_inserted_rows > 0 then
    perform public.apply_catalog_operations_snapshot_delta(
      v_run.organization_id,
      input_brand_id,
      v_inserted_rows,
      v_complete_rows,
      v_incomplete_rows,
      v_missing_description,
      v_missing_origin,
      v_missing_hs_code,
      v_missing_weight,
      v_missing_ean,
      v_missing_oem,
      v_missing_vehicle,
      v_missing_image,
      now()
    );

    insert into public.catalog_integrity_queue (
      organization_id,
      product_id,
      reason,
      priority,
      status,
      attempt_count,
      next_attempt_at,
      locked_at,
      lock_token,
      locked_by,
      last_error,
      updated_at
    )
    select
      p.organization_id,
      p.id,
      'provider_stage_published',
      20,
      'queued',
      0,
      now(),
      null,
      null,
      null,
      null,
      now()
    from provider_publication_inserted p
    on conflict (organization_id, product_id)
    do update set
      reason = excluded.reason,
      priority = greatest(public.catalog_integrity_queue.priority, excluded.priority),
      status = 'queued',
      attempt_count = 0,
      next_attempt_at = now(),
      locked_at = null,
      lock_token = null,
      locked_by = null,
      last_error = null,
      updated_at = now();

    insert into public.catalog_product_integrity (
      organization_id,
      product_id,
      status,
      last_product_change_at,
      updated_at
    )
    select
      p.organization_id,
      p.id,
      'queued',
      now(),
      now()
    from provider_publication_inserted p
    on conflict (organization_id, product_id)
    do update set
      status = 'queued',
      last_product_change_at = now(),
      last_error = null,
      updated_at = now();
  end if;

  insert into public.catalog_product_source_records (
    organization_id,
    catalog_product_id,
    source_key,
    source_url,
    source_product_id,
    source_version,
    source_product_type,
    source_as_of,
    retrieved_at,
    payload_fingerprint
  )
  select
    s.organization_id,
    p.id,
    s.source_key,
    s.source_url,
    s.source_product_id,
    input_run_id::text,
    coalesce(nullif(trim(s.product_type), ''), 'catalog_product'),
    s.source_as_of,
    coalesce(s.source_retrieved_at, now()),
    s.source_fingerprint
  from provider_publication_batch s
  join public.catalog_products p
    on p.organization_id = s.organization_id
   and p.brand_id = input_brand_id
   and p.normalized_code = s.normalized_code
  on conflict (
    organization_id,
    catalog_product_id,
    source_key,
    payload_fingerprint
  ) do nothing;

  get diagnostics v_provenance_rows = row_count;

  update public.catalog_provider_stage_publications p
  set processed_rows = p.processed_rows + v_batch_rows,
      inserted_rows = p.inserted_rows + v_inserted_rows,
      provenance_rows = p.provenance_rows + v_provenance_rows,
      last_row_index = v_batch_last_row,
      updated_at = now()
  where p.id = v_publication.id
  returning * into v_publication;

  if v_publication.processed_rows = v_publication.expected_rows then
    select count(*)::integer
      into v_canonical_matches
    from public.catalog_import_stage s
    join public.catalog_products p
      on p.organization_id = s.organization_id
     and p.brand_id = input_brand_id
     and p.normalized_code = s.normalized_code
    where s.run_id = input_run_id;

    select count(*)::integer
      into v_provenance_matches
    from public.catalog_import_stage s
    where s.run_id = input_run_id
      and exists (
        select 1
        from public.catalog_products p
        join public.catalog_product_source_records sr
          on sr.organization_id = p.organization_id
         and sr.catalog_product_id = p.id
         and sr.source_key = s.source_key
         and sr.payload_fingerprint = s.source_fingerprint
        where p.organization_id = s.organization_id
          and p.brand_id = input_brand_id
          and p.normalized_code = s.normalized_code
      );

    if v_canonical_matches <> v_publication.expected_rows
       or v_provenance_matches <> v_publication.expected_rows then
      raise exception 'Publication postflight failed';
    end if;

    update public.catalog_provider_stage_publications p
    set status = 'completed',
        completed_at = now(),
        updated_at = now()
    where p.id = v_publication.id
    returning * into v_publication;
  end if;

  v_status := v_publication.status;

  return jsonb_build_object(
    'publication_id', v_publication.id,
    'run_id', v_publication.run_id,
    'brand', v_brand_name,
    'source_key', v_source_key,
    'status', v_status,
    'expected_rows', v_publication.expected_rows,
    'batch_rows', v_batch_rows,
    'batch_inserted_rows', v_inserted_rows,
    'batch_provenance_rows', v_provenance_rows,
    'processed_rows', v_publication.processed_rows,
    'inserted_rows', v_publication.inserted_rows,
    'provenance_rows', v_publication.provenance_rows,
    'remaining_rows', v_publication.expected_rows - v_publication.processed_rows,
    'provider_run_unchanged', true
  );
end;
$$;

revoke all on function public.publish_catalog_provider_stage_batch(
  uuid,
  uuid,
  integer,
  text,
  text,
  integer
) from public, anon, authenticated;

grant execute on function public.publish_catalog_provider_stage_batch(
  uuid,
  uuid,
  integer,
  text,
  text,
  integer
) to service_role;
