-- Additive release. Apply only after full schema compatibility/E2E gates.
-- No bulk rewrite of existing documents or supplier-price publication.
create schema if not exists order_commit_private;
revoke all on schema order_commit_private from public, anon, authenticated;

create table order_commit_private.confirmation_receipts (
  organization_id uuid not null references public.organizations(id),
  decision_id uuid not null,
  order_id text not null,
  request_payload jsonb not null,
  actor_id uuid not null,
  receipt jsonb not null,
  created_at timestamptz not null default now(),
  primary key (organization_id, decision_id)
);
alter table order_commit_private.confirmation_receipts enable row level security;
create policy deny_direct_access on order_commit_private.confirmation_receipts
  for all to public using (false) with check (false);
revoke all on order_commit_private.confirmation_receipts from public, anon, authenticated, service_role;

create function order_commit_private.normalize_lines(input_lines jsonb, kind text, priced boolean, order_currency text)
returns jsonb language plpgsql immutable security invoker set search_path = '' as $$
declare
  item jsonb; result jsonb := '[]'; qty numeric; buy numeric; sell numeric;
begin
  if jsonb_typeof(input_lines) is distinct from 'array' or jsonb_array_length(input_lines) > 10000
    or (priced and jsonb_array_length(input_lines) = 0) then
    raise exception 'Order must contain valid lines';
  end if;
  if order_currency !~ '^[A-Z]{3}$' then raise exception 'Order currency is invalid'; end if;
  for item in select value from jsonb_array_elements(input_lines) loop
    if jsonb_typeof(item) is distinct from 'object' then raise exception 'Order line is invalid'; end if;
    qty := nullif(item->>'qty', '')::numeric;
    buy := nullif(item->>'buy_price', '')::numeric;
    sell := nullif(item->>'sell_price', '')::numeric;
    if qty is null or qty <= 0 or qty > 1000000000 or qty::text in ('NaN','Infinity','-Infinity')
      or scale(trim_scale(qty)) > 6 then raise exception 'Quantity must be positive and within the supported range'; end if;
    if (buy is not null and (buy < 0 or buy > 999999999999.99 or buy::text in ('NaN','Infinity','-Infinity') or scale(trim_scale(buy)) > 12))
      or (sell is not null and (sell < 0 or sell > 999999999999.99 or sell::text in ('NaN','Infinity','-Infinity') or scale(trim_scale(sell)) > 12)) then
      raise exception 'Order price is invalid';
    end if;
    if priced and (buy is null or buy <= 0 or (kind = 'sales' and (sell is null or sell <= 0))) then
      raise exception 'A positive price is required before confirming the order';
    end if;
    if nullif(item->>'currency', '') is not null and upper(item->>'currency') <> order_currency then
      raise exception 'Order line currency does not match order currency';
    end if;
    item := item || jsonb_build_object('qty', qty, 'buy_price', buy);
    if kind = 'sales' then
      item := item || jsonb_build_object('sell_price', sell);
    else
      -- Ignore untrusted client line_total; derive from full-precision unit.
      item := item || jsonb_build_object('line_total', case when buy is null then null else round(buy * qty, 2) end);
    end if;
    result := result || jsonb_build_array(item);
  end loop;
  return result;
end;
$$;
revoke all on function order_commit_private.normalize_lines(jsonb,text,boolean,text) from public, anon, authenticated, service_role;

create or replace function order_commit_private.save_sales_order(
  payload jsonb,
  previous_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
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
  v_shipping numeric := 0;
  v_discount numeric := 0;
  v_purchase_total numeric(14, 2) := 0;
  v_subtotal numeric(14, 2) := 0;
  v_sales_total numeric(14, 2) := 0;
  v_profit_total numeric(14, 2) := 0;
  v_margin_percent numeric(10, 2) := 0;
  v_confirmed_at timestamptz;
  v_lock_id text;
begin
  if auth.uid() is null or v_org_id is null or (coalesce(v_role, '') not in ('admin', 'sales') and not coalesce(public.is_superadmin(), false)) then
    raise exception 'Only active staff users can save sales orders';
  end if;

  if v_order_id is null then
    raise exception 'Sales order id is required';
  end if;

  -- Serialize even absent roots: a stale draft must not upsert over a new
  -- confirmation. ID replacement locks both identities in a stable order.
  for v_lock_id in select distinct value from unnest(array[v_order_id, v_previous_id]) as ids(value)
    where value is not null order by value
  loop
    perform pg_advisory_xact_lock(hashtextextended(v_org_id::text || ':sales:' || v_lock_id, 0));
  end loop;

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

  if v_shipping < 0 or v_discount < 0 or v_shipping::text in ('NaN','Infinity','-Infinity') or v_discount::text in ('NaN','Infinity','-Infinity') then
    raise exception 'Sales order shipping and discount cannot be negative';
  end if;
  if v_shipping > 999999999999.99 or v_discount > 999999999999.99
    or scale(trim_scale(v_shipping)) > 12 or scale(trim_scale(v_discount)) > 12 then
    raise exception 'Sales order totals are invalid';
  end if;
  v_shipping := round(v_shipping, 2);
  v_discount := round(v_discount, 2);

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

  v_lines := order_commit_private.normalize_lines(v_lines, 'sales', v_status <> 'draft', v_currency);

  select
    coalesce(sum(round(coalesce(nullif(line.value->>'buy_price', '')::numeric, 0) * coalesce(nullif(line.value->>'qty', '')::numeric, 0), 2)), 0),
    coalesce(sum(round(coalesce(nullif(line.value->>'sell_price', '')::numeric, 0) * coalesce(nullif(line.value->>'qty', '')::numeric, 0), 2)), 0)
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

create or replace function public.save_purchase_order_atomic(
  payload jsonb,
  previous_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
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
  if auth.uid() is null or v_org_id is null or (coalesce(v_role, '') not in ('admin', 'sales') and not coalesce(public.is_superadmin(), false)) then
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

  v_lines := order_commit_private.normalize_lines(v_lines, 'purchase', v_status <> 'draft', v_currency);

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

create function public.confirm_sales_order_with_purchases_atomic(payload jsonb, decision_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := public.current_profile_org_id();
  v_actor uuid := auth.uid();
  v_role text := public.current_profile_role();
  v_id text := nullif(trim(payload->>'id'), '');
  v_request jsonb := payload - 'updated_at' - 'created_at' - 'confirmed_at' - 'organization_id';
  v_receipt order_commit_private.confirmation_receipts%rowtype;
  v_existing public.sales_orders%rowtype;
  v_sales jsonb; v_po jsonb; v_orders jsonb := '[]'; v_result jsonb; vendor record;
begin
  if v_actor is null or v_org is null or (coalesce(v_role, '') not in ('admin','sales') and not coalesce(public.is_superadmin(),false)) then
    raise exception 'Staff access required';
  end if;
  if decision_id is null or v_id is null or length(v_id) > 180 or payload->>'status' is distinct from 'confirmed' then
    raise exception 'Confirmation identity and confirmed status are required';
  end if;
  -- Consistent order: decision lock, Sales root, then derived Purchase roots.
  perform pg_advisory_xact_lock(hashtextextended(v_org::text || ':decision:' || decision_id::text,0));
  perform pg_advisory_xact_lock(hashtextextended(v_org::text || ':sales:' || v_id,0));
  select * into v_receipt from order_commit_private.confirmation_receipts cr
    where cr.organization_id=v_org and cr.decision_id=confirm_sales_order_with_purchases_atomic.decision_id;
  if found then
    if v_receipt.actor_id <> v_actor or v_receipt.order_id <> v_id or v_receipt.request_payload <> v_request then
      raise exception 'Confirmation decision does not match the original request';
    end if;
    return v_receipt.receipt || jsonb_build_object('replayed',true);
  end if;
  select * into v_existing from public.sales_orders so where so.id=v_id and so.organization_id=v_org for update;
  if found and v_existing.status <> 'draft' then
    raise exception 'Order is already confirmed. Reload its status before confirming again';
  end if;
  -- Never delete/rebuild historical POs or downstream documents on a retry.
  if exists (select 1 from public.purchase_orders po where po.organization_id=v_org and po.sales_order_id=v_id)
    or exists (select 1 from public.invoices i where i.organization_id=v_org and (i.sales_order_id=v_id or v_id=any(coalesce(i.sales_order_ids,'{}'::text[])))) then
    raise exception 'Order already has downstream documents. Review them before confirmation';
  end if;
  v_sales := order_commit_private.save_sales_order(payload,null)->'sales_order';
  for vendor in
    select lower(trim(coalesce(l.value->>'supplier_name',''))) as supplier_key,
      min(trim(coalesce(l.value->>'supplier_name',''))) as supplier_name,
      jsonb_agg(jsonb_build_object(
        'sales_order_id',v_id,'sales_order_no',v_sales->>'sales_order_no',
        'product_code',l.value->>'resolvedCode',
        'old_code',case when coalesce((l.value->>'codeChanged')::boolean,false) then l.value->>'requestedCode' else '' end,
        'brand',l.value->>'brand','description',l.value->>'description','qty',l.value->'qty',
        'oem_no',l.value->>'oem_no','hs_code',coalesce(l.value->>'hs_code',''),
        'weight_kg',l.value->'weight_kg','origin',l.value->>'origin','notes',l.value->>'notes',
        'supplier_name',trim(l.value->>'supplier_name'),'buy_price',l.value->'buy_price'
      ) order by l.ordinality) as lines
    from jsonb_array_elements(v_sales->'lines') with ordinality as l(value,ordinality)
    group by lower(trim(coalesce(l.value->>'supplier_name','')))
    order by lower(trim(coalesce(l.value->>'supplier_name','')))
  loop
    if vendor.supplier_key in ('','unassigned supplier') then raise exception 'Select a supplier before confirming the order'; end if;
    v_po := public.save_purchase_order_atomic(jsonb_build_object(
      'id','po-' || v_id || '-' || md5(vendor.supplier_key), 'supplier_name',vendor.supplier_name,
      'supplier_key',vendor.supplier_key,'sales_order_id',v_id,'sales_order_no',v_sales->>'sales_order_no',
      'customer_name',v_sales->>'customer_name','purchase_company',v_sales->>'purchase_company',
      'currency',v_sales->>'currency','status','draft','lines',vendor.lines
    ),null)->'purchase_order';
    v_orders := v_orders || jsonb_build_array(v_po);
  end loop;
  v_result := jsonb_build_object('sales_order',v_sales,'purchase_orders',v_orders,'replayed',false);
  insert into order_commit_private.confirmation_receipts(organization_id,decision_id,order_id,actor_id,request_payload,receipt)
    values (v_org,decision_id,v_id,v_actor,v_request,v_result);
  return v_result;
end;
$$;
revoke all on function public.confirm_sales_order_with_purchases_atomic(jsonb,uuid) from public,anon,authenticated,service_role;
grant execute on function public.confirm_sales_order_with_purchases_atomic(jsonb,uuid) to authenticated,service_role;
revoke all on function order_commit_private.save_sales_order(jsonb,text) from public,anon,authenticated,service_role;

create or replace function public.save_sales_order_atomic(payload jsonb, previous_id text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  -- A new confirmation cannot bypass the atomic SO + PO boundary.
  if lower(coalesce(payload->>'status','draft')) = 'confirmed' and not exists (
    select 1 from public.sales_orders so where so.organization_id=public.current_profile_org_id()
      and so.id=payload->>'id' and so.status='confirmed'
  ) then
    raise exception 'Use atomic sales and purchase confirmation';
  end if;
  return order_commit_private.save_sales_order(payload,previous_id);
end;
$$;
revoke all on function public.save_sales_order_atomic(jsonb,text) from public,anon;
revoke all on function public.save_purchase_order_atomic(jsonb,text) from public,anon;
grant execute on function public.save_sales_order_atomic(jsonb,text) to authenticated,service_role;
grant execute on function public.save_purchase_order_atomic(jsonb,text) to authenticated,service_role;
