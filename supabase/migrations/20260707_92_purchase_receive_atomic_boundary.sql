-- Purchase receive must be one commercial event: receive document, stock
-- movement, and purchase-order receive state commit or roll back together.

drop function if exists public.post_purchase_receive_atomic(jsonb);

create or replace function public.post_purchase_receive_atomic(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_id uuid;
  v_role text;
  v_purchase_order_id text := nullif(trim(coalesce(payload->>'purchase_order_id', '')), '');
  v_warehouse_id uuid;
  v_received_date date := coalesce(nullif(trim(coalesce(payload->>'received_date', '')), '')::date, current_date);
  v_notes text := coalesce(payload->>'notes', '');
  v_order public.purchase_orders%rowtype;
  v_warehouse public.warehouses%rowtype;
  v_receive public.purchase_receives%rowtype;
  v_total_qty numeric(14, 2) := 0;
  v_total_amount numeric(14, 2) := 0;
  v_movement_count integer := 0;
  v_fully_received boolean := false;
  v_line_count integer := 0;
begin
  v_org_id := public.current_profile_org_id();
  v_role := public.current_profile_role();

  if v_org_id is null or (v_role <> 'admin' and not public.is_superadmin()) then
    raise exception 'Only active admin users can post purchase receives';
  end if;

  if v_purchase_order_id is null then
    raise exception 'Purchase order is required';
  end if;

  if nullif(trim(coalesce(payload->>'warehouse_id', '')), '') is null then
    raise exception 'Warehouse is required';
  end if;

  begin
    v_warehouse_id := nullif(trim(coalesce(payload->>'warehouse_id', '')), '')::uuid;
  exception when invalid_text_representation then
    raise exception 'Warehouse id is invalid';
  end;

  select *
    into v_order
  from public.purchase_orders po
  where po.organization_id = v_org_id
    and po.id = v_purchase_order_id
  for update;

  if not found then
    raise exception 'Purchase order was not found';
  end if;

  select *
    into v_warehouse
  from public.warehouses w
  where w.organization_id = v_org_id
    and w.id = v_warehouse_id
  for update;

  if not found then
    raise exception 'Warehouse was not found';
  end if;

  if coalesce(v_warehouse.is_active, false) is not true then
    raise exception 'Warehouse is not active';
  end if;

  if lower(coalesce(v_warehouse.fulfillment_model, 'stocked')) <> 'stocked' then
    raise exception 'Dropship warehouses do not accept stock receives. Use a stocked warehouse.';
  end if;

  create temporary table tmp_purchase_receive_input (
    line_index integer,
    product_code text,
    old_code text,
    brand text,
    description text,
    qty_received numeric,
    unit_cost numeric,
    origin text,
    notes text,
    line_key text
  ) on commit drop;

  insert into tmp_purchase_receive_input (
    line_index,
    product_code,
    old_code,
    brand,
    description,
    qty_received,
    unit_cost,
    origin,
    notes,
    line_key
  )
  select
    row_number() over ()::integer,
    coalesce(line.product_code, ''),
    coalesce(line.old_code, ''),
    coalesce(line.brand, ''),
    coalesce(line.description, ''),
    coalesce(line.qty_received, 0),
    coalesce(line.unit_cost, 0),
    coalesce(line.origin, ''),
    coalesce(line.notes, ''),
    lower(trim(coalesce(line.brand, ''))) || '::' ||
      public.normalize_part_code(coalesce(line.product_code, '')) || '::' ||
      public.normalize_part_code(coalesce(line.old_code, ''))
  from jsonb_to_recordset(
    case
      when jsonb_typeof(coalesce(payload->'lines', '[]'::jsonb)) = 'array'
        then coalesce(payload->'lines', '[]'::jsonb)
      else '[]'::jsonb
    end
  ) as line(
    product_code text,
    old_code text,
    brand text,
    description text,
    qty_received numeric,
    unit_cost numeric,
    origin text,
    notes text
  );

  if exists (select 1 from tmp_purchase_receive_input where qty_received < 0) then
    raise exception 'Received quantity cannot be negative';
  end if;

  delete from tmp_purchase_receive_input where coalesce(qty_received, 0) = 0;

  select count(*)::integer
    into v_line_count
  from tmp_purchase_receive_input;

  if v_line_count <= 0 then
    raise exception 'Enter at least one received quantity';
  end if;

  if exists (select 1 from tmp_purchase_receive_input where qty_received <= 0) then
    raise exception 'Received quantity must be greater than zero';
  end if;

  create temporary table tmp_purchase_order_lines on commit drop as
  select
    line.ordinality::integer as line_index,
    line.value as line_json,
    lower(trim(coalesce(line.value->>'brand', ''))) || '::' ||
      public.normalize_part_code(coalesce(line.value->>'product_code', '')) || '::' ||
      public.normalize_part_code(coalesce(line.value->>'old_code', '')) as line_key,
    coalesce(nullif(line.value->>'qty', ''), '0')::numeric as qty_ordered
  from jsonb_array_elements(
    case
      when jsonb_typeof(coalesce(v_order.lines, '[]'::jsonb)) = 'array'
        then coalesce(v_order.lines, '[]'::jsonb)
      else '[]'::jsonb
    end
  ) with ordinality as line(value, ordinality);

  create temporary table tmp_ordered_by_key on commit drop as
  select
    line_key,
    sum(qty_ordered) as qty_ordered
  from tmp_purchase_order_lines
  group by line_key;

  create temporary table tmp_existing_received_by_key on commit drop as
  select
    lower(trim(coalesce(line.value->>'brand', ''))) || '::' ||
      public.normalize_part_code(coalesce(line.value->>'product_code', '')) || '::' ||
      public.normalize_part_code(coalesce(line.value->>'old_code', '')) as line_key,
    sum(coalesce(nullif(line.value->>'qty_received', ''), '0')::numeric) as qty_received
  from public.purchase_receives pr
  cross join lateral jsonb_array_elements(
    case
      when jsonb_typeof(coalesce(pr.lines, '[]'::jsonb)) = 'array'
        then coalesce(pr.lines, '[]'::jsonb)
      else '[]'::jsonb
    end
  ) as line(value)
  where pr.organization_id = v_org_id
    and pr.purchase_order_id = v_order.id
    and pr.status = 'posted'
  group by 1;

  create temporary table tmp_requested_by_key on commit drop as
  select
    line_key,
    sum(qty_received) as qty_received
  from tmp_purchase_receive_input
  group by line_key;

  if exists (
    select 1
    from tmp_requested_by_key requested
    left join tmp_ordered_by_key ordered on ordered.line_key = requested.line_key
    where ordered.line_key is null
  ) then
    raise exception 'Receive line does not belong to the purchase order';
  end if;

  if exists (
    select 1
    from tmp_requested_by_key requested
    join tmp_ordered_by_key ordered on ordered.line_key = requested.line_key
    left join tmp_existing_received_by_key existing on existing.line_key = requested.line_key
    where requested.qty_received > greatest(ordered.qty_ordered - coalesce(existing.qty_received, 0), 0) + 0.000001
  ) then
    raise exception 'Received quantity exceeds remaining purchase order quantity';
  end if;

  select
    round(coalesce(sum(qty_received), 0)::numeric, 2),
    round(coalesce(sum(qty_received * unit_cost), 0)::numeric, 2)
    into v_total_qty, v_total_amount
  from tmp_purchase_receive_input;

  insert into public.purchase_receives (
    organization_id,
    purchase_order_id,
    purchase_order_no,
    supplier_name,
    warehouse_id,
    warehouse_code,
    warehouse_name,
    status,
    received_date,
    notes,
    total_qty,
    total_amount,
    lines,
    created_at,
    updated_at
  )
  select
    v_org_id,
    v_order.id,
    v_order.id,
    v_order.supplier_name,
    v_warehouse.id,
    v_warehouse.warehouse_code,
    v_warehouse.warehouse_name,
    'posted',
    v_received_date,
    v_notes,
    v_total_qty,
    v_total_amount,
    coalesce(
      jsonb_agg(
        jsonb_build_object(
          'product_code', input.product_code,
          'old_code', input.old_code,
          'brand', input.brand,
          'description', input.description,
          'qty_ordered', coalesce(ordered.qty_ordered, 0),
          'qty_received', input.qty_received,
          'qty_remaining_before', greatest(coalesce(ordered.qty_ordered, 0) - coalesce(existing.qty_received, 0), 0),
          'unit_cost', input.unit_cost,
          'line_total', round((input.qty_received * input.unit_cost)::numeric, 2),
          'origin', input.origin,
          'notes', input.notes
        )
        order by input.line_index
      ),
      '[]'::jsonb
    ),
    now(),
    now()
  from tmp_purchase_receive_input input
  left join tmp_ordered_by_key ordered on ordered.line_key = input.line_key
  left join tmp_existing_received_by_key existing on existing.line_key = input.line_key
  returning * into v_receive;

  insert into public.inventory_movements (
    organization_id,
    warehouse_id,
    warehouse_code,
    warehouse_name,
    movement_type,
    document_type,
    document_id,
    document_no,
    related_party,
    product_code,
    old_code,
    brand,
    description,
    qty_in,
    qty_out,
    unit_cost,
    total_cost,
    origin,
    notes,
    moved_at,
    created_at,
    updated_at
  )
  select
    v_org_id,
    v_warehouse.id,
    v_warehouse.warehouse_code,
    v_warehouse.warehouse_name,
    'purchase_receive',
    'Purchase Receive',
    v_receive.id::text,
    v_receive.id::text,
    v_order.supplier_name,
    input.product_code,
    input.old_code,
    input.brand,
    input.description,
    input.qty_received,
    0,
    input.unit_cost,
    round((input.qty_received * input.unit_cost)::numeric, 2),
    input.origin,
    coalesce(nullif(input.notes, ''), v_notes, ''),
    v_received_date::timestamptz,
    now(),
    now()
  from tmp_purchase_receive_input input;

  get diagnostics v_movement_count = row_count;

  create temporary table tmp_total_received_by_key on commit drop as
  select
    ordered.line_key,
    ordered.qty_ordered,
    coalesce(existing.qty_received, 0) + coalesce(requested.qty_received, 0) as qty_received
  from tmp_ordered_by_key ordered
  left join tmp_existing_received_by_key existing on existing.line_key = ordered.line_key
  left join tmp_requested_by_key requested on requested.line_key = ordered.line_key;

  select bool_and(qty_received >= qty_ordered - 0.000001)
    into v_fully_received
  from tmp_total_received_by_key;

  update public.purchase_orders po
  set
    status = case when coalesce(v_fully_received, false) then 'closed' else po.status end,
    lines = coalesce(
      (
        select jsonb_agg(
          line.line_json ||
            jsonb_build_object(
              'qty_received', coalesce(total.qty_received, 0),
              'qty_remaining', greatest(coalesce(total.qty_ordered, 0) - coalesce(total.qty_received, 0), 0)
            )
          order by line.line_index
        )
        from tmp_purchase_order_lines line
        left join tmp_total_received_by_key total on total.line_key = line.line_key
      ),
      po.lines
    ),
    updated_at = now()
  where po.organization_id = v_org_id
    and po.id = v_order.id
  returning * into v_order;

  return jsonb_build_object(
    'receive', to_jsonb(v_receive),
    'movement_count', v_movement_count,
    'purchase_order', jsonb_build_object(
      'id', v_order.id,
      'status', v_order.status,
      'fully_received', coalesce(v_fully_received, false)
    )
  );
end;
$$;

grant execute on function public.post_purchase_receive_atomic(jsonb) to authenticated;
grant execute on function public.post_purchase_receive_atomic(jsonb) to service_role;
