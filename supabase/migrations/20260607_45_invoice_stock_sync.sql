alter table public.invoices
  add column if not exists warehouse_id uuid references public.warehouses(id) on delete set null,
  add column if not exists warehouse_code text not null default '',
  add column if not exists warehouse_name text not null default '';

create index if not exists idx_invoices_org_warehouse
  on public.invoices (organization_id, warehouse_id, updated_at desc);

create index if not exists idx_inventory_movements_org_document
  on public.inventory_movements (organization_id, document_type, document_id);

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

  if invoice_row.warehouse_id is null then
    raise exception 'Sales invoice % requires a warehouse before it can be confirmed.', invoice_row.id;
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
      invoice_row.warehouse_id,
      coalesce(invoice_row.warehouse_code, ''),
      coalesce(invoice_row.warehouse_name, ''),
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

drop trigger if exists trg_sync_invoice_stock_movements on public.invoices;
create trigger trg_sync_invoice_stock_movements
after insert or update or delete on public.invoices
for each row execute function public.sync_invoice_stock_movements();
