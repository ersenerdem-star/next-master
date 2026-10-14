-- Capture the deployed export-job schema so clean environments can reproduce
-- the asynchronous exports. Existing jobs and storage pointers are preserved.
create table if not exists public.app_export_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  requested_by uuid references public.profiles(id) on delete set null,
  audience text not null default 'admin' check (audience in ('admin','portal','system')),
  export_type text not null check (export_type in ('admin_price_list','portal_price_list','catalog_master','catalog_export','supplier_report','supplier_price_list')),
  status text not null default 'queued' check (status in ('queued','running','finalized','failed','expired')),
  scope jsonb not null default '{}'::jsonb,
  cache_key text not null,
  data_version text not null default '',
  file_name text,
  content_type text,
  storage_bucket text,
  storage_path text,
  row_count integer not null default 0 check (row_count>=0),
  byte_size integer not null default 0 check (byte_size>=0),
  progress_total integer check (progress_total is null or progress_total>=0),
  progress_done integer not null default 0 check (progress_done>=0),
  progress_message text,
  error_message text,
  started_at timestamptz,
  finalized_at timestamptz,
  failed_at timestamptz,
  expires_at timestamptz not null default (now()+interval '7 days'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  worker_lease_owner text,
  worker_lease_expires_at timestamptz
);
-- The deployed worker added its lease columns separately before this bootstrap.
alter table public.app_export_jobs add column if not exists worker_lease_owner text;
alter table public.app_export_jobs add column if not exists worker_lease_expires_at timestamptz;

create index if not exists idx_app_export_jobs_cache_lookup
  on public.app_export_jobs(organization_id,export_type,cache_key,status,finalized_at desc);
create index if not exists idx_app_export_jobs_org_created
  on public.app_export_jobs(organization_id,created_at desc);
create index if not exists idx_app_export_jobs_org_status
  on public.app_export_jobs(organization_id,status,updated_at desc);
create index if not exists idx_app_export_jobs_worker_lease
  on public.app_export_jobs(id,worker_lease_expires_at);

create or replace function public.touch_app_export_jobs_updated_at()
returns trigger language plpgsql set search_path to '' as $function$
begin
  new.updated_at=pg_catalog.now();
  return new;
end;
$function$;
drop trigger if exists trg_app_export_jobs_updated_at on public.app_export_jobs;
create trigger trg_app_export_jobs_updated_at before update on public.app_export_jobs
  for each row execute function public.touch_app_export_jobs_updated_at();

alter table public.app_export_jobs enable row level security;
-- Netlify authenticates the caller and applies organization/user scope before
-- accessing jobs. No browser table policy or direct browser grant is needed.
revoke all on public.app_export_jobs from public,anon,authenticated,service_role;
grant select,insert,update on public.app_export_jobs to service_role;
revoke all on function public.touch_app_export_jobs_updated_at() from public,anon,authenticated;
grant execute on function public.touch_app_export_jobs_updated_at() to service_role;
