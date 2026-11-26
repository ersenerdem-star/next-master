-- Confirm a sales order and all derived purchase orders in one transaction.
-- Historical documents are never modified by this migration or replaced by confirmation.
create schema if not exists sales_confirmation_private;
revoke all on schema sales_confirmation_private from public, anon, authenticated, service_role;
create table sales_confirmation_private.receipts (
 organization_id uuid not null, decision_id uuid not null, actor_id uuid not null,
 order_id text not null, request_payload jsonb not null, receipt jsonb not null,
 created_at timestamptz not null default now(), primary key (organization_id, decision_id)
);
create table sales_confirmation_private.capabilities (
 organization_id uuid not null, actor_id uuid not null, order_id text not null, transaction_id bigint not null,
 primary key (organization_id, actor_id, order_id, transaction_id)
);
alter table sales_confirmation_private.receipts enable row level security;
alter table sales_confirmation_private.capabilities enable row level security;
revoke all on all tables in schema sales_confirmation_private from public, anon, authenticated, service_role;

create function sales_confirmation_private.require_atomic_confirmation() returns trigger
language plpgsql security definer set search_path='' as $function$
declare previous_status text;
begin
 -- The customer portal saves drafts via a service-role REST upsert. Its
 -- earlier read can race internal confirmation; reject a stale portal write
 -- at the locked row rather than allowing it to revert the confirmed order.
 if tg_op='UPDATE' and lower(coalesce(old.status,'draft'))='confirmed' and lower(coalesce(new.status,'draft'))<>'confirmed'
  and (exists(select 1 from public.purchase_orders p where p.organization_id=old.organization_id and p.sales_order_id=old.id)
   or exists(select 1 from public.invoices i where i.organization_id=old.organization_id and (i.sales_order_id=old.id or old.id=any(coalesce(i.sales_order_ids,'{}'::text[]))))) then
  raise exception 'SALES_CONFIRMATION_PORTAL_STALE' using errcode='40001';
 end if;
 if lower(coalesce(new.status,'draft')) <> 'confirmed' then return new; end if;
 if tg_op = 'UPDATE' then previous_status := lower(coalesce(old.status,'draft'));
 else
  -- BEFORE INSERT also fires for an INSERT ... ON CONFLICT UPDATE.
  select lower(coalesce(so.status,'draft')) into previous_status from public.sales_orders so
   where so.organization_id=new.organization_id and so.id=new.id;
 end if;
 if previous_status = 'confirmed' then return new; end if;
 if not exists (select 1 from sales_confirmation_private.capabilities c
  where c.organization_id=new.organization_id and c.actor_id=auth.uid()
   and c.order_id=new.id and c.transaction_id=pg_catalog.txid_current()) then
  raise exception 'SALES_CONFIRMATION_ATOMIC_REQUIRED' using errcode='42501';
 end if;
 return new;
end;
$function$;
revoke all on function sales_confirmation_private.require_atomic_confirmation() from public,anon,authenticated,service_role;
create trigger sales_confirmation_require_atomic before insert or update on public.sales_orders
 for each row execute function sales_confirmation_private.require_atomic_confirmation();

create function public.confirm_sales_order_with_purchases_safe(payload jsonb, decision_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $function$
declare
 org uuid:=public.current_profile_org_id(); actor uuid:=auth.uid(); role_name text:=public.current_profile_role();
 v_order_id text:=nullif(btrim(payload->>'id'),''); request jsonb:=payload-'updated_at'-'created_at'-'confirmed_at'-'organization_id';
 prior sales_confirmation_private.receipts%rowtype; existing public.sales_orders%rowtype;
 source_line jsonb; qty numeric; buy numeric; sell numeric; resolved record; grouped jsonb:='{}'::jsonb;
 vendor_key text; group_item jsonb; po_line jsonb; saved jsonb; po jsonb; orders jsonb:='[]'::jsonb; result jsonb; po_id text;
begin
 if actor is null or org is null or (coalesce(role_name,'') not in ('admin','sales') and not coalesce(public.is_superadmin(),false)) then
  raise exception 'SALES_CONFIRMATION_STAFF_REQUIRED' using errcode='42501'; end if;
 if decision_id is null or v_order_id is null or length(v_order_id)>180 or payload->>'status' is distinct from 'confirmed' then
  raise exception 'SALES_CONFIRMATION_INPUT_INVALID' using errcode='22023'; end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(org::text||':sales-confirmation-decision:'||decision_id::text,0));
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(org::text||':sales-confirmation-order:'||v_order_id,0));
 select * into prior from sales_confirmation_private.receipts r where r.organization_id=org and r.decision_id=confirm_sales_order_with_purchases_safe.decision_id;
 if found then
  if prior.actor_id<>actor or prior.order_id<>v_order_id or prior.request_payload<>request then raise exception 'SALES_CONFIRMATION_DECISION_MISMATCH'; end if;
  return prior.receipt||jsonb_build_object('replayed',true);
 end if;
 select * into existing from public.sales_orders so where so.organization_id=org and so.id=v_order_id for update;
 if found and lower(coalesce(existing.status,'draft'))<>'draft' then raise exception 'SALES_CONFIRMATION_ALREADY_CONFIRMED'; end if;
 if exists(select 1 from public.purchase_orders po0 where po0.organization_id=org and po0.sales_order_id=v_order_id)
  or exists(select 1 from public.invoices i where i.organization_id=org and (i.sales_order_id=v_order_id or v_order_id=any(coalesce(i.sales_order_ids,'{}'::text[])))) then
  raise exception 'SALES_CONFIRMATION_HAS_DOCUMENTS'; end if;
 if jsonb_typeof(payload->'lines') is distinct from 'array' or jsonb_array_length(payload->'lines') not between 1 and 10000 then
  raise exception 'SALES_CONFIRMATION_LINES_INVALID'; end if;
 -- Resolve all recipients and validate every line before writing anything.
 for source_line in select value from jsonb_array_elements(payload->'lines') loop
  begin qty:=(source_line->>'qty')::numeric; buy:=(source_line->>'buy_price')::numeric; sell:=(source_line->>'sell_price')::numeric;
  exception when invalid_text_representation or numeric_value_out_of_range then raise exception 'SALES_CONFIRMATION_PRICE_INVALID'; end;
  if qty is null or buy is null or sell is null or qty::text in ('NaN','Infinity','-Infinity') or buy::text in ('NaN','Infinity','-Infinity') or sell::text in ('NaN','Infinity','-Infinity')
    or qty<=0 or qty>1000000000 or buy<=0 or sell<=0 or buy>1000000000 or sell>1000000000
    or scale(qty)>6 or scale(buy)>6 or scale(sell)>6
    or nullif(btrim(source_line->>'resolvedCode'),'') is null then raise exception 'SALES_CONFIRMATION_PRICE_INVALID'; end if;
  select * into strict resolved from purchase_vendor_resolution_private.resolve_one(org,source_line->>'supplier_name');
  vendor_key:=resolved.vendor_id::text;
  group_item:=coalesce(grouped->vendor_key,jsonb_build_object('vendor_id',vendor_key,'supplier_name',resolved.supplier_name,'lines','[]'::jsonb));
  po_line:=jsonb_build_object('sales_order_id',v_order_id,'sales_order_no',payload->>'sales_order_no',
   'product_code',source_line->>'resolvedCode','old_code',case when coalesce((source_line->>'codeChanged')::boolean,false) then source_line->>'requestedCode' else '' end,
   'brand',source_line->>'brand','description',source_line->>'description','qty',source_line->'qty','oem_no',source_line->>'oem_no',
   'hs_code',coalesce(source_line->>'hs_code',''),'weight_kg',source_line->'weight_kg','origin',source_line->>'origin',
   'notes',source_line->>'notes','supplier_name',resolved.supplier_name,'buy_price',source_line->'buy_price','line_total',round(qty*buy,2));
  if source_line->>'supplier_name' is distinct from resolved.supplier_name then
   po_line:=po_line||jsonb_build_object('source_supplier_name',source_line->>'supplier_name'); end if;
  group_item:=jsonb_set(group_item,'{lines}',(group_item->'lines')||jsonb_build_array(po_line));
  grouped:=jsonb_set(grouped,array[vendor_key],group_item,true);
 end loop;
 if (select count(*) from jsonb_object_keys(grouped))>100 then raise exception 'SALES_CONFIRMATION_TOO_MANY_SUPPLIERS'; end if;
 insert into sales_confirmation_private.capabilities values(org,actor,v_order_id,pg_catalog.txid_current());
 saved:=public.save_sales_order_atomic(payload,null)->'sales_order';
 delete from sales_confirmation_private.capabilities c where c.organization_id=org and c.actor_id=actor and c.order_id=v_order_id and c.transaction_id=pg_catalog.txid_current();
 for group_item in select value from jsonb_each(grouped) order by key loop
  po_id:='po-'||md5(org::text||':'||v_order_id||':'||(group_item->>'vendor_id'));
  if exists(select 1 from public.purchase_orders p where p.id=po_id) then raise exception 'SALES_CONFIRMATION_PO_ID_COLLISION'; end if;
  po:=public.save_purchase_order_atomic(jsonb_build_object('id',po_id,'vendor_id',group_item->>'vendor_id',
   'supplier_name',group_item->>'supplier_name','supplier_key',regexp_replace(lower(group_item->>'supplier_name'),'[^a-z0-9]+','-','g'),
   'sales_order_id',v_order_id,'sales_order_no',saved->>'sales_order_no','customer_name',saved->>'customer_name',
   'purchase_company',saved->>'purchase_company','currency',saved->>'currency','status','draft','lines',group_item->'lines'),null)->'purchase_order';
  orders:=orders||jsonb_build_array(po);
 end loop;
 result:=jsonb_build_object('sales_order',saved,'purchase_orders',orders,'replayed',false);
 insert into sales_confirmation_private.receipts(organization_id,decision_id,actor_id,order_id,request_payload,receipt) values(org,decision_id,actor,v_order_id,request,result);
 return result;
end;
$function$;
revoke all on function public.confirm_sales_order_with_purchases_safe(jsonb,uuid) from public,anon,authenticated,service_role;
grant execute on function public.confirm_sales_order_with_purchases_safe(jsonb,uuid) to authenticated,service_role;
