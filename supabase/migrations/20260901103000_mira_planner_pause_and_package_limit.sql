-- MIRA planner controls and larger operator-selected mission packages.
--
-- FEBI's autonomous image planner is paused without disabling the admitted
-- source or changing any Catalog data. Historical missions remain auditable.

set lock_timeout = '5s';
set statement_timeout = '60s';

alter table public.mira_missions
  drop constraint if exists mira_missions_max_items_check;

alter table public.mira_missions
  add constraint mira_missions_max_items_check
  check (max_items between 1 and 1000);

create table if not exists public.mira_planner_controls (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  control_key text not null,
  enabled boolean not null default true,
  reason text not null default '',
  updated_at timestamptz not null default now(),
  primary key (organization_id, control_key)
);

alter table public.mira_planner_controls enable row level security;
revoke all on table public.mira_planner_controls from public, anon, authenticated;
grant select, insert, update on table public.mira_planner_controls to service_role;

drop policy if exists mira_planner_controls_no_direct_access on public.mira_planner_controls;
create policy mira_planner_controls_no_direct_access
  on public.mira_planner_controls
  for all
  to anon, authenticated
  using (false)
  with check (false);

-- Use the existing admitted source to resolve the tenant instead of embedding
-- a generated organization UUID in this data migration.
insert into public.mira_planner_controls (
  organization_id, control_key, enabled, reason, updated_at
)
select distinct
  source.organization_id,
  'febi_image_reference',
  false,
  'FEBI autonomous image planner paused by operator; historical missions remain reviewable.',
  now()
from public.catalog_external_sources source
where source.source_key = 'bilstein_group_partsfinder_observation'
on conflict (organization_id, control_key) do update
  set enabled = false,
      reason = excluded.reason,
      updated_at = excluded.updated_at;

-- Preserve the existing, fully audited planner implementation and put a
-- tenant-scoped pause guard in front of it.
alter function public.plan_mira_catalog_missions(uuid, uuid, integer)
  rename to plan_mira_catalog_missions_original;

create or replace function public.plan_mira_catalog_missions(
  input_organization_id uuid,
  input_actor_id uuid default null,
  input_limit integer default 1
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
set statement_timeout = '60s'
as $$
begin
  if exists (
    select 1
    from public.mira_planner_controls control
    where control.organization_id = input_organization_id
      and control.control_key = 'febi_image_reference'
      and control.enabled is false
  ) then
    return jsonb_build_object(
      'status', 'disabled',
      'createdCount', 0,
      'reason', 'FEBI autonomous image planner is paused by operator.',
      'catalogWrite', false,
      'apply', false
    );
  end if;

  return public.plan_mira_catalog_missions_original(
    input_organization_id,
    input_actor_id,
    input_limit
  );
end;
$$;

revoke all on function public.plan_mira_catalog_missions(uuid, uuid, integer)
  from public, anon, authenticated;
grant execute on function public.plan_mira_catalog_missions(uuid, uuid, integer)
  to service_role;

comment on table public.mira_planner_controls is
  'Tenant-scoped operator controls for autonomous MIRA planner routes.';
comment on function public.plan_mira_catalog_missions(uuid, uuid, integer) is
  'Returns disabled for paused planner routes; otherwise delegates to the audited planner implementation.';
