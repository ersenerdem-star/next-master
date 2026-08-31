-- Add explicit progress/worker state telemetry and make stale duplicate runs safe to skip.

alter table public.supplier_price_import_runs
  add column if not exists catalog_sync_last_progress_at timestamptz,
  add column if not exists catalog_sync_last_batch_processed integer not null default 0,
  add column if not exists catalog_sync_batches integer not null default 0,
  add column if not exists catalog_sync_worker_state text not null default 'queued',
  add column if not exists superseded_by uuid references public.supplier_price_import_runs(id) on delete set null,
  add column if not exists superseded_at timestamptz;

do $$
begin
  alter table public.supplier_price_import_runs
    drop constraint if exists supplier_price_import_runs_status_check;
  alter table public.supplier_price_import_runs
    add constraint supplier_price_import_runs_status_check
    check (status in ('running', 'finalizing', 'finalized', 'succeeded', 'failed', 'superseded'));
exception
  when duplicate_object then null;
end;
$$;

do $$
begin
  alter table public.supplier_price_import_runs
    drop constraint if exists supplier_price_import_runs_catalog_sync_worker_state_check;
  alter table public.supplier_price_import_runs
    add constraint supplier_price_import_runs_catalog_sync_worker_state_check
    check (catalog_sync_worker_state in ('queued', 'running', 'lock_waiting', 'stalled', 'completed', 'failed', 'superseded'));
exception
  when duplicate_object then null;
end;
$$;

update public.supplier_price_import_runs
set catalog_sync_worker_state = case
  when status = 'superseded' then 'superseded'
  when catalog_sync_status = 'succeeded' then 'completed'
  when catalog_sync_status = 'failed' then 'failed'
  when catalog_sync_status = 'running' then 'running'
  else 'queued'
end,
catalog_sync_last_progress_at = coalesce(catalog_sync_last_progress_at, catalog_sync_started_at),
catalog_sync_last_batch_processed = coalesce(catalog_sync_last_batch_processed, 0),
catalog_sync_batches = coalesce(catalog_sync_batches, 0);

create index if not exists idx_supplier_price_import_runs_catalog_sync_priority
  on public.supplier_price_import_runs (catalog_sync_status, catalog_sync_started_at, started_at desc)
  where catalog_sync_status in ('pending', 'running')
    and status in ('finalized', 'succeeded');

create or replace function public.supersede_duplicate_supplier_price_import_runs()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status in ('finalized', 'succeeded')
     and (tg_op = 'INSERT' or (tg_op = 'UPDATE' and old.status is distinct from new.status))
  then
    update public.supplier_price_import_runs older
    set status = 'superseded',
        superseded_by = new.id,
        superseded_at = clock_timestamp(),
        catalog_sync_worker_state = 'superseded',
        processing_queued_at = null,
        processing_queued_by = null
    where older.id <> new.id
      and older.organization_id = new.organization_id
      and older.supplier_id = new.supplier_id
      and older.brand_id = new.brand_id
      and older.status in ('finalized', 'succeeded')
      and older.catalog_sync_status = 'pending'
      and older.started_at < new.started_at
      and older.staged_rows = new.staged_rows
      and coalesce(older.processed_rows, 0) = coalesce(new.processed_rows, 0);
  end if;
  return new;
end;
$$;

drop trigger if exists supplier_price_import_runs_supersede_duplicates
on public.supplier_price_import_runs;

create trigger supplier_price_import_runs_supersede_duplicates
after insert or update of status on public.supplier_price_import_runs
for each row execute function public.supersede_duplicate_supplier_price_import_runs();

-- Backfill the currently queued exact duplicates once, keeping the newest run.
with ranked as (
  select id,
         first_value(id) over (
           partition by organization_id, supplier_id, brand_id, staged_rows, coalesce(processed_rows, 0)
           order by started_at desc, id desc
         ) as winner_id,
         row_number() over (
           partition by organization_id, supplier_id, brand_id, staged_rows, coalesce(processed_rows, 0)
           order by started_at desc, id desc
         ) as row_rank
  from public.supplier_price_import_runs
  where status in ('finalized', 'succeeded')
    and catalog_sync_status = 'pending'
)
update public.supplier_price_import_runs older
set status = 'superseded',
    superseded_by = ranked.winner_id,
    superseded_at = clock_timestamp(),
    catalog_sync_worker_state = 'superseded',
    processing_queued_at = null,
    processing_queued_by = null
from ranked
where older.id = ranked.id
  and ranked.row_rank > 1;

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
  v_lock_key bigint;
begin
  if v_org_id is null or (public.current_profile_role() <> 'admin' and not public.is_superadmin()) then
    raise exception 'Only active admin users can import supplier prices';
  end if;
  if input_run_id is null then raise exception 'Import run is required'; end if;

  select * into v_run
  from public.supplier_price_import_runs
  where id = input_run_id and organization_id = v_org_id
  for update;
  if not found then raise exception 'Import run was not found'; end if;
  if v_run.status not in ('succeeded', 'finalized') then
    if v_run.status = 'superseded' then
      return jsonb_build_object('status','superseded','run_id',v_run.id,'catalog_sync_status','superseded','has_more',false);
    end if;
    raise exception 'Catalog sync can only run after supplier finalize succeeds';
  end if;
  if coalesce(v_run.catalog_sync_status, 'pending') = 'succeeded' then
    return jsonb_build_object(
      'status', 'ok', 'run_id', v_run.id, 'catalog_sync_status', 'succeeded',
      'catalog_synced', coalesce(v_run.catalog_synced, 0),
      'processed', coalesce(v_run.catalog_sync_processed, 0),
      'batches', coalesce(v_run.catalog_sync_batches, 0), 'has_more', false,
      'worker_state', 'completed', 'cursor', coalesce(v_run.catalog_sync_cursor, '')
    );
  end if;

  v_lock_key := hashtextextended(v_run.organization_id::text || ':' || v_run.supplier_id::text || ':' || v_run.brand_id::text, 0);
  if not pg_try_advisory_xact_lock(v_lock_key) then
    update public.supplier_price_import_runs
    set catalog_sync_status = 'running',
        catalog_sync_worker_state = 'lock_waiting',
        catalog_sync_started_at = coalesce(catalog_sync_started_at, clock_timestamp()),
        catalog_sync_last_progress_at = clock_timestamp(),
        catalog_sync_finished_at = null
    where id = v_run.id;
    return jsonb_build_object(
      'status','running','run_id',v_run.id,'catalog_sync_status','running',
      'worker_state','lock_waiting','processed',coalesce(v_run.catalog_sync_processed,0),
      'batches',coalesce(v_run.catalog_sync_batches,0),'cursor',coalesce(v_run.catalog_sync_cursor,''),'has_more',true
    );
  end if;

  update public.supplier_price_import_runs
  set catalog_sync_status = 'running',
      catalog_sync_worker_state = 'running',
      catalog_sync_started_at = coalesce(catalog_sync_started_at, clock_timestamp()),
      catalog_sync_last_progress_at = coalesce(catalog_sync_last_progress_at, clock_timestamp()),
      catalog_sync_finished_at = null,
      catalog_sync_error_message = null
  where id = v_run.id;

  with source_rows as (
    select distinct on (s.normalized_code)
      s.organization_id, s.brand_id, s.product_code, s.description, s.oem_no, s.notes, s.normalized_code
    from public.supplier_price_import_stage s
    where s.run_id = v_run.id
      and s.organization_id = v_run.organization_id
      and s.brand_id = v_run.brand_id
      and s.normalized_code <> ''
      and s.normalized_code > coalesce(v_run.catalog_sync_cursor, '')
    order by s.normalized_code,
      case when nullif(trim(coalesce(s.description, '')), '') is not null then 0 else 1 end,
      case when nullif(trim(coalesce(s.oem_no, '')), '') is not null then 0 else 1 end,
      case when nullif(trim(coalesce(s.notes, '')), '') is not null then 0 else 1 end,
      s.buy_price asc nulls last, s.valid_from desc nulls last, s.id
    limit v_batch_size
  ),
  upserted_catalog as (
    insert into public.catalog_products (organization_id, brand_id, product_code, description, oem_no, notes)
    select organization_id, brand_id, product_code,
      nullif(trim(coalesce(description, '')), ''),
      nullif(trim(coalesce(oem_no, '')), ''),
      nullif(trim(coalesce(notes, '')), '')
    from source_rows
    on conflict (organization_id, brand_id, normalized_code) do update set
      product_code = excluded.product_code,
      description = case when nullif(trim(coalesce(public.catalog_products.description, '')), '') is null then excluded.description else public.catalog_products.description end,
      oem_no = case when nullif(trim(coalesce(public.catalog_products.oem_no, '')), '') is null then excluded.oem_no else public.catalog_products.oem_no end,
      notes = case when nullif(trim(coalesce(public.catalog_products.notes, '')), '') is null then excluded.notes else public.catalog_products.notes end,
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
    set catalog_sync_status = 'succeeded', catalog_sync_worker_state = 'completed',
        catalog_sync_finished_at = v_finished_at, catalog_sync_last_progress_at = v_finished_at,
        catalog_sync_last_batch_processed = 0, catalog_sync_error_message = null
    where id = v_run.id;
    return jsonb_build_object(
      'status','ok','run_id',v_run.id,'catalog_sync_status','succeeded',
      'catalog_synced',coalesce(v_run.catalog_synced,0),'processed',coalesce(v_run.catalog_sync_processed,0),
      'batches',coalesce(v_run.catalog_sync_batches,0),'worker_state','completed',
      'cursor',coalesce(v_run.catalog_sync_cursor,''),'has_more',false
    );
  end if;

  update public.supplier_price_import_runs
  set catalog_sync_cursor = v_next_cursor,
      catalog_sync_processed = coalesce(catalog_sync_processed, 0) + v_batch_rows,
      catalog_synced = coalesce(catalog_synced, 0) + v_catalog_synced,
      catalog_sync_last_progress_at = clock_timestamp(),
      catalog_sync_last_batch_processed = v_batch_rows,
      catalog_sync_batches = coalesce(catalog_sync_batches, 0) + 1,
      catalog_sync_worker_state = 'running'
  where id = v_run.id;

  return jsonb_build_object(
    'status','running','run_id',v_run.id,'catalog_sync_status','running',
    'catalog_synced',coalesce(v_run.catalog_synced,0)+v_catalog_synced,
    'processed',coalesce(v_run.catalog_sync_processed,0)+v_batch_rows,
    'batch_processed',v_batch_rows,'batches',coalesce(v_run.catalog_sync_batches,0)+1,
    'worker_state','running','cursor',v_next_cursor,'has_more',true
  );
exception when others then
  update public.supplier_price_import_runs
  set catalog_sync_status='failed', catalog_sync_worker_state='failed',
      catalog_sync_finished_at=clock_timestamp(), catalog_sync_last_progress_at=clock_timestamp(),
      catalog_sync_error_message=left(coalesce(sqlerrm,'Unknown supplier catalog sync failure'),1000)
  where id=input_run_id;
  return jsonb_build_object('status','failed','run_id',input_run_id,'catalog_sync_status','failed','worker_state','failed','error_message',left(coalesce(sqlerrm,'Unknown supplier catalog sync failure'),1000));
end;
$$;
