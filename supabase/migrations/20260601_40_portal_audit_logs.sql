create table if not exists public.portal_audit_logs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid null,
  invite_id uuid null,
  party_type text null,
  email text null,
  event_type text not null,
  status text not null default 'ok',
  ip_address text null,
  user_agent text null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists portal_audit_logs_organization_created_idx
  on public.portal_audit_logs (organization_id, created_at desc);

create index if not exists portal_audit_logs_invite_created_idx
  on public.portal_audit_logs (invite_id, created_at desc);

create index if not exists portal_audit_logs_event_created_idx
  on public.portal_audit_logs (event_type, created_at desc);

alter table public.portal_audit_logs enable row level security;

revoke all on table public.portal_audit_logs from public;
revoke all on table public.portal_audit_logs from anon;
revoke all on table public.portal_audit_logs from authenticated;
