-- An invoice belongs to the customer on every linked sales order. Derive the
-- customer UUID at the table boundary, including for the existing
-- save_invoice_atomic RPC, which does not include customer_id in its upsert.
-- Do not backfill historical invoices by name: those names are snapshots and
-- can be ambiguous. Existing rows remain readable without being rewritten.
create schema if not exists invoice_identity_private;
revoke all on schema invoice_identity_private from public, anon, authenticated, service_role;

create or replace function invoice_identity_private.bind_invoice_linked_customer()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_order_ids text[];
  v_order record;
  v_order_count integer := 0;
  v_customer_id uuid;
  v_customer public.customers%rowtype;
  v_customer_name text := pg_catalog.lower(pg_catalog.btrim(coalesce(new.customer_name, '')));
  v_matches_order_name boolean := false;
begin
  -- Payment reconciliation updates status without editing the commercial
  -- identity. Allow that narrow operation for historical invoices whose
  -- original sales order may no longer be available.
  if tg_op = 'UPDATE' and
     (pg_catalog.to_jsonb(new) - 'status' - 'updated_at')
       is not distinct from
     (pg_catalog.to_jsonb(old) - 'status' - 'updated_at') then
    return new;
  end if;

  select pg_catalog.array_agg(distinct input.id order by input.id)
    into v_order_ids
  from (
    select nullif(pg_catalog.btrim(coalesce(new.sales_order_id, '')), '') as id
    union all
    select nullif(pg_catalog.btrim(coalesce(id, '')), '')
    from pg_catalog.unnest(coalesce(new.sales_order_ids, '{}'::text[])) as linked(id)
  ) input
  where input.id is not null;

  -- SHARE locks block concurrent reassignment/deletion of a linked order
  -- until the invoice transaction commits, so the entire set is one snapshot.
  for v_order in
    select so.id, so.customer_id, so.customer_name
    from public.sales_orders so
    where so.organization_id = new.organization_id
      and so.id = any(v_order_ids)
    order by so.id
    for share
  loop
    v_order_count := v_order_count + 1;
    if v_order.customer_id is null then
      raise exception 'Linked sales order has no customer account'
        using errcode = '23514';
    end if;
    if v_customer_id is not null and v_customer_id is distinct from v_order.customer_id then
      raise exception 'All linked sales orders must belong to one customer account'
        using errcode = '23514';
    end if;
    v_customer_id := v_order.customer_id;
    if v_customer_name <> '' and
       v_customer_name = pg_catalog.lower(pg_catalog.btrim(coalesce(v_order.customer_name, ''))) then
      v_matches_order_name := true;
    end if;
  end loop;

  -- The old direct local-invoice bootstrap can contain standalone/orphaned
  -- records. It supplies no customer UUID. Keep accepting those without
  -- guessing a portal-visible customer from a mutable display name. The
  -- guarded save_invoice_atomic RPC still requires every linked order.
  if v_order_count = 0 then
    if new.customer_id is null then
      return new;
    end if;
    raise exception 'Standalone invoice cannot claim a linked customer account'
      using errcode = '23514';
  end if;

  if v_order_count <> coalesce(pg_catalog.cardinality(v_order_ids), 0) then
    raise exception 'Linked sales order was not found in this organization'
      using errcode = '23514';
  end if;

  -- sales_orders.customer_id has a UUID FK, but that alone does not require
  -- the referenced customer to belong to this organization.
  select c.* into v_customer
  from public.customers c
  where c.id = v_customer_id
    and c.organization_id = new.organization_id
  for share;
  if not found then
    raise exception 'Linked customer account is outside this organization'
      using errcode = '23514';
  end if;

  -- customer_name is the document's visible snapshot, but it cannot label a
  -- B-bound invoice as A. Accept an order's own historical name or a current
  -- display/legal company name for the same UUID after an account rename.
  if v_customer_name = '' or not (
    v_matches_order_name
    or v_customer_name = pg_catalog.lower(pg_catalog.btrim(coalesce(v_customer.display_name, '')))
    or v_customer_name = pg_catalog.lower(pg_catalog.btrim(coalesce(v_customer.company_name, '')))
  ) then
    raise exception 'Invoice customer name must match the linked customer account'
      using errcode = '23514';
  end if;

  -- A caller cannot present another customer ID. On UPDATE, an old ID may be
  -- stale because the existing RPC does not update this column; replace it
  -- only when the caller left that old value unchanged.
  if new.customer_id is not null
     and new.customer_id is distinct from v_customer_id
     and (tg_op = 'INSERT' or new.customer_id is distinct from old.customer_id) then
    raise exception 'Invoice customer account must match linked sales orders'
      using errcode = '23514';
  end if;

  new.customer_id := v_customer_id;
  return new;
end;
$function$;

revoke all on function invoice_identity_private.bind_invoice_linked_customer()
  from public, anon, authenticated, service_role;

drop trigger if exists invoices_linked_customer_identity on public.invoices;
create trigger invoices_linked_customer_identity
before insert or update on public.invoices
for each row execute function invoice_identity_private.bind_invoice_linked_customer();

-- An invoice locks its sales orders while deriving the customer. In the other
-- direction, an already invoiced order cannot be rebound or removed: the
-- invoice would otherwise keep the old UUID and become invisible to the new
-- customer's portal. The trigger name sorts after the existing active-customer
-- pricing trigger, so it sees customer_id resolved from an edited name.
create or replace function invoice_identity_private.keep_invoiced_sales_order_customer()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if tg_op = 'UPDATE' and
     new.id is not distinct from old.id and
     new.organization_id is not distinct from old.organization_id and
     new.customer_id is not distinct from old.customer_id then
    return new;
  end if;

  if exists (
    select 1 from public.invoices i
    where i.organization_id = old.organization_id
      and (i.sales_order_id = old.id or old.id = any(coalesce(i.sales_order_ids, '{}'::text[])))
  ) then
    raise exception 'Invoiced sales order customer account cannot change or be deleted'
      using errcode = '23514';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$function$;

revoke all on function invoice_identity_private.keep_invoiced_sales_order_customer()
  from public, anon, authenticated, service_role;

drop trigger if exists sales_orders_invoiced_customer_identity on public.sales_orders;
create trigger sales_orders_invoiced_customer_identity
before update or delete on public.sales_orders
for each row execute function invoice_identity_private.keep_invoiced_sales_order_customer();
