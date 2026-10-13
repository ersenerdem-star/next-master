-- Durable private catalog CSV source, upload seal, fenced worker ownership and
-- idempotent staging receipts. Validation/finalization remain existing catalog
-- operations. This migration never writes catalog_products.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'catalog-imports', 'catalog-imports', false, 1073741824,
  array[
    'text/csv', 'text/plain', 'text/tab-separated-values', 'application/csv',
    'application/vnd.ms-excel', 'application/octet-stream'
  ]::text[]
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types,
    updated_at = now();

-- The source table uses the tenant-qualified run key for every cross-tenant
-- foreign key.  This unique key is present in the provider resumable slice,
-- but creating it here also keeps a partial/staging database migratable.
create unique index if not exists idx_catalog_import_runs_id_org_unique
  on public.catalog_import_runs (id, organization_id);

create table if not exists public.catalog_import_sources (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null unique references public.catalog_import_runs(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  created_by uuid not null references public.profiles(id) on delete restrict,
  storage_bucket text not null default 'catalog-imports',
  storage_object_path text not null,
  file_name text not null,
  content_type text not null,
  total_bytes bigint not null,
  admitted_checksum_sha256 text,
  checksum_sha256 text,
  idempotency_key text not null,
  input_scope jsonb not null default '{}'::jsonb,
  parser text not null default 'csv',
  parser_version text not null default 'catalog-csv-v1',
  status text not null default 'created',
  cursor_row bigint not null default -1,
  rows_parsed bigint not null default 0,
  rows_staged bigint not null default 0,
  storage_object_id uuid,
  sealed_object_version text,
  uploaded_at timestamptz,
  verified_at timestamptz,
  verified_lease_generation bigint,
  processing_started_at timestamptz,
  completed_at timestamptz,
  failed_at timestamptz,
  error_code text,
  error_message text,
  lease_owner text,
  lease_token uuid,
  lease_generation bigint not null default 0,
  lease_expires_at timestamptz,
  attempt_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint catalog_import_sources_bucket_check
    check (storage_bucket = 'catalog-imports'),
  constraint catalog_import_sources_path_check
    check (
      storage_object_path = organization_id::text || '/catalog/' || run_id::text || '/' || file_name
      and storage_object_path !~ '(^|/)\.\.?(/|$)'
    ),
  constraint catalog_import_sources_file_name_check
    check (length(trim(file_name)) between 1 and 120 and file_name !~ '[\\/]'),
  constraint catalog_import_sources_content_type_check
    check (lower(content_type) in (
      'text/csv', 'text/plain', 'text/tab-separated-values', 'application/csv',
      'application/vnd.ms-excel', 'application/octet-stream'
    )),
  constraint catalog_import_sources_bytes_check
    check (total_bytes > 0 and total_bytes <= 1073741824),
  constraint catalog_import_sources_checksum_check
    check (admitted_checksum_sha256 is null or admitted_checksum_sha256 ~ '^[0-9a-fA-F]{64}$'),
  constraint catalog_import_sources_verified_checksum_check
    check (checksum_sha256 is null or checksum_sha256 ~ '^[0-9a-fA-F]{64}$'),
  constraint catalog_import_sources_idempotency_check
    check (length(trim(idempotency_key)) between 1 and 200),
  constraint catalog_import_sources_scope_check
    check (jsonb_typeof(input_scope) = 'object'),
  constraint catalog_import_sources_parser_check
    check (parser = 'csv' and parser_version = 'catalog-csv-v1'),
  constraint catalog_import_sources_status_check
    check (status in ('created','uploading','uploaded','processing','staged','failed','expired','cancelled')),
  constraint catalog_import_sources_cursor_check
    check (cursor_row >= -1 and rows_parsed >= 0 and rows_staged >= 0),
  constraint catalog_import_sources_attempt_check
    check (attempt_count >= 0 and lease_generation >= 0)
);

-- Older staging databases may already have this table from a prior additive
-- draft. Keep the source identity and fencing columns additive on upgrade.
alter table public.catalog_import_sources
  add column if not exists admitted_checksum_sha256 text,
  add column if not exists input_scope jsonb not null default '{}'::jsonb,
  add column if not exists parser text not null default 'csv',
  add column if not exists parser_version text not null default 'catalog-csv-v1',
  add column if not exists storage_object_id uuid,
  add column if not exists sealed_object_version text,
  add column if not exists verified_at timestamptz,
  add column if not exists verified_lease_generation bigint,
  add column if not exists lease_owner text,
  add column if not exists lease_token uuid,
  add column if not exists lease_generation bigint not null default 0,
  add column if not exists lease_expires_at timestamptz,
  add column if not exists attempt_count integer not null default 0;

-- A previous draft used `duckdb_csv` as the parser label.  Preserve that
-- historical value while making the normalization version the immutable
-- contract used by workers.
alter table public.catalog_import_sources
  drop constraint if exists catalog_import_sources_parser_check;
alter table public.catalog_import_sources
  drop constraint if exists catalog_import_sources_parser_version_check;
alter table public.catalog_import_sources
  add constraint catalog_import_sources_parser_version_check
  check (parser_version = 'catalog-csv-v1');

create or replace function public.catalog_storage_guard_source_identity()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'UPDATE' and (
    new.run_id is distinct from old.run_id
    or new.organization_id is distinct from old.organization_id
    or new.created_by is distinct from old.created_by
    or new.storage_bucket is distinct from old.storage_bucket
    or new.storage_object_path is distinct from old.storage_object_path
    or new.file_name is distinct from old.file_name
    or new.content_type is distinct from old.content_type
    or new.total_bytes is distinct from old.total_bytes
    or new.admitted_checksum_sha256 is distinct from old.admitted_checksum_sha256
    or new.idempotency_key is distinct from old.idempotency_key
    or new.input_scope is distinct from old.input_scope
    or new.parser is distinct from old.parser
    or new.parser_version is distinct from old.parser_version
  ) then
    raise exception 'CATALOG_STORAGE_SOURCE_IDENTITY_IMMUTABLE';
  end if;
  return new;
end;
$$;
drop trigger if exists catalog_storage_source_identity_guard
  on public.catalog_import_sources;
create trigger catalog_storage_source_identity_guard
before update on public.catalog_import_sources
for each row execute function public.catalog_storage_guard_source_identity();
revoke all on function public.catalog_storage_guard_source_identity() from public, anon, authenticated, service_role;

create unique index if not exists idx_catalog_import_sources_org_idempotency
  on public.catalog_import_sources (organization_id, idempotency_key);
create unique index if not exists idx_catalog_import_sources_run_unique
  on public.catalog_import_sources (run_id);
create unique index if not exists idx_catalog_import_sources_storage_path
  on public.catalog_import_sources (storage_bucket, storage_object_path);
create unique index if not exists idx_catalog_import_sources_id_run_org_unique
  on public.catalog_import_sources (id, run_id, organization_id);
create index if not exists idx_catalog_import_sources_dispatch
  on public.catalog_import_sources (status, lease_expires_at, updated_at)
  where status in ('uploaded','processing','staged');

create table if not exists public.catalog_import_source_batches (
  id uuid primary key default gen_random_uuid(),
  source_id uuid not null,
  run_id uuid not null,
  organization_id uuid not null,
  cursor_start bigint not null,
  cursor_end bigint not null,
  payload_sha256 text not null,
  payload_rows integer not null,
  is_final boolean not null default false,
  lease_generation bigint not null,
  stage_result jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint catalog_import_source_batches_cursor_check
    check (cursor_start >= 0 and cursor_end >= cursor_start),
  constraint catalog_import_source_batches_rows_check
    check (payload_rows between 1 and 10000 and payload_rows = cursor_end - cursor_start + 1),
  constraint catalog_import_source_batches_hash_check
    check (payload_sha256 ~ '^[0-9a-f]{64}$'),
  constraint catalog_import_source_batches_source_run_org_fk
    foreign key (source_id, run_id, organization_id)
    references public.catalog_import_sources (id, run_id, organization_id)
    on delete cascade
);

create unique index if not exists idx_catalog_import_source_batches_cursor_unique
  on public.catalog_import_source_batches (source_id, cursor_end);
create index if not exists idx_catalog_import_source_batches_run
  on public.catalog_import_source_batches (run_id, cursor_end);

alter table public.catalog_import_sources enable row level security;
alter table public.catalog_import_source_batches enable row level security;
revoke all on table public.catalog_import_sources from public, anon, authenticated, service_role;
revoke all on table public.catalog_import_source_batches from public, anon, authenticated, service_role;
grant select on table public.catalog_import_sources to authenticated, service_role;
grant select on table public.catalog_import_source_batches to authenticated, service_role;

drop policy if exists catalog_import_sources_select_ops on public.catalog_import_sources;
create policy catalog_import_sources_select_ops
on public.catalog_import_sources for select to authenticated
using (organization_id = public.current_profile_org_id() and public.current_profile_role() in ('admin','superadmin'));

drop policy if exists catalog_import_source_batches_select_ops on public.catalog_import_source_batches;
create policy catalog_import_source_batches_select_ops
on public.catalog_import_source_batches for select to authenticated
using (organization_id = public.current_profile_org_id() and public.current_profile_role() in ('admin','superadmin'));

-- Run/actor scope is locked before source scope. All source operations call
-- this helper so failed/cancelled/finalized runs cannot be revived.
create or replace function public.catalog_storage_lock_run(
  input_run_id uuid,
  input_organization_id uuid,
  input_actor_id uuid
)
returns public.catalog_import_runs
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare v_run public.catalog_import_runs%rowtype;
begin
  if not exists (
    select 1 from public.profiles p
    where p.id = input_actor_id and p.organization_id = input_organization_id
      and p.is_active = true and lower(p.role::text) in ('admin','superadmin')
  ) then raise exception 'CATALOG_STORAGE_ACTOR_INVALID'; end if;
  select * into v_run
  from public.catalog_import_runs r
  where r.id = input_run_id and r.organization_id = input_organization_id
    and r.created_by = input_actor_id
  for update;
  if not found then raise exception 'CATALOG_STORAGE_RUN_SCOPE'; end if;
  if v_run.status not in ('running','validating','validated','finalizing') then
    raise exception 'CATALOG_STORAGE_RUN_TERMINAL:%', v_run.status;
  end if;
  return v_run;
end;
$$;
revoke all on function public.catalog_storage_lock_run(uuid,uuid,uuid) from public,anon,authenticated,service_role;

create or replace function public.catalog_storage_assert_system_actor(
  input_organization_id uuid,
  input_actor_id uuid
)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1
    from public.profiles p
    where p.id=input_actor_id
      and p.organization_id=input_organization_id
      and p.is_active=true
      and lower(p.role::text) in ('admin','superadmin')
  ) then
    raise exception 'CATALOG_STORAGE_ACTOR_INVALID';
  end if;
end;
$$;
revoke all on function public.catalog_storage_assert_system_actor(uuid,uuid) from public,anon,authenticated,service_role;

-- Existing permissive Storage policies cannot re-open a sealed object because
-- these restrictive policies are ANDed with all permissive policies.
create or replace function public.catalog_storage_object_allowed(input_path text, input_write boolean)
returns boolean language sql stable security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.catalog_import_sources s
    join public.catalog_import_runs r on r.id = s.run_id and r.organization_id = s.organization_id
    join public.profiles p on p.id = auth.uid() and p.organization_id = s.organization_id
    where s.storage_object_path = input_path
      and p.is_active = true and lower(p.role::text) in ('admin','superadmin')
      and public.profile_has_permission('catalog.manage')
      and (not input_write or (
        s.created_by = p.id and s.status in ('created','uploading') and r.status = 'running'
      ))
  );
$$;
revoke all on function public.catalog_storage_object_allowed(text,boolean) from public,anon,authenticated,service_role;
grant execute on function public.catalog_storage_object_allowed(text,boolean) to authenticated;

drop policy if exists catalog_import_objects_select on storage.objects;
create policy catalog_import_objects_select on storage.objects for select to authenticated
using (bucket_id = 'catalog-imports' and public.catalog_storage_object_allowed(name,false));
drop policy if exists catalog_import_objects_insert on storage.objects;
create policy catalog_import_objects_insert on storage.objects for insert to authenticated
with check (bucket_id = 'catalog-imports' and public.catalog_storage_object_allowed(name,true));
drop policy if exists catalog_import_objects_update on storage.objects;
create policy catalog_import_objects_update on storage.objects for update to authenticated
using (bucket_id = 'catalog-imports' and public.catalog_storage_object_allowed(name,true))
with check (bucket_id = 'catalog-imports' and public.catalog_storage_object_allowed(name,true));
drop policy if exists catalog_import_objects_delete on storage.objects;
create policy catalog_import_objects_delete on storage.objects for delete to authenticated
using (bucket_id = 'catalog-imports' and public.catalog_storage_object_allowed(name,true));

drop policy if exists catalog_import_objects_select_fence on storage.objects;
create policy catalog_import_objects_select_fence on storage.objects as restrictive for select to authenticated
using (bucket_id <> 'catalog-imports' or public.catalog_storage_object_allowed(name,false));
drop policy if exists catalog_import_objects_insert_fence on storage.objects;
create policy catalog_import_objects_insert_fence on storage.objects as restrictive for insert to authenticated
with check (bucket_id <> 'catalog-imports' or public.catalog_storage_object_allowed(name,true));
drop policy if exists catalog_import_objects_update_fence on storage.objects;
create policy catalog_import_objects_update_fence on storage.objects as restrictive for update to authenticated
using (bucket_id <> 'catalog-imports' or public.catalog_storage_object_allowed(name,true))
with check (bucket_id <> 'catalog-imports' or public.catalog_storage_object_allowed(name,true));
drop policy if exists catalog_import_objects_delete_fence on storage.objects;
create policy catalog_import_objects_delete_fence on storage.objects as restrictive for delete to authenticated
using (bucket_id <> 'catalog-imports' or public.catalog_storage_object_allowed(name,true));

drop policy if exists catalog_import_objects_anon_fence on storage.objects;
create policy catalog_import_objects_anon_fence on storage.objects as restrictive for all to anon
using (bucket_id <> 'catalog-imports') with check (bucket_id <> 'catalog-imports');

-- Authenticated begin contract. The source path is generated server-side;
-- retries with the same tenant/idempotency key return the original admission.
drop function if exists public.begin_catalog_import_storage(jsonb,text,text,text,bigint,text,text);
create or replace function public.begin_catalog_import_storage(
  input_scope jsonb,
  input_mode text,
  input_file_name text,
  input_content_type text,
  input_total_bytes bigint,
  input_checksum_sha256 text,
  input_idempotency_key text
)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_org uuid := public.current_profile_org_id();
  v_actor uuid := auth.uid();
  v_scope jsonb := coalesce(input_scope, '{}'::jsonb);
  v_mode text := lower(coalesce(nullif(trim(input_mode),''),'upsert'));
  v_name text;
  v_type text := lower(coalesce(nullif(trim(input_content_type),''),'text/csv'));
  v_checksum text := nullif(lower(trim(coalesce(input_checksum_sha256,''))),'');
  v_key text := nullif(trim(coalesce(input_idempotency_key,'')),'');
  v_existing public.catalog_import_sources%rowtype;
  v_result jsonb;
  v_run_id uuid;
  v_source_id uuid;
  v_path text;
begin
  if v_actor is null or v_org is null or public.current_profile_role() not in ('admin','superadmin')
     or not public.profile_has_permission('catalog.manage') then
    raise exception 'CATALOG_STORAGE_ACTOR_INVALID';
  end if;
  if v_mode = 'insert' then v_mode := 'insert_only'; end if;
  if v_mode not in ('insert_only','upsert') then raise exception 'CATALOG_STORAGE_MODE_INVALID'; end if;
  if jsonb_typeof(v_scope) is distinct from 'object' then raise exception 'CATALOG_STORAGE_SCOPE_INVALID'; end if;
  if v_key is null or length(v_key) > 200 then raise exception 'CATALOG_STORAGE_IDEMPOTENCY_REQUIRED'; end if;
  if input_total_bytes is null or input_total_bytes <= 0 or input_total_bytes > 1073741824 then raise exception 'CATALOG_STORAGE_SIZE_INVALID'; end if;
  if v_type not in ('text/csv','text/plain','text/tab-separated-values','application/csv','application/vnd.ms-excel','application/octet-stream') then raise exception 'CATALOG_STORAGE_CONTENT_TYPE_INVALID'; end if;
  if v_checksum is not null and v_checksum !~ '^[0-9a-f]{64}$' then raise exception 'CATALOG_STORAGE_CHECKSUM_INVALID'; end if;
  v_name := regexp_replace(left(trim(coalesce(input_file_name,'catalog.csv')),120),'[^A-Za-z0-9._-]+','-','g');
  v_name := coalesce(nullif(trim(both '-' from v_name),''),'catalog.csv');
  if lower(v_name) !~ '\.(csv|tsv|txt)$' then
    raise exception 'CATALOG_STORAGE_FILE_TYPE_INVALID';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_org::text || ':catalog_storage_import',0));
  select * into v_existing from public.catalog_import_sources s
  where s.organization_id = v_org and s.idempotency_key = v_key;
  if found then
    perform public.catalog_storage_lock_run(v_existing.run_id,v_org,v_actor);
    if v_existing.created_by is distinct from v_actor
       or v_existing.file_name is distinct from v_name
       or v_existing.content_type is distinct from v_type
       or v_existing.total_bytes is distinct from input_total_bytes
       or v_existing.admitted_checksum_sha256 is distinct from v_checksum then
      raise exception 'CATALOG_STORAGE_IDEMPOTENCY_MISMATCH';
    end if;
    return jsonb_build_object('status',v_existing.status,'replayed',true,'run_id',v_existing.run_id,
      'source_id',v_existing.id,'organization_id',v_existing.organization_id,
      'storage_bucket',v_existing.storage_bucket,'storage_object_path',v_existing.storage_object_path,
      'file_name',v_existing.file_name,'content_type',v_existing.content_type,'total_bytes',v_existing.total_bytes,
      'idempotency_key',v_existing.idempotency_key,'parser_version',v_existing.parser_version);
  end if;

  v_result := public.begin_catalog_import(v_scope,v_mode);
  v_run_id := (v_result->>'run_id')::uuid;
  v_path := v_org::text || '/catalog/' || v_run_id::text || '/' || v_name;
  insert into public.catalog_import_sources(
    run_id,organization_id,created_by,storage_object_path,file_name,content_type,total_bytes,
    admitted_checksum_sha256,idempotency_key,input_scope
  ) values (
    v_run_id,v_org,v_actor,v_path,v_name,v_type,input_total_bytes,v_checksum,v_key,v_scope
  ) returning id into v_source_id;
  update public.catalog_import_runs
  set input_scope = v_scope || jsonb_build_object('source_kind','storage_csv','storage_bucket','catalog-imports','storage_object_path',v_path,'source_id',v_source_id,'idempotency_key',v_key)
  where id = v_run_id and organization_id = v_org;
  return jsonb_build_object('status','created','replayed',false,'run_id',v_run_id,'source_id',v_source_id,
    'organization_id',v_org,'actor_id',v_actor,'storage_bucket','catalog-imports','storage_object_path',v_path,
    'file_name',v_name,'content_type',v_type,'total_bytes',input_total_bytes,'idempotency_key',v_key,
    'parser_version','catalog-csv-v1');
end;
$$;
revoke all on function public.begin_catalog_import_storage(jsonb,text,text,text,bigint,text,text) from public,anon;
grant execute on function public.begin_catalog_import_storage(jsonb,text,text,text,bigint,text,text) to authenticated;

-- Browser sealing contract. It is authenticated, verifies the real Storage
-- object metadata and freezes the source before any worker can claim it.
drop function if exists public.complete_catalog_import_storage_upload(uuid);
create or replace function public.complete_catalog_import_storage_upload(input_run_id uuid)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_org uuid := public.current_profile_org_id();
  v_actor uuid := auth.uid();
  v_run public.catalog_import_runs%rowtype;
  v_source public.catalog_import_sources%rowtype;
  v_object storage.objects%rowtype;
  v_size bigint;
  v_metadata_type text;
begin
  v_run := public.catalog_storage_lock_run(input_run_id,v_org,v_actor);
  select * into v_source from public.catalog_import_sources s where s.run_id=v_run.id and s.organization_id=v_org and s.created_by=v_actor for update;
  if not found then raise exception 'CATALOG_STORAGE_SOURCE_SCOPE'; end if;
  if v_source.status not in ('created','uploading','uploaded') then
    if v_source.status in ('processing','staged') then
      return jsonb_build_object('status',v_source.status,'replayed',true,'run_id',v_run.id,'source_id',v_source.id,'storage_object_version',v_source.sealed_object_version);
    end if;
    raise exception 'CATALOG_STORAGE_SOURCE_TERMINAL:%',v_source.status;
  end if;
  select * into v_object from storage.objects o where o.id is not null and o.bucket_id=v_source.storage_bucket and o.name=v_source.storage_object_path order by o.created_at desc limit 1;
  if not found then raise exception 'CATALOG_STORAGE_OBJECT_MISSING'; end if;
  if v_object.owner_id::text is distinct from v_actor::text then raise exception 'CATALOG_STORAGE_OBJECT_OWNER_INVALID'; end if;
  if v_object.version is null or length(trim(v_object.version))=0 then raise exception 'CATALOG_STORAGE_OBJECT_VERSION_MISSING'; end if;
  if coalesce(v_object.metadata->>'size','') !~ '^[0-9]+$' then raise exception 'CATALOG_STORAGE_OBJECT_SIZE_MISSING'; end if;
  v_size := (v_object.metadata->>'size')::bigint;
  if v_size <> v_source.total_bytes then raise exception 'CATALOG_STORAGE_OBJECT_SIZE_MISMATCH'; end if;
  v_metadata_type := lower(nullif(trim(coalesce(v_object.metadata->>'mimetype','')),''));
  if v_metadata_type is not null and v_metadata_type <> lower(v_source.content_type) then raise exception 'CATALOG_STORAGE_OBJECT_TYPE_MISMATCH'; end if;
  update public.catalog_import_sources
  set status='uploaded', storage_object_id=v_object.id, sealed_object_version=v_object.version,
      checksum_sha256=coalesce(v_source.admitted_checksum_sha256, nullif(lower(v_object.metadata->>'sha256'),'')),
      uploaded_at=coalesce(uploaded_at,now()), verified_at=now(), updated_at=now(), error_code=null, error_message=null
  where id=v_source.id;
  return jsonb_build_object('status','uploaded','replayed',false,'run_id',v_run.id,'source_id',v_source.id,
    'organization_id',v_org,'storage_bucket',v_source.storage_bucket,'storage_object_path',v_source.storage_object_path,
    'storage_object_id',v_object.id,'storage_object_version',v_object.version,'uploaded_bytes',v_size);
end;
$$;
revoke all on function public.complete_catalog_import_storage_upload(uuid) from public,anon;
grant execute on function public.complete_catalog_import_storage_upload(uuid) to authenticated;

-- Worker-side verification closes the gap between the browser seal and the
-- streamed bytes it actually parsed.  It is deliberately lease-fenced: a
-- retry may re-submit the same digest, but a stale worker cannot rewrite the
-- sealed checksum or object version owned by a newer attempt.
drop function if exists public.complete_catalog_import_storage_upload_system(uuid,uuid,uuid,text,uuid,bigint,bigint,text);
create or replace function public.complete_catalog_import_storage_upload_system(
  input_run_id uuid,
  input_organization_id uuid,
  input_actor_id uuid,
  input_worker_id text,
  input_lease_token uuid,
  input_lease_generation bigint,
  input_uploaded_bytes bigint,
  input_checksum_sha256 text
)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_source public.catalog_import_sources%rowtype;
  v_run public.catalog_import_runs%rowtype;
  v_object storage.objects%rowtype;
  v_size bigint;
  v_checksum text := lower(trim(coalesce(input_checksum_sha256, '')));
begin
  if coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'CATALOG_STORAGE_SERVICE_REQUIRED';
  end if;
  perform public.catalog_storage_assert_system_actor(input_organization_id,input_actor_id);
  if input_uploaded_bytes is null or input_uploaded_bytes <= 0
     or v_checksum !~ '^[0-9a-f]{64}$' then
    raise exception 'CATALOG_STORAGE_UPLOAD_VERIFICATION_INVALID';
  end if;
  select * into v_source
  from public.catalog_import_sources s
  where s.run_id=input_run_id
    and s.organization_id=input_organization_id
    and s.created_by=input_actor_id
  for update;
  if not found then raise exception 'CATALOG_STORAGE_SOURCE_SCOPE'; end if;
  select * into v_run
  from public.catalog_import_runs r
  where r.id=v_source.run_id and r.organization_id=v_source.organization_id
  for update;
  if v_run.status in ('failed','cancelled','finalized','succeeded') then
    raise exception 'CATALOG_STORAGE_RUN_TERMINAL:%',v_run.status;
  end if;
  if v_source.lease_owner is distinct from input_worker_id
     or v_source.lease_token is distinct from input_lease_token
     or v_source.lease_generation is distinct from input_lease_generation
     or v_source.lease_expires_at is null
     or v_source.lease_expires_at <= now() then
    raise exception 'CATALOG_STORAGE_LEASE_FENCE';
  end if;
  select * into v_object
  from storage.objects o
  where o.id=v_source.storage_object_id
    and o.bucket_id=v_source.storage_bucket
    and o.name=v_source.storage_object_path;
  if not found then raise exception 'CATALOG_STORAGE_OBJECT_MISSING'; end if;
  if v_object.version is distinct from v_source.sealed_object_version then
    raise exception 'CATALOG_STORAGE_OBJECT_VERSION_CHANGED';
  end if;
  if coalesce(v_object.metadata->>'size','') !~ '^[0-9]+$' then
    raise exception 'CATALOG_STORAGE_OBJECT_SIZE_MISSING';
  end if;
  v_size := (v_object.metadata->>'size')::bigint;
  if v_size <> input_uploaded_bytes or v_size <> v_source.total_bytes then
    raise exception 'CATALOG_STORAGE_OBJECT_SIZE_MISMATCH';
  end if;
  if nullif(lower(trim(coalesce(v_object.metadata->>'sha256',''))),'') is not null
     and lower(trim(v_object.metadata->>'sha256')) <> v_checksum then
    raise exception 'CATALOG_STORAGE_OBJECT_CHECKSUM_MISMATCH';
  end if;
  if v_source.admitted_checksum_sha256 is not null
     and lower(v_source.admitted_checksum_sha256) <> v_checksum then
    raise exception 'CATALOG_STORAGE_ADMITTED_CHECKSUM_MISMATCH';
  end if;
  update public.catalog_import_sources
  set checksum_sha256=v_checksum,
      verified_at=coalesce(verified_at,now()),
      verified_lease_generation=input_lease_generation,
      updated_at=now()
  where id=v_source.id;
  return jsonb_build_object(
    'status',v_source.status,'source_status',v_source.status,'replayed',v_source.checksum_sha256 is not null,
    'run_id',v_source.run_id,'source_id',v_source.id,
    'storage_object_version',v_source.sealed_object_version,
    'uploaded_bytes',v_size,'checksum_sha256',v_checksum
  );
end;
$$;
revoke all on function public.complete_catalog_import_storage_upload_system(uuid,uuid,uuid,text,uuid,bigint,bigint,text) from public,anon,authenticated;
grant execute on function public.complete_catalog_import_storage_upload_system(uuid,uuid,uuid,text,uuid,bigint,bigint,text) to service_role;

-- Service worker claim. Created/uploading sources can never be claimed; only a
-- sealed source is claimable, and the current run must already be queued.
drop function if exists public.claim_catalog_import_storage_source_system(uuid,uuid,uuid,text,integer);
create or replace function public.claim_catalog_import_storage_source_system(
  input_source_id uuid,input_organization_id uuid,input_actor_id uuid,input_worker_id text,input_lease_seconds integer default 900
)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_source public.catalog_import_sources%rowtype;
  v_run public.catalog_import_runs%rowtype;
  v_worker text := nullif(trim(coalesce(input_worker_id,'')),'');
  v_lease integer := coalesce(input_lease_seconds,900);
  v_token uuid := gen_random_uuid();
  v_generation bigint;
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception 'CATALOG_STORAGE_SERVICE_REQUIRED'; end if;
  perform public.catalog_storage_assert_system_actor(input_organization_id,input_actor_id);
  if v_worker is null or length(v_worker)>120 or v_lease<30 or v_lease>3600 then raise exception 'CATALOG_STORAGE_CLAIM_INPUT_INVALID'; end if;
  select * into v_source from public.catalog_import_sources s where s.id=input_source_id and s.organization_id=input_organization_id and s.created_by=input_actor_id for update;
  if not found then raise exception 'CATALOG_STORAGE_SOURCE_SCOPE'; end if;
  select * into v_run from public.catalog_import_runs r where r.id=v_source.run_id and r.organization_id=v_source.organization_id for update;
  if v_run.status in ('failed','cancelled','finalized','succeeded') then raise exception 'CATALOG_STORAGE_RUN_TERMINAL:%',v_run.status; end if;
  -- A staged source with no queue marker is a recoverable handoff window;
  -- uploaded/processing sources still require the run to be queued by the
  -- authenticated browser contract. Once staged and queued, finalization owns
  -- the run and the ingestion worker must not replay it.
  if v_run.processing_queued_at is null and v_source.status <> 'staged' then
    return jsonb_build_object('claimed',false,'status','not_queued','source_id',v_source.id);
  end if;
  if v_source.status = 'staged' and v_run.processing_queued_at is not null then
    return jsonb_build_object('claimed',false,'status','handed_off','source_id',v_source.id);
  end if;
  if v_source.status not in ('uploaded','processing','staged') or v_source.sealed_object_version is null then return jsonb_build_object('claimed',false,'status',v_source.status,'source_id',v_source.id); end if;
  if v_source.lease_expires_at is not null and v_source.lease_expires_at > now() then return jsonb_build_object('claimed',false,'status','busy','source_id',v_source.id,'lease_expires_at',v_source.lease_expires_at,'lease_owner',v_source.lease_owner); end if;
  v_generation := v_source.lease_generation + 1;
  update public.catalog_import_sources set status='processing',lease_owner=v_worker,lease_token=v_token,lease_generation=v_generation,lease_expires_at=now()+make_interval(secs=>v_lease),attempt_count=attempt_count+1,processing_started_at=coalesce(processing_started_at,now()),updated_at=now() where id=v_source.id;
  return jsonb_build_object('claimed',true,'status','processing','source_id',v_source.id,'run_id',v_source.run_id,'organization_id',v_source.organization_id,'created_by',v_source.created_by,'storage_bucket',v_source.storage_bucket,'storage_object_path',v_source.storage_object_path,'total_bytes',v_source.total_bytes,'checksum_sha256',v_source.checksum_sha256,'cursor_row',v_source.cursor_row,'lease_owner',v_worker,'lease_token',v_token,'lease_generation',v_generation,'lease_expires_at',now()+make_interval(secs=>v_lease));
end;
$$;
revoke all on function public.claim_catalog_import_storage_source_system(uuid,uuid,uuid,text,integer) from public,anon,authenticated;
grant execute on function public.claim_catalog_import_storage_source_system(uuid,uuid,uuid,text,integer) to service_role;

-- Fenced heartbeat. A stale token can never extend another worker's lease.
drop function if exists public.heartbeat_catalog_import_storage_source_system(uuid,uuid,uuid,text,uuid,bigint,integer);
create or replace function public.heartbeat_catalog_import_storage_source_system(
  input_source_id uuid,input_organization_id uuid,input_actor_id uuid,input_worker_id text,input_lease_token uuid,input_lease_generation bigint,input_lease_seconds integer default 900
)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_source public.catalog_import_sources%rowtype; v_lease integer := coalesce(input_lease_seconds,900);
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception 'CATALOG_STORAGE_SERVICE_REQUIRED'; end if;
  perform public.catalog_storage_assert_system_actor(input_organization_id,input_actor_id);
  if v_lease<30 or v_lease>3600 then raise exception 'CATALOG_STORAGE_LEASE_INVALID'; end if;
  update public.catalog_import_sources s set lease_expires_at=now()+make_interval(secs=>v_lease),updated_at=now()
  where s.id=input_source_id and s.organization_id=input_organization_id and s.created_by=input_actor_id and s.lease_owner=input_worker_id and s.lease_token=input_lease_token and s.lease_generation=input_lease_generation and s.status in ('processing','staged')
  returning s.* into v_source;
  if not found then raise exception 'CATALOG_STORAGE_LEASE_FENCE'; end if;
  return jsonb_build_object('status',v_source.status,'source_id',v_source.id,'lease_expires_at',v_source.lease_expires_at,'lease_generation',v_source.lease_generation);
end;
$$;
revoke all on function public.heartbeat_catalog_import_storage_source_system(uuid,uuid,uuid,text,uuid,bigint,integer) from public,anon,authenticated;
grant execute on function public.heartbeat_catalog_import_storage_source_system(uuid,uuid,uuid,text,uuid,bigint,integer) to service_role;

-- The service begin bridge preserves the same org/actor checks.
drop function if exists public.begin_catalog_import_storage_system(uuid,uuid,jsonb,text,text,text,bigint,text,text);
create or replace function public.begin_catalog_import_storage_system(input_organization_id uuid,input_actor_id uuid,input_scope jsonb,input_mode text,input_file_name text,input_content_type text,input_total_bytes bigint,input_checksum_sha256 text,input_idempotency_key text)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_org uuid; v_role text;
begin
  select organization_id,lower(role::text) into v_org,v_role from public.profiles where id=input_actor_id and is_active=true;
  if v_org is distinct from input_organization_id or v_role not in ('admin','superadmin') then raise exception 'CATALOG_STORAGE_ACTOR_INVALID'; end if;
  perform set_config('request.jwt.claim.sub',input_actor_id::text,true);
  return public.begin_catalog_import_storage(input_scope,input_mode,input_file_name,input_content_type,input_total_bytes,input_checksum_sha256,input_idempotency_key);
end;
$$;
revoke all on function public.begin_catalog_import_storage_system(uuid,uuid,jsonb,text,text,text,bigint,text,text) from public,anon,authenticated;
grant execute on function public.begin_catalog_import_storage_system(uuid,uuid,jsonb,text,text,text,bigint,text,text) to service_role;

-- Fenced stage bridge. The existing stage_catalog_import_chunk remains the
-- normalization/dedupe implementation; this wrapper owns cursor receipts.
drop function if exists public.stage_catalog_import_storage_batch_system(uuid,uuid,uuid,text,uuid,bigint,jsonb,bigint,boolean);
create or replace function public.stage_catalog_import_storage_batch_system(
  input_run_id uuid,input_organization_id uuid,input_actor_id uuid,input_worker_id text,input_lease_token uuid,input_lease_generation bigint,input_payload jsonb,input_cursor_row bigint,input_is_final boolean default false
)
returns jsonb language plpgsql security definer set search_path = public, extensions, pg_temp
as $$
declare
  v_source public.catalog_import_sources%rowtype;
  v_run public.catalog_import_runs%rowtype;
  v_existing public.catalog_import_source_batches%rowtype;
  v_hash text;
  v_rows integer;
  v_min bigint;
  v_max bigint;
  v_start bigint;
  v_result jsonb;
  v_stage_count bigint;
  v_receipt_id uuid;
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception 'CATALOG_STORAGE_SERVICE_REQUIRED'; end if;
  perform public.catalog_storage_assert_system_actor(input_organization_id,input_actor_id);
  if input_payload is null or jsonb_typeof(input_payload)<>'array' then raise exception 'CATALOG_STORAGE_PAYLOAD_INVALID'; end if;
  if jsonb_array_length(input_payload)>10000 or pg_column_size(input_payload)>8388608 then raise exception 'CATALOG_STORAGE_PAYLOAD_TOO_LARGE'; end if;
  select * into v_source from public.catalog_import_sources s where s.run_id=input_run_id and s.organization_id=input_organization_id and s.created_by=input_actor_id for update;
  if not found then raise exception 'CATALOG_STORAGE_SOURCE_SCOPE'; end if;
  select * into v_run from public.catalog_import_runs r where r.id=v_source.run_id and r.organization_id=v_source.organization_id for update;
  if v_run.status in ('failed','cancelled','finalized','succeeded') then raise exception 'CATALOG_STORAGE_RUN_TERMINAL:%',v_run.status; end if;
  if v_source.lease_owner is distinct from input_worker_id or v_source.lease_token is distinct from input_lease_token or v_source.lease_generation is distinct from input_lease_generation or v_source.lease_expires_at is null or v_source.lease_expires_at<=now() then raise exception 'CATALOG_STORAGE_LEASE_FENCE'; end if;
  v_hash := public.catalog_provider_jsonb_sha256(jsonb_build_object('payload',input_payload,'is_final',input_is_final));
  if jsonb_array_length(input_payload)=0 then
    if not input_is_final or v_source.status not in ('uploaded','processing','staged') then raise exception 'CATALOG_STORAGE_EMPTY_FINAL_INVALID'; end if;
    if input_cursor_row is not null and input_cursor_row is distinct from v_source.cursor_row then
      raise exception 'CATALOG_STORAGE_FINAL_CURSOR_MISMATCH';
    end if;
    update public.catalog_import_sources set status='staged',completed_at=coalesce(completed_at,now()),updated_at=now() where id=v_source.id;
    return jsonb_build_object('status','ok','run_id',v_source.run_id,'source_id',v_source.id,'source_status','staged','cursor_row',v_source.cursor_row,'rows_staged',v_source.rows_staged,'is_final',true,'replayed',v_source.status='staged');
  end if;
  if input_cursor_row is null or input_cursor_row<0 then raise exception 'CATALOG_STORAGE_CURSOR_INVALID'; end if;
  select * into v_existing from public.catalog_import_source_batches b where b.source_id=v_source.id and b.cursor_end=input_cursor_row for update;
  if found then
    -- The source lease was checked above.  A new lease generation may safely
    -- replay an identical receipt after a worker crash; only a changed payload
    -- for the same cursor is rejected.
    if v_existing.payload_sha256<>v_hash then raise exception 'CATALOG_STORAGE_PAYLOAD_CHANGED'; end if;
    return v_existing.stage_result || jsonb_build_object('replayed',true,'source_id',v_source.id,'cursor_row',v_existing.cursor_end);
  end if;
  if exists (select 1 from jsonb_array_elements(input_payload) x(value) where nullif(trim(coalesce(x.value->>'row_index','')),'') is null or (x.value->>'row_index') !~ '^[0-9]+$') then raise exception 'CATALOG_STORAGE_ROW_INDEX_INVALID'; end if;
  select count(*)::integer,min((x.value->>'row_index')::bigint),max((x.value->>'row_index')::bigint) into v_rows,v_min,v_max from jsonb_array_elements(input_payload) x(value);
  v_start:=v_source.cursor_row+1;
  if v_min<>v_start or v_max<>input_cursor_row or v_rows<>v_max-v_min+1 then raise exception 'CATALOG_STORAGE_CURSOR_NOT_CONTIGUOUS'; end if;
  insert into public.catalog_import_source_batches(source_id,run_id,organization_id,cursor_start,cursor_end,payload_sha256,payload_rows,is_final,lease_generation)
  values(v_source.id,v_source.run_id,v_source.organization_id,v_start,input_cursor_row,v_hash,v_rows,input_is_final,input_lease_generation) returning id into v_receipt_id;
  perform set_config('request.jwt.claim.sub',input_actor_id::text,true);
  v_result:=public.stage_catalog_import_chunk(input_run_id,input_payload);
  v_stage_count:=coalesce((v_result->>'staged_count')::bigint,0);
  update public.catalog_import_sources set status=case when input_is_final then 'staged' else 'processing' end,cursor_row=input_cursor_row,rows_parsed=input_cursor_row+1,rows_staged=rows_staged+v_stage_count,completed_at=case when input_is_final then coalesce(completed_at,now()) else completed_at end,updated_at=now() where id=v_source.id;
  v_result:=v_result || jsonb_build_object('source_id',v_source.id,'source_status',case when input_is_final then 'staged' else 'processing' end,'cursor_row',input_cursor_row,'rows_staged',v_source.rows_staged+v_stage_count,'is_final',input_is_final,'replayed',false);
  update public.catalog_import_source_batches set stage_result=v_result,completed_at=now() where id=v_receipt_id;
  return v_result;
end;
$$;
revoke all on function public.stage_catalog_import_storage_batch_system(uuid,uuid,uuid,text,uuid,bigint,jsonb,bigint,boolean) from public,anon,authenticated;
grant execute on function public.stage_catalog_import_storage_batch_system(uuid,uuid,uuid,text,uuid,bigint,jsonb,bigint,boolean) to service_role;

-- Queue handoff remains idempotent when the source is already staged.
drop function if exists public.mark_catalog_import_storage_processing_queued_system(uuid,uuid,uuid,text,uuid,bigint);
create or replace function public.mark_catalog_import_storage_processing_queued_system(input_run_id uuid,input_organization_id uuid,input_actor_id uuid,input_worker_id text,input_lease_token uuid,input_lease_generation bigint)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_source public.catalog_import_sources%rowtype; v_run public.catalog_import_runs%rowtype; v_now timestamptz:=now();
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception 'CATALOG_STORAGE_SERVICE_REQUIRED'; end if;
  perform public.catalog_storage_assert_system_actor(input_organization_id,input_actor_id);
  select * into v_source from public.catalog_import_sources s where s.run_id=input_run_id and s.organization_id=input_organization_id and s.created_by=input_actor_id for update;
  if not found then raise exception 'CATALOG_STORAGE_SOURCE_SCOPE'; end if;
  select * into v_run from public.catalog_import_runs r where r.id=input_run_id and r.organization_id=input_organization_id for update;
  if v_run.status in ('failed','cancelled','finalized','succeeded') then raise exception 'CATALOG_STORAGE_RUN_TERMINAL:%',v_run.status; end if;
  if v_source.status<>'staged' then raise exception 'CATALOG_STORAGE_SOURCE_NOT_STAGED'; end if;
  if v_source.lease_owner is distinct from input_worker_id or v_source.lease_token is distinct from input_lease_token or v_source.lease_generation is distinct from input_lease_generation or v_source.lease_expires_at is null or v_source.lease_expires_at<=v_now then raise exception 'CATALOG_STORAGE_LEASE_FENCE'; end if;
  update public.catalog_import_runs set processing_queued_at=coalesce(processing_queued_at,v_now),processing_queued_by=coalesce(processing_queued_by,input_actor_id) where id=v_run.id;
  return jsonb_build_object('queued',true,'run_id',v_run.id,'organization_id',v_run.organization_id,'source_id',v_source.id,'source_status',v_source.status,'replayed',v_run.processing_queued_at is not null);
end;
$$;
revoke all on function public.mark_catalog_import_storage_processing_queued_system(uuid,uuid,uuid,text,uuid,bigint) from public,anon,authenticated;
grant execute on function public.mark_catalog_import_storage_processing_queued_system(uuid,uuid,uuid,text,uuid,bigint) to service_role;

-- Fatal worker errors are recorded through the same fenced owner.  This keeps
-- a failed source from being redispatched by the queue poller and delegates
-- run status/error semantics to the canonical catalog failure RPC.
drop function if exists public.fail_catalog_import_storage_source_system(uuid,uuid,uuid,text,uuid,bigint,text,text);
create or replace function public.fail_catalog_import_storage_source_system(
  input_source_id uuid,
  input_organization_id uuid,
  input_actor_id uuid,
  input_worker_id text,
  input_lease_token uuid,
  input_lease_generation bigint,
  input_error_code text,
  input_error_message text
)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_source public.catalog_import_sources%rowtype;
  v_run public.catalog_import_runs%rowtype;
  v_code text := left(nullif(trim(coalesce(input_error_code,'')),''),120);
  v_message text := left(nullif(trim(coalesce(input_error_message,'')),''),2000);
  v_failed jsonb;
begin
  if coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'CATALOG_STORAGE_SERVICE_REQUIRED';
  end if;
  perform public.catalog_storage_assert_system_actor(input_organization_id,input_actor_id);
  if v_code is null then v_code := 'CATALOG_STORAGE_WORKER_FAILED'; end if;
  select * into v_source
  from public.catalog_import_sources s
  where s.id=input_source_id
    and s.organization_id=input_organization_id
    and s.created_by=input_actor_id
  for update;
  if not found then raise exception 'CATALOG_STORAGE_SOURCE_SCOPE'; end if;
  select * into v_run
  from public.catalog_import_runs r
  where r.id=v_source.run_id and r.organization_id=v_source.organization_id
  for update;
  if v_run.status in ('failed','cancelled','finalized','succeeded') then
    return jsonb_build_object('status',v_run.status,'source_status',v_source.status,
      'run_id',v_run.id,'source_id',v_source.id,'replayed',true);
  end if;
  if v_source.lease_owner is distinct from input_worker_id
     or v_source.lease_token is distinct from input_lease_token
     or v_source.lease_generation is distinct from input_lease_generation
     or v_source.lease_expires_at is null
     or v_source.lease_expires_at <= now() then
    raise exception 'CATALOG_STORAGE_LEASE_FENCE';
  end if;
  update public.catalog_import_sources
  set status='failed',failed_at=now(),error_code=v_code,error_message=v_message,
      lease_owner=null,lease_token=null,lease_expires_at=null,updated_at=now()
  where id=v_source.id;
  update public.catalog_import_runs
  set processing_queued_at=null,processing_queued_by=null
  where id=v_run.id and organization_id=v_run.organization_id;
  perform set_config('request.jwt.claim.sub',input_actor_id::text,true);
  v_failed := public.fail_catalog_import(v_run.id,v_code || case when v_message is null then '' else ': ' || v_message end);
  return v_failed || jsonb_build_object('source_id',v_source.id,'source_status','failed','error_code',v_code);
end;
$$;
revoke all on function public.fail_catalog_import_storage_source_system(uuid,uuid,uuid,text,uuid,bigint,text,text) from public,anon,authenticated;
grant execute on function public.fail_catalog_import_storage_source_system(uuid,uuid,uuid,text,uuid,bigint,text,text) to service_role;

-- Transient transport/worker errors release ownership for a retry.  The queue
-- marker is intentionally preserved; deterministic parse/schema failures use
-- the failure RPC above and clear it instead.
drop function if exists public.release_catalog_import_storage_source_system(uuid,uuid,uuid,text,uuid,bigint,text,text);
create or replace function public.release_catalog_import_storage_source_system(
  input_source_id uuid,
  input_organization_id uuid,
  input_actor_id uuid,
  input_worker_id text,
  input_lease_token uuid,
  input_lease_generation bigint,
  input_error_code text,
  input_error_message text
)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_source public.catalog_import_sources%rowtype;
  v_run public.catalog_import_runs%rowtype;
begin
  if coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'CATALOG_STORAGE_SERVICE_REQUIRED';
  end if;
  perform public.catalog_storage_assert_system_actor(input_organization_id,input_actor_id);
  select * into v_source
  from public.catalog_import_sources s
  where s.id=input_source_id
    and s.organization_id=input_organization_id
    and s.created_by=input_actor_id
  for update;
  if not found then raise exception 'CATALOG_STORAGE_SOURCE_SCOPE'; end if;
  select * into v_run
  from public.catalog_import_runs r
  where r.id=v_source.run_id and r.organization_id=v_source.organization_id
  for update;
  if v_run.status in ('failed','cancelled','finalized','succeeded') then
    return jsonb_build_object('status',v_run.status,'source_status',v_source.status,
      'run_id',v_run.id,'source_id',v_source.id,'released',false,'replayed',true);
  end if;
  if v_source.lease_owner is distinct from input_worker_id
     or v_source.lease_token is distinct from input_lease_token
     or v_source.lease_generation is distinct from input_lease_generation then
    raise exception 'CATALOG_STORAGE_LEASE_FENCE';
  end if;
  update public.catalog_import_sources
  set lease_owner=null,lease_token=null,lease_expires_at=null,
      error_code=left(nullif(trim(coalesce(input_error_code,'')),''),120),
      error_message=left(nullif(trim(coalesce(input_error_message,'')),''),2000),
      updated_at=now()
  where id=v_source.id;
  return jsonb_build_object('status',v_source.status,'source_status',v_source.status,
    'run_id',v_source.run_id,'source_id',v_source.id,'released',true,
    'processing_queued_at',v_run.processing_queued_at);
end;
$$;
revoke all on function public.release_catalog_import_storage_source_system(uuid,uuid,uuid,text,uuid,bigint,text,text) from public,anon,authenticated;
grant execute on function public.release_catalog_import_storage_source_system(uuid,uuid,uuid,text,uuid,bigint,text,text) to service_role;

-- Queue finalization bridge.  The existing catalog finalizer remains the
-- source of truth for validation/publication; this system wrapper preserves
-- the actor boundary used by the scheduled worker.  A future cursor-native
-- finalizer can replace the delegated function without changing the queue or
-- Storage contract above.
drop function if exists public.finalize_catalog_import_batch_system(uuid,uuid,uuid,integer);
create or replace function public.finalize_catalog_import_batch_system(
  input_run_id uuid,
  input_organization_id uuid,
  input_actor_id uuid,
  input_batch_size integer default 500
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_org uuid;
  v_actor_role text;
  v_result jsonb;
begin
  select organization_id, lower(role::text) into v_actor_org, v_actor_role
  from public.profiles
  where id = input_actor_id and is_active = true;
  if v_actor_org is null or v_actor_org <> input_organization_id
     or v_actor_role not in ('admin', 'superadmin') then
    raise exception 'System finalization actor is not an active organization admin';
  end if;
  perform set_config('request.jwt.claim.sub', input_actor_id::text, true);
  -- The canonical catalog finalizer is currently a single transactional RPC;
  -- keep this system endpoint stable for the queue worker and expose an
  -- explicit completion marker until a cursor-native finalizer is introduced.
  v_result := public.finalize_catalog_import(input_run_id);
  return v_result || jsonb_build_object(
    'batch_size', greatest(1, least(coalesce(input_batch_size, 500), 1000)),
    'has_more', false
  );
end;
$$;
revoke all on function public.finalize_catalog_import_batch_system(uuid,uuid,uuid,integer) from public, anon, authenticated;
grant execute on function public.finalize_catalog_import_batch_system(uuid,uuid,uuid,integer) to service_role;
