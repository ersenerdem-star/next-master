-- Inventory movements are a physical ledger. Invoice stock synchronization must
-- append reversals/corrections instead of deleting posted movement rows.

alter table public.inventory_movements
  add column if not exists source_document_version text not null default '',
  add column if not exists reversal_of_movement_id uuid null references public.inventory_movements(id) on delete restrict,
  add column if not exists correction_reason text not null default '',
  add column if not exists posted_by uuid default auth.uid(),
  add column if not exists posted_at timestamptz not null default now();

create index if not exists idx_inventory_movements_reversal_of
  on public.inventory_movements (organization_id, reversal_of_movement_id)
  where reversal_of_movement_id is not null;

create index if not exists idx_inventory_movements_invoice_active_version
  on public.inventory_movements (organization_id, document_type, document_id, source_document_version)
  where document_type = 'Sales Invoice' and reversal_of_movement_id is null;

create or replace function public.invoice_stock_movement_version(invoice_row public.invoices)
returns text
language sql
stable
set search_path = public
as $$
  select md5(
    concat_ws(
      '|',
      coalesce(invoice_row.status, ''),
      coalesce(invoice_row.warehouse_id::text, ''),
      coalesce(invoice_row.warehouse_code, ''),
      coalesce(invoice_row.warehouse_name, ''),
      coalesce(invoice_row.customer_name, ''),
      coalesce(invoice_row.notes, ''),
      coalesce(invoice_row.lines::text, '[]')
    )
  );
$$;

create or replace function public.reverse_invoice_stock_movements_for_org(
  input_organization_id uuid,
  input_invoice_id text,
  input_reason text default 'Invoice stock movement correction'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reversed integer := 0;
begin
  if input_organization_id is null then
    raise exception 'Organization is required';
  end if;

  if nullif(trim(coalesce(input_invoice_id, '')), '') is null then
    raise exception 'Invoice is required';
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
    source_document_version,
    reversal_of_movement_id,
    correction_reason,
    posted_by,
    posted_at,
    created_at,
    updated_at
  )
  select
    original.organization_id,
    original.warehouse_id,
    original.warehouse_code,
    original.warehouse_name,
    'adjustment',
    original.document_type,
    original.document_id,
    original.document_no,
    original.related_party,
    original.product_code,
    original.old_code,
    original.brand,
    original.description,
    coalesce(original.qty_out, 0),
    coalesce(original.qty_in, 0),
    original.unit_cost,
    original.total_cost,
    original.origin,
    trim(both from concat_ws(E'\n', nullif(original.notes, ''), coalesce(input_reason, 'Invoice stock movement correction'))),
    now(),
    original.source_document_version,
    original.id,
    coalesce(nullif(trim(input_reason), ''), 'Invoice stock movement correction'),
    auth.uid(),
    now(),
    now(),
    now()
  from public.inventory_movements original
  where original.organization_id = input_organization_id
    and original.document_type = 'Sales Invoice'
    and original.document_id = input_invoice_id
    and original.reversal_of_movement_id is null
    and not exists (
      select 1
      from public.inventory_movements reversal
      where reversal.organization_id = original.organization_id
        and reversal.reversal_of_movement_id = original.id
    );

  get diagnostics v_reversed = row_count;

  return jsonb_build_object(
    'invoice_id', input_invoice_id,
    'reversed_movements', v_reversed
  );
end;
$$;

create or replace function public.reverse_invoice_stock_movements(
  invoice_id text,
  reason text default 'Invoice stock movement correction'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_id uuid;
begin
  v_org_id := public.current_profile_org_id();

  if v_org_id is null or (public.current_profile_role() <> 'admin' and not public.is_superadmin()) then
    raise exception 'Only active admin users can reverse invoice stock movements';
  end if;

  return public.reverse_invoice_stock_movements_for_org(v_org_id, invoice_id, reason);
end;
$$;

create or replace function public.post_invoice_stock_movements_for_org(
  input_organization_id uuid,
  input_invoice_id text,
  input_reason text default 'Invoice stock movement repost'
)
returns jsonb
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
  v_version text := '';
  v_inserted integer := 0;
  v_reversal_result jsonb := '{}'::jsonb;
begin
  if input_organization_id is null then
    raise exception 'Organization is required';
  end if;

  if nullif(trim(coalesce(input_invoice_id, '')), '') is null then
    raise exception 'Invoice is required';
  end if;

  select *
    into invoice_row
  from public.invoices i
  where i.organization_id = input_organization_id
    and i.id = input_invoice_id
  for update;

  if not found then
    raise exception 'Invoice was not found';
  end if;

  active_status := lower(coalesce(invoice_row.status, 'draft')) not in ('draft', 'void');

  if not active_status then
    return public.reverse_invoice_stock_movements_for_org(
      invoice_row.organization_id,
      invoice_row.id,
      coalesce(nullif(trim(input_reason), ''), 'Invoice is no longer stock-active')
    );
  end if;

  v_version := public.invoice_stock_movement_version(invoice_row);

  if exists (
    select 1
    from public.inventory_movements existing
    where existing.organization_id = invoice_row.organization_id
      and existing.document_type = 'Sales Invoice'
      and existing.document_id = invoice_row.id
      and existing.reversal_of_movement_id is null
      and existing.source_document_version = v_version
      and not exists (
        select 1
        from public.inventory_movements reversal
        where reversal.organization_id = existing.organization_id
          and reversal.reversal_of_movement_id = existing.id
      )
  ) then
    return jsonb_build_object(
      'invoice_id', invoice_row.id,
      'source_document_version', v_version,
      'posted_movements', 0,
      'reversed_movements', 0,
      'status', 'already_posted'
    );
  end if;

  v_reversal_result := public.reverse_invoice_stock_movements_for_org(
    invoice_row.organization_id,
    invoice_row.id,
    coalesce(nullif(trim(input_reason), ''), 'Invoice stock movement repost')
  );

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
    raise exception
      'Sales invoice % requires a warehouse before it can be confirmed. No active stocked warehouse was found for organization %.',
      invoice_row.id,
      invoice_row.organization_id;
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
      source_document_version,
      reversal_of_movement_id,
      correction_reason,
      posted_by,
      posted_at,
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
      v_version,
      null,
      coalesce(nullif(trim(input_reason), ''), 'Invoice stock movement repost'),
      auth.uid(),
      now(),
      now(),
      now()
    );

    v_inserted := v_inserted + 1;
  end loop;

  return jsonb_build_object(
    'invoice_id', invoice_row.id,
    'source_document_version', v_version,
    'posted_movements', v_inserted,
    'reversed_movements', coalesce((v_reversal_result->>'reversed_movements')::integer, 0),
    'status', 'posted'
  );
end;
$$;

create or replace function public.post_invoice_stock_movements(invoice_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_id uuid;
begin
  v_org_id := public.current_profile_org_id();

  if v_org_id is null or (public.current_profile_role() <> 'admin' and not public.is_superadmin()) then
    raise exception 'Only active admin users can post invoice stock movements';
  end if;

  return public.post_invoice_stock_movements_for_org(v_org_id, invoice_id, 'Manual invoice stock movement post');
end;
$$;

create or replace function public.sync_invoice_stock_movements()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    perform public.reverse_invoice_stock_movements_for_org(
      old.organization_id,
      old.id,
      'Invoice deleted; reversing posted stock movements'
    );
    return old;
  end if;

  if lower(coalesce(new.status, 'draft')) in ('draft', 'void') then
    perform public.reverse_invoice_stock_movements_for_org(
      new.organization_id,
      new.id,
      'Invoice is no longer stock-active; reversing posted stock movements'
    );
    return new;
  end if;

  perform public.post_invoice_stock_movements_for_org(
    new.organization_id,
    new.id,
    'Invoice stock movement synchronization'
  );

  return new;
end;
$$;

drop trigger if exists trg_sync_invoice_stock_movements on public.invoices;
create trigger trg_sync_invoice_stock_movements
after insert or update or delete on public.invoices
for each row execute function public.sync_invoice_stock_movements();

grant execute on function public.reverse_invoice_stock_movements(text, text) to authenticated;
grant execute on function public.reverse_invoice_stock_movements(text, text) to service_role;
grant execute on function public.post_invoice_stock_movements(text) to authenticated;
grant execute on function public.post_invoice_stock_movements(text) to service_role;
