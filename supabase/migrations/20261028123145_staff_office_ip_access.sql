-- Dormant until a superadmin assigns an IP and enables a staff account.
create table if not exists public.staff_office_access (
  profile_id uuid primary key references public.profiles(id) on delete cascade,
  enabled boolean not null default false,
  allowed_ips inet[] not null default '{}'::inet[],
  updated_at timestamptz not null default now(),
  constraint staff_office_access_requires_ip check (not enabled or cardinality(allowed_ips) > 0),
  constraint staff_office_access_ip_limit check (cardinality(allowed_ips) <= 12)
);

alter table public.staff_office_access enable row level security;
revoke all on public.staff_office_access from public, anon, authenticated;
grant select, insert, update, delete on public.staff_office_access to service_role;

-- The Data API checks this before every request, including RPCs that bypass RLS.
-- Never use the first X-Forwarded-For value for security: clients can prepend it.
create schema if not exists staff_office_guard;
revoke all on schema staff_office_guard from public;

create or replace function staff_office_guard.is_allowed()
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public, staff_office_guard
as $$
declare
  raw_ip text;
  client_ip inet;
  allowed inet[];
begin
  if auth.uid() is null then return true; end if;
  if exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role in ('admin', 'superadmin')
  ) then return true; end if;

  select a.allowed_ips into allowed
  from public.staff_office_access a
  where a.profile_id = auth.uid() and a.enabled;
  if not found then return true; end if;

  raw_ip := nullif(trim(coalesce(current_setting('request.headers', true)::jsonb ->> 'cf-connecting-ip', '')), '');
  begin
    client_ip := raw_ip::inet;
  exception when invalid_text_representation then
    client_ip := null;
  end;
  return coalesce(client_ip = any(allowed), false);
end;
$$;

create or replace function staff_office_guard.enforce_staff_office_ip()
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, staff_office_guard
as $$
begin
  if not staff_office_guard.is_allowed() then
    raise exception 'Bu hesap yalnızca tanımlı ofis ağından kullanılabilir.' using errcode = '42501';
  end if;
end;
$$;

revoke all on function staff_office_guard.is_allowed() from public;
revoke all on function staff_office_guard.enforce_staff_office_ip() from public;
grant usage on schema staff_office_guard to authenticator, anon, authenticated, service_role;
grant execute on function staff_office_guard.is_allowed() to anon, authenticated, service_role;
grant execute on function staff_office_guard.enforce_staff_office_ip() to authenticator, anon, authenticated, service_role;

-- Storage's supplier-price policies call this existing permission function.
-- Keep its current department/override behavior while adding the office gate.
create or replace function public.profile_has_permission(input_permission text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select staff_office_guard.is_allowed() and case
    when public.raw_profile_role(auth.uid()) in ('superadmin', 'admin') then true
    when exists (
      select 1 from public.profile_permissions pp
      join public.profiles p on p.id = pp.profile_id and p.organization_id = pp.organization_id
      where pp.profile_id = auth.uid() and pp.permission_key = input_permission and p.is_active
    ) then coalesce((
      select pp.allowed from public.profile_permissions pp
      where pp.profile_id = auth.uid() and pp.permission_key = input_permission limit 1
    ), false)
    else case public.current_profile_department()
      when 'sales' then input_permission in ('customers.view', 'catalog.view', 'sales.orders', 'sales.invoices', 'reports.view')
      when 'purchasing' then input_permission in ('catalog.view', 'purchasing.orders', 'purchasing.receive', 'supplier_prices.view', 'reports.view')
      when 'accounting' then input_permission in ('customers.view', 'sales.invoices', 'finance.view', 'reports.view')
      when 'warehouse' then input_permission in ('catalog.view', 'inventory.view', 'purchasing.receive')
      else input_permission = 'catalog.view'
    end
  end;
$$;

-- PostgREST checks every REST/RPC call. RLS adds coverage for public table
-- access reached by GraphQL and Realtime where applicable. Storage tables are
-- owned by supabase_storage_admin and require a separate rollout gate.
do $$
declare
  target record;
begin
  for target in
    select n.nspname as schema_name, c.relname as table_name
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind in ('r', 'p')
      and not c.relispartition
      and c.relrowsecurity
      and not (n.nspname = 'public' and c.relname = 'staff_office_access')
  loop
    execute format('drop policy if exists staff_office_ip_guard on %I.%I', target.schema_name, target.table_name);
    execute format(
      'create policy staff_office_ip_guard on %I.%I as restrictive for all to authenticated using ((select staff_office_guard.is_allowed())) with check ((select staff_office_guard.is_allowed()))',
      target.schema_name, target.table_name
    );
  end loop;
end;
$$;

alter role authenticator set pgrst.db_pre_request = 'staff_office_guard.enforce_staff_office_ip';
notify pgrst, 'reload config';
