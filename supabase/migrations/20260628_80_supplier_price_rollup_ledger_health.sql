-- Supplier Comparison rollup refresh ledger and lightweight health RPC.
-- This migration preserves the live rollup selection logic by cloning the
-- existing refresh_supplier_price_rollups(uuid) implementation into a private
-- core function before wrapping the public function with run-ledger writes.

create table if not exists public.supplier_price_rollup_refresh_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid null references public.organizations(id) on delete set null,
  started_at timestamptz not null default now(),
  finished_at timestamptz null,
  duration_ms integer null,
  status text not null default 'running',
  error_message text null,
  supplier_price_rollups_count integer null
);

alter table public.supplier_price_rollup_refresh_runs
  add column if not exists organization_id uuid null references public.organizations(id) on delete set null,
  add column if not exists started_at timestamptz not null default now(),
  add column if not exists finished_at timestamptz null,
  add column if not exists duration_ms integer null,
  add column if not exists status text not null default 'running',
  add column if not exists error_message text null,
  add column if not exists supplier_price_rollups_count integer null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'supplier_price_rollup_refresh_runs_status_check'
      and conrelid = 'public.supplier_price_rollup_refresh_runs'::regclass
  ) then
    alter table public.supplier_price_rollup_refresh_runs
      add constraint supplier_price_rollup_refresh_runs_status_check
      check (status in ('running', 'succeeded', 'failed'));
  end if;
end $$;

create index if not exists idx_supplier_price_rollup_refresh_runs_started_at
  on public.supplier_price_rollup_refresh_runs (started_at desc);

create index if not exists idx_supplier_price_rollup_refresh_runs_org_started_at
  on public.supplier_price_rollup_refresh_runs (organization_id, started_at desc);

create index if not exists idx_supplier_price_rollup_refresh_runs_status_started_at
  on public.supplier_price_rollup_refresh_runs (status, started_at desc);

alter table public.supplier_price_rollup_refresh_runs enable row level security;

drop policy if exists supplier_price_rollup_refresh_runs_select_superadmin
on public.supplier_price_rollup_refresh_runs;

create policy supplier_price_rollup_refresh_runs_select_superadmin
on public.supplier_price_rollup_refresh_runs
for select
using (public.is_superadmin());

grant select on public.supplier_price_rollup_refresh_runs to authenticated;
grant select on public.supplier_price_rollup_refresh_runs to service_role;

do $$
declare
  v_function_def text;
  v_core_function_def text;
begin
  if to_regprocedure('public.refresh_supplier_price_rollups_core(uuid)') is null then
    if to_regprocedure('public.refresh_supplier_price_rollups(uuid)') is null then
      raise exception 'Required function public.refresh_supplier_price_rollups(uuid) does not exist';
    end if;

    v_function_def := pg_get_functiondef('public.refresh_supplier_price_rollups(uuid)'::regprocedure);

    v_core_function_def := regexp_replace(
      v_function_def,
      'CREATE OR REPLACE FUNCTION public\.refresh_supplier_price_rollups\s*\(',
      'CREATE OR REPLACE FUNCTION public.refresh_supplier_price_rollups_core(',
      'i'
    );

    execute v_core_function_def;
  end if;
end $$;

revoke all on function public.refresh_supplier_price_rollups_core(uuid) from public;
revoke all on function public.refresh_supplier_price_rollups_core(uuid) from anon;
revoke all on function public.refresh_supplier_price_rollups_core(uuid) from authenticated;
grant execute on function public.refresh_supplier_price_rollups_core(uuid) to service_role;

create or replace function public.refresh_supplier_price_rollups(input_organization_id uuid default null)
returns integer
language plpgsql
security definer
set search_path = public
set statement_timeout = '180s'
as $$
declare
  v_run_id uuid := gen_random_uuid();
  v_started_at timestamptz := clock_timestamp();
  v_finished_at timestamptz;
  v_duration_ms integer;
  v_error_message text;
  v_supplier_price_rollups_count integer := 0;
begin
  insert into public.supplier_price_rollup_refresh_runs (
    id,
    organization_id,
    started_at,
    status
  ) values (
    v_run_id,
    input_organization_id,
    v_started_at,
    'running'
  );

  begin
    v_supplier_price_rollups_count := public.refresh_supplier_price_rollups_core(input_organization_id);
    v_finished_at := clock_timestamp();
    v_duration_ms := greatest(0, round(extract(epoch from (v_finished_at - v_started_at)) * 1000)::integer);

    update public.supplier_price_rollup_refresh_runs
    set finished_at = v_finished_at,
        duration_ms = v_duration_ms,
        status = 'succeeded',
        error_message = null,
        supplier_price_rollups_count = v_supplier_price_rollups_count
    where id = v_run_id;

    return v_supplier_price_rollups_count;
  exception when others then
    v_finished_at := clock_timestamp();
    v_duration_ms := greatest(0, round(extract(epoch from (v_finished_at - v_started_at)) * 1000)::integer);
    v_error_message := left(coalesce(sqlerrm, 'Unknown refresh failure'), 1000);

    update public.supplier_price_rollup_refresh_runs
    set finished_at = v_finished_at,
        duration_ms = v_duration_ms,
        status = 'failed',
        error_message = v_error_message
    where id = v_run_id;

    raise;
  end;
end;
$$;

grant execute on function public.refresh_supplier_price_rollups(uuid) to authenticated;
grant execute on function public.refresh_supplier_price_rollups(uuid) to service_role;

create or replace function public.refresh_supplier_price_rollups_logged(p_organization_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
set statement_timeout = '180s'
as $$
declare
  v_run_id uuid := gen_random_uuid();
  v_started_at timestamptz := clock_timestamp();
  v_finished_at timestamptz;
  v_duration_ms integer;
  v_error_message text;
  v_supplier_price_rollups_count integer := 0;
begin
  if p_organization_id is null then
    raise exception 'Organization id is required';
  end if;

  insert into public.supplier_price_rollup_refresh_runs (
    id,
    organization_id,
    started_at,
    status
  ) values (
    v_run_id,
    p_organization_id,
    v_started_at,
    'running'
  );

  begin
    v_supplier_price_rollups_count := public.refresh_supplier_price_rollups_core(p_organization_id);
    v_finished_at := clock_timestamp();
    v_duration_ms := greatest(0, round(extract(epoch from (v_finished_at - v_started_at)) * 1000)::integer);

    update public.supplier_price_rollup_refresh_runs
    set finished_at = v_finished_at,
        duration_ms = v_duration_ms,
        status = 'succeeded',
        error_message = null,
        supplier_price_rollups_count = v_supplier_price_rollups_count
    where id = v_run_id;

    return jsonb_build_object(
      'run_id', v_run_id,
      'organization_id', p_organization_id,
      'started_at', v_started_at,
      'finished_at', v_finished_at,
      'duration_ms', v_duration_ms,
      'status', 'succeeded',
      'supplier_price_rollups_count', v_supplier_price_rollups_count
    );
  exception when others then
    v_finished_at := clock_timestamp();
    v_duration_ms := greatest(0, round(extract(epoch from (v_finished_at - v_started_at)) * 1000)::integer);
    v_error_message := left(coalesce(sqlerrm, 'Unknown refresh failure'), 1000);

    update public.supplier_price_rollup_refresh_runs
    set finished_at = v_finished_at,
        duration_ms = v_duration_ms,
        status = 'failed',
        error_message = v_error_message
    where id = v_run_id;

    return jsonb_build_object(
      'run_id', v_run_id,
      'organization_id', p_organization_id,
      'started_at', v_started_at,
      'finished_at', v_finished_at,
      'duration_ms', v_duration_ms,
      'status', 'failed',
      'error_message', v_error_message
    );
  end;
end;
$$;

grant execute on function public.refresh_supplier_price_rollups_logged(uuid) to authenticated;
grant execute on function public.refresh_supplier_price_rollups_logged(uuid) to service_role;

create or replace function public.supplier_price_rollup_health(p_organization_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_result jsonb;
begin
  if p_organization_id is null then
    raise exception 'Organization id is required';
  end if;

  if auth.uid() is not null and not public.is_superadmin() then
    if p_organization_id <> public.current_profile_org_id() then
      raise exception 'Only active users can inspect supplier price rollup health for their own organization';
    end if;
  end if;

  with latest_run as (
    select
      id,
      organization_id,
      started_at,
      finished_at,
      duration_ms,
      status,
      error_message,
      supplier_price_rollups_count
    from public.supplier_price_rollup_refresh_runs
    where organization_id = p_organization_id
    order by started_at desc, id desc
    limit 1
  ),
  latest_success as (
    select
      id,
      organization_id,
      started_at,
      finished_at,
      duration_ms,
      status,
      error_message,
      supplier_price_rollups_count
    from public.supplier_price_rollup_refresh_runs
    where organization_id = p_organization_id
      and status = 'succeeded'
    order by finished_at desc nulls last, started_at desc, id desc
    limit 1
  ),
  rollup_counts as (
    select count(*)::bigint as supplier_price_rollups_count
    from public.supplier_price_rollups spr
    where spr.organization_id = p_organization_id
  ),
  eligible_counts as (
    select
      count(*)::bigint as eligible_supplier_price_rows,
      count(*) filter (
        where latest_success.id is not null
          and sp.updated_at > coalesce(latest_success.finished_at, latest_success.started_at)
      )::bigint as rows_updated_after_refresh
    from public.supplier_prices sp
    left join latest_success on true
    where sp.organization_id = p_organization_id
      and sp.is_active
      and sp.buy_price is not null
      and sp.normalized_code is not null
      and sp.normalized_code <> ''
  ),
  health as (
    select
      case
        when latest_run.id is null then 'NO_LEDGER'
        when latest_run.status = 'failed' then 'FAILED'
        when latest_run.status = 'running' then 'RUNNING'
        when eligible_counts.rows_updated_after_refresh > 0 then 'STALE'
        else 'OK'
      end as status,
      latest_run.started_at as latest_refresh_started_at,
      latest_run.finished_at as latest_refresh_finished_at,
      latest_run.duration_ms as latest_refresh_duration_ms,
      latest_run.status as latest_refresh_status,
      latest_run.error_message as latest_refresh_error_message,
      latest_success.started_at as latest_successful_refresh_started_at,
      latest_success.finished_at as latest_successful_refresh_finished_at,
      rollup_counts.supplier_price_rollups_count,
      eligible_counts.eligible_supplier_price_rows,
      eligible_counts.rows_updated_after_refresh
    from rollup_counts
    cross join eligible_counts
    left join latest_run on true
    left join latest_success on true
  )
  select jsonb_build_object(
    'organization_id', p_organization_id,
    'status', health.status,
    'latest_refresh_started_at', health.latest_refresh_started_at,
    'latest_refresh_finished_at', health.latest_refresh_finished_at,
    'latest_refresh_duration_ms', health.latest_refresh_duration_ms,
    'latest_refresh_status', health.latest_refresh_status,
    'latest_refresh_error_message', health.latest_refresh_error_message,
    'latest_successful_refresh_started_at', health.latest_successful_refresh_started_at,
    'latest_successful_refresh_finished_at', health.latest_successful_refresh_finished_at,
    'supplier_price_rollups_count', health.supplier_price_rollups_count,
    'eligible_supplier_price_rows', health.eligible_supplier_price_rows,
    'rows_updated_after_refresh', health.rows_updated_after_refresh,
    'parity_mismatch_count', null,
    'generated_at', now()
  )
  into v_result
  from health;

  return v_result;
end;
$$;

revoke all on function public.supplier_price_rollup_health(uuid) from public;
revoke all on function public.supplier_price_rollup_health(uuid) from anon;
grant execute on function public.supplier_price_rollup_health(uuid) to authenticated;
grant execute on function public.supplier_price_rollup_health(uuid) to service_role;
