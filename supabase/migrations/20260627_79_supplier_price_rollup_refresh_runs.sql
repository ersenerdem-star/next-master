create table if not exists public.supplier_price_rollup_refresh_runs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid null references public.organizations(id) on delete set null,
  started_at timestamptz not null default now(),
  finished_at timestamptz null,
  duration_ms integer null,
  status text not null default 'running' check (status in ('running', 'succeeded', 'failed')),
  error_message text null,
  supplier_price_rollups_count integer null
);

create index if not exists idx_supplier_price_rollup_refresh_runs_started_at
  on public.supplier_price_rollup_refresh_runs (started_at desc);

create index if not exists idx_supplier_price_rollup_refresh_runs_org_started_at
  on public.supplier_price_rollup_refresh_runs (organization_id, started_at desc);

create index if not exists idx_supplier_price_rollup_refresh_runs_status_started_at
  on public.supplier_price_rollup_refresh_runs (status, started_at desc);

alter table public.supplier_price_rollup_refresh_runs enable row level security;

drop policy if exists supplier_price_rollup_refresh_runs_select_superadmin on public.supplier_price_rollup_refresh_runs;
create policy supplier_price_rollup_refresh_runs_select_superadmin on public.supplier_price_rollup_refresh_runs
for select
using (public.is_superadmin());

grant select on public.supplier_price_rollup_refresh_runs to authenticated;
grant select on public.supplier_price_rollup_refresh_runs to service_role;

create or replace function public.refresh_supplier_price_rollups_logged(p_organization_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
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

  if auth.uid() is not null and not public.is_superadmin() then
    if p_organization_id <> public.current_profile_org_id() then
      raise exception 'Only active superadmin users can refresh supplier price rollups for another organization';
    end if;
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
    v_supplier_price_rollups_count := public.refresh_supplier_price_rollups(p_organization_id);
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
