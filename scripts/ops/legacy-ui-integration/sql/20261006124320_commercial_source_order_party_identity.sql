-- Source roots of the commercial party chain. No backfill or new grants.
set local lock_timeout='5s';
create function invoice_money_private.guard_source_party()
returns trigger language plpgsql security invoker set search_path='' as $$
declare doc jsonb:=to_jsonb(new); old_doc jsonb; kind text; field text; name_field text;
  candidate uuid; party uuid; canonical_name text;
begin
  kind:=case when tg_table_name='sales_orders' then 'customer' else 'vendor' end;
  field:=case when kind='customer' then 'customer_id' else 'vendor_id' end;
  name_field:=case when kind='customer' then 'customer_name' else 'supplier_name' end;
  candidate:=nullif(doc->>field,'')::uuid;
  -- Only the existing explicit unassigned draft PO case may lack a party.
  -- A duplicate/unknown registered label must never choose an arbitrary row.
  if kind='vendor' and candidate is null and doc->>'status'='draft' and
     lower(trim(coalesce(doc->>name_field,''))) in ('','unassigned supplier') then
    party:=null;
  else
    party:=invoice_money_private.resolve_party(kind,new.organization_id,candidate,doc->>name_field);
  end if;
  if tg_op='UPDATE' then
    old_doc:=to_jsonb(old);
    if old.organization_id is distinct from new.organization_id then raise exception 'COMMERCIAL_PARTY_TENANT_IMMUTABLE'; end if;
    if old_doc->>'status' in ('confirmed','open','closed') and nullif(old_doc->>field,'')::uuid is not null and
       (old_doc->>field)::uuid is distinct from party then raise exception 'COMMERCIAL_POSTED_PARTY_IMMUTABLE'; end if;
  end if;
  if party is not null then
    if kind='customer' then
      select coalesce(nullif(trim(c.display_name),''),c.company_name) into canonical_name
        from public.customers c where c.organization_id=new.organization_id and c.id=party;
    else
      select coalesce(nullif(trim(v.display_name),''),v.company_name) into canonical_name
        from public.vendors v where v.organization_id=new.organization_id and v.id=party;
    end if;
    new:=jsonb_populate_record(new,jsonb_build_object(field,party,name_field,canonical_name));
  end if;
  return new;
end $$;
revoke all on function invoice_money_private.guard_source_party() from public,anon,authenticated,service_role;
create trigger trg_aa_sales_source_party before insert or update on public.sales_orders
  for each row execute function invoice_money_private.guard_source_party();
create trigger trg_aa_purchase_source_party before insert or update on public.purchase_orders
  for each row execute function invoice_money_private.guard_source_party();

-- Minimal patches to the already verified source RPCs, retaining their
-- authorization, lock order, confirmation receipts, financial math and ACLs.
do $$ declare spec record; definition text; patched text; anchor text; replacement text;
begin
  for spec in select * from (values
    ('order_commit_private','save_sales_order','168b1cec1aa5fffce8d82edea26f9bca','customer_id','customer_name','v_customer_name','        '),
    ('public','save_purchase_order_atomic','96d14fd25b51f2af6c3b0694dc89a4f8','vendor_id','supplier_name','v_supplier_name','    set ')
  ) as s(schema_name,name,hash,field,name_field,value_anchor,update_indent) loop
    definition:=pg_get_functiondef(format('%I.%I(jsonb,text)',spec.schema_name,spec.name)::regprocedure);
    if md5(definition)<>spec.hash then raise exception 'COMMERCIAL_SOURCE_RPC_BASELINE_CHANGED:%',spec.name; end if;
    anchor:=E'    '||spec.value_anchor||E',\n';
    replacement:=anchor||'    coalesce(nullif(payload->>'''||spec.field||''','''')::uuid, case when lower(trim(coalesce(v_existing.'||spec.name_field||
      ','''')))=lower('||spec.value_anchor||') then v_existing.'||spec.field||E' else null end),\n';
    if (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 then
      raise exception 'COMMERCIAL_SOURCE_VALUE_ANCHOR_CHANGED:%',spec.name; end if;
    patched:=replace(definition,anchor,replacement);
    anchor:=E'    '||spec.name_field||E',\n';
    if (length(patched)-length(replace(patched,anchor,'')))/length(anchor)<>1 then
      raise exception 'COMMERCIAL_SOURCE_COLUMN_ANCHOR_CHANGED:%',spec.name; end if;
    patched:=replace(patched,anchor,anchor||'    '||spec.field||E',\n');
    anchor:=spec.update_indent||spec.name_field||' = excluded.'||spec.name_field||E',\n';
    if (length(patched)-length(replace(patched,anchor,'')))/length(anchor)<>1 then
      raise exception 'COMMERCIAL_SOURCE_UPDATE_ANCHOR_CHANGED:%',spec.name; end if;
    patched:=replace(patched,anchor,anchor||'        '||spec.field||' = excluded.'||spec.field||E',\n');
    execute patched;
  end loop;
end $$;
