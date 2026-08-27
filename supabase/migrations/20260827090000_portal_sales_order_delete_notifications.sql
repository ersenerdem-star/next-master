-- Allow an administrator to remove a confirmed sales order only when it has
-- no downstream documents, and leave a durable portal notification for the
-- customer attached to a portal-created order.
create or replace function public.delete_sales_order_guarded(id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_id uuid := public.current_profile_org_id();
  v_role text := public.current_profile_role();
  v_order public.sales_orders%rowtype;
  v_status text;
begin
  if v_org_id is null or (v_role not in ('admin', 'sales') and not public.is_superadmin()) then
    raise exception 'Only active staff users can delete sales orders';
  end if;

  if nullif(trim(coalesce(delete_sales_order_guarded.id, '')), '') is null then
    raise exception 'Sales order id is required';
  end if;

  select *
    into v_order
  from public.sales_orders so
  where so.organization_id = v_org_id
    and so.id = delete_sales_order_guarded.id
  for update;

  if not found then
    raise exception 'Sales order was not found';
  end if;

  v_status := lower(coalesce(v_order.status, 'draft'));
  if v_status <> 'draft'
     and not (v_status = 'confirmed' and (v_role = 'admin' or public.is_superadmin())) then
    raise exception 'Only draft orders can be deleted by this user';
  end if;

  if exists (
    select 1 from public.purchase_orders po
    where po.organization_id = v_org_id
      and po.sales_order_id = v_order.id
    union all
    select 1 from public.invoices i
    where i.organization_id = v_org_id
      and (i.sales_order_id = v_order.id or v_order.id = any(coalesce(i.sales_order_ids, '{}'::text[])))
    union all
    select 1 from public.inventory_movements im
    where im.organization_id = v_org_id
      and im.document_id = v_order.id
  ) then
    raise exception 'Sales order has downstream documents and cannot be deleted';
  end if;

  if v_status = 'confirmed'
     and lower(coalesce(v_order.source_channel, '')) = 'portal'
     and v_order.portal_invite_id is not null then
    insert into public.portal_audit_logs (
      organization_id,
      invite_id,
      party_type,
      event_type,
      status,
      details
    ) values (
      v_org_id,
      v_order.portal_invite_id,
      'customer',
      'sales_order_deleted_by_admin',
      'ok',
      jsonb_build_object(
        'order_id', v_order.id,
        'sales_order_no', v_order.sales_order_no,
        'message', 'The seller deleted this confirmed order. You can now delete this order from your portal.'
      )
    );
  end if;

  delete from public.sales_orders
   where organization_id = v_org_id
     and sales_orders.id = v_order.id;

  return jsonb_build_object('deleted', true, 'sales_order', to_jsonb(v_order));
end;
$$;
