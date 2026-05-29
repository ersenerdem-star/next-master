create or replace function public.raw_profile_role(input_user_id uuid default auth.uid())
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (
      select lower(trim(coalesce(p.role, '')))
      from public.profiles p
      where p.id = coalesce(input_user_id, auth.uid())
        and p.is_active
      limit 1
    ),
    ''
  );
$$;

create or replace function public.current_profile_role()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select
    case
      when public.raw_profile_role(auth.uid()) = 'superadmin' then 'admin'
      else public.raw_profile_role(auth.uid())
    end;
$$;

create or replace function public.is_superadmin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.raw_profile_role(auth.uid()) = 'superadmin';
$$;

grant execute on function public.raw_profile_role(uuid) to authenticated;
grant execute on function public.current_profile_role() to authenticated;
grant execute on function public.is_superadmin() to authenticated;
grant execute on function public.raw_profile_role(uuid) to service_role;
grant execute on function public.current_profile_role() to service_role;
grant execute on function public.is_superadmin() to service_role;

do $$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'profiles'
      and column_name = 'updated_at'
  ) then
    execute $sql$
      update public.profiles
      set role = 'superadmin',
          updated_at = now()
      where lower(trim(coalesce(email, ''))) = 'ersenerdem@hotmail.com'
        and role is distinct from 'superadmin'
    $sql$;
  else
    execute $sql$
      update public.profiles
      set role = 'superadmin'
      where lower(trim(coalesce(email, ''))) = 'ersenerdem@hotmail.com'
        and role is distinct from 'superadmin'
    $sql$;
  end if;
end $$;

drop policy if exists company_profiles_write_admin on public.company_profiles;
create policy company_profiles_write_admin on public.company_profiles
for all
using (
  public.is_superadmin()
  and organization_id = public.current_profile_org_id()
)
with check (
  public.is_superadmin()
  and organization_id = public.current_profile_org_id()
);

drop policy if exists portal_invites_select_admin on public.portal_invites;
create policy portal_invites_select_admin on public.portal_invites
for select
using (
  public.current_profile_role() in ('admin', 'sales')
  and organization_id = public.current_profile_org_id()
);

drop policy if exists portal_invites_write_admin on public.portal_invites;
create policy portal_invites_write_admin on public.portal_invites
for all
using (
  public.current_profile_role() in ('admin', 'sales')
  and organization_id = public.current_profile_org_id()
)
with check (
  public.current_profile_role() in ('admin', 'sales')
  and organization_id = public.current_profile_org_id()
);

drop policy if exists "item_code_references_admin_manage_own_org" on public.item_code_references;
create policy "item_code_references_admin_manage_own_org" on public.item_code_references
for all
using (
  public.is_superadmin()
  and organization_id = public.current_profile_org_id()
)
with check (
  public.is_superadmin()
  and organization_id = public.current_profile_org_id()
);

drop policy if exists email_templates_write_admin on public.email_templates;
create policy email_templates_write_admin on public.email_templates
for all
using (
  public.is_superadmin()
  and organization_id = public.current_profile_org_id()
)
with check (
  public.is_superadmin()
  and organization_id = public.current_profile_org_id()
);

drop policy if exists vendors_select_org on public.vendors;
create policy vendors_select_org on public.vendors
for select
using (
  public.is_superadmin()
  and organization_id = public.current_profile_org_id()
);

drop policy if exists vendors_write_org on public.vendors;
create policy vendors_write_org on public.vendors
for all
using (
  public.is_superadmin()
  and organization_id = public.current_profile_org_id()
)
with check (
  public.is_superadmin()
  and organization_id = public.current_profile_org_id()
);

drop policy if exists purchase_orders_select_org on public.purchase_orders;
create policy purchase_orders_select_org on public.purchase_orders
for select
using (
  public.is_superadmin()
  and organization_id = public.current_profile_org_id()
);

drop policy if exists purchase_orders_write_org on public.purchase_orders;
create policy purchase_orders_write_org on public.purchase_orders
for all
using (
  public.is_superadmin()
  and organization_id = public.current_profile_org_id()
)
with check (
  public.is_superadmin()
  and organization_id = public.current_profile_org_id()
);

drop policy if exists bills_select_org on public.bills;
create policy bills_select_org on public.bills
for select
using (
  public.is_superadmin()
  and organization_id = public.current_profile_org_id()
);

drop policy if exists bills_write_org on public.bills;
create policy bills_write_org on public.bills
for all
using (
  public.is_superadmin()
  and organization_id = public.current_profile_org_id()
)
with check (
  public.is_superadmin()
  and organization_id = public.current_profile_org_id()
);

drop policy if exists payments_made_select_org on public.payments_made;
create policy payments_made_select_org on public.payments_made
for select
using (
  public.is_superadmin()
  and organization_id = public.current_profile_org_id()
);

drop policy if exists payments_made_write_org on public.payments_made;
create policy payments_made_write_org on public.payments_made
for all
using (
  public.is_superadmin()
  and organization_id = public.current_profile_org_id()
)
with check (
  public.is_superadmin()
  and organization_id = public.current_profile_org_id()
);

drop policy if exists warehouses_select_org on public.warehouses;
create policy warehouses_select_org on public.warehouses
for select
using (
  public.is_superadmin()
  and organization_id = public.current_profile_org_id()
);

drop policy if exists warehouses_write_org on public.warehouses;
create policy warehouses_write_org on public.warehouses
for all
using (
  public.is_superadmin()
  and organization_id = public.current_profile_org_id()
)
with check (
  public.is_superadmin()
  and organization_id = public.current_profile_org_id()
);

drop policy if exists purchase_receives_select_org on public.purchase_receives;
create policy purchase_receives_select_org on public.purchase_receives
for select
using (
  public.is_superadmin()
  and organization_id = public.current_profile_org_id()
);

drop policy if exists purchase_receives_write_org on public.purchase_receives;
create policy purchase_receives_write_org on public.purchase_receives
for all
using (
  public.is_superadmin()
  and organization_id = public.current_profile_org_id()
)
with check (
  public.is_superadmin()
  and organization_id = public.current_profile_org_id()
);

drop policy if exists inventory_movements_select_org on public.inventory_movements;
create policy inventory_movements_select_org on public.inventory_movements
for select
using (
  public.is_superadmin()
  and organization_id = public.current_profile_org_id()
);

drop policy if exists inventory_movements_write_org on public.inventory_movements;
create policy inventory_movements_write_org on public.inventory_movements
for all
using (
  public.is_superadmin()
  and organization_id = public.current_profile_org_id()
)
with check (
  public.is_superadmin()
  and organization_id = public.current_profile_org_id()
);

drop policy if exists stock_transfers_select_org on public.stock_transfers;
create policy stock_transfers_select_org on public.stock_transfers
for select
using (
  public.is_superadmin()
  and organization_id = public.current_profile_org_id()
);

drop policy if exists stock_transfers_write_org on public.stock_transfers;
create policy stock_transfers_write_org on public.stock_transfers
for all
using (
  public.is_superadmin()
  and organization_id = public.current_profile_org_id()
)
with check (
  public.is_superadmin()
  and organization_id = public.current_profile_org_id()
);

drop policy if exists user_presence_select_admin_org on public.user_presence;
create policy user_presence_select_admin_org on public.user_presence
for select
using (
  public.is_superadmin()
  and organization_id = public.current_profile_org_id()
);

do $$
begin
  if exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'admin_list_org_users'
      and oidvectortypes(p.proargtypes) = ''
  ) and not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'admin_list_org_users_inner'
      and oidvectortypes(p.proargtypes) = ''
  ) then
    execute 'alter function public.admin_list_org_users() rename to admin_list_org_users_inner';
  end if;
end $$;

create or replace function public.admin_list_org_users()
returns table (
  user_id uuid,
  email text,
  full_name text,
  role text,
  is_active boolean,
  created_at timestamptz,
  last_login_at timestamptz,
  last_seen_at timestamptz,
  quote_count bigint,
  last_quote_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_superadmin() then
    raise exception 'Only active superadmin users can list organization users';
  end if;

  return query
  select * from public.admin_list_org_users_inner();
end;
$$;

grant execute on function public.admin_list_org_users() to authenticated;

do $$
begin
  if exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'admin_delete_org_user_profile'
      and oidvectortypes(p.proargtypes) = 'uuid'
  ) and not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'admin_delete_org_user_profile_inner'
      and oidvectortypes(p.proargtypes) = 'uuid'
  ) then
    execute 'alter function public.admin_delete_org_user_profile(uuid) rename to admin_delete_org_user_profile_inner';
  end if;
end $$;

create or replace function public.admin_delete_org_user_profile(
  input_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_superadmin() then
    raise exception 'Only active superadmin users can delete organization users';
  end if;

  return public.admin_delete_org_user_profile_inner(input_user_id);
end;
$$;

grant execute on function public.admin_delete_org_user_profile(uuid) to authenticated;

do $$
begin
  if exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'upsert_org_user_profile'
      and oidvectortypes(p.proargtypes) = 'uuid, text, text, text, boolean'
  ) and not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'upsert_org_user_profile_inner'
      and oidvectortypes(p.proargtypes) = 'uuid, text, text, text, boolean'
  ) then
    execute 'alter function public.upsert_org_user_profile(uuid, text, text, text, boolean) rename to upsert_org_user_profile_inner';
  end if;
end $$;

create or replace function public.upsert_org_user_profile(
  input_user_id uuid,
  input_email text,
  input_full_name text default '',
  input_role text default 'sales',
  input_is_active boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_superadmin() then
    raise exception 'Only active superadmin users can manage organization users';
  end if;

  return public.upsert_org_user_profile_inner(input_user_id, input_email, input_full_name, input_role, input_is_active);
end;
$$;

grant execute on function public.upsert_org_user_profile(uuid, text, text, text, boolean) to authenticated;

do $$
begin
  if exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'admin_list_quote_activity'
      and oidvectortypes(p.proargtypes) = 'integer, text'
  ) and not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'admin_list_quote_activity_inner'
      and oidvectortypes(p.proargtypes) = 'integer, text'
  ) then
    execute 'alter function public.admin_list_quote_activity(integer, text) rename to admin_list_quote_activity_inner';
  end if;
end $$;

create or replace function public.admin_list_quote_activity(
  input_limit integer default 100,
  input_search text default ''
)
returns table (
  quote_id uuid,
  quote_no text,
  customer_name text,
  status text,
  quote_date date,
  created_at timestamptz,
  updated_at timestamptz,
  created_by_name text,
  created_by_email text
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_superadmin() then
    raise exception 'Only active superadmin users can view quote activity';
  end if;

  return query
  select * from public.admin_list_quote_activity_inner(input_limit, input_search);
end;
$$;

grant execute on function public.admin_list_quote_activity(integer, text) to authenticated;

do $$
begin
  if exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'bulk_import_catalog'
      and oidvectortypes(p.proargtypes) = 'jsonb'
  ) and not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'bulk_import_catalog_inner'
      and oidvectortypes(p.proargtypes) = 'jsonb'
  ) then
    execute 'alter function public.bulk_import_catalog(jsonb) rename to bulk_import_catalog_inner';
  end if;
end $$;

create or replace function public.bulk_import_catalog(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.current_profile_org_id() is null or not public.is_superadmin() then
    raise exception 'Only active superadmin users can import catalog data';
  end if;

  return public.bulk_import_catalog_inner(payload);
end;
$$;

grant execute on function public.bulk_import_catalog(jsonb) to authenticated;

do $$
begin
  if exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'bulk_import_supplier_prices'
      and oidvectortypes(p.proargtypes) = 'jsonb'
  ) and not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'bulk_import_supplier_prices_inner'
      and oidvectortypes(p.proargtypes) = 'jsonb'
  ) then
    execute 'alter function public.bulk_import_supplier_prices(jsonb) rename to bulk_import_supplier_prices_inner';
  end if;
end $$;

create or replace function public.bulk_import_supplier_prices(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.current_profile_org_id() is null or not public.is_superadmin() then
    raise exception 'Only active superadmin users can import supplier prices';
  end if;

  return public.bulk_import_supplier_prices_inner(payload);
end;
$$;

grant execute on function public.bulk_import_supplier_prices(jsonb) to authenticated;

do $$
begin
  if exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'list_cloud_suppliers'
      and oidvectortypes(p.proargtypes) = ''
  ) and not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'list_cloud_suppliers_inner'
      and oidvectortypes(p.proargtypes) = ''
  ) then
    execute 'alter function public.list_cloud_suppliers() rename to list_cloud_suppliers_inner';
  end if;
end $$;

create or replace function public.list_cloud_suppliers()
returns table (
  supplier_id uuid,
  name text,
  is_active boolean,
  line_count bigint,
  latest_price_date date,
  old_or_unknown_count bigint
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_superadmin() then
    raise exception 'Only active superadmin users can view suppliers';
  end if;

  return query
  select * from public.list_cloud_suppliers_inner();
end;
$$;

grant execute on function public.list_cloud_suppliers() to authenticated;

do $$
begin
  if exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'cloud_supplier_price_page'
      and oidvectortypes(p.proargtypes) = 'uuid, text, integer, integer, text'
  ) and not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'cloud_supplier_price_page_inner'
      and oidvectortypes(p.proargtypes) = 'uuid, text, integer, integer, text'
  ) then
    execute 'alter function public.cloud_supplier_price_page(uuid, text, integer, integer, text) rename to cloud_supplier_price_page_inner';
  end if;
end $$;

create or replace function public.cloud_supplier_price_page(
  input_supplier_id uuid,
  input_search text default '',
  input_page integer default 1,
  input_page_size integer default 250,
  input_freshness text default 'all'
)
returns table (
  total_count bigint,
  price_id uuid,
  product_code text,
  brand text,
  description text,
  oem_no text,
  buy_price numeric,
  currency text,
  price_date date,
  moq integer,
  lead_time_days integer,
  notes text,
  freshness text
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_superadmin() then
    raise exception 'Only active superadmin users can view supplier prices';
  end if;

  return query
  select * from public.cloud_supplier_price_page_inner(input_supplier_id, input_search, input_page, input_page_size, input_freshness);
end;
$$;

grant execute on function public.cloud_supplier_price_page(uuid, text, integer, integer, text) to authenticated;

do $$
begin
  if exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'cloud_supplier_brand_summary'
      and oidvectortypes(p.proargtypes) = 'uuid'
  ) and not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'cloud_supplier_brand_summary_inner'
      and oidvectortypes(p.proargtypes) = 'uuid'
  ) then
    execute 'alter function public.cloud_supplier_brand_summary(uuid) rename to cloud_supplier_brand_summary_inner';
  end if;
end $$;

create or replace function public.cloud_supplier_brand_summary(
  input_supplier_id uuid default null
)
returns table (
  supplier_id uuid,
  supplier_name text,
  brand text,
  part_count bigint,
  line_count bigint,
  latest_price_date date,
  oldest_price_date date
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not public.is_superadmin() then
    raise exception 'Only active superadmin users can view supplier brand summary';
  end if;

  return query
  select * from public.cloud_supplier_brand_summary_inner(input_supplier_id);
end;
$$;

grant execute on function public.cloud_supplier_brand_summary(uuid) to authenticated;

do $$
begin
  if exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'update_cloud_supplier_price'
      and oidvectortypes(p.proargtypes) = 'uuid, text, text, numeric, integer, integer, text'
  ) and not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'update_cloud_supplier_price_inner'
      and oidvectortypes(p.proargtypes) = 'uuid, text, text, numeric, integer, integer, text'
  ) then
    execute 'alter function public.update_cloud_supplier_price(uuid, text, text, numeric, integer, integer, text) rename to update_cloud_supplier_price_inner';
  end if;
end $$;

create or replace function public.update_cloud_supplier_price(
  input_price_id uuid,
  input_description text default null,
  input_oem_no text default null,
  input_buy_price numeric default null,
  input_moq integer default null,
  input_lead_time_days integer default null,
  input_notes text default null
)
returns table (
  price_id uuid,
  description text,
  oem_no text,
  buy_price numeric,
  moq integer,
  lead_time_days integer,
  notes text
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_superadmin() then
    raise exception 'Only active superadmin users can edit supplier prices';
  end if;

  return query
  select * from public.update_cloud_supplier_price_inner(
    input_price_id,
    input_description,
    input_oem_no,
    input_buy_price,
    input_moq,
    input_lead_time_days,
    input_notes
  );
end;
$$;

grant execute on function public.update_cloud_supplier_price(uuid, text, text, numeric, integer, integer, text) to authenticated;

do $$
begin
  if exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'deactivate_old_supplier_prices'
      and oidvectortypes(p.proargtypes) = 'uuid, integer'
  ) and not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'deactivate_old_supplier_prices_inner'
      and oidvectortypes(p.proargtypes) = 'uuid, integer'
  ) then
    execute 'alter function public.deactivate_old_supplier_prices(uuid, integer) rename to deactivate_old_supplier_prices_inner';
  end if;
end $$;

create or replace function public.deactivate_old_supplier_prices(
  input_supplier_id uuid default null,
  input_before_days integer default 180
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.current_profile_org_id() is null or not public.is_superadmin() then
    raise exception 'Only active superadmin users can deactivate supplier prices';
  end if;

  return public.deactivate_old_supplier_prices_inner(input_supplier_id, input_before_days);
end;
$$;

grant execute on function public.deactivate_old_supplier_prices(uuid, integer) to authenticated;

do $$
begin
  if exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'deactivate_supplier_prices_by_filter'
      and oidvectortypes(p.proargtypes) = 'uuid, text, date, text'
  ) and not exists (
    select 1
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'deactivate_supplier_prices_by_filter_inner'
      and oidvectortypes(p.proargtypes) = 'uuid, text, date, text'
  ) then
    execute 'alter function public.deactivate_supplier_prices_by_filter(uuid, text, date, text) rename to deactivate_supplier_prices_by_filter_inner';
  end if;
end $$;

create or replace function public.deactivate_supplier_prices_by_filter(
  input_supplier_id uuid,
  input_brand text default '',
  input_price_date date default null,
  input_search text default ''
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.current_profile_org_id() is null or not public.is_superadmin() then
    raise exception 'Only active superadmin users can deactivate supplier prices';
  end if;

  return public.deactivate_supplier_prices_by_filter_inner(input_supplier_id, input_brand, input_price_date, input_search);
end;
$$;

grant execute on function public.deactivate_supplier_prices_by_filter(uuid, text, date, text) to authenticated;

drop function if exists public.cloud_catalog_page(text, integer, integer);
drop function if exists public.cloud_catalog_page(text, text, integer, integer);

create or replace function public.cloud_catalog_page(
  input_search text default '',
  input_brand text default '',
  input_page integer default 1,
  input_page_size integer default 250
)
returns table (
  total_count bigint,
  product_id uuid,
  product_code text,
  brand text,
  image_url text,
  description text,
  oem_no text,
  hs_code text,
  origin text,
  weight_kg numeric,
  lifecycle_status text,
  lifecycle_note text
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  org_id uuid;
begin
  org_id := public.current_profile_org_id();
  if org_id is null or not public.is_superadmin() then
    raise exception 'Only active superadmin users can load catalog';
  end if;

  return query
  with params as (
    select
      nullif(trim(coalesce(input_search, '')), '') as raw_search,
      public.normalize_part_code(input_search) as search_norm,
      public.normalize_part_code(input_brand) as brand_norm,
      greatest(input_page, 1) as page_no,
      least(greatest(input_page_size, 1), 1000) as page_size,
      greatest(0, (greatest(input_page, 1) - 1) * least(greatest(input_page_size, 1), 1000)) as row_offset
  ),
  flags as (
    select
      raw_search,
      search_norm,
      brand_norm,
      page_no,
      page_size,
      row_offset,
      (search_norm <> '' and (raw_search ~ '[0-9]' or raw_search ~ '[-/+.()]')) as search_is_code
    from params
  ),
  filtered as (
    select
      cp.id,
      cp.product_code,
      b.name as brand,
      cp.image_url,
      cp.description,
      cp.oem_no,
      cp.hs_code,
      cp.origin,
      cp.weight_kg,
      cp.lifecycle_status,
      cp.lifecycle_note
    from public.catalog_products cp
    join public.brands b
      on b.id = cp.brand_id
    cross join flags f
    where cp.organization_id = org_id
      and (
        f.brand_norm = ''
        or coalesce(b.normalized_name, public.normalize_part_code(b.name)) = f.brand_norm
      )
      and (
        f.raw_search is null
        or (
          f.search_is_code
          and (
            cp.normalized_code = f.search_norm
            or cp.normalized_oem = f.search_norm
            or cp.normalized_code like f.search_norm || '%'
            or cp.normalized_oem like f.search_norm || '%'
            or cp.normalized_oem like '%' || f.search_norm || '%'
            or public.normalize_part_code(coalesce(cp.oem_no, '')) like '%' || f.search_norm || '%'
            or (
              f.search_norm ~ '^[0-9]+$'
              and public.normalize_part_code(coalesce(cp.oem_no, '')) like '%a' || f.search_norm || '%'
            )
            or cp.product_code ilike '%' || f.raw_search || '%'
            or coalesce(cp.oem_no, '') ilike '%' || f.raw_search || '%'
          )
        )
        or (
          not f.search_is_code
          and (
            cp.product_code ilike '%' || f.raw_search || '%'
            or coalesce(cp.description, '') ilike '%' || f.raw_search || '%'
            or coalesce(cp.oem_no, '') ilike '%' || f.raw_search || '%'
            or b.name ilike '%' || f.raw_search || '%'
            or cp.normalized_code like '%' || f.search_norm || '%'
            or (
              nullif(cp.normalized_oem, '') is not null
              and cp.normalized_oem like '%' || f.search_norm || '%'
            )
          )
        )
      )
  ),
  counted as (
    select
      filtered.*,
      count(*) over () as total_count,
      row_number() over (order by filtered.product_code) as row_no
    from filtered
  )
  select
    counted.total_count,
    counted.id,
    counted.product_code,
    counted.brand,
    counted.image_url,
    counted.description,
    counted.oem_no,
    counted.hs_code,
    counted.origin,
    counted.weight_kg,
    counted.lifecycle_status,
    counted.lifecycle_note
  from counted
  cross join flags f
  where counted.row_no > f.row_offset
    and counted.row_no <= (f.row_offset + f.page_size);
end;
$$;

create or replace function public.cloud_catalog_page(
  input_search text default '',
  input_page integer default 1,
  input_page_size integer default 250
)
returns table (
  total_count bigint,
  product_id uuid,
  product_code text,
  brand text,
  image_url text,
  description text,
  oem_no text,
  hs_code text,
  origin text,
  weight_kg numeric,
  lifecycle_status text,
  lifecycle_note text
)
language sql
stable
security definer
set search_path = public
as $$
  select *
  from public.cloud_catalog_page(input_search, '', input_page, input_page_size);
$$;

grant execute on function public.cloud_catalog_page(text, text, integer, integer) to authenticated;
grant execute on function public.cloud_catalog_page(text, integer, integer) to authenticated;
