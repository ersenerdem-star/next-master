alter table public.profiles
add column if not exists session_revoked_at timestamptz null;

create index if not exists idx_profiles_org_session_revoked_at
  on public.profiles (organization_id, session_revoked_at desc);
