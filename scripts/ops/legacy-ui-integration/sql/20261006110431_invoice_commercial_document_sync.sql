-- Document-local realized commercial/cari projection. No backfill or global refresh.
-- ONLY staging rollout after local contracts; production is a separate gate.
set local lock_timeout='5s';
do $$ begin
  if md5(pg_get_functiondef('public.save_invoice_atomic(jsonb,text)'::regprocedure))<>'0ad1d36724e332200a6a4649258e1e35'
    or md5(pg_get_functiondef('public.save_bill_atomic(jsonb,text)'::regprocedure))<>'139ff0c5735b55fe33c18c00b92f6122'
    or to_regprocedure('invoice_money_private.project_document_trigger()') is null then
    raise exception 'COMMERCIAL_DOCUMENT_BASELINE_REQUIRED';
  end if;
end $$;
-- Precision changes cannot ALTER a column referenced by a view. Preserve the
-- three verified leaf views inside this transaction; never DROP CASCADE or
-- silently replace unknown definitions, grants, comments or downstream objects.
create temporary table commercial_view_backup on commit drop as
select c.relname, pg_get_viewdef(c.oid,true) as definition,
  c.relacl, c.reloptions, pg_get_userbyid(c.relowner) as owner
from pg_class c where c.oid in ('public.sales_margin_report'::regclass,
  'public.open_sales_orders_by_brand_product'::regclass,
  'public.open_purchase_orders_by_brand_product'::regclass);
do $$ declare v record; expected text; begin
  for v in select * from commercial_view_backup loop
    expected:=case v.relname
      when 'sales_margin_report' then '0983e098d31617042b5496db25d64cf8'
      when 'open_sales_orders_by_brand_product' then '1a136e798f999e4d3ddc89ac6fcd88c2'
      when 'open_purchase_orders_by_brand_product' then '215e92ed197e585dd0707da195609e4f' end;
    if md5(v.definition) is distinct from expected or v.owner<>'postgres'
      or v.reloptions is distinct from array['security_invoker=true']::text[]
      or exists(select 1 from pg_attribute a where a.attrelid=format('public.%I',v.relname)::regclass
        and a.attnum>0 and (a.attacl is not null or col_description(a.attrelid,a.attnum) is not null))
      or obj_description(format('public.%I',v.relname)::regclass,'pg_class') is not null then
      raise exception 'COMMERCIAL_VIEW_BASELINE_CHANGED:%',v.relname;
    end if;
    execute format('drop view public.%I restrict',v.relname);
  end loop;
end $$;
-- Keep vendor (commercial account) identity distinct from price supplier identity.
alter table public.commercial_line_facts
  alter column quantity type numeric(18,6), alter column unit_price type numeric(26,12),
  add column vendor_id uuid references public.vendors(id) on delete restrict,
  add column line_role text not null default 'product'
    check(line_role in ('product','shipping','discount'));
alter table public.account_transactions
  alter column quantity type numeric(18,6),
  add column vendor_id uuid references public.vendors(id) on delete restrict,
  add column linked_document_type text,
  add column linked_document_id text,
  add column line_role text not null default 'product'
    check(line_role in ('product','shipping','discount','payment'));
create index idx_commercial_facts_vendor on public.commercial_line_facts(vendor_id) where vendor_id is not null;
create index idx_account_transactions_vendor on public.account_transactions(vendor_id) where vendor_id is not null;
create index idx_account_transactions_linked_document
  on public.account_transactions(organization_id,linked_document_type,linked_document_id);
do $$ declare v record; a record; begin
  for v in select * from commercial_view_backup loop
    execute format('create view public.%I with (security_invoker=true) as %s',v.relname,v.definition);
    execute format('alter view public.%I owner to postgres',v.relname);
    -- Clear creation/default privileges, then restore the captured ACL exactly.
    for a in select distinct grantee from aclexplode((select relacl from pg_class
      where oid=format('public.%I',v.relname)::regclass)) loop
      execute format('revoke all on public.%I from %s',v.relname,
        case when a.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(a.grantee)) end);
    end loop;
    for a in select * from aclexplode(v.relacl) loop
      if a.grantor<>(select oid from pg_roles where rolname='postgres') then
        raise exception 'COMMERCIAL_VIEW_GRANTOR_UNSUPPORTED'; end if;
      execute format('grant %s on public.%I to %s%s',a.privilege_type,v.relname,
        case when a.grantee=0 then 'PUBLIC' else quote_ident(pg_get_userbyid(a.grantee)) end,
        case when a.is_grantable then ' with grant option' else '' end);
    end loop;
    if md5(pg_get_viewdef(format('public.%I',v.relname)::regclass,true))<>md5(v.definition)
      or exists((select * from aclexplode(v.relacl) except select * from aclexplode((select relacl from pg_class where oid=format('public.%I',v.relname)::regclass)))
        union all (select * from aclexplode((select relacl from pg_class where oid=format('public.%I',v.relname)::regclass)) except select * from aclexplode(v.relacl))) then
      raise exception 'COMMERCIAL_VIEW_RESTORE_MISMATCH:%',v.relname; end if;
  end loop;
end $$;

create function invoice_money_private.sync_commercial(kind text, org uuid, document_id text)
returns void language plpgsql security invoker set search_path='' as $$
declare
  doc jsonb; facts jsonb:='[]'; ledger jsonb:='[]'; payments jsonb:='[]'; base jsonb;
  party uuid; supplier uuid; vendor uuid; n integer; fee numeric; eligible boolean;
  inv public.invoices; bill public.bills; txdate date; duedate date; paid numeric;
begin
  if org is null or kind not in ('invoice','bill') or kind is null or nullif(document_id,'') is null then
    raise exception 'COMMERCIAL_DOCUMENT_CONTEXT_INVALID';
  end if;
  -- Serialize document saves and all linked payment mutations on the same parent.
  if kind='invoice' then
    select * into inv from public.invoices i where i.organization_id=org and i.id=document_id for update;
    if not found then return; end if;
    perform invoice_money_private.project_invoice(inv);
    doc:=to_jsonb(inv);
    select count(distinct l.customer_id),(array_agg(distinct l.customer_id))[1] into n,party
      from public.invoice_lines l where l.organization_id=org and l.invoice_id=document_id;
    if n<>1 then party:=null; end if;
    select coalesce(jsonb_agg(to_jsonb(p) order by p.id),'[]') into payments
      from public.payments_received p where p.organization_id=org and p.invoice_id=document_id and p.status='confirmed';
  else
    select * into bill from public.bills b where b.organization_id=org and b.id=document_id for update;
    if not found then return; end if;
    perform invoice_money_private.project_bill(bill);
    doc:=to_jsonb(bill);
    if bill.vendor_id is not null then
      select v.id into vendor from public.vendors v where v.organization_id=org and v.id=bill.vendor_id;
      if vendor is null then raise exception 'COMMERCIAL_VENDOR_SCOPE_INVALID'; end if;
    else
      select count(*),(array_agg(v.id order by v.id))[1] into n,vendor from public.vendors v
        where v.organization_id=org and nullif(trim(bill.supplier_name),'') is not null
          and (v.display_name=bill.supplier_name or v.company_name=bill.supplier_name);
      if n<>1 then vendor:=null; end if;
    end if;
    select count(distinct l.supplier_id),(array_agg(distinct l.supplier_id))[1] into n,supplier
      from public.bill_lines l where l.organization_id=org and l.bill_id=document_id;
    if n<>1 then supplier:=null; end if;
    party:=coalesce(vendor,supplier);
    select coalesce(jsonb_agg(to_jsonb(p) order by p.id),'[]') into payments
      from public.payments_made p where p.organization_id=org and p.bill_id=document_id and p.status='confirmed';
  end if;
  eligible:=doc->>'status' in ('confirmed','open','paid');
  if not eligible and jsonb_array_length(payments)>0 then
    raise exception 'COMMERCIAL_CONFIRMED_PAYMENTS_REQUIRE_ACTIVE_INVOICE';
  end if;
  if eligible then
    if party is null then raise exception 'COMMERCIAL_PARTY_REQUIRED_OR_AMBIGUOUS'; end if;
    if jsonb_array_length(doc->'lines')=0 then raise exception 'COMMERCIAL_POSTED_LINES_REQUIRED'; end if;
    txdate:=public.reporting_to_date(doc->>case when kind='invoice' then 'quote_date' else 'bill_date' end);
    duedate:=public.reporting_to_date(doc->>'due_date');
    if txdate is null or (nullif(trim(doc->>'due_date'),'') is not null and duedate is null) then
      raise exception 'COMMERCIAL_DOCUMENT_DATE_INVALID';
    end if;
    if exists(select 1 from jsonb_array_elements(payments) p where
      p->>'currency' is distinct from doc->>'currency' or (p->>'amount')::numeric<=0
      or public.reporting_to_date(p->>case when kind='invoice' then 'received_date' else 'payment_date' end) is null
      or (nullif(p->>case when kind='invoice' then 'customer_id' else 'vendor_id' end,'') is not null
        and (p->>case when kind='invoice' then 'customer_id' else 'vendor_id' end)::uuid is distinct from party)) then
      raise exception 'COMMERCIAL_PAYMENT_CURRENCY_PARTY_AMOUNT_OR_DATE_INVALID';
    end if;
    select coalesce(sum((p->>'amount')::numeric),0) into paid from jsonb_array_elements(payments) p;
    if paid>(doc->>'total_amount')::numeric then raise exception 'COMMERCIAL_PAYMENT_EXCEEDS_DOCUMENT'; end if;
    base:=jsonb_build_object('organization_id',org,'direction',case when kind='invoice' then 'sales' else 'purchase' end,
      'party_type',case when kind='invoice' then 'customer' else 'supplier' end,'party_id',party,
      'customer_id',case when kind='invoice' then party end,'supplier_id',supplier,'vendor_id',vendor,
      'party_name',doc->>case when kind='invoice' then 'customer_name' else 'supplier_name' end,
      'document_type',kind,'document_id',document_id,'document_no',document_id,
      'sales_order_id',coalesce(doc->>'sales_order_id',''),'sales_order_no',coalesce(doc->>'sales_order_no',''),
      'sales_order_ids',coalesce(doc->'sales_order_ids','[]'::jsonb),
      'purchase_order_id',coalesce(doc->>'purchase_order_id',''),'purchase_order_no',coalesce(doc->>'purchase_order_no',''),
      'currency',doc->>'currency','warehouse_id',doc->'warehouse_id','transaction_date',txdate,'due_date',duedate,
      'status',doc->>'status','created_at',now(),'updated_at',now());
    if kind='invoice' then
      select coalesce(jsonb_agg(base || jsonb_build_object(
        'id',public.reporting_line_uuid('fact:invoice:'||org::text,document_id,l.line_index),
        'document_line_id',l.id,'brand_id',l.brand_id,'brand',l.brand,'product_id',l.product_id,
        'product_code',l.product_code,'normalized_code',l.normalized_code,'description',l.description,
        'sales_order_id',l.sales_order_id,'sales_order_no',l.sales_order_no,'sales_order_ids',to_jsonb(l.sales_order_ids),
        'quantity',l.qty,'unit_price',l.sell_price,'total_amount',l.sales_total,
        'cost_amount',l.purchase_total,'margin_amount',l.profit_total,'line_role','product') order by l.line_index),'[]')
        into facts from public.invoice_lines l where l.organization_id=org and l.invoice_id=document_id;
    else
      select coalesce(jsonb_agg(base || jsonb_build_object(
        'id',public.reporting_line_uuid('fact:bill:'||org::text,document_id,l.line_index),
        'document_line_id',l.id,'brand_id',l.brand_id,'brand',l.brand,'product_id',l.product_id,
        'product_code',l.product_code,'normalized_code',l.normalized_code,'description',l.description,
        'quantity',l.qty,'unit_price',l.buy_price,'total_amount',l.line_total,
        'cost_amount',l.line_total,'margin_amount',0,'line_role','product') order by l.line_index),'[]')
        into facts from public.bill_lines l where l.organization_id=org and l.bill_id=document_id;
    end if;
    -- Separate zero-quantity, unbranded adjustments. Never invent product margins
    -- by allocating fees arbitrarily; brand-filtered product totals exclude them.
    for n in 0..1 loop
      fee:=case when n=0 then (doc->>'shipping_cost')::numeric else -(doc->>'discount_amount')::numeric end;
      if fee<>0 then facts:=facts||jsonb_build_array(base||jsonb_build_object(
        'id',public.reporting_line_uuid('fact:'||kind||':'||org::text,document_id,-n),
        'document_line_id',public.reporting_line_uuid('adjustment:'||kind||':'||org::text,document_id,-n),
        'brand','Document charges','product_code','','normalized_code','',
        'description',case when n=0 then 'Document shipping' else 'Document discount' end,
        'quantity',0,'unit_price',0,'total_amount',fee,
        'cost_amount',case when kind='bill' then fee else 0 end,
        'margin_amount',case when kind='invoice' then fee else 0 end,
        'line_role',case when n=0 then 'shipping' else 'discount' end)); end if;
    end loop;
    select coalesce(jsonb_agg(jsonb_build_object(
      'id',public.reporting_line_uuid('ledger:'||kind||':'||org::text||':'||(f->>'document_line_id'),document_id,1),
      'organization_id',org,'party_type',f->>'party_type','party_id',party,'customer_id',f->'customer_id',
      'supplier_id',supplier,'vendor_id',vendor,'party_name',f->>'party_name',
      'direction',case when kind='invoice' then 'receivable' else 'payable' end,
      'source_type',kind,'source_id',document_id,'source_no',document_id,'source_line_id',f->'document_line_id',
      'linked_document_type',kind,'linked_document_id',document_id,
      'brand_id',f->'brand_id','brand',f->>'brand','product_id',f->'product_id','product_code',f->>'product_code',
      'normalized_code',f->>'normalized_code','description',f->>'description','quantity',f->'quantity',
      'debit_amount',case when kind='invoice' then greatest((f->>'total_amount')::numeric,0) else greatest(-(f->>'total_amount')::numeric,0) end,
      'credit_amount',case when kind='bill' then greatest((f->>'total_amount')::numeric,0) else greatest(-(f->>'total_amount')::numeric,0) end,
      'transaction_date',txdate,'due_date',duedate,'currency',doc->>'currency','warehouse_id',doc->'warehouse_id',
      'status',doc->>'status','line_role',f->>'line_role','created_at',now(),'updated_at',now()) order by s.ordinal),'[]')
      into ledger from jsonb_array_elements(facts) with ordinality s(f,ordinal);
    select ledger||coalesce(jsonb_agg(jsonb_build_object(
      'id',public.reporting_line_uuid('ledger-payment:'||kind||':'||org::text,p->>'id',1),
      'organization_id',org,'party_type',case when kind='invoice' then 'customer' else 'supplier' end,
      'party_id',party,'customer_id',case when kind='invoice' then party end,'supplier_id',supplier,'vendor_id',vendor,
      'party_name',base->>'party_name','direction',case when kind='invoice' then 'receivable' else 'payable' end,
      'source_type',case when kind='invoice' then 'payment_received' else 'payment_made' end,
      'source_id',p->>'id','source_no',p->>'id','source_line_id',public.reporting_line_uuid('payment:'||kind||':'||org::text,p->>'id',1),
      'linked_document_type',kind,'linked_document_id',document_id,'brand','','product_code','','normalized_code','',
      'description',coalesce(p->>'notes',''),'quantity',0,'debit_amount',case when kind='bill' then (p->>'amount')::numeric else 0 end,
      'credit_amount',case when kind='invoice' then (p->>'amount')::numeric else 0 end,
      'transaction_date',public.reporting_to_date(p->>case when kind='invoice' then 'received_date' else 'payment_date' end),
      'currency',doc->>'currency','status','confirmed','line_role','payment','created_at',now(),'updated_at',now())),'[]')
      into ledger from jsonb_array_elements(payments) p;
  end if;

  insert into public.commercial_line_facts as t select * from jsonb_populate_recordset(null::public.commercial_line_facts,facts)
  on conflict on constraint commercial_line_facts_organization_id_document_type_documen_key do update set
    direction=excluded.direction,party_type=excluded.party_type,party_id=excluded.party_id,supplier_id=excluded.supplier_id,
    customer_id=excluded.customer_id,vendor_id=excluded.vendor_id,party_name=excluded.party_name,
    brand_id=excluded.brand_id,brand=excluded.brand,product_id=excluded.product_id,product_code=excluded.product_code,
    normalized_code=excluded.normalized_code,description=excluded.description,document_no=excluded.document_no,
    sales_order_id=excluded.sales_order_id,sales_order_no=excluded.sales_order_no,sales_order_ids=excluded.sales_order_ids,
    purchase_order_id=excluded.purchase_order_id,purchase_order_no=excluded.purchase_order_no,quantity=excluded.quantity,
    unit_price=excluded.unit_price,total_amount=excluded.total_amount,currency=excluded.currency,cost_amount=excluded.cost_amount,
    margin_amount=excluded.margin_amount,warehouse_id=excluded.warehouse_id,transaction_date=excluded.transaction_date,
    due_date=excluded.due_date,status=excluded.status,line_role=excluded.line_role,updated_at=now()
  where (to_jsonb(t)-'id'-'created_at'-'updated_at') is distinct from (to_jsonb(excluded)-'id'-'created_at'-'updated_at');
  delete from public.commercial_line_facts t where t.organization_id=org and t.document_type=kind and t.document_id=sync_commercial.document_id
    and not exists(select 1 from jsonb_array_elements(facts) f where (f->>'document_line_id')::uuid=t.document_line_id);

  insert into public.account_transactions as t select * from jsonb_populate_recordset(null::public.account_transactions,ledger)
  on conflict on constraint account_transactions_organization_id_source_type_source_id__key do update set
    party_type=excluded.party_type,party_id=excluded.party_id,customer_id=excluded.customer_id,supplier_id=excluded.supplier_id,
    vendor_id=excluded.vendor_id,party_name=excluded.party_name,direction=excluded.direction,source_no=excluded.source_no,
    brand_id=excluded.brand_id,brand=excluded.brand,product_id=excluded.product_id,product_code=excluded.product_code,
    normalized_code=excluded.normalized_code,description=excluded.description,quantity=excluded.quantity,
    debit_amount=excluded.debit_amount,credit_amount=excluded.credit_amount,due_date=excluded.due_date,
    transaction_date=excluded.transaction_date,currency=excluded.currency,warehouse_id=excluded.warehouse_id,status=excluded.status,
    linked_document_type=excluded.linked_document_type,linked_document_id=excluded.linked_document_id,line_role=excluded.line_role,updated_at=now()
  where (to_jsonb(t)-'id'-'created_at'-'updated_at') is distinct from (to_jsonb(excluded)-'id'-'created_at'-'updated_at');
  delete from public.account_transactions t where t.organization_id=org
    and ((t.source_type=kind and t.source_id=sync_commercial.document_id)
      or (t.linked_document_type=kind and t.linked_document_id=sync_commercial.document_id))
    and not exists(select 1 from jsonb_array_elements(ledger) l where l->>'source_type'=t.source_type
      and l->>'source_id'=t.source_id and (l->>'source_line_id')::uuid=t.source_line_id);
end $$;
revoke all on function invoice_money_private.sync_commercial(text,uuid,text) from public,anon,authenticated,service_role;

create function invoice_money_private.commercial_trigger()
returns trigger language plpgsql security invoker set search_path='' as $$
declare kind text; docid text; org uuid;
begin
  if tg_table_schema<>'public' then raise exception 'COMMERCIAL_TRIGGER_CONTEXT_INVALID'; end if;
  if tg_table_name in ('invoices','bills') then
    kind:=case when tg_table_name='invoices' then 'invoice' else 'bill' end;
    if tg_op='DELETE' then
      if exists(select 1 from public.account_transactions a where a.organization_id=old.organization_id
        and a.linked_document_type=kind and a.linked_document_id=old.id and a.line_role='payment')
        or (kind='invoice' and exists(select 1 from public.payments_received p where p.organization_id=old.organization_id and p.invoice_id=old.id))
        or (kind='bill' and exists(select 1 from public.payments_made p where p.organization_id=old.organization_id and p.bill_id=old.id)) then
        raise exception 'COMMERCIAL_DELETE_LINKED_PAYMENTS_FIRST';
      end if;
      delete from public.commercial_line_facts f where f.organization_id=old.organization_id and f.document_type=kind and f.document_id=old.id;
      delete from public.account_transactions a where a.organization_id=old.organization_id and a.source_type=kind and a.source_id=old.id;
      return old;
    end if;
    if tg_op='UPDATE' and (new.id is distinct from old.id or new.organization_id is distinct from old.organization_id) then
      raise exception 'COMMERCIAL_DOCUMENT_IDENTITY_IMMUTABLE';
    end if;
    perform invoice_money_private.sync_commercial(kind,new.organization_id,new.id);
    return new;
  elsif tg_table_name in ('payments_received','payments_made') then
    kind:=case when tg_table_name='payments_received' then 'invoice' else 'bill' end;
    if tg_op='UPDATE' and (new.id is distinct from old.id or new.organization_id is distinct from old.organization_id) then
      raise exception 'COMMERCIAL_PAYMENT_IDENTITY_IMMUTABLE';
    end if;
    if tg_op<>'INSERT' then
      docid:=to_jsonb(old)->>case when kind='invoice' then 'invoice_id' else 'bill_id' end;
      if nullif(docid,'') is not null then
        perform invoice_money_private.sync_commercial(kind,old.organization_id,docid);
        if kind='invoice' then perform public.recalculate_invoice_paid_status_for_org(old.organization_id,docid);
        else perform public.recalculate_bill_paid_status_for_org(old.organization_id,docid); end if;
      end if;
    end if;
    if tg_op<>'DELETE' then
      docid:=to_jsonb(new)->>case when kind='invoice' then 'invoice_id' else 'bill_id' end;
      if nullif(docid,'') is not null then
        -- Linked payments must refer to a same-org parent, not silently disappear.
        if kind='invoice' then
          if not exists(select 1 from public.invoices d where d.id=docid and d.organization_id=new.organization_id) then
            raise exception 'COMMERCIAL_PAYMENT_DOCUMENT_SCOPE_INVALID'; end if;
        else
          if not exists(select 1 from public.bills d where d.id=docid and d.organization_id=new.organization_id) then
            raise exception 'COMMERCIAL_PAYMENT_DOCUMENT_SCOPE_INVALID'; end if;
        end if;
        perform invoice_money_private.sync_commercial(kind,new.organization_id,docid);
        if kind='invoice' then perform public.recalculate_invoice_paid_status_for_org(new.organization_id,docid);
        else perform public.recalculate_bill_paid_status_for_org(new.organization_id,docid); end if;
      end if;
      return new;
    end if;
    return old;
  end if;
  raise exception 'COMMERCIAL_TRIGGER_TABLE_INVALID';
end $$;
revoke all on function invoice_money_private.commercial_trigger() from public,anon,authenticated,service_role;
-- AFTER document row projection; status/date/fee-only updates are also covered.
create trigger trg_zz_invoice_commercial after insert or update on public.invoices
  for each row execute function invoice_money_private.commercial_trigger();
create trigger trg_zz_bill_commercial after insert or update on public.bills
  for each row execute function invoice_money_private.commercial_trigger();
create trigger trg_invoice_commercial_delete before delete on public.invoices
  for each row execute function invoice_money_private.commercial_trigger();
create trigger trg_bill_commercial_delete before delete on public.bills
  for each row execute function invoice_money_private.commercial_trigger();
create trigger trg_payment_received_commercial after insert or update or delete on public.payments_received
  for each row execute function invoice_money_private.commercial_trigger();
create trigger trg_payment_made_commercial after insert or update or delete on public.payments_made
  for each row execute function invoice_money_private.commercial_trigger();
