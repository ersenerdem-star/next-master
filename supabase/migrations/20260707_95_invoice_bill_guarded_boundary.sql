-- Invoices and bills are protected commercial documents. Save/delete now runs
-- behind org-scoped, role-scoped RPC boundaries.

drop function if exists public.save_invoice_atomic(jsonb, text);
drop function if exists public.delete_invoice_guarded(text);
drop function if exists public.save_bill_atomic(jsonb, text);
drop function if exists public.delete_bill_guarded(text);

create or replace function public.save_invoice_atomic(
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
  v_invoice_id text := nullif(trim(coalesce(payload->>'id', '')), '');
  v_previous_id text := nullif(trim(coalesce(previous_id, '')), '');
  v_sales_order_id text := nullif(trim(coalesce(payload->>'sales_order_id', '')), '');
  v_sales_order_ids text[];
  v_sales_order_count integer := 0;
  v_currency text := upper(trim(coalesce(nullif(payload->>'currency', ''), 'EUR')));
  v_status text := lower(trim(coalesce(nullif(payload->>'status', ''), 'draft')));
  v_lines jsonb := coalesce(payload->'lines', '[]'::jsonb);
  v_warehouse_id uuid;
  v_invoice public.invoices%rowtype;
  v_previous_invoice public.invoices%rowtype;
  v_payment_count integer := 0;
  v_subtotal numeric(14, 2) := 0;
  v_discount numeric(14, 2) := 0;
  v_shipping numeric(14, 2) := 0;
  v_total_amount numeric(14, 2) := 0;
  v_purchase_total numeric(14, 2) := 0;
  v_profit_total numeric(14, 2) := 0;
  v_margin_percent numeric(10, 2) := 0;
begin
  if v_org_id is null or (v_role <> 'admin' and not public.is_superadmin()) then
    raise exception 'Only active admin users can save invoices';
  end if;

  if v_invoice_id is null then
    raise exception 'Invoice id is required';
  end if;

  if v_status not in ('draft', 'confirmed', 'open', 'paid', 'void') then
    raise exception 'Invoice status is invalid';
  end if;

  if jsonb_typeof(v_lines) is distinct from 'array' then
    raise exception 'Invoice lines must be an array';
  end if;

  begin
    v_discount := coalesce(nullif(payload->>'discount_amount', '')::numeric, 0);
    v_shipping := coalesce(nullif(payload->>'shipping_cost', '')::numeric, 0);
  exception when invalid_text_representation then
    raise exception 'Invoice totals are invalid';
  end;

  if v_discount < 0 or v_shipping < 0 then
    raise exception 'Invoice discount and shipping cannot be negative';
  end if;

  begin
    v_warehouse_id := nullif(trim(coalesce(payload->>'warehouse_id', '')), '')::uuid;
  exception when invalid_text_representation then
    raise exception 'Invoice warehouse id is invalid';
  end;

  if v_warehouse_id is not null and not exists (
    select 1
    from public.warehouses w
    where w.organization_id = v_org_id
      and w.id = v_warehouse_id
  ) then
    raise exception 'Invoice warehouse was not found';
  end if;

  if jsonb_typeof(coalesce(payload->'sales_order_ids', '[]'::jsonb)) is distinct from 'array' then
    raise exception 'Invoice sales order ids must be an array';
  end if;

  select coalesce(array_agg(distinct sales_order_id), '{}'::text[])
    into v_sales_order_ids
  from (
    select nullif(trim(value), '') as sales_order_id
    from jsonb_array_elements_text(coalesce(payload->'sales_order_ids', '[]'::jsonb)) as ids(value)
    union all
    select v_sales_order_id
  ) input_ids
  where sales_order_id is not null;

  if coalesce(array_length(v_sales_order_ids, 1), 0) = 0 then
    raise exception 'Linked sales order is required';
  end if;

  v_sales_order_id := coalesce(v_sales_order_id, v_sales_order_ids[1]);

  select count(*)::integer
    into v_sales_order_count
  from public.sales_orders so
  where so.organization_id = v_org_id
    and so.id = any(v_sales_order_ids);

  if v_sales_order_count <> array_length(v_sales_order_ids, 1) then
    raise exception 'Linked sales order was not found';
  end if;

  if exists (
    select 1
    from public.sales_orders so
    where so.organization_id = v_org_id
      and so.id = any(v_sales_order_ids)
      and upper(trim(coalesce(so.currency, 'EUR'))) <> v_currency
  ) then
    raise exception 'Invoice currency must match linked sales order currency';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(v_lines) as line(value)
    where coalesce(nullif(line.value->>'qty', '')::numeric, 0) < 0
  ) then
    raise exception 'Invoice line quantities cannot be negative';
  end if;

  select
    coalesce(round(sum(coalesce(
      nullif(line.value->>'sales_total', '')::numeric,
      round(coalesce(nullif(line.value->>'sell_price', '')::numeric, 0) * coalesce(nullif(line.value->>'qty', '')::numeric, 0), 2)
    )), 2), 0),
    coalesce(round(sum(coalesce(
      nullif(line.value->>'purchase_total', '')::numeric,
      round(coalesce(nullif(line.value->>'buy_price', '')::numeric, 0) * coalesce(nullif(line.value->>'qty', '')::numeric, 0), 2)
    )), 2), 0)
    into v_subtotal, v_purchase_total
  from jsonb_array_elements(v_lines) as line(value);

  v_total_amount := round(v_subtotal - v_discount + v_shipping, 2);
  v_profit_total := round(v_total_amount - v_purchase_total, 2);
  v_margin_percent := case when v_total_amount > 0 then round((v_profit_total / v_total_amount) * 100, 2) else 0 end;

  if v_subtotal < 0 or v_purchase_total < 0 or v_total_amount < 0 then
    raise exception 'Invoice totals are invalid';
  end if;

  if v_previous_id is not null and v_previous_id <> v_invoice_id then
    select *
      into v_previous_invoice
    from public.invoices i
    where i.organization_id = v_org_id
      and i.id = v_previous_id
    for update;

    if not found then
      raise exception 'Previous invoice was not found';
    end if;

    if lower(coalesce(v_previous_invoice.status, 'draft')) not in ('draft', 'void') then
      raise exception 'Posted invoices cannot be replaced by id change';
    end if;

    select count(*)::integer
      into v_payment_count
    from public.payments_received pr
    where pr.organization_id = v_org_id
      and pr.invoice_id = v_previous_id;

    if v_payment_count > 0 then
      raise exception 'Delete linked payments first, then replace the invoice id';
    end if;

    delete from public.invoices
     where organization_id = v_org_id
       and id = v_previous_id;
  end if;

  insert into public.invoices (
    id,
    organization_id,
    sales_order_id,
    sales_order_ids,
    warehouse_id,
    warehouse_code,
    warehouse_name,
    sales_order_no,
    customer_name,
    seller_company,
    purchase_company,
    currency,
    status,
    quote_date,
    delivery_term,
    payment_terms,
    due_date,
    contract_nr,
    packing_details,
    notes,
    subtotal,
    discount_amount,
    shipping_cost,
    total_amount,
    purchase_total,
    profit_total,
    margin_percent,
    created_at,
    updated_at,
    lines
  )
  values (
    v_invoice_id,
    v_org_id,
    v_sales_order_id,
    v_sales_order_ids,
    v_warehouse_id,
    coalesce(payload->>'warehouse_code', ''),
    coalesce(payload->>'warehouse_name', ''),
    coalesce(payload->>'sales_order_no', ''),
    coalesce(payload->>'customer_name', ''),
    coalesce(payload->>'seller_company', ''),
    coalesce(payload->>'purchase_company', ''),
    v_currency,
    v_status,
    coalesce(payload->>'quote_date', ''),
    coalesce(payload->>'delivery_term', ''),
    coalesce(payload->>'payment_terms', ''),
    coalesce(payload->>'due_date', ''),
    coalesce(payload->>'contract_nr', ''),
    coalesce(payload->>'packing_details', ''),
    coalesce(payload->>'notes', ''),
    v_subtotal,
    v_discount,
    v_shipping,
    v_total_amount,
    v_purchase_total,
    v_profit_total,
    v_margin_percent,
    coalesce(nullif(payload->>'created_at', '')::timestamptz, now()),
    now(),
    v_lines
  )
  on conflict (id) do update
    set sales_order_id = excluded.sales_order_id,
        sales_order_ids = excluded.sales_order_ids,
        warehouse_id = excluded.warehouse_id,
        warehouse_code = excluded.warehouse_code,
        warehouse_name = excluded.warehouse_name,
        sales_order_no = excluded.sales_order_no,
        customer_name = excluded.customer_name,
        seller_company = excluded.seller_company,
        purchase_company = excluded.purchase_company,
        currency = excluded.currency,
        status = excluded.status,
        quote_date = excluded.quote_date,
        delivery_term = excluded.delivery_term,
        payment_terms = excluded.payment_terms,
        due_date = excluded.due_date,
        contract_nr = excluded.contract_nr,
        packing_details = excluded.packing_details,
        notes = excluded.notes,
        subtotal = excluded.subtotal,
        discount_amount = excluded.discount_amount,
        shipping_cost = excluded.shipping_cost,
        total_amount = excluded.total_amount,
        purchase_total = excluded.purchase_total,
        profit_total = excluded.profit_total,
        margin_percent = excluded.margin_percent,
        updated_at = now(),
        lines = excluded.lines
    where public.invoices.organization_id = v_org_id
  returning * into v_invoice;

  if v_invoice.id is null or v_invoice.organization_id is distinct from v_org_id then
    raise exception 'Invoice belongs to a different organization';
  end if;

  perform public.recalculate_invoice_paid_status_for_org(v_org_id, v_invoice.id);

  select *
    into v_invoice
  from public.invoices i
  where i.organization_id = v_org_id
    and i.id = v_invoice_id;

  return jsonb_build_object('invoice', to_jsonb(v_invoice));
end;
$$;

create or replace function public.delete_invoice_guarded(id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_id uuid := public.current_profile_org_id();
  v_role text := public.current_profile_role();
  v_invoice public.invoices%rowtype;
  v_payment_count integer := 0;
begin
  if v_org_id is null or (v_role <> 'admin' and not public.is_superadmin()) then
    raise exception 'Only active admin users can delete invoices';
  end if;

  if nullif(trim(coalesce(delete_invoice_guarded.id, '')), '') is null then
    raise exception 'Invoice id is required';
  end if;

  select *
    into v_invoice
  from public.invoices i
  where i.organization_id = v_org_id
    and i.id = delete_invoice_guarded.id
  for update;

  if not found then
    raise exception 'Invoice was not found';
  end if;

  if lower(coalesce(v_invoice.status, 'draft')) not in ('draft', 'void') then
    raise exception 'Posted invoices cannot be deleted';
  end if;

  select count(*)::integer
    into v_payment_count
  from public.payments_received pr
  where pr.organization_id = v_org_id
    and pr.invoice_id = v_invoice.id;

  if v_payment_count > 0 then
    raise exception 'Delete linked payments first, then delete the invoice';
  end if;

  delete from public.invoices
   where organization_id = v_org_id
     and invoices.id = v_invoice.id;

  return jsonb_build_object(
    'deleted', true,
    'invoice', to_jsonb(v_invoice)
  );
end;
$$;

create or replace function public.save_bill_atomic(
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
  v_bill_id text := nullif(trim(coalesce(payload->>'id', '')), '');
  v_previous_id text := nullif(trim(coalesce(previous_id, '')), '');
  v_purchase_order_id text := nullif(trim(coalesce(payload->>'purchase_order_id', '')), '');
  v_currency text := upper(trim(coalesce(nullif(payload->>'currency', ''), 'EUR')));
  v_status text := lower(trim(coalesce(nullif(payload->>'status', ''), 'draft')));
  v_lines jsonb := coalesce(payload->'lines', '[]'::jsonb);
  v_bill public.bills%rowtype;
  v_previous_bill public.bills%rowtype;
  v_payment_count integer := 0;
  v_subtotal numeric(14, 2) := 0;
  v_discount numeric(14, 2) := 0;
  v_shipping numeric(14, 2) := 0;
  v_total_amount numeric(14, 2) := 0;
begin
  if v_org_id is null or (v_role <> 'admin' and not public.is_superadmin()) then
    raise exception 'Only active admin users can save bills';
  end if;

  if v_bill_id is null then
    raise exception 'Bill id is required';
  end if;

  if v_purchase_order_id is null then
    raise exception 'Linked purchase order is required';
  end if;

  if v_status not in ('draft', 'confirmed', 'paid', 'void') then
    raise exception 'Bill status is invalid';
  end if;

  if jsonb_typeof(v_lines) is distinct from 'array' then
    raise exception 'Bill lines must be an array';
  end if;

  begin
    v_discount := coalesce(nullif(payload->>'discount_amount', '')::numeric, 0);
    v_shipping := coalesce(nullif(payload->>'shipping_cost', '')::numeric, 0);
  exception when invalid_text_representation then
    raise exception 'Bill totals are invalid';
  end;

  if v_discount < 0 or v_shipping < 0 then
    raise exception 'Bill discount and shipping cannot be negative';
  end if;

  if not exists (
    select 1
    from public.purchase_orders po
    where po.organization_id = v_org_id
      and po.id = v_purchase_order_id
  ) then
    raise exception 'Linked purchase order was not found';
  end if;

  if exists (
    select 1
    from public.purchase_orders po
    where po.organization_id = v_org_id
      and po.id = v_purchase_order_id
      and upper(trim(coalesce(po.currency, 'EUR'))) <> v_currency
  ) then
    raise exception 'Bill currency must match linked purchase order currency';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(v_lines) as line(value)
    where coalesce(nullif(line.value->>'qty', '')::numeric, 0) < 0
  ) then
    raise exception 'Bill line quantities cannot be negative';
  end if;

  select coalesce(round(sum(coalesce(
      nullif(line.value->>'line_total', '')::numeric,
      round(coalesce(nullif(line.value->>'buy_price', '')::numeric, 0) * coalesce(nullif(line.value->>'qty', '')::numeric, 0), 2)
    )), 2), 0)
    into v_subtotal
  from jsonb_array_elements(v_lines) as line(value);

  v_total_amount := round(v_subtotal - v_discount + v_shipping, 2);

  if v_subtotal < 0 or v_total_amount < 0 then
    raise exception 'Bill totals are invalid';
  end if;

  if v_previous_id is not null and v_previous_id <> v_bill_id then
    select *
      into v_previous_bill
    from public.bills b
    where b.organization_id = v_org_id
      and b.id = v_previous_id
    for update;

    if not found then
      raise exception 'Previous bill was not found';
    end if;

    if lower(coalesce(v_previous_bill.status, 'draft')) not in ('draft', 'void') then
      raise exception 'Posted bills cannot be replaced by id change';
    end if;

    select count(*)::integer
      into v_payment_count
    from public.payments_made pm
    where pm.organization_id = v_org_id
      and pm.bill_id = v_previous_id;

    if v_payment_count > 0 then
      raise exception 'Delete linked payments first, then replace the bill id';
    end if;

    delete from public.bills
     where organization_id = v_org_id
       and id = v_previous_id;
  end if;

  insert into public.bills (
    id,
    organization_id,
    purchase_order_id,
    purchase_order_no,
    supplier_name,
    purchase_company,
    currency,
    status,
    bill_date,
    due_date,
    payment_terms,
    notes,
    subtotal,
    shipping_cost,
    discount_amount,
    total_amount,
    created_at,
    updated_at,
    lines
  )
  values (
    v_bill_id,
    v_org_id,
    v_purchase_order_id,
    coalesce(payload->>'purchase_order_no', ''),
    coalesce(payload->>'supplier_name', ''),
    coalesce(payload->>'purchase_company', ''),
    v_currency,
    v_status,
    coalesce(payload->>'bill_date', ''),
    coalesce(payload->>'due_date', ''),
    coalesce(payload->>'payment_terms', ''),
    coalesce(payload->>'notes', ''),
    v_subtotal,
    v_shipping,
    v_discount,
    v_total_amount,
    coalesce(nullif(payload->>'created_at', '')::timestamptz, now()),
    now(),
    v_lines
  )
  on conflict (id) do update
    set purchase_order_id = excluded.purchase_order_id,
        purchase_order_no = excluded.purchase_order_no,
        supplier_name = excluded.supplier_name,
        purchase_company = excluded.purchase_company,
        currency = excluded.currency,
        status = excluded.status,
        bill_date = excluded.bill_date,
        due_date = excluded.due_date,
        payment_terms = excluded.payment_terms,
        notes = excluded.notes,
        subtotal = excluded.subtotal,
        shipping_cost = excluded.shipping_cost,
        discount_amount = excluded.discount_amount,
        total_amount = excluded.total_amount,
        updated_at = now(),
        lines = excluded.lines
    where public.bills.organization_id = v_org_id
  returning * into v_bill;

  if v_bill.id is null or v_bill.organization_id is distinct from v_org_id then
    raise exception 'Bill belongs to a different organization';
  end if;

  perform public.recalculate_bill_paid_status_for_org(v_org_id, v_bill.id);

  select *
    into v_bill
  from public.bills b
  where b.organization_id = v_org_id
    and b.id = v_bill_id;

  return jsonb_build_object('bill', to_jsonb(v_bill));
end;
$$;

create or replace function public.delete_bill_guarded(id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_id uuid := public.current_profile_org_id();
  v_role text := public.current_profile_role();
  v_bill public.bills%rowtype;
  v_payment_count integer := 0;
begin
  if v_org_id is null or (v_role <> 'admin' and not public.is_superadmin()) then
    raise exception 'Only active admin users can delete bills';
  end if;

  if nullif(trim(coalesce(delete_bill_guarded.id, '')), '') is null then
    raise exception 'Bill id is required';
  end if;

  select *
    into v_bill
  from public.bills b
  where b.organization_id = v_org_id
    and b.id = delete_bill_guarded.id
  for update;

  if not found then
    raise exception 'Bill was not found';
  end if;

  if lower(coalesce(v_bill.status, 'draft')) not in ('draft', 'void') then
    raise exception 'Posted bills cannot be deleted';
  end if;

  select count(*)::integer
    into v_payment_count
  from public.payments_made pm
  where pm.organization_id = v_org_id
    and pm.bill_id = v_bill.id;

  if v_payment_count > 0 then
    raise exception 'Delete linked payments first, then delete the bill';
  end if;

  delete from public.bills
   where organization_id = v_org_id
     and bills.id = v_bill.id;

  return jsonb_build_object(
    'deleted', true,
    'bill', to_jsonb(v_bill)
  );
end;
$$;

grant execute on function public.save_invoice_atomic(jsonb, text) to authenticated, service_role;
grant execute on function public.delete_invoice_guarded(text) to authenticated, service_role;
grant execute on function public.save_bill_atomic(jsonb, text) to authenticated, service_role;
grant execute on function public.delete_bill_guarded(text) to authenticated, service_role;
