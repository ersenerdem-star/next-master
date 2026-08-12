-- MIRA bridge result ingress. This migration keeps the queue review-only:
-- bridge results are evidence/debrief metadata and never Catalog mutations.

do $$
begin
  if to_regclass('public.mira_missions') is null then
    raise exception 'public.mira_missions must exist before applying the MIRA bridge migration';
  end if;
end
$$;

alter table public.mira_missions
  add column if not exists bridge_client text,
  add column if not exists bridge_event_id text,
  add column if not exists bridge_protocol_version text,
  add column if not exists bridge_received_at timestamptz;

alter table public.mira_missions
  drop constraint if exists mira_missions_status_check;

alter table public.mira_missions
  add constraint mira_missions_status_check
  check (status in ('queued', 'processing', 'completed', 'partial', 'blocked', 'failed', 'cancelled'));

create unique index if not exists uq_mira_missions_bridge_event
  on public.mira_missions (organization_id, bridge_event_id)
  where bridge_event_id is not null;

create or replace function public.claim_mira_mission_bridge(
  input_organization_id uuid,
  input_bridge_client text
)
returns setof public.mira_missions
language sql
security definer
set search_path = public, pg_temp
as $$
  with next_mission as (
    select id
    from public.mira_missions
    where organization_id = input_organization_id
      and status = 'queued'
    order by created_at asc
    for update skip locked
    limit 1
  )
  update public.mira_missions as mission
  set status = 'processing',
      started_at = coalesce(mission.started_at, now()),
      bridge_client = left(nullif(btrim(input_bridge_client), ''), 100)
  from next_mission
  where mission.id = next_mission.id
  returning mission.*;
$$;

-- The online worker must bind a claim to the exact mission it was assigned.
-- This avoids consuming a different queued mission when multiple workers run.
create or replace function public.claim_mira_mission_bridge_by_id(
  input_organization_id uuid,
  input_bridge_client text,
  input_mission_id uuid
)
returns setof public.mira_missions
language sql
security definer
set search_path = public, pg_temp
as $$
  update public.mira_missions as mission
  set status = 'processing',
      started_at = coalesce(mission.started_at, now()),
      bridge_client = left(nullif(btrim(input_bridge_client), ''), 100)
  where mission.id = input_mission_id
    and mission.organization_id = input_organization_id
    and mission.status = 'queued'
  returning mission.*;
$$;

revoke all on function public.claim_mira_mission_bridge(uuid, text) from public, anon, authenticated;
grant execute on function public.claim_mira_mission_bridge(uuid, text) to service_role;
revoke all on function public.claim_mira_mission_bridge_by_id(uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.claim_mira_mission_bridge_by_id(uuid, text, uuid) to service_role;

comment on column public.mira_missions.result is
  'Bounded MIRA evidence/result envelope. Review-only; never treated as Catalog product data.';
comment on column public.mira_missions.bridge_event_id is
  'Signed idempotency key from the external MIRA worker; not a Catalog event.';
comment on function public.claim_mira_mission_bridge(uuid, text) is
  'Operator-only fallback: atomically claims the oldest queued review-only MIRA mission. The network bridge uses the exact-ID function below.';
comment on function public.claim_mira_mission_bridge_by_id(uuid, text, uuid) is
  'Atomically claims only the exact queued review-only MIRA mission requested by the allow-listed bridge worker.';
