-- Supplier price import now allows admin and superadmin users.
-- Keep org isolation and authenticated-user requirements intact.

do $$
begin
  if exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'begin_supplier_price_import'
      and oidvectortypes(p.proargtypes) = 'text, text, text'
  ) and not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'begin_supplier_price_import_inner'
      and oidvectortypes(p.proargtypes) = 'text, text, text'
  ) then
    execute 'alter function public.begin_supplier_price_import(text, text, text) rename to begin_supplier_price_import_inner';
  end if;

  if exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'stage_supplier_price_import_chunk'
      and oidvectortypes(p.proargtypes) = 'uuid, jsonb'
  ) and not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'stage_supplier_price_import_chunk_inner'
      and oidvectortypes(p.proargtypes) = 'uuid, jsonb'
  ) then
    execute 'alter function public.stage_supplier_price_import_chunk(uuid, jsonb) rename to stage_supplier_price_import_chunk_inner';
  end if;

  if exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'finalize_supplier_price_import'
      and oidvectortypes(p.proargtypes) = 'uuid'
  ) and not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'finalize_supplier_price_import_inner'
      and oidvectortypes(p.proargtypes) = 'uuid'
  ) then
    execute 'alter function public.finalize_supplier_price_import(uuid) rename to finalize_supplier_price_import_inner';
  end if;

  if exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'fail_supplier_price_import'
      and oidvectortypes(p.proargtypes) = 'uuid, text'
  ) and not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'fail_supplier_price_import_inner'
      and oidvectortypes(p.proargtypes) = 'uuid, text'
  ) then
    execute 'alter function public.fail_supplier_price_import(uuid, text) rename to fail_supplier_price_import_inner';
  end if;
end $$;

create or replace function public.begin_supplier_price_import(
  input_supplier_name text,
  input_brand text,
  input_mode text default 'replace'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.current_profile_org_id() is null or (public.current_profile_role() <> 'admin' and not public.is_superadmin()) then
    raise exception 'Only active admin users can import supplier prices';
  end if;

  return public.begin_supplier_price_import_inner(input_supplier_name, input_brand, input_mode);
end;
$$;

create or replace function public.stage_supplier_price_import_chunk(
  input_run_id uuid,
  payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.current_profile_org_id() is null or (public.current_profile_role() <> 'admin' and not public.is_superadmin()) then
    raise exception 'Only active admin users can import supplier prices';
  end if;

  return public.stage_supplier_price_import_chunk_inner(input_run_id, payload);
end;
$$;

create or replace function public.finalize_supplier_price_import(input_run_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.current_profile_org_id() is null or (public.current_profile_role() <> 'admin' and not public.is_superadmin()) then
    raise exception 'Only active admin users can import supplier prices';
  end if;

  return public.finalize_supplier_price_import_inner(input_run_id);
end;
$$;

create or replace function public.fail_supplier_price_import(
  input_run_id uuid,
  input_error_message text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.current_profile_org_id() is null or (public.current_profile_role() <> 'admin' and not public.is_superadmin()) then
    raise exception 'Only active admin users can import supplier prices';
  end if;

  return public.fail_supplier_price_import_inner(input_run_id, input_error_message);
end;
$$;

create or replace function public.bulk_import_supplier_prices(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.current_profile_org_id() is null or (public.current_profile_role() <> 'admin' and not public.is_superadmin()) then
    raise exception 'Only active admin users can import supplier prices';
  end if;

  return public.bulk_import_supplier_prices_inner(payload);
end;
$$;

drop policy if exists supplier_price_import_runs_select_superadmin
on public.supplier_price_import_runs;

create policy supplier_price_import_runs_select_ops
on public.supplier_price_import_runs
for select
using (
  organization_id = public.current_profile_org_id()
  and public.current_profile_role() in ('admin', 'superadmin')
);

drop policy if exists supplier_price_import_stage_select_superadmin
on public.supplier_price_import_stage;

create policy supplier_price_import_stage_select_ops
on public.supplier_price_import_stage
for select
using (
  organization_id = public.current_profile_org_id()
  and public.current_profile_role() in ('admin', 'superadmin')
);

grant execute on function public.begin_supplier_price_import(text, text, text) to authenticated;
grant execute on function public.stage_supplier_price_import_chunk(uuid, jsonb) to authenticated;
grant execute on function public.finalize_supplier_price_import(uuid) to authenticated;
grant execute on function public.fail_supplier_price_import(uuid, text) to authenticated;
grant execute on function public.bulk_import_supplier_prices(jsonb) to authenticated;
