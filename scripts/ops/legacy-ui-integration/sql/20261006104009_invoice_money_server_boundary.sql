-- Additive monetary boundary. No backfill, reporting rebuild, payment, stock
-- posting, or privilege expansion. Production deployment is a separate gate.
-- Exact existing RPC source retained; only authenticated authorization and
-- canonical input normalization are added before any document mutation.
do $$ begin
  if md5(pg_get_functiondef('public.save_invoice_atomic(jsonb,text)'::regprocedure)) <> 'a11651a154a25f334a75be4a9ccc0316'
    or md5(pg_get_functiondef('public.save_bill_atomic(jsonb,text)'::regprocedure)) <> 'e47304f9620a46ec8561d98d5c994ecf' then
    raise exception 'INVOICE_RPC_BASELINE_CHANGED_REVIEW_REQUIRED';
  end if;
end $$;
create schema if not exists invoice_money_private;
revoke all on schema invoice_money_private from public, anon, authenticated, service_role;

create function invoice_money_private.checked_number(value jsonb, kind text)
returns numeric language plpgsql immutable security invoker set search_path = '' as $$
declare n numeric; raw text; exponent_text text;
begin
  if jsonb_typeof(value) not in ('string','number') or value is null then
    raise exception 'Invoice % is required', kind;
  end if;
  raw := trim(value #>> '{}');
  if length(raw) > 128 or raw !~ '^[+-]?[0-9]+([.][0-9]+)?([eE][+-]?[0-9]+)?$' then
    raise exception 'Invoice % must be a finite decimal number', kind;
  end if;
  exponent_text := substring(raw from '[eE]([+-]?[0-9]+)$');
  if exponent_text is not null and abs(exponent_text::numeric) > 24 then
    raise exception 'Invoice decimal exponent is outside the supported range';
  end if;
  n := raw::numeric;
  if n::text in ('NaN','Infinity','-Infinity') or n < 0
    or n > (case when kind = 'quantity' then 1000000000 else 999999999999.99 end)
    or scale(trim_scale(n)) > (case when kind = 'quantity' then 6 else 12 end)
    or (kind = 'quantity' and n = 0) then
    raise exception 'Invoice % is outside the supported range or precision', kind;
  end if;
  return n;
end;
$$;
revoke all on function invoice_money_private.checked_number(jsonb,text) from public, anon, authenticated, service_role;

create function invoice_money_private.normalize_line(item jsonb, kind text, currency text)
returns jsonb language plpgsql immutable security invoker set search_path = '' as $$
declare qty numeric; buy numeric; sell numeric; purchase numeric(14,2); sales numeric(14,2); profit numeric(14,2);
begin
  if jsonb_typeof(item) is distinct from 'object' then raise exception 'Invoice line must be an object'; end if;
  qty := invoice_money_private.checked_number(item->'qty','quantity');
  buy := invoice_money_private.checked_number(item->'buy_price','price');
  if nullif(trim(item->>'currency'),'') is not null and upper(trim(item->>'currency')) <> currency then
    raise exception 'Invoice line currency does not match document currency';
  end if;
  purchase := round(qty * buy, 2);
  item := item || jsonb_build_object('qty',qty,'buy_price',buy);
  if kind = 'sales' then
    sell := invoice_money_private.checked_number(item->'sell_price','price');
    sales := round(qty * sell, 2);
    profit := sales - purchase;
    return item || jsonb_build_object('sell_price',sell,'purchase_total',purchase,
      'sales_total',sales,'profit_total',profit,
      'margin_percent',case when sales > 0 then round(profit / sales * 100, 2) else 0 end);
  end if;
  return item || jsonb_build_object('line_total',purchase);
end;
$$;
revoke all on function invoice_money_private.normalize_line(jsonb,text,text) from public, anon, authenticated, service_role;

create function invoice_money_private.normalize_document(input jsonb, kind text)
returns jsonb language plpgsql immutable security invoker set search_path = '' as $$
declare
  lines jsonb; currency text; result jsonb; subtotal numeric(14,2); purchase numeric(14,2);
  shipping numeric(14,2); discount numeric(14,2); total numeric(14,2); profit numeric(14,2);
begin
  if kind not in ('sales','purchase') or kind is null or jsonb_typeof(input) is distinct from 'object' then
    raise exception 'Invoice document is invalid';
  end if;
  lines := coalesce(input->'lines','[]'::jsonb);
  if jsonb_typeof(lines) is distinct from 'array' then raise exception 'Invoice lines must be an array'; end if;
  if jsonb_array_length(lines) > 10000 then raise exception 'Invoice has too many lines'; end if;
  currency := upper(trim(coalesce(nullif(input->>'currency',''),'EUR')));
  if currency !~ '^[A-Z]{3}$' then raise exception 'Invoice currency is invalid'; end if;
  shipping := round(invoice_money_private.checked_number(coalesce(nullif(input->'shipping_cost','null'::jsonb),'0'::jsonb),'shipping'),2);
  discount := round(invoice_money_private.checked_number(coalesce(nullif(input->'discount_amount','null'::jsonb),'0'::jsonb),'discount'),2);
  -- One ordered aggregation, not quadratic repeated JSON-array concatenation.
  select coalesce(jsonb_agg(invoice_money_private.normalize_line(value,kind,currency) order by ordinal),'[]'::jsonb)
    into lines from jsonb_array_elements(lines) with ordinality as source(value,ordinal);
  select coalesce(sum((line->>case when kind='sales' then 'sales_total' else 'line_total' end)::numeric),0),
    coalesce(sum((line->>case when kind='sales' then 'purchase_total' else 'line_total' end)::numeric),0)
    into subtotal,purchase from jsonb_array_elements(lines) as source(line);
  total := subtotal + shipping - discount;
  if total < 0 then raise exception 'Discount cannot exceed the invoice total'; end if;
  result := input || jsonb_build_object('lines',lines,'currency',currency,'shipping_cost',shipping,
    'discount_amount',discount,'subtotal',subtotal,'total_amount',total);
  if kind = 'sales' then
    profit := total - purchase;
    result := result || jsonb_build_object('purchase_total',purchase,'profit_total',profit,
      'margin_percent',case when total > 0 then round(profit / total * 100,2) else 0 end);
  end if;
  return result;
end;
$$;
revoke all on function invoice_money_private.normalize_document(jsonb,text) from public, anon, authenticated, service_role;

-- Trigger-only defense for other existing privileged writers; no client RPC.
create function invoice_money_private.guard_document()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if TG_TABLE_SCHEMA <> 'public' or TG_TABLE_NAME not in ('invoices','bills') then
    raise exception 'Invoice money trigger bound to invalid table';
  end if;
  NEW := jsonb_populate_record(NEW, invoice_money_private.normalize_document(to_jsonb(NEW),
    case when TG_TABLE_NAME='invoices' then 'sales' else 'purchase' end));
  return NEW;
end;
$$;
revoke all on function invoice_money_private.guard_document() from public, anon, authenticated, service_role;
create trigger trg_invoice_money_guard before insert or update of lines, currency,
  shipping_cost, discount_amount, subtotal, total_amount, purchase_total, profit_total, margin_percent
  on public.invoices for each row execute function invoice_money_private.guard_document();
create trigger trg_bill_money_guard before insert or update of lines, currency,
  shipping_cost, discount_amount, subtotal, total_amount
  on public.bills for each row execute function invoice_money_private.guard_document();

CREATE OR REPLACE FUNCTION public.save_invoice_atomic(payload jsonb, previous_id text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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
  if auth.uid() is null or v_org_id is null or (coalesce(v_role, '') <> 'admin' and not coalesce(public.is_superadmin(), false)) then
    raise exception 'Only active admin users can save invoices';
  end if;

  payload := invoice_money_private.normalize_document(payload, 'sales');
  v_lines := payload->'lines';

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

CREATE OR REPLACE FUNCTION public.save_bill_atomic(payload jsonb, previous_id text DEFAULT NULL::text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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
  if auth.uid() is null or v_org_id is null or (coalesce(v_role, '') <> 'admin' and not coalesce(public.is_superadmin(), false)) then
    raise exception 'Only active admin users can save bills';
  end if;

  payload := invoice_money_private.normalize_document(payload, 'purchase');
  v_lines := payload->'lines';

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
-- Existing RPC ACLs are deliberately unchanged by CREATE OR REPLACE.
