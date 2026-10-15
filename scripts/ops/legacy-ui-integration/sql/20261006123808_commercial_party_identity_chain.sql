-- No backfill, source-order mutation, grant expansion or production rollout.
-- Preserve exact RPC behavior/ACLs except passing party IDs to the row guard.
set local lock_timeout='5s';

create function invoice_money_private.resolve_party(kind text, org uuid, candidate uuid, snapshot_name text)
returns uuid language plpgsql security invoker set search_path='' as $$
declare ids uuid[];
begin
  if kind='customer' then
    select array_agg(c.id order by c.id) into ids from public.customers c
      where c.organization_id=org and
        (case when candidate is not null then c.id=candidate else
          nullif(trim(snapshot_name),'') is not null and
          (lower(trim(c.display_name))=lower(trim(snapshot_name)) or lower(trim(c.company_name))=lower(trim(snapshot_name))) end);
  elsif kind='vendor' then
    select array_agg(v.id order by v.id) into ids from public.vendors v
      where v.organization_id=org and
        (case when candidate is not null then v.id=candidate else
          nullif(trim(snapshot_name),'') is not null and
          (lower(trim(v.display_name))=lower(trim(snapshot_name)) or lower(trim(v.company_name))=lower(trim(snapshot_name))) end);
  else raise exception 'COMMERCIAL_PARTY_KIND_INVALID';
  end if;
  if coalesce(cardinality(ids),0)<>1 then raise exception 'COMMERCIAL_PARTY_REQUIRED_OR_AMBIGUOUS'; end if;
  return ids[1];
end;
$$;
revoke all on function invoice_money_private.resolve_party(text,uuid,uuid,text) from public,anon,authenticated,service_role;

create function invoice_money_private.source_document_party(kind text, org uuid, doc jsonb)
returns uuid language plpgsql security invoker set search_path='' as $$
declare source_ids text[]; source_id text; source_row record; candidate uuid; party uuid;
begin
  -- Include EVERY source referenced by a merged document, including its lines.
  select array_agg(distinct id order by id) into source_ids from (
    select nullif(trim(doc->>case when kind='invoice' then 'sales_order_id' else 'purchase_order_id' end),'') as id
    union all
    select nullif(trim(value),'') from jsonb_array_elements_text(coalesce(doc->'sales_order_ids','[]')) where kind='invoice'
    union all
    select nullif(trim(value->>case when kind='invoice' then 'sales_order_id' else 'purchase_order_id' end),'')
      from jsonb_array_elements(coalesce(doc->'lines','[]'))
  ) s where id is not null;
  if coalesce(cardinality(source_ids),0)=0 then raise exception 'COMMERCIAL_SOURCE_REQUIRED'; end if;
  foreach source_id in array source_ids loop
    if kind='invoice' then
      select o.customer_id as party_id,o.customer_name as party_name into source_row
        from public.sales_orders o where o.organization_id=org and o.id=source_id for share;
    elsif kind='bill' then
      select o.vendor_id as party_id,o.supplier_name as party_name into source_row
        from public.purchase_orders o where o.organization_id=org and o.id=source_id for share;
    else raise exception 'COMMERCIAL_DOCUMENT_KIND_INVALID'; end if;
    if not found then raise exception 'COMMERCIAL_SOURCE_NOT_FOUND'; end if;
    candidate:=invoice_money_private.resolve_party(case when kind='invoice' then 'customer' else 'vendor' end,
      org,source_row.party_id,source_row.party_name);
    if party is not null and party is distinct from candidate then raise exception 'COMMERCIAL_MERGE_PARTY_MISMATCH'; end if;
    party:=candidate;
  end loop;
  return party;
end;
$$;
revoke all on function invoice_money_private.source_document_party(text,uuid,jsonb) from public,anon,authenticated,service_role;

create function invoice_money_private.guard_party_chain()
returns trigger language plpgsql security invoker set search_path='' as $$
declare doc jsonb:=to_jsonb(new); parent jsonb; party uuid; supplied uuid; kind text; canonical_name text; old_doc jsonb;
begin
  kind:=case when tg_table_name in ('invoices','payments_received') then 'customer' else 'vendor' end;
  supplied:=nullif(doc->>case when kind='customer' then 'customer_id' else 'vendor_id' end,'')::uuid;
  if tg_table_name in ('invoices','bills') then
    party:=invoice_money_private.source_document_party(case when kind='customer' then 'invoice' else 'bill' end,new.organization_id,doc);
  elsif tg_table_name='payments_received' then
    select to_jsonb(i) into parent from public.invoices i where i.organization_id=new.organization_id and i.id=new.invoice_id for update;
    if not found then raise exception 'COMMERCIAL_PAYMENT_PARENT_NOT_FOUND'; end if;
    party:=invoice_money_private.source_document_party('invoice',new.organization_id,parent);
    if nullif(parent->>'customer_id','')::uuid is not null and (parent->>'customer_id')::uuid is distinct from party then
      raise exception 'COMMERCIAL_PAYMENT_PARENT_PARTY_MISMATCH'; end if;
  elsif tg_table_name='payments_made' then
    select to_jsonb(b) into parent from public.bills b where b.organization_id=new.organization_id and b.id=new.bill_id for update;
    if not found then raise exception 'COMMERCIAL_PAYMENT_PARENT_NOT_FOUND'; end if;
    party:=invoice_money_private.source_document_party('bill',new.organization_id,parent);
    if nullif(parent->>'vendor_id','')::uuid is not null and (parent->>'vendor_id')::uuid is distinct from party then
      raise exception 'COMMERCIAL_PAYMENT_PARENT_PARTY_MISMATCH'; end if;
  else raise exception 'COMMERCIAL_PARTY_TABLE_INVALID'; end if;
  if supplied is not null and supplied is distinct from party then raise exception 'COMMERCIAL_PARTY_SOURCE_MISMATCH'; end if;
  if tg_op='UPDATE' then
    old_doc:=to_jsonb(old);
    if old.organization_id is distinct from new.organization_id then raise exception 'COMMERCIAL_PARTY_TENANT_IMMUTABLE'; end if;
    if old_doc->>'status' in ('confirmed','open','paid') and
       nullif(old_doc->>case when kind='customer' then 'customer_id' else 'vendor_id' end,'')::uuid is not null and
       (old_doc->>case when kind='customer' then 'customer_id' else 'vendor_id' end)::uuid is distinct from party then
      raise exception 'COMMERCIAL_POSTED_PARTY_IMMUTABLE'; end if;
  end if;
  if kind='customer' then
    select coalesce(nullif(trim(c.display_name),''),c.company_name) into canonical_name from public.customers c
      where c.organization_id=new.organization_id and c.id=party;
    new:=jsonb_populate_record(new,jsonb_build_object('customer_id',party,'customer_name',canonical_name));
  else
    select coalesce(nullif(trim(v.display_name),''),v.company_name) into canonical_name from public.vendors v
      where v.organization_id=new.organization_id and v.id=party;
    new:=jsonb_populate_record(new,jsonb_build_object('vendor_id',party,'supplier_name',canonical_name));
  end if;
  return new;
end;
$$;
revoke all on function invoice_money_private.guard_party_chain() from public,anon,authenticated,service_role;

create trigger trg_aa_invoice_party_chain before insert or update on public.invoices
  for each row execute function invoice_money_private.guard_party_chain();
create trigger trg_aa_bill_party_chain before insert or update on public.bills
  for each row execute function invoice_money_private.guard_party_chain();
create trigger trg_aa_received_party_chain before insert or update on public.payments_received
  for each row execute function invoice_money_private.guard_party_chain();
create trigger trg_aa_made_party_chain before insert or update on public.payments_made
  for each row execute function invoice_money_private.guard_party_chain();

-- Guarded, minimal edits to retained RPCs; CREATE OR REPLACE preserves ACLs.
do $$ declare spec record; definition text; patched text; anchor text; replacement text;
begin
  for spec in select * from (values
    ('save_invoice_atomic','0ad1d36724e332200a6a4649258e1e35','customer_id','v_sales_order_ids'),
    ('save_bill_atomic','139ff0c5735b55fe33c18c00b92f6122','vendor_id','v_purchase_order_id'),
    ('save_payment_received_atomic','22f8f870793b35cb30d35ed2cc1f16db','customer_id','v_invoice.id'),
    ('save_payment_made_atomic','23d1166131b67031cc2c1d5f45e04e3f','vendor_id','v_bill.id')
  ) as s(name,hash,field,value_anchor) loop
    definition:=pg_get_functiondef(format('public.%I(jsonb,text)',spec.name)::regprocedure);
    if md5(definition)<>spec.hash then raise exception 'COMMERCIAL_PARTY_RPC_BASELINE_CHANGED:%',spec.name; end if;
    anchor:=E'    '||spec.value_anchor||E',\n';
    replacement:=anchor||'    nullif(payload->>'''||spec.field||E''','''')::uuid,\n';
    if (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 then
      raise exception 'COMMERCIAL_PARTY_RPC_VALUE_ANCHOR_CHANGED:%',spec.name; end if;
    patched:=replace(definition,anchor,replacement);
    anchor:=case spec.name when 'save_invoice_atomic' then E'    sales_order_ids,\n'
      when 'save_bill_atomic' then E'    purchase_order_id,\n'
      when 'save_payment_received_atomic' then E'    invoice_id,\n' else E'    bill_id,\n' end;
    if (length(patched)-length(replace(patched,anchor,'')))/length(anchor)<>1 then
      raise exception 'COMMERCIAL_PARTY_RPC_COLUMN_ANCHOR_CHANGED:%',spec.name; end if;
    patched:=replace(patched,anchor,anchor||'    '||spec.field||E',\n');
    anchor:=E'        currency = excluded.currency,\n';
    if (length(patched)-length(replace(patched,anchor,'')))/length(anchor)<>1 then
      raise exception 'COMMERCIAL_PARTY_RPC_UPDATE_ANCHOR_CHANGED:%',spec.name; end if;
    patched:=replace(patched,anchor,anchor||'        '||spec.field||' = excluded.'||spec.field||E',\n');
    execute patched;
  end loop;
end $$;
