-- Make supplier-price catalog synchronization resumable.
-- Large imports must not be copied into catalog_products in one transaction.

alter table public.supplier_price_import_runs
  add column if not exists catalog_sync_cursor text not null default '',
  add column if not exists catalog_sync_processed integer not null default 0;

create index if not exists idx_supplier_price_import_runs_catalog_sync_queue
  on public.supplier_price_import_runs (catalog_sync_status, status, started_at)
  where catalog_sync_status in ('pending', 'running')
    and status in ('finalized', 'succeeded');

create or replace function public.sync_supplier_price_catalog_batch(input_run_id uuid, input_batch_size integer default 1000)
returns jsonb
language plpgsql
security definer
set search_path = public
set statement_timeout = '55s'
as $$
declare
  v_org_id uuid := public.current_profile_org_id();
  v_run public.supplier_price_import_runs%rowtype;
  v_batch_size integer := greatest(1, least(coalesce(input_batch_size, 1000), 2000));
  v_batch_rows integer := 0;
  v_catalog_synced integer := 0;
  v_next_cursor text;
  v_finished_at timestamptz;
begin
  if v_org_id is null or (public.current_profile_role() <> 'admin' and not public.is_superadmin()) then
    raise exception 'Only active admin users can import supplier prices';
  end if;

  if input_run_id is null then
    raise exception 'Import run is required';
  end if;

  select * into v_run
  from public.supplier_price_import_runs
  where id = input_run_id and organization_id = v_org_id
  for update;

  if not found then raise exception 'Import run was not found'; end if;
  if v_run.status not in ('succeeded', 'finalized') then
    raise exception 'Catalog sync can only run after supplier finalize succeeds';
  end if;

  if coalesce(v_run.catalog_sync_status, 'pending') = 'succeeded' then
    return jsonb_build_object(
      'status', 'ok', 'run_id', v_run.id, 'catalog_sync_status', 'succeeded',
      'catalog_synced', coalesce(v_run.catalog_synced, 0),
      'processed', coalesce(v_run.catalog_sync_processed, 0), 'has_more', false
    );
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    v_run.organization_id::text || ':' || v_run.supplier_id::text || ':' || v_run.brand_id::text,
    0
  ));

  update public.supplier_price_import_runs
  set catalog_sync_status = 'running',
      catalog_sync_started_at = coalesce(catalog_sync_started_at, clock_timestamp()),
      catalog_sync_finished_at = null,
      catalog_sync_error_message = null
  where id = v_run.id;

  with source_rows as (
    select distinct on (s.normalized_code)
      s.organization_id,
      s.brand_id,
      s.product_code,
      s.description,
      s.oem_no,
      s.notes,
      s.normalized_code
    from public.supplier_price_import_stage s
    where s.run_id = v_run.id
      and s.organization_id = v_run.organization_id
      and s.brand_id = v_run.brand_id
      and s.normalized_code <> ''
      and s.normalized_code > coalesce(v_run.catalog_sync_cursor, '')
    order by
      s.normalized_code,
      case when nullif(trim(coalesce(s.description, '')), '') is not null then 0 else 1 end,
      case when nullif(trim(coalesce(s.oem_no, '')), '') is not null then 0 else 1 end,
      case when nullif(trim(coalesce(s.notes, '')), '') is not null then 0 else 1 end,
      s.buy_price asc nulls last,
      s.valid_from desc nulls last,
      s.id
    limit v_batch_size
  ),
  upserted_catalog as (
    insert into public.catalog_products (organization_id, brand_id, product_code, description, oem_no, notes)
    select
      organization_id,
      brand_id,
      product_code,
      nullif(trim(coalesce(description, '')), ''),
      nullif(trim(coalesce(oem_no, '')), ''),
      nullif(trim(coalesce(notes, '')), '')
    from source_rows
    on conflict (organization_id, brand_id, normalized_code) do update set
      product_code = excluded.product_code,
      description = case
        when nullif(trim(coalesce(public.catalog_products.description, '')), '') is null then excluded.description
        else public.catalog_products.description
      end,
      oem_no = case
        when nullif(trim(coalesce(public.catalog_products.oem_no, '')), '') is null then excluded.oem_no
        else public.catalog_products.oem_no
      end,
      notes = case
        when nullif(trim(coalesce(public.catalog_products.notes, '')), '') is null then excluded.notes
        else public.catalog_products.notes
      end,
      updated_at = now()
    where public.catalog_products.product_code is distinct from excluded.product_code
       or (nullif(trim(coalesce(public.catalog_products.description, '')), '') is null and excluded.description is not null)
       or (nullif(trim(coalesce(public.catalog_products.oem_no, '')), '') is null and excluded.oem_no is not null)
       or (nullif(trim(coalesce(public.catalog_products.notes, '')), '') is null and excluded.notes is not null)
    returning 1
  )
  select (select count(*)::integer from source_rows),
         (select count(*)::integer from upserted_catalog),
         (select max(normalized_code) from source_rows)
    into v_batch_rows, v_catalog_synced, v_next_cursor;

  if v_batch_rows = 0 then
    v_finished_at := clock_timestamp();
    update public.supplier_price_import_runs
    set catalog_sync_status = 'succeeded',
        catalog_sync_finished_at = v_finished_at,
        catalog_sync_error_message = null
    where id = v_run.id;

    return jsonb_build_object(
      'status', 'ok', 'run_id', v_run.id, 'catalog_sync_status', 'succeeded',
      'catalog_synced', coalesce(v_run.catalog_synced, 0),
      'processed', coalesce(v_run.catalog_sync_processed, 0), 'has_more', false
    );
  end if;

  update public.supplier_price_import_runs
  set catalog_sync_cursor = v_next_cursor,
      catalog_sync_processed = coalesce(catalog_sync_processed, 0) + v_batch_rows,
      catalog_synced = coalesce(catalog_synced, 0) + v_catalog_synced
  where id = v_run.id;

  return jsonb_build_object(
    'status', 'running', 'run_id', v_run.id, 'catalog_sync_status', 'running',
    'catalog_synced', coalesce(v_run.catalog_synced, 0) + v_catalog_synced,
    'processed', coalesce(v_run.catalog_sync_processed, 0) + v_batch_rows,
    'batch_processed', v_batch_rows, 'has_more', true
  );
exception
  when others then
    update public.supplier_price_import_runs
    set catalog_sync_status = 'failed',
        catalog_sync_finished_at = clock_timestamp(),
        catalog_sync_error_message = left(coalesce(sqlerrm, 'Unknown supplier catalog sync failure'), 1000)
    where id = input_run_id;
    return jsonb_build_object(
      'status', 'failed', 'run_id', input_run_id, 'catalog_sync_status', 'failed',
      'error_message', left(coalesce(sqlerrm, 'Unknown supplier catalog sync failure'), 1000)
    );
end;
$$;

create or replace function public.sync_supplier_price_catalog_batch_system(
  input_run_id uuid,
  input_organization_id uuid,
  input_actor_id uuid,
  input_batch_size integer default 1000
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_org uuid;
  v_actor_role text;
begin
  select organization_id, lower(role::text) into v_actor_org, v_actor_role
  from public.profiles
  where id = input_actor_id and is_active = true;
  if v_actor_org is null or v_actor_org <> input_organization_id
     or v_actor_role not in ('admin', 'superadmin') then
    raise exception 'System supplier sync actor is not an active organization admin';
  end if;
  perform set_config('request.jwt.claim.sub', input_actor_id::text, true);
  return public.sync_supplier_price_catalog_batch(input_run_id, input_batch_size);
end;
$$;

revoke all on function public.sync_supplier_price_catalog_batch(uuid, integer) from public, anon, authenticated;
grant execute on function public.sync_supplier_price_catalog_batch(uuid, integer) to service_role;
revoke all on function public.sync_supplier_price_catalog_batch_system(uuid, uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.sync_supplier_price_catalog_batch_system(uuid, uuid, uuid, integer) to service_role;
