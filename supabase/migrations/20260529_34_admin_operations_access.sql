drop policy if exists vendors_select_org on public.vendors;
create policy vendors_select_org on public.vendors
for select
using (
  public.current_profile_role() = 'admin'
  and organization_id = public.current_profile_org_id()
);

drop policy if exists vendors_write_org on public.vendors;
create policy vendors_write_org on public.vendors
for all
using (
  public.current_profile_role() = 'admin'
  and organization_id = public.current_profile_org_id()
)
with check (
  public.current_profile_role() = 'admin'
  and organization_id = public.current_profile_org_id()
);

drop policy if exists purchase_orders_select_org on public.purchase_orders;
create policy purchase_orders_select_org on public.purchase_orders
for select
using (
  public.current_profile_role() = 'admin'
  and organization_id = public.current_profile_org_id()
);

drop policy if exists purchase_orders_write_org on public.purchase_orders;
create policy purchase_orders_write_org on public.purchase_orders
for all
using (
  public.current_profile_role() = 'admin'
  and organization_id = public.current_profile_org_id()
)
with check (
  public.current_profile_role() = 'admin'
  and organization_id = public.current_profile_org_id()
);

drop policy if exists bills_select_org on public.bills;
create policy bills_select_org on public.bills
for select
using (
  public.current_profile_role() = 'admin'
  and organization_id = public.current_profile_org_id()
);

drop policy if exists bills_write_org on public.bills;
create policy bills_write_org on public.bills
for all
using (
  public.current_profile_role() = 'admin'
  and organization_id = public.current_profile_org_id()
)
with check (
  public.current_profile_role() = 'admin'
  and organization_id = public.current_profile_org_id()
);

drop policy if exists payments_made_select_org on public.payments_made;
create policy payments_made_select_org on public.payments_made
for select
using (
  public.current_profile_role() = 'admin'
  and organization_id = public.current_profile_org_id()
);

drop policy if exists payments_made_write_org on public.payments_made;
create policy payments_made_write_org on public.payments_made
for all
using (
  public.current_profile_role() = 'admin'
  and organization_id = public.current_profile_org_id()
)
with check (
  public.current_profile_role() = 'admin'
  and organization_id = public.current_profile_org_id()
);

drop policy if exists warehouses_select_org on public.warehouses;
create policy warehouses_select_org on public.warehouses
for select
using (
  public.current_profile_role() = 'admin'
  and organization_id = public.current_profile_org_id()
);

drop policy if exists warehouses_write_org on public.warehouses;
create policy warehouses_write_org on public.warehouses
for all
using (
  public.current_profile_role() = 'admin'
  and organization_id = public.current_profile_org_id()
)
with check (
  public.current_profile_role() = 'admin'
  and organization_id = public.current_profile_org_id()
);

drop policy if exists purchase_receives_select_org on public.purchase_receives;
create policy purchase_receives_select_org on public.purchase_receives
for select
using (
  public.current_profile_role() = 'admin'
  and organization_id = public.current_profile_org_id()
);

drop policy if exists purchase_receives_write_org on public.purchase_receives;
create policy purchase_receives_write_org on public.purchase_receives
for all
using (
  public.current_profile_role() = 'admin'
  and organization_id = public.current_profile_org_id()
)
with check (
  public.current_profile_role() = 'admin'
  and organization_id = public.current_profile_org_id()
);

drop policy if exists inventory_movements_select_org on public.inventory_movements;
create policy inventory_movements_select_org on public.inventory_movements
for select
using (
  public.current_profile_role() = 'admin'
  and organization_id = public.current_profile_org_id()
);

drop policy if exists inventory_movements_write_org on public.inventory_movements;
create policy inventory_movements_write_org on public.inventory_movements
for all
using (
  public.current_profile_role() = 'admin'
  and organization_id = public.current_profile_org_id()
)
with check (
  public.current_profile_role() = 'admin'
  and organization_id = public.current_profile_org_id()
);

drop policy if exists stock_transfers_select_org on public.stock_transfers;
create policy stock_transfers_select_org on public.stock_transfers
for select
using (
  public.current_profile_role() = 'admin'
  and organization_id = public.current_profile_org_id()
);

drop policy if exists stock_transfers_write_org on public.stock_transfers;
create policy stock_transfers_write_org on public.stock_transfers
for all
using (
  public.current_profile_role() = 'admin'
  and organization_id = public.current_profile_org_id()
)
with check (
  public.current_profile_role() = 'admin'
  and organization_id = public.current_profile_org_id()
);
