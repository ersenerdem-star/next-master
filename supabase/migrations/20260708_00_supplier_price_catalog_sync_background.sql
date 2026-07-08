-- Split supplier price import finalize into two steps:
-- 1) finalize supplier_prices atomically
-- 2) sync catalog_products in a retryable background step
--
-- This keeps the 45k+ row supplier finalize under the DB timeout while
-- preserving the staged rows needed for catalog retry/sync.

alter table public.supplier_price_import_runs
  add column if not exists catalog_sync_status text not null default 'pending',
  add column if not exists catalog_sync_started_at timestamptz,
  add column if not exists catalog_sync_finished_at timestamptz,
  add column if not exists catalog_sync_error_message text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'supplier_price_import_runs_catalog_sync_status_check'
      and conrelid = 'public.supplier_price_import_runs'::regclass
  ) then
    alter table public.supplier_price_import_runs
      add constraint supplier_price_import_runs_catalog_sync_status_check
      check (catalog_sync_status in ('pending', 'running', 'succeeded', 'failed'));
  end if;
end $$;

create or replace function public.finalize_supplier_price_import_inner(input_run_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
set statement_timeout = '300s'
as $$
declare
  v_org_id uuid;
  v_run public.supplier_price_import_runs%rowtype;
  v_processed integer := 0;
  v_deactivated integer := 0;
begin
  v_org_id := public.current_profile_org_id();

  if v_org_id is null or not public.is_superadmin() then
    raise exception 'Only active superadmin users can import supplier prices';
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

  if v_run.status <> 'running' then
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

  begin
    update public.supplier_price_import_runs
    set status = 'finalizing',
        catalog_sync_status = 'pending',
        catalog_sync_started_at = null,
        catalog_sync_finished_at = null,
        catalog_sync_error_message = null
    where id = v_run.id;

    if v_run.mode = 'replace' then
      update public.supplier_prices sp
      set is_active = false,
          updated_at = now()
      where sp.organization_id = v_run.organization_id
        and sp.supplier_id = v_run.supplier_id
        and sp.brand_id = v_run.brand_id
        and sp.is_active;

      get diagnostics v_deactivated = row_count;
    end if;

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
    duplicate_stats as (
      select
        greatest(
          (select count(*) from public.supplier_price_import_stage where run_id = v_run.id)
          - (select count(*) from supplier_source_rows),
          0
        )::integer as duplicate_rows
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
      from supplier_source_rows
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
    select count(*)::integer into v_processed
    from upserted_supplier_prices;

    update public.supplier_price_import_runs
    set status = 'succeeded',
        finished_at = now(),
        error_message = null,
        processed_rows = v_processed,
        catalog_synced = coalesce(catalog_synced, 0),
        catalog_sync_status = 'pending',
        catalog_sync_started_at = null,
        catalog_sync_finished_at = null,
        catalog_sync_error_message = null
    where id = v_run.id;

    return jsonb_build_object(
      'status', 'ok',
      'run_id', v_run.id,
      'mode', v_run.mode,
      'processed', v_processed,
      'catalog_synced', coalesce(v_run.catalog_synced, 0),
      'catalog_sync_status', 'pending',
      'deactivated', v_deactivated,
      'staged_rows', v_run.staged_rows
    );
  exception
    when others then
      update public.supplier_price_import_runs
      set status = 'failed',
          finished_at = now(),
          error_message = sqlerrm
      where id = v_run.id;
      raise;
  end;
end;
$$;

grant execute on function public.finalize_supplier_price_import_inner(uuid) to authenticated;
grant execute on function public.finalize_supplier_price_import_inner(uuid) to service_role;

drop function if exists public.sync_supplier_price_catalog_from_import(uuid);

create or replace function public.sync_supplier_price_catalog_from_import(input_run_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
set statement_timeout = '300s'
as $$
declare
  v_org_id uuid;
  v_run public.supplier_price_import_runs%rowtype;
  v_catalog_synced integer := 0;
  v_started_at timestamptz := clock_timestamp();
  v_finished_at timestamptz;
  v_error_message text;
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

  if v_run.status <> 'succeeded' then
    raise exception 'Catalog sync can only run after supplier finalize succeeds';
  end if;

  if coalesce(v_run.catalog_sync_status, 'pending') = 'succeeded' then
    return jsonb_build_object(
      'status', 'ok',
      'run_id', v_run.id,
      'catalog_sync_status', 'succeeded',
      'catalog_synced', coalesce(v_run.catalog_synced, 0)
    );
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(
      v_run.organization_id::text || ':' || v_run.supplier_id::text || ':' || v_run.brand_id::text,
      0
    )
  );

  begin
    update public.supplier_price_import_runs
    set catalog_sync_status = 'running',
        catalog_sync_started_at = v_started_at,
        catalog_sync_finished_at = null,
        catalog_sync_error_message = null
    where id = v_run.id;

    with source_rows as (
      select distinct on (s.brand_id, s.normalized_code)
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
      order by
        s.brand_id,
        s.normalized_code,
        case when nullif(trim(coalesce(s.description, '')), '') is not null then 0 else 1 end,
        case when nullif(trim(coalesce(s.oem_no, '')), '') is not null then 0 else 1 end,
        case when nullif(trim(coalesce(s.notes, '')), '') is not null then 0 else 1 end,
        s.buy_price asc nulls last,
        s.valid_from desc nulls last,
        s.id
    ),
    upserted_catalog as (
      insert into public.catalog_products (
        organization_id,
        brand_id,
        product_code,
        description,
        oem_no,
        notes
      )
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
          when nullif(trim(coalesce(public.catalog_products.description, '')), '') is null
            then excluded.description
          else public.catalog_products.description
        end,
        oem_no = case
          when nullif(trim(coalesce(public.catalog_products.oem_no, '')), '') is null
            then excluded.oem_no
          else public.catalog_products.oem_no
        end,
        notes = case
          when nullif(trim(coalesce(public.catalog_products.notes, '')), '') is null
            then excluded.notes
          else public.catalog_products.notes
        end,
        updated_at = now()
      where
        public.catalog_products.product_code is distinct from excluded.product_code
        or (
          nullif(trim(coalesce(public.catalog_products.description, '')), '') is null
          and excluded.description is not null
        )
        or (
          nullif(trim(coalesce(public.catalog_products.oem_no, '')), '') is null
          and excluded.oem_no is not null
        )
        or (
          nullif(trim(coalesce(public.catalog_products.notes, '')), '') is null
          and excluded.notes is not null
        )
      returning 1
    )
    select count(*)::integer into v_catalog_synced
    from upserted_catalog;

    v_finished_at := clock_timestamp();

    update public.supplier_price_import_runs
    set catalog_sync_status = 'succeeded',
        catalog_sync_finished_at = v_finished_at,
        catalog_sync_error_message = null,
        catalog_synced = v_catalog_synced
    where id = v_run.id;

    return jsonb_build_object(
      'status', 'ok',
      'run_id', v_run.id,
      'catalog_sync_status', 'succeeded',
      'catalog_synced', v_catalog_synced
    );
  exception
    when others then
      v_finished_at := clock_timestamp();
      v_error_message := left(coalesce(sqlerrm, 'Unknown supplier catalog sync failure'), 1000);

      update public.supplier_price_import_runs
      set catalog_sync_status = 'failed',
          catalog_sync_finished_at = v_finished_at,
          catalog_sync_error_message = v_error_message
      where id = v_run.id;

      return jsonb_build_object(
        'status', 'failed',
        'run_id', v_run.id,
        'catalog_sync_status', 'failed',
        'error_message', v_error_message
      );
  end;
end;
$$;

grant execute on function public.sync_supplier_price_catalog_from_import(uuid) to authenticated;
grant execute on function public.sync_supplier_price_catalog_from_import(uuid) to service_role;
