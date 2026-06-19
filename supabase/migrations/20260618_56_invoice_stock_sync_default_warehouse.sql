create or replace function public.sync_invoice_stock_movements()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  invoice_row public.invoices%rowtype;
  line record;
  active_status boolean;
  effective_warehouse_id uuid;
  effective_warehouse_code text := '';
  effective_warehouse_name text := '';
begin
  if tg_op = 'DELETE' then
    delete from public.inventory_movements
    where organization_id = old.organization_id
      and document_type = 'Sales Invoice'
      and document_id = old.id;
    return old;
  end if;

  invoice_row := new;
  active_status := lower(coalesce(invoice_row.status, 'draft')) not in ('draft', 'void');

  delete from public.inventory_movements
  where organization_id = invoice_row.organization_id
    and document_type = 'Sales Invoice'
    and document_id = invoice_row.id;

  if not active_status then
    return new;
  end if;

  effective_warehouse_id := invoice_row.warehouse_id;
  effective_warehouse_code := coalesce(invoice_row.warehouse_code, '');
  effective_warehouse_name := coalesce(invoice_row.warehouse_name, '');

  if effective_warehouse_id is null then
    select
      w.id,
      coalesce(w.warehouse_code, ''),
      coalesce(w.warehouse_name, '')
    into
      effective_warehouse_id,
      effective_warehouse_code,
      effective_warehouse_name
    from public.warehouses w
    where w.organization_id = invoice_row.organization_id
      and coalesce(w.is_active, true) = true
      and lower(coalesce(w.fulfillment_model, 'stocked')) <> 'dropship'
    order by w.updated_at desc, w.warehouse_name asc
    limit 1;
  end if;

  if effective_warehouse_id is null then
    raise exception 'Sales invoice % requires a warehouse before it can be confirmed. No active stocked warehouse was found for organization %.', invoice_row.id, invoice_row.organization_id;
  end if;

  for line in
    select
      coalesce(nullif(item->>'product_code', ''), '') as product_code,
      coalesce(nullif(item->>'old_code', ''), '') as old_code,
      coalesce(nullif(item->>'brand', ''), '') as brand,
      coalesce(nullif(item->>'description', ''), '') as description,
      round(coalesce(nullif(item->>'qty', '')::numeric, 0)::numeric, 2) as qty_out,
      round(coalesce(nullif(item->>'buy_price', '')::numeric, 0)::numeric, 2) as unit_cost,
      round(
        coalesce(
          nullif(item->>'purchase_total', '')::numeric,
          coalesce(nullif(item->>'qty', '')::numeric, 0) * coalesce(nullif(item->>'buy_price', '')::numeric, 0)
        )::numeric,
        2
      ) as total_cost,
      coalesce(nullif(item->>'origin', ''), '') as origin,
      coalesce(nullif(item->>'notes', ''), '') as notes
    from jsonb_array_elements(coalesce(invoice_row.lines, '[]'::jsonb)) as item
  loop
    if line.qty_out <= 0 then
      continue;
    end if;

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
    ) values (
      invoice_row.organization_id,
      effective_warehouse_id,
      effective_warehouse_code,
      effective_warehouse_name,
      'transfer_out',
      'Sales Invoice',
      invoice_row.id,
      invoice_row.id,
      coalesce(invoice_row.customer_name, ''),
      line.product_code,
      line.old_code,
      line.brand,
      line.description,
      0,
      line.qty_out,
      line.unit_cost,
      line.total_cost,
      coalesce(line.origin, ''),
      trim(both from concat_ws(E'\n', line.notes, coalesce(invoice_row.notes, ''))),
      coalesce(invoice_row.updated_at, now()),
      now(),
      now()
    );
  end loop;

  return new;
end;
$$;

with default_warehouses as (
  select distinct on (w.organization_id)
    w.organization_id,
    w.id,
    coalesce(w.warehouse_code, '') as warehouse_code,
    coalesce(w.warehouse_name, '') as warehouse_name
  from public.warehouses w
  where coalesce(w.is_active, true) = true
    and lower(coalesce(w.fulfillment_model, 'stocked')) <> 'dropship'
  order by w.organization_id, w.updated_at desc, w.warehouse_name asc
)
update public.invoices i
set
  warehouse_id = dw.id,
  warehouse_code = dw.warehouse_code,
  warehouse_name = dw.warehouse_name,
  updated_at = now()
from default_warehouses dw
where i.organization_id = dw.organization_id
  and i.warehouse_id is null
  and lower(coalesce(i.status, 'draft')) not in ('draft', 'void');
