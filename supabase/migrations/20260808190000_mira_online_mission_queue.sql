-- MIRA online mission intake. This is an authenticated, review-only queue.
-- It intentionally does not execute external work or mutate Catalog products.

create table if not exists public.mira_missions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete restrict,
  created_by uuid not null references public.profiles(id) on delete restrict,
  objective text not null check (char_length(btrim(objective)) between 8 and 500),
  mission_area text not null default 'Public catalog signal',
  max_pages integer not null default 1 check (max_pages between 1 and 50),
  delay_ms integer not null default 2000 check (delay_ms between 1000 and 10000),
  status text not null default 'queued' check (status in ('queued', 'processing', 'completed', 'failed', 'cancelled')),
  execution_mode text not null default 'review_only' check (execution_mode = 'review_only'),
  result jsonb,
  error_message text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);

create index if not exists idx_mira_missions_org_created
  on public.mira_missions (organization_id, created_at desc);

create index if not exists idx_mira_missions_queue
  on public.mira_missions (status, created_at)
  where status in ('queued', 'processing');

alter table public.mira_missions enable row level security;

revoke all on table public.mira_missions from anon, authenticated;
grant select, insert, update on table public.mira_missions to service_role;

drop policy if exists mira_missions_no_direct_access on public.mira_missions;
create policy mira_missions_no_direct_access
  on public.mira_missions
  for all
  to anon, authenticated
  using (false)
  with check (false);

comment on table public.mira_missions is
  'Authenticated MIRA mission intake. Review-only; no automatic Catalog write or authority expansion.';
