-- Sales orders and purchase orders are commitment roots. Save/delete now runs
-- behind guarded RPC boundaries with server-side total recalculation.

drop function if exists public.save_sales_order_atomic(jsonb, text);
drop function if exists public.delete_sales_order_guarded(text);
drop function if exists public.save_purchase_order_atomic(jsonb, text);
drop function if exists public.delete_purchase_order_guarded(text);

create or replace function public.save_sales_order_atomic(
  payload jsonb,
  previous_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_id uuid := public.current_profile_org_id();
  v_role text := public.current_profile_role();
  v_order_id text := nullif(trim(coalesce(payload->>'id', '')), '');
  v_previous_id text := nullif(trim(coalesce(previous_id, '')), '');
  v_customer_name text := trim(coalesce(payload->>'customer_name', ''));
  v_seller_company text := trim(coalesce(payload->>'seller_company', ''));
  v_purchase_company text := trim(coalesce(payload->>'purchase_company', ''));
  v_currency text := upper(trim(coalesce(nullif(payload->>'currency', ''), 'EUR')));
  v_status text := lower(trim(coalesce(nullif(payload->>'status', ''), 'draft')));
  v_source_channel text := lower(trim(coalesce(nullif(payload->>'source_channel', ''), 'internal')));
  v_lines jsonb := coalesce(payload->'lines', '[]'::jsonb);
  v_existing public.sales_orders%rowtype;
  v_previous public.sales_orders%rowtype;
  v_order public.sales_orders%rowtype;
  v_downstream_count integer := 0;
  v_shipping numeric(14, 2) := 0;
  v_discount numeric(14, 2) := 0;
  v_purchase_total numeric(14, 2) := 0;
  v_subtotal numeric(14, 2) := 0;
  v_sales_total numeric(14, 2) := 0;
  v_profit_total numeric(14, 2) := 0;
  v_margin_percent numeric(10, 2) := 0;
  v_confirmed_at timestamptz;
begin
  if v_org_id is null or (v_role not in ('admin', 'sales') and not public.is_superadmin()) then
    raise exception 'Only active staff users can save sales orders';
  end if;

  if v_order_id is null then
    raise exception 'Sales order id is required';
  end if;

  if v_customer_name = '' then
    raise exception 'Customer is required';
  end if;

  if v_status not in ('draft', 'confirmed') then
    raise exception 'Sales order status is invalid';
  end if;

  if v_source_channel not in ('internal', 'portal') then
    v_source_channel := 'internal';
  end if;

  if jsonb_typeof(v_lines) is distinct from 'array' then
    raise exception 'Sales order lines must be an array';
  end if;

  begin
    v_shipping := coalesce(nullif(payload->>'shipping_cost', '')::numeric, 0);
    v_discount := coalesce(nullif(payload->>'discount_amount', '')::numeric, 0);
  exception when invalid_text_representation then
    raise exception 'Sales order totals are invalid';
  end;

  if v_shipping < 0 or v_discount < 0 then
    raise exception 'Sales order shipping and discount cannot be negative';
  end if;

  if not exists (
    select 1
    from public.customers c
    where c.organization_id = v_org_id
      and (
        lower(trim(coalesce(c.display_name, ''))) = lower(v_customer_name)
        or lower(trim(coalesce(c.company_name, ''))) = lower(v_customer_name)
      )
  ) then
    raise exception 'Customer was not found';
  end if;

  if v_seller_company <> '' and not exists (
    select 1
    from public.company_profiles cp
    where cp.organization_id = v_org_id
      and lower(trim(cp.company_name)) = lower(v_seller_company)
  ) then
    raise exception 'Seller company was not found';
  end if;

  if v_purchase_company <> '' and not exists (
    select 1
    from public.company_profiles cp
    where cp.organization_id = v_org_id
      and lower(trim(cp.company_name)) = lower(v_purchase_company)
  ) then
    raise exception 'Purchase company was not found';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(v_lines) as line(value)
    where coalesce(nullif(line.value->>'qty', '')::numeric, 0) < 0
  ) then
    raise exception 'Sales order line quantities cannot be negative';
  end if;

  select
    coalesce(round(sum(coalesce(nullif(line.value->>'buy_price', '')::numeric, 0) * coalesce(nullif(line.value->>'qty', '')::numeric, 0)), 2), 0),
    coalesce(round(sum(coalesce(nullif(line.value->>'sell_price', '')::numeric, 0) * coalesce(nullif(line.value->>'qty', '')::numeric, 0)), 2), 0)
    into v_purchase_total, v_subtotal
  from jsonb_array_elements(v_lines) as line(value);

  v_sales_total := round(v_subtotal - v_discount + v_shipping, 2);
  v_profit_total := round(v_sales_total - v_purchase_total, 2);
  v_margin_percent := case when v_sales_total > 0 then round((v_profit_total / v_sales_total) * 100, 2) else 0 end;

  if v_purchase_total < 0 or v_subtotal < 0 or v_sales_total < 0 then
    raise exception 'Sales order totals are invalid';
  end if;

  select *
    into v_existing
  from public.sales_orders so
  where so.organization_id = v_org_id
    and so.id = v_order_id
  for update;

  if found then
    select
      (
        select count(*) from public.purchase_orders po
        where po.organization_id = v_org_id
          and po.sales_order_id = v_order_id
      ) +
      (
        select count(*) from public.invoices i
        where i.organization_id = v_org_id
          and (i.sales_order_id = v_order_id or v_order_id = any(coalesce(i.sales_order_ids, '{}'::text[])))
      )
      into v_downstream_count;

    if lower(coalesce(v_existing.status, 'draft')) = 'confirmed' and v_downstream_count > 0 then
      raise exception 'Confirmed sales orders with downstream documents cannot be edited';
    end if;
  end if;

  if v_previous_id is not null and v_previous_id <> v_order_id then
    select *
      into v_previous
    from public.sales_orders so
    where so.organization_id = v_org_id
      and so.id = v_previous_id
    for update;

    if not found then
      raise exception 'Previous sales order was not found';
    end if;

    if lower(coalesce(v_previous.status, 'draft')) <> 'draft' then
      raise exception 'Confirmed sales orders cannot be replaced by id change';
    end if;

    if exists (
      select 1 from public.purchase_orders po
      where po.organization_id = v_org_id
        and po.sales_order_id = v_previous_id
      union all
      select 1 from public.invoices i
      where i.organization_id = v_org_id
        and (i.sales_order_id = v_previous_id or v_previous_id = any(coalesce(i.sales_order_ids, '{}'::text[])))
    ) then
      raise exception 'Sales order with downstream documents cannot be replaced';
    end if;

    delete from public.sales_orders
     where organization_id = v_org_id
       and id = v_previous_id;
  end if;

  v_confirmed_at := case
    when v_status = 'confirmed' then coalesce(nullif(payload->>'confirmed_at', '')::timestamptz, v_existing.confirmed_at, now())
    else null
  end;

  insert into public.sales_orders (
    id,
    organization_id,
    sales_order_no,
    customer_name,
    seller_company,
    purchase_company,
    quote_date,
    currency,
    customer_type,
    shipping_cost,
    discount_amount,
    supplier_mode,
    preferred_supplier,
    seller_info,
    buyer_info,
    delivery_term,
    payment_terms,
    packing_details,
    notes,
    status,
    purchase_total,
    sales_total,
    profit_total,
    margin_percent,
    source_channel,
    portal_invite_id,
    portal_submitted_at,
    portal_seen_at,
    confirmed_at,
    lines,
    created_at,
    updated_at
  )
  values (
    v_order_id,
    v_org_id,
    coalesce(payload->>'sales_order_no', ''),
    v_customer_name,
    v_seller_company,
    v_purchase_company,
    coalesce(payload->>'quote_date', ''),
    v_currency,
    coalesce(payload->>'customer_type', 'A'),
    v_shipping,
    v_discount,
    coalesce(payload->>'supplier_mode', ''),
    coalesce(payload->>'preferred_supplier', ''),
    coalesce(payload->>'seller_info', ''),
    coalesce(payload->>'buyer_info', ''),
    coalesce(payload->>'delivery_term', ''),
    coalesce(payload->>'payment_terms', ''),
    coalesce(payload->>'packing_details', ''),
    coalesce(payload->>'notes', ''),
    v_status,
    v_purchase_total,
    v_sales_total,
    v_profit_total,
    v_margin_percent,
    v_source_channel,
    nullif(payload->>'portal_invite_id', '')::uuid,
    nullif(payload->>'portal_submitted_at', '')::timestamptz,
    nullif(payload->>'portal_seen_at', '')::timestamptz,
    v_confirmed_at,
    v_lines,
    coalesce(nullif(payload->>'created_at', '')::timestamptz, now()),
    now()
  )
  on conflict (id) do update
    set sales_order_no = excluded.sales_order_no,
        customer_name = excluded.customer_name,
        seller_company = excluded.seller_company,
        purchase_company = excluded.purchase_company,
        quote_date = excluded.quote_date,
        currency = excluded.currency,
        customer_type = excluded.customer_type,
        shipping_cost = excluded.shipping_cost,
        discount_amount = excluded.discount_amount,
        supplier_mode = excluded.supplier_mode,
        preferred_supplier = excluded.preferred_supplier,
        seller_info = excluded.seller_info,
        buyer_info = excluded.buyer_info,
        delivery_term = excluded.delivery_term,
        payment_terms = excluded.payment_terms,
        packing_details = excluded.packing_details,
        notes = excluded.notes,
        status = excluded.status,
        purchase_total = excluded.purchase_total,
        sales_total = excluded.sales_total,
        profit_total = excluded.profit_total,
        margin_percent = excluded.margin_percent,
        source_channel = excluded.source_channel,
        portal_invite_id = excluded.portal_invite_id,
        portal_submitted_at = excluded.portal_submitted_at,
        portal_seen_at = excluded.portal_seen_at,
        confirmed_at = excluded.confirmed_at,
        lines = excluded.lines,
        updated_at = now()
    where public.sales_orders.organization_id = v_org_id
  returning * into v_order;

  if v_order.id is null or v_order.organization_id is distinct from v_org_id then
    raise exception 'Sales order belongs to a different organization';
  end if;

  return jsonb_build_object('sales_order', to_jsonb(v_order));
end;
$$;

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

  if lower(coalesce(v_order.status, 'draft')) <> 'draft' then
    raise exception 'Confirmed sales orders cannot be deleted';
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

  delete from public.sales_orders
   where organization_id = v_org_id
     and sales_orders.id = v_order.id;

  return jsonb_build_object('deleted', true, 'sales_order', to_jsonb(v_order));
end;
$$;

create or replace function public.save_purchase_order_atomic(
  payload jsonb,
  previous_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_id uuid := public.current_profile_org_id();
  v_role text := public.current_profile_role();
  v_order_id text := nullif(trim(coalesce(payload->>'id', '')), '');
  v_previous_id text := nullif(trim(coalesce(previous_id, '')), '');
  v_sales_order_id text := nullif(trim(coalesce(payload->>'sales_order_id', '')), '');
  v_supplier_name text := trim(coalesce(payload->>'supplier_name', ''));
  v_purchase_company text := trim(coalesce(payload->>'purchase_company', ''));
  v_currency text := upper(trim(coalesce(nullif(payload->>'currency', ''), 'EUR')));
  v_status text := lower(trim(coalesce(nullif(payload->>'status', ''), 'draft')));
  v_lines jsonb := coalesce(payload->'lines', '[]'::jsonb);
  v_sales_order public.sales_orders%rowtype;
  v_existing public.purchase_orders%rowtype;
  v_previous public.purchase_orders%rowtype;
  v_order public.purchase_orders%rowtype;
  v_downstream_count integer := 0;
  v_total_amount numeric(14, 2) := 0;
  v_line_count integer := 0;
begin
  if v_org_id is null or (v_role not in ('admin', 'sales') and not public.is_superadmin()) then
    raise exception 'Only active staff users can save purchase orders';
  end if;

  if v_order_id is null then
    raise exception 'Purchase order id is required';
  end if;

  if v_sales_order_id is null then
    raise exception 'Linked sales order is required';
  end if;

  if v_status not in ('draft', 'open', 'closed') then
    raise exception 'Purchase order status is invalid';
  end if;

  if jsonb_typeof(v_lines) is distinct from 'array' then
    raise exception 'Purchase order lines must be an array';
  end if;

  select *
    into v_sales_order
  from public.sales_orders so
  where so.organization_id = v_org_id
    and so.id = v_sales_order_id
  for update;

  if not found then
    raise exception 'Linked sales order was not found';
  end if;

  if upper(trim(coalesce(v_sales_order.currency, 'EUR'))) <> v_currency then
    raise exception 'Purchase order currency must match linked sales order currency';
  end if;

  if v_supplier_name <> '' and lower(v_supplier_name) <> 'unassigned supplier' and not exists (
    select 1
    from public.vendors v
    where v.organization_id = v_org_id
      and (
        lower(trim(coalesce(v.display_name, ''))) = lower(v_supplier_name)
        or lower(trim(coalesce(v.company_name, ''))) = lower(v_supplier_name)
      )
  ) then
    raise exception 'Vendor was not found';
  end if;

  if v_purchase_company <> '' and not exists (
    select 1
    from public.company_profiles cp
    where cp.organization_id = v_org_id
      and lower(trim(cp.company_name)) = lower(v_purchase_company)
  ) then
    raise exception 'Purchase company was not found';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(v_lines) as line(value)
    where coalesce(nullif(line.value->>'qty', '')::numeric, 0) < 0
  ) then
    raise exception 'Purchase order line quantities cannot be negative';
  end if;

  select
    coalesce(count(*), 0)::integer,
    coalesce(round(sum(coalesce(
      nullif(line.value->>'line_total', '')::numeric,
      round(coalesce(nullif(line.value->>'buy_price', '')::numeric, 0) * coalesce(nullif(line.value->>'qty', '')::numeric, 0), 2)
    )), 2), 0)
    into v_line_count, v_total_amount
  from jsonb_array_elements(v_lines) as line(value);

  if v_total_amount < 0 then
    raise exception 'Purchase order total is invalid';
  end if;

  select *
    into v_existing
  from public.purchase_orders po
  where po.organization_id = v_org_id
    and po.id = v_order_id
  for update;

  if found then
    select
      (
        select count(*) from public.bills b
        where b.organization_id = v_org_id
          and b.purchase_order_id = v_order_id
      ) +
      (
        select count(*) from public.purchase_receives pr
        where pr.organization_id = v_org_id
          and pr.purchase_order_id = v_order_id
      ) +
      (
        select count(*) from public.inventory_movements im
        where im.organization_id = v_org_id
          and (im.document_id = v_order_id or im.document_no = v_order_id)
      )
      into v_downstream_count;

    if lower(coalesce(v_existing.status, 'draft')) in ('open', 'closed') and v_downstream_count > 0 then
      raise exception 'Purchase orders with downstream documents cannot be edited';
    end if;
  end if;

  if v_previous_id is not null and v_previous_id <> v_order_id then
    select *
      into v_previous
    from public.purchase_orders po
    where po.organization_id = v_org_id
      and po.id = v_previous_id
    for update;

    if not found then
      raise exception 'Previous purchase order was not found';
    end if;

    if lower(coalesce(v_previous.status, 'draft')) <> 'draft' then
      raise exception 'Posted purchase orders cannot be replaced by id change';
    end if;

    if exists (
      select 1 from public.bills b
      where b.organization_id = v_org_id
        and b.purchase_order_id = v_previous_id
      union all
      select 1 from public.purchase_receives pr
      where pr.organization_id = v_org_id
        and pr.purchase_order_id = v_previous_id
      union all
      select 1 from public.inventory_movements im
      where im.organization_id = v_org_id
        and (im.document_id = v_previous_id or im.document_no = v_previous_id)
    ) then
      raise exception 'Purchase order with downstream documents cannot be replaced';
    end if;

    delete from public.purchase_orders
     where organization_id = v_org_id
       and id = v_previous_id;
  end if;

  insert into public.purchase_orders (
    id,
    organization_id,
    supplier_name,
    supplier_key,
    purchase_company,
    sales_order_id,
    sales_order_no,
    customer_name,
    status,
    currency,
    total_amount,
    line_count,
    lines,
    created_at,
    updated_at
  )
  values (
    v_order_id,
    v_org_id,
    v_supplier_name,
    coalesce(nullif(payload->>'supplier_key', ''), regexp_replace(lower(coalesce(v_supplier_name, 'unassigned supplier')), '[^a-z0-9]+', '-', 'g')),
    v_purchase_company,
    v_sales_order.id,
    coalesce(nullif(payload->>'sales_order_no', ''), v_sales_order.sales_order_no),
    coalesce(nullif(payload->>'customer_name', ''), v_sales_order.customer_name),
    v_status,
    v_currency,
    v_total_amount,
    v_line_count,
    v_lines,
    coalesce(nullif(payload->>'created_at', '')::timestamptz, now()),
    now()
  )
  on conflict (id) do update
    set supplier_name = excluded.supplier_name,
        supplier_key = excluded.supplier_key,
        purchase_company = excluded.purchase_company,
        sales_order_id = excluded.sales_order_id,
        sales_order_no = excluded.sales_order_no,
        customer_name = excluded.customer_name,
        status = excluded.status,
        currency = excluded.currency,
        total_amount = excluded.total_amount,
        line_count = excluded.line_count,
        lines = excluded.lines,
        updated_at = now()
    where public.purchase_orders.organization_id = v_org_id
  returning * into v_order;

  if v_order.id is null or v_order.organization_id is distinct from v_org_id then
    raise exception 'Purchase order belongs to a different organization';
  end if;

  return jsonb_build_object('purchase_order', to_jsonb(v_order));
end;
$$;

create or replace function public.delete_purchase_order_guarded(id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_id uuid := public.current_profile_org_id();
  v_role text := public.current_profile_role();
  v_order public.purchase_orders%rowtype;
begin
  if v_org_id is null or (v_role not in ('admin', 'sales') and not public.is_superadmin()) then
    raise exception 'Only active staff users can delete purchase orders';
  end if;

  if nullif(trim(coalesce(delete_purchase_order_guarded.id, '')), '') is null then
    raise exception 'Purchase order id is required';
  end if;

  select *
    into v_order
  from public.purchase_orders po
  where po.organization_id = v_org_id
    and po.id = delete_purchase_order_guarded.id
  for update;

  if not found then
    raise exception 'Purchase order was not found';
  end if;

  if lower(coalesce(v_order.status, 'draft')) <> 'draft' then
    raise exception 'Posted purchase orders cannot be deleted';
  end if;

  if exists (
    select 1 from public.bills b
    where b.organization_id = v_org_id
      and b.purchase_order_id = v_order.id
    union all
    select 1 from public.purchase_receives pr
    where pr.organization_id = v_org_id
      and pr.purchase_order_id = v_order.id
    union all
    select 1 from public.inventory_movements im
    where im.organization_id = v_org_id
      and (im.document_id = v_order.id or im.document_no = v_order.id)
  ) then
    raise exception 'Purchase order has downstream documents and cannot be deleted';
  end if;

  delete from public.purchase_orders
   where organization_id = v_org_id
     and purchase_orders.id = v_order.id;

  return jsonb_build_object('deleted', true, 'purchase_order', to_jsonb(v_order));
end;
$$;

grant execute on function public.save_sales_order_atomic(jsonb, text) to authenticated, service_role;
grant execute on function public.delete_sales_order_guarded(text) to authenticated, service_role;
grant execute on function public.save_purchase_order_atomic(jsonb, text) to authenticated, service_role;
grant execute on function public.delete_purchase_order_guarded(text) to authenticated, service_role;
