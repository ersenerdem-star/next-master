-- Document-local canonical JSON -> relational reporting projection.
-- No historical backfill, whole-org refresh, account posting or price mutation.
-- Internal invoker functions run only through already-authorized document writes.
set local lock_timeout = '5s';
do $$ begin
  if to_regprocedure('invoice_money_private.normalize_document(jsonb,text)') is null
    or to_regclass('public.invoice_lines') is null or to_regclass('public.bill_lines') is null then
    raise exception 'INVOICE_REPORTING_BASELINE_REQUIRED';
  end if;
  if md5(pg_get_functiondef('public.save_invoice_atomic(jsonb,text)'::regprocedure))<>'0ad1d36724e332200a6a4649258e1e35'
    or md5(pg_get_functiondef('public.save_bill_atomic(jsonb,text)'::regprocedure))<>'139ff0c5735b55fe33c18c00b92f6122' then
    raise exception 'INVOICE_REPORTING_RPC_BASELINE_CHANGED';
  end if;
end $$;

-- Match canonical limits: quantity <= 1e9 / 6 decimals; unit price / 12 decimals.
-- These columns have no dependent views in the verified baseline. No truncation.
alter table public.invoice_lines
  alter column qty type numeric(18,6),
  alter column buy_price type numeric(26,12),
  alter column sell_price type numeric(26,12);
alter table public.bill_lines
  alter column qty type numeric(18,6),
  alter column buy_price type numeric(26,12);

create function invoice_money_private.project_invoice(i public.invoices)
returns void language plpgsql security invoker set search_path = '' as $$
declare v_customer uuid; v_count integer;
begin
  if i.organization_id is null then raise exception 'REPORTING_ORGANIZATION_REQUIRED'; end if;
  if i.customer_id is not null then
    select c.id into v_customer from public.customers c
      where c.id=i.customer_id and c.organization_id=i.organization_id;
    if v_customer is null then raise exception 'REPORTING_CUSTOMER_SCOPE_INVALID'; end if;
  else
    -- Never arbitrarily select one of multiple matching customers.
    select count(*), (array_agg(c.id order by c.id))[1] into v_count,v_customer
      from public.customers c where c.organization_id=i.organization_id
      and nullif(trim(i.customer_name),'') is not null
      and (c.display_name=i.customer_name or c.company_name=i.customer_name);
    if v_count<>1 then v_customer:=null; end if;
  end if;
  if i.warehouse_id is not null and not exists (
    select 1 from public.warehouses w where w.id=i.warehouse_id and w.organization_id=i.organization_id
  ) then raise exception 'REPORTING_WAREHOUSE_SCOPE_INVALID'; end if;

  insert into public.invoice_lines as target (
    id,organization_id,invoice_id,line_index,sales_order_id,sales_order_no,sales_order_ids,
    customer_id,customer_name,warehouse_id,warehouse_code,warehouse_name,
    brand_id,brand,product_id,product_code,normalized_code,old_code,description,oem_no,hs_code,
    qty,buy_price,sell_price,purchase_total,sales_total,profit_total,margin_percent,
    weight_kg,currency,origin,notes,lifecycle_status,lifecycle_note,lifecycle_warning
  )
  select public.reporting_line_uuid('invoice:'||i.organization_id::text,i.id,s.ordinal::integer),
    i.organization_id,i.id,s.ordinal::integer,
    coalesce(nullif(s.line->>'sales_order_id',''),i.sales_order_id,''),
    coalesce(nullif(s.line->>'sales_order_no',''),i.sales_order_no,''),
    case when cardinality(i.sales_order_ids)>0 then i.sales_order_ids
      when nullif(i.sales_order_id,'') is not null then array[i.sales_order_id] else '{}'::text[] end,
    v_customer,coalesce(i.customer_name,''),i.warehouse_id,coalesce(i.warehouse_code,''),coalesce(i.warehouse_name,''),
    br.id,coalesce(nullif(s.line->>'brand',''),'Unbranded'),cp.id,
    coalesce(s.line->>'product_code',s.line->>'resolvedCode',s.line->>'requestedCode',''),
    public.normalize_part_code(coalesce(s.line->>'product_code',s.line->>'resolvedCode',s.line->>'requestedCode','')),
    coalesce(s.line->>'old_code',s.line->>'requestedCode',''),coalesce(s.line->>'description',''),
    coalesce(s.line->>'oem_no',s.line->>'oemNo',s.line->>'oem',''),coalesce(s.line->>'hs_code',s.line->>'hsCode',''),
    (s.line->>'qty')::numeric,(s.line->>'buy_price')::numeric,(s.line->>'sell_price')::numeric,
    (s.line->>'purchase_total')::numeric,(s.line->>'sales_total')::numeric,
    (s.line->>'profit_total')::numeric,(s.line->>'margin_percent')::numeric,
    public.reporting_to_numeric(s.line->>'weight_kg'),i.currency,coalesce(s.line->>'origin',''),
    coalesce(s.line->>'notes',''),s.line->>'lifecycle_status',s.line->>'lifecycle_note',s.line->>'lifecycle_warning'
  from jsonb_array_elements(i.lines) with ordinality s(line,ordinal)
  left join public.brands br on br.organization_id=i.organization_id
    and br.normalized_name=public.normalize_part_code(coalesce(nullif(s.line->>'brand',''),'Unbranded'))
  left join public.catalog_products cp on cp.organization_id=i.organization_id and cp.brand_id=br.id
    and cp.normalized_code=public.normalize_part_code(coalesce(s.line->>'product_code',s.line->>'resolvedCode',s.line->>'requestedCode',''))
  on conflict on constraint invoice_lines_organization_id_invoice_id_line_index_key do update set
    sales_order_id=excluded.sales_order_id,sales_order_no=excluded.sales_order_no,sales_order_ids=excluded.sales_order_ids,
    customer_id=excluded.customer_id,customer_name=excluded.customer_name,
    warehouse_id=excluded.warehouse_id,warehouse_code=excluded.warehouse_code,warehouse_name=excluded.warehouse_name,
    brand_id=excluded.brand_id,brand=excluded.brand,product_id=excluded.product_id,product_code=excluded.product_code,
    normalized_code=excluded.normalized_code,old_code=excluded.old_code,description=excluded.description,
    oem_no=excluded.oem_no,hs_code=excluded.hs_code,qty=excluded.qty,buy_price=excluded.buy_price,sell_price=excluded.sell_price,
    purchase_total=excluded.purchase_total,sales_total=excluded.sales_total,profit_total=excluded.profit_total,
    margin_percent=excluded.margin_percent,weight_kg=excluded.weight_kg,currency=excluded.currency,
    origin=excluded.origin,notes=excluded.notes,lifecycle_status=excluded.lifecycle_status,
    lifecycle_note=excluded.lifecycle_note,lifecycle_warning=excluded.lifecycle_warning,updated_at=now()
  where (target.sales_order_id,target.sales_order_no,target.sales_order_ids,target.customer_id,target.customer_name,
    target.warehouse_id,target.warehouse_code,target.warehouse_name,target.brand_id,target.brand,target.product_id,
    target.product_code,target.normalized_code,target.old_code,target.description,target.oem_no,target.hs_code,
    target.qty,target.buy_price,target.sell_price,target.purchase_total,target.sales_total,target.profit_total,
    target.margin_percent,target.weight_kg,target.currency,target.origin,target.notes,target.lifecycle_status,
    target.lifecycle_note,target.lifecycle_warning)
  is distinct from (excluded.sales_order_id,excluded.sales_order_no,excluded.sales_order_ids,excluded.customer_id,excluded.customer_name,
    excluded.warehouse_id,excluded.warehouse_code,excluded.warehouse_name,excluded.brand_id,excluded.brand,excluded.product_id,
    excluded.product_code,excluded.normalized_code,excluded.old_code,excluded.description,excluded.oem_no,excluded.hs_code,
    excluded.qty,excluded.buy_price,excluded.sell_price,excluded.purchase_total,excluded.sales_total,excluded.profit_total,
    excluded.margin_percent,excluded.weight_kg,excluded.currency,excluded.origin,excluded.notes,excluded.lifecycle_status,
    excluded.lifecycle_note,excluded.lifecycle_warning);
  delete from public.invoice_lines l where l.organization_id=i.organization_id and l.invoice_id=i.id
    and l.line_index>jsonb_array_length(i.lines);
end;
$$;
revoke all on function invoice_money_private.project_invoice(public.invoices) from public,anon,authenticated,service_role;

create function invoice_money_private.project_bill(b public.bills)
returns void language plpgsql security invoker set search_path = '' as $$
declare v_supplier uuid;
begin
  if b.organization_id is null then raise exception 'REPORTING_ORGANIZATION_REQUIRED'; end if;
  -- Supplier is not vendor: never coerce vendor_id into the suppliers foreign key.
  select s.id into v_supplier from public.suppliers s
    where s.organization_id=b.organization_id
      and nullif(trim(b.supplier_name),'') is not null
      and s.normalized_name=public.normalize_part_code(b.supplier_name);
  insert into public.bill_lines as target (
    id,organization_id,bill_id,line_index,purchase_order_id,purchase_order_no,supplier_id,supplier_name,
    brand_id,brand,product_id,product_code,normalized_code,old_code,description,oem_no,hs_code,
    qty,buy_price,line_total,weight_kg,currency,origin,notes
  )
  select public.reporting_line_uuid('bill:'||b.organization_id::text,b.id,s.ordinal::integer),
    b.organization_id,b.id,s.ordinal::integer,
    coalesce(nullif(s.line->>'purchase_order_id',''),b.purchase_order_id,''),
    coalesce(nullif(s.line->>'purchase_order_no',''),b.purchase_order_no,''),v_supplier,coalesce(b.supplier_name,''),
    br.id,coalesce(nullif(s.line->>'brand',''),'Unbranded'),cp.id,
    coalesce(s.line->>'product_code',s.line->>'resolvedCode',s.line->>'requestedCode',''),
    public.normalize_part_code(coalesce(s.line->>'product_code',s.line->>'resolvedCode',s.line->>'requestedCode','')),
    coalesce(s.line->>'old_code',s.line->>'requestedCode',''),coalesce(s.line->>'description',''),
    coalesce(s.line->>'oem_no',s.line->>'oemNo',s.line->>'oem',''),coalesce(s.line->>'hs_code',s.line->>'hsCode',''),
    (s.line->>'qty')::numeric,(s.line->>'buy_price')::numeric,(s.line->>'line_total')::numeric,
    public.reporting_to_numeric(s.line->>'weight_kg'),b.currency,coalesce(s.line->>'origin',''),coalesce(s.line->>'notes','')
  from jsonb_array_elements(b.lines) with ordinality s(line,ordinal)
  left join public.brands br on br.organization_id=b.organization_id
    and br.normalized_name=public.normalize_part_code(coalesce(nullif(s.line->>'brand',''),'Unbranded'))
  left join public.catalog_products cp on cp.organization_id=b.organization_id and cp.brand_id=br.id
    and cp.normalized_code=public.normalize_part_code(coalesce(s.line->>'product_code',s.line->>'resolvedCode',s.line->>'requestedCode',''))
  on conflict on constraint bill_lines_organization_id_bill_id_line_index_key do update set
    purchase_order_id=excluded.purchase_order_id,purchase_order_no=excluded.purchase_order_no,
    supplier_id=excluded.supplier_id,supplier_name=excluded.supplier_name,
    brand_id=excluded.brand_id,brand=excluded.brand,product_id=excluded.product_id,product_code=excluded.product_code,
    normalized_code=excluded.normalized_code,old_code=excluded.old_code,description=excluded.description,
    oem_no=excluded.oem_no,hs_code=excluded.hs_code,qty=excluded.qty,buy_price=excluded.buy_price,line_total=excluded.line_total,
    weight_kg=excluded.weight_kg,currency=excluded.currency,origin=excluded.origin,notes=excluded.notes,updated_at=now()
  where (target.purchase_order_id,target.purchase_order_no,target.supplier_id,target.supplier_name,
    target.brand_id,target.brand,target.product_id,target.product_code,target.normalized_code,target.old_code,
    target.description,target.oem_no,target.hs_code,target.qty,target.buy_price,target.line_total,target.weight_kg,
    target.currency,target.origin,target.notes)
  is distinct from (excluded.purchase_order_id,excluded.purchase_order_no,excluded.supplier_id,excluded.supplier_name,
    excluded.brand_id,excluded.brand,excluded.product_id,excluded.product_code,excluded.normalized_code,excluded.old_code,
    excluded.description,excluded.oem_no,excluded.hs_code,excluded.qty,excluded.buy_price,excluded.line_total,excluded.weight_kg,
    excluded.currency,excluded.origin,excluded.notes);
  delete from public.bill_lines l where l.organization_id=b.organization_id and l.bill_id=b.id
    and l.line_index>jsonb_array_length(b.lines);
end;
$$;
revoke all on function invoice_money_private.project_bill(public.bills) from public,anon,authenticated,service_role;

create function invoice_money_private.project_document_trigger()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if tg_table_schema<>'public' or tg_op not in ('INSERT','UPDATE') then
    raise exception 'REPORTING_TRIGGER_CONTEXT_INVALID';
  end if;
  if tg_op='UPDATE' and (new.organization_id is distinct from old.organization_id or new.id is distinct from old.id) then
    raise exception 'REPORTING_DOCUMENT_IDENTITY_IMMUTABLE';
  end if;
  if tg_table_name='invoices' then
    perform invoice_money_private.project_invoice(new);
  elsif tg_table_name='bills' then
    perform invoice_money_private.project_bill(new);
  else raise exception 'REPORTING_TRIGGER_TABLE_INVALID'; end if;
  return new;
end;
$$;
revoke all on function invoice_money_private.project_document_trigger() from public,anon,authenticated,service_role;

create trigger trg_invoice_report_lines after insert or update of
  id,organization_id,lines,currency,sales_order_id,sales_order_no,sales_order_ids,
  customer_id,customer_name,warehouse_id,warehouse_code,warehouse_name
on public.invoices for each row execute function invoice_money_private.project_document_trigger();
create trigger trg_bill_report_lines after insert or update of
  id,organization_id,lines,currency,purchase_order_id,purchase_order_no,supplier_name
on public.bills for each row execute function invoice_money_private.project_document_trigger();
-- Parent foreign keys already ON DELETE CASCADE. No DELETE API or public writer added.
-- Existing table RLS, ACL and authorized save RPC definitions remain unchanged.
