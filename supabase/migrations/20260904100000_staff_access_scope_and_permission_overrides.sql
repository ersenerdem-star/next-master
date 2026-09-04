-- Phase 2 staff access: explicit permission denies and configured customer scope.

alter table public.profiles
  add column if not exists customer_scope_mode text not null default 'all';

alter table public.profiles drop constraint if exists profiles_customer_scope_mode_check;
alter table public.profiles
  add constraint profiles_customer_scope_mode_check
  check (customer_scope_mode in ('all', 'assigned'));

create or replace function public.current_profile_customer_scope_mode()
returns text
language sql stable security definer set search_path = public
as $$
  select coalesce((
    select p.customer_scope_mode
    from public.profiles p
    where p.id = auth.uid() and p.is_active
    limit 1
  ), 'assigned');
$$;

create or replace function public.profile_has_permission(input_permission text)
returns boolean
language sql stable security definer set search_path = public
as $$
  select case
    when public.raw_profile_role(auth.uid()) in ('superadmin', 'admin') then true
    when exists (
      select 1
      from public.profile_permissions pp
      join public.profiles p on p.id = pp.profile_id and p.organization_id = pp.organization_id
      where pp.profile_id = auth.uid()
        and pp.permission_key = input_permission
        and p.is_active
    ) then coalesce((
      select pp.allowed
      from public.profile_permissions pp
      where pp.profile_id = auth.uid()
        and pp.permission_key = input_permission
      limit 1
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

drop policy if exists customers_select_scoped on public.customers;
create policy customers_select_scoped on public.customers
for select to authenticated
using (
  organization_id = public.current_profile_org_id()
  and (
    public.raw_profile_role(auth.uid()) in ('superadmin', 'admin')
    or (
      public.profile_has_permission('customers.view')
      and (
        public.current_profile_customer_scope_mode() = 'all'
        or public.can_access_customer(id)
      )
    )
  )
);

drop policy if exists customers_write_scoped on public.customers;
create policy customers_write_scoped on public.customers
for all to authenticated
using (
  organization_id = public.current_profile_org_id()
  and (
    public.raw_profile_role(auth.uid()) in ('superadmin', 'admin')
    or (
      public.profile_has_permission('customers.manage')
      and (
        public.current_profile_customer_scope_mode() = 'all'
        or public.can_access_customer(id)
      )
    )
  )
)
with check (
  organization_id = public.current_profile_org_id()
  and (
    public.raw_profile_role(auth.uid()) in ('superadmin', 'admin')
    or public.profile_has_permission('customers.manage')
  )
);

revoke all on function public.current_profile_customer_scope_mode() from public;
revoke all on function public.profile_has_permission(text) from public;
grant execute on function public.current_profile_customer_scope_mode() to authenticated, service_role;
grant execute on function public.profile_has_permission(text) to authenticated, service_role;
