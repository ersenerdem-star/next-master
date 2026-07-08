-- Make supplier price import finalize resumable.
-- Supplier price rows are merged in bounded transactions, then replace cleanup
-- deactivates stale rows in bounded transactions. Catalog sync remains outside
-- finalize and is queued after the run reaches finalized.

alter table public.supplier_price_import_runs
  add column if not exists finalize_phase text not null default 'merge',
  add column if not exists finalize_cursor integer not null default 0,
  add column if not exists finalize_started_at timestamptz,
  add column if not exists finalized_at timestamptz,
  add column if not exists finalize_error_message text;

do $$
begin
  if exists (
    select 1
    from pg_constraint
    where conname = 'supplier_price_import_runs_status_check'
      and conrelid = 'public.supplier_price_import_runs'::regclass
  ) then
    alter table public.supplier_price_import_runs
      drop constraint supplier_price_import_runs_status_check;
  end if;

  alter table public.supplier_price_import_runs
    add constraint supplier_price_import_runs_status_check
    check (status in ('running', 'finalizing', 'finalized', 'succeeded', 'failed'));

  if not exists (
    select 1
    from pg_constraint
    where conname = 'supplier_price_import_runs_finalize_phase_check'
      and conrelid = 'public.supplier_price_import_runs'::regclass
  ) then
    alter table public.supplier_price_import_runs
      add constraint supplier_price_import_runs_finalize_phase_check
      check (finalize_phase in ('merge', 'cleanup', 'done'));
  end if;
end $$;

drop function if exists public.finalize_supplier_price_import_batch(uuid, integer);

create or replace function public.finalize_supplier_price_import_batch(
  input_run_id uuid,
  input_batch_size integer default 2000
)
returns jsonb
language plpgsql
security definer
set search_path = public
set statement_timeout = '55s'
as $$
declare
  v_org_id uuid;
  v_run public.supplier_price_import_runs%rowtype;
  v_batch_size integer := greatest(100, least(coalesce(input_batch_size, 2000), 5000));
  v_batch_count integer := 0;
  v_source_total integer := 0;
  v_processed integer := 0;
  v_deactivated integer := 0;
begin
  v_org_id := public.current_profile_org_id();

  if v_org_id is null or (public.current_profile_role() <> 'admin' and not public.is_superadmin()) then
    raise exception 'Only active admin users can import supplier prices';
  end if;

  if input_run_id is null then
    raise exception 'Import run is required';
  end if;

  select *
  into v_run
  from public.supplier_price_import_runs
  where id = input_run_id
    and organization_id = v_org_id
  for update;

  if not found then
    raise exception 'Import run was not found';
  end if;

  if v_run.status in ('finalized', 'succeeded') then
    return jsonb_build_object(
      'status', 'finalized',
      'run_id', v_run.id,
      'processed', coalesce(v_run.processed_rows, v_run.staged_rows, 0),
      'staged_rows', v_run.staged_rows,
      'finalize_phase', 'done',
      'has_more', false,
      'catalog_sync_status', coalesce(v_run.catalog_sync_status, 'pending')
    );
  end if;

  if v_run.status not in ('running', 'finalizing', 'failed') then
    raise exception 'Import run cannot be finalized from status %', v_run.status;
  end if;

  if v_run.staged_rows <= 0 then
    raise exception 'Import run has no staged rows';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      v_run.organization_id::text || ':' || v_run.supplier_id::text || ':' || v_run.brand_id::text,
      0
    )
  );

  update public.supplier_price_import_runs
  set status = 'finalizing',
      finalize_phase = coalesce(nullif(finalize_phase, ''), 'merge'),
      finalize_started_at = coalesce(finalize_started_at, now()),
      finished_at = null,
      finalized_at = null,
      error_message = null,
      finalize_error_message = null
  where id = v_run.id
  returning * into v_run;

  if v_run.finalize_phase = 'merge' then
    with supplier_source_rows as (
      select distinct on (
        s.supplier_id,
        s.brand_id,
        s.normalized_code,
        s.valid_from
      )
        s.organization_id,
        s.supplier_id,
        s.brand_id,
        s.product_code,
        s.description,
        s.oem_no,
        round(coalesce(s.buy_price, 0), 2) as buy_price,
        s.currency,
        s.moq,
        s.lead_time_days,
        s.notes,
        s.valid_from,
        s.normalized_code
      from public.supplier_price_import_stage s
      where s.run_id = v_run.id
        and s.organization_id = v_run.organization_id
        and s.supplier_id = v_run.supplier_id
        and s.brand_id = v_run.brand_id
        and s.normalized_code <> ''
      order by
        s.supplier_id,
        s.brand_id,
        s.normalized_code,
        s.valid_from,
        case when s.buy_price is not null and s.buy_price > 0 then 0 else 1 end,
        case when nullif(trim(coalesce(s.description, '')), '') is not null then 0 else 1 end,
        case when nullif(trim(coalesce(s.oem_no, '')), '') is not null then 0 else 1 end,
        case when nullif(trim(coalesce(s.notes, '')), '') is not null then 0 else 1 end,
        s.buy_price asc nulls last,
        s.id
    ),
    numbered_rows as (
      select
        row_number() over (order by normalized_code, valid_from, product_code) as rn,
        count(*) over () as source_total,
        *
      from supplier_source_rows
    ),
    source_count as (
      select count(*)::integer as source_total
      from numbered_rows
    ),
    batch_rows as (
      select *
      from numbered_rows
      where rn > coalesce(v_run.processed_rows, 0)
      order by rn
      limit v_batch_size
    ),
    upserted_supplier_prices as (
      insert into public.supplier_prices (
        organization_id,
        supplier_id,
        brand_id,
        product_code,
        description,
        oem_no,
        buy_price,
        currency,
        moq,
        lead_time_days,
        notes,
        valid_from,
        is_active
      )
      select
        organization_id,
        supplier_id,
        brand_id,
        product_code,
        description,
        oem_no,
        buy_price,
        currency,
        moq,
        lead_time_days,
        notes,
        valid_from,
        true
      from batch_rows
      on conflict (organization_id, supplier_id, brand_id, normalized_code, valid_from) do update set
        product_code = excluded.product_code,
        description = coalesce(excluded.description, public.supplier_prices.description),
        oem_no = coalesce(excluded.oem_no, public.supplier_prices.oem_no),
        buy_price = excluded.buy_price,
        currency = excluded.currency,
        moq = coalesce(excluded.moq, public.supplier_prices.moq),
        lead_time_days = coalesce(excluded.lead_time_days, public.supplier_prices.lead_time_days),
        notes = coalesce(excluded.notes, public.supplier_prices.notes),
        is_active = true,
        updated_at = now()
      where
        public.supplier_prices.product_code is distinct from excluded.product_code
        or (excluded.description is not null and public.supplier_prices.description is distinct from excluded.description)
        or (excluded.oem_no is not null and public.supplier_prices.oem_no is distinct from excluded.oem_no)
        or public.supplier_prices.buy_price is distinct from excluded.buy_price
        or public.supplier_prices.currency is distinct from excluded.currency
        or (excluded.moq is not null and public.supplier_prices.moq is distinct from excluded.moq)
        or (excluded.lead_time_days is not null and public.supplier_prices.lead_time_days is distinct from excluded.lead_time_days)
        or (excluded.notes is not null and public.supplier_prices.notes is distinct from excluded.notes)
        or public.supplier_prices.is_active is distinct from true
      returning 1
    )
    select
      coalesce((select source_total from source_count), 0),
      (select count(*)::integer from batch_rows)
    into v_source_total, v_batch_count;

    v_processed := coalesce(v_run.processed_rows, 0) + v_batch_count;

    if v_batch_count = 0 or v_processed >= v_source_total then
      update public.supplier_price_import_runs
      set processed_rows = v_source_total,
          finalize_cursor = v_source_total,
          finalize_phase = case when mode = 'replace' then 'cleanup' else 'done' end,
          status = case when mode = 'replace' then 'finalizing' else 'finalized' end,
          finished_at = case when mode = 'replace' then null else now() end,
          finalized_at = case when mode = 'replace' then null else now() end,
          catalog_synced = coalesce(catalog_synced, 0),
          catalog_sync_status = 'pending',
          catalog_sync_started_at = null,
          catalog_sync_finished_at = null,
          catalog_sync_error_message = null
      where id = v_run.id
      returning * into v_run;
    else
      update public.supplier_price_import_runs
      set processed_rows = v_processed,
          finalize_cursor = v_processed,
          status = 'finalizing',
          finalize_phase = 'merge'
      where id = v_run.id
      returning * into v_run;
    end if;

    return jsonb_build_object(
      'status', v_run.status,
      'run_id', v_run.id,
      'processed', coalesce(v_run.processed_rows, 0),
      'staged_rows', v_run.staged_rows,
      'batch_processed', v_batch_count,
      'source_total', v_source_total,
      'finalize_phase', v_run.finalize_phase,
      'has_more', v_run.status <> 'finalized',
      'catalog_sync_status', coalesce(v_run.catalog_sync_status, 'pending')
    );
  end if;

  if v_run.finalize_phase = 'cleanup' then
    with stale_prices as (
      select sp.id
      from public.supplier_prices sp
      where sp.organization_id = v_run.organization_id
        and sp.supplier_id = v_run.supplier_id
        and sp.brand_id = v_run.brand_id
        and sp.is_active
        and not exists (
          select 1
          from public.supplier_price_import_stage s
          where s.run_id = v_run.id
            and s.organization_id = sp.organization_id
            and s.supplier_id = sp.supplier_id
            and s.brand_id = sp.brand_id
            and s.normalized_code = sp.normalized_code
            and s.valid_from = sp.valid_from
        )
      order by sp.id
      limit v_batch_size
    ),
    deactivated as (
      update public.supplier_prices sp
      set is_active = false,
          updated_at = now()
      from stale_prices stale
      where sp.id = stale.id
      returning 1
    )
    select count(*)::integer into v_deactivated
    from deactivated;

    if v_deactivated = 0 then
      update public.supplier_price_import_runs
      set status = 'finalized',
          finalize_phase = 'done',
          finished_at = now(),
          finalized_at = now(),
          error_message = null,
          finalize_error_message = null,
          catalog_synced = coalesce(catalog_synced, 0),
          catalog_sync_status = 'pending',
          catalog_sync_started_at = null,
          catalog_sync_finished_at = null,
          catalog_sync_error_message = null
      where id = v_run.id
      returning * into v_run;
    end if;

    return jsonb_build_object(
      'status', v_run.status,
      'run_id', v_run.id,
      'processed', coalesce(v_run.processed_rows, 0),
      'staged_rows', v_run.staged_rows,
      'batch_deactivated', v_deactivated,
      'finalize_phase', v_run.finalize_phase,
      'has_more', v_run.status <> 'finalized',
      'catalog_sync_status', coalesce(v_run.catalog_sync_status, 'pending')
    );
  end if;

  raise exception 'Unknown finalize phase %', v_run.finalize_phase;
exception
  when others then
    update public.supplier_price_import_runs
    set status = 'failed',
        finished_at = now(),
        error_message = sqlerrm,
        finalize_error_message = sqlerrm
    where id = input_run_id
      and organization_id = v_org_id;
    raise;
end;
$$;

grant execute on function public.finalize_supplier_price_import_batch(uuid, integer) to authenticated;
grant execute on function public.finalize_supplier_price_import_batch(uuid, integer) to service_role;

create or replace function public.finalize_supplier_price_import(input_run_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
set statement_timeout = '55s'
as $$
begin
  return public.finalize_supplier_price_import_batch(input_run_id, 2000);
end;
$$;

grant execute on function public.finalize_supplier_price_import(uuid) to authenticated;
grant execute on function public.finalize_supplier_price_import(uuid) to service_role;
