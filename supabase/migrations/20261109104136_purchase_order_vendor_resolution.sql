-- Resolve supplier snapshots only when projecting NEW purchase documents.
-- No source orders, historical documents or supplier-price eligibility change.
set local lock_timeout='5s';
set local statement_timeout='30s';

create schema if not exists purchase_vendor_resolution_private;
revoke all on schema purchase_vendor_resolution_private from public,anon,authenticated,service_role;

create unique index if not exists uq_vendors_id_organization on public.vendors(id,organization_id);
create table purchase_vendor_resolution_private.vendor_aliases (
 organization_id uuid not null references public.organizations(id) on delete cascade,
 alias_supplier_name text not null check(length(btrim(alias_supplier_name)) between 1 and 180 and alias_supplier_name!~'[[:cntrl:]]'),
 alias_key text generated always as(lower(regexp_replace(btrim(alias_supplier_name),'[[:space:]]+',' ','g'))) stored,
 vendor_id uuid not null,
 is_active boolean not null default true,
 reason text not null check(length(btrim(reason)) between 3 and 500),
 created_at timestamptz not null default now(),
 primary key(organization_id,alias_key),
 foreign key(vendor_id,organization_id) references public.vendors(id,organization_id) on delete restrict
);
alter table purchase_vendor_resolution_private.vendor_aliases enable row level security;
revoke all on purchase_vendor_resolution_private.vendor_aliases from public,anon,authenticated,service_role;

create function purchase_vendor_resolution_private.resolve_one(input_org uuid,input_supplier text)
returns table(vendor_id uuid,supplier_name text)
language plpgsql stable security invoker set search_path='' as $function$
declare ids uuid[];target uuid;label text;requested text:=btrim(input_supplier);
begin
 if input_org is null or requested is null or length(requested) not between 1 and 180 or requested~'[[:cntrl:]]' then
  raise exception 'PURCHASE_VENDOR_INPUT_INVALID' using errcode='22023';
 end if;
 -- Explicit aliases take precedence for new projections, even while the old
 -- vendor cards still exist for their historical bills and payments.
 select a.vendor_id into target from purchase_vendor_resolution_private.vendor_aliases a
 where a.organization_id=input_org and a.is_active
  and a.alias_key=lower(regexp_replace(requested,'[[:space:]]+',' ','g'));
 if target is null then
  select array_agg(v.id order by v.id) into ids from public.vendors v
  where v.organization_id=input_org and
   (lower(btrim(coalesce(v.display_name,'')))=lower(requested) or lower(btrim(coalesce(v.company_name,'')))=lower(requested));
  if coalesce(cardinality(ids),0)=0 then raise exception 'PURCHASE_VENDOR_NOT_FOUND';end if;
  if cardinality(ids)<>1 then raise exception 'PURCHASE_VENDOR_AMBIGUOUS';end if;
  target:=ids[1];
 end if;
 select coalesce(nullif(btrim(v.display_name),''),nullif(btrim(v.company_name),'')) into label
 from public.vendors v where v.id=target and v.organization_id=input_org;
 if label is null or length(label)>180 then raise exception 'PURCHASE_VENDOR_TARGET_INVALID';end if;
 return query select target,label;
end;
$function$;
revoke all on function purchase_vendor_resolution_private.resolve_one(uuid,text) from public,anon,authenticated,service_role;

create function public.resolve_purchase_order_vendors(input_suppliers text[])
returns jsonb language plpgsql stable security definer set search_path='' set statement_timeout='8s' as $function$
declare org uuid:=public.current_profile_org_id();requested text;resolved record;result jsonb:='[]';
begin
 if auth.uid() is null or org is null or not exists(
  select 1 from public.profiles p where p.id=auth.uid() and p.organization_id=org and p.is_active
   and p.role in ('admin','sales','superadmin')) then raise exception 'PURCHASE_VENDOR_STAFF_REQUIRED' using errcode='42501';end if;
 if input_suppliers is null or coalesce(array_ndims(input_suppliers),0)<>1 or array_lower(input_suppliers,1)<>1
  or cardinality(input_suppliers) not between 1 and 100
  or exists(select 1 from unnest(input_suppliers) n where n is null or length(btrim(n)) not between 1 and 180 or n~'[[:cntrl:]]')
 then raise exception 'PURCHASE_VENDOR_INPUT_INVALID' using errcode='22023';end if;
 if (select count(distinct lower(regexp_replace(btrim(n),'[[:space:]]+',' ','g'))) from unnest(input_suppliers) n)<>cardinality(input_suppliers)
 then raise exception 'PURCHASE_VENDOR_DUPLICATE_INPUT' using errcode='22023';end if;
 foreach requested in array input_suppliers loop
  requested:=btrim(requested);
  select * into strict resolved from purchase_vendor_resolution_private.resolve_one(org,requested);
  result:=result||jsonb_build_array(jsonb_build_object('requested_supplier_name',requested,'supplier_name',resolved.supplier_name,'vendor_id',resolved.vendor_id));
 end loop;
 return result;
end;
$function$;
revoke all on function public.resolve_purchase_order_vendors(text[]) from public,anon,authenticated,service_role;
grant execute on function public.resolve_purchase_order_vendors(text[]) to authenticated;

-- Patch the exact deployed legacy save boundary, retaining its financial math,
-- downstream guards, transaction behavior, ownership and execute privileges.
-- A different baseline must be reviewed instead of replacing modern finance.
do $migration$
declare definition text;anchor text;replacement text;
begin
 definition:=pg_get_functiondef('public.save_purchase_order_atomic(jsonb,text)'::regprocedure);
 if md5(definition)<>'438afcf7da36ba5f8b7103d14e7b3615' then raise exception 'PURCHASE_VENDOR_SAVE_BASELINE_CHANGED';end if;
 anchor:=E'  v_line_count integer := 0;';
 replacement:=anchor||E'\n  v_supplied_vendor_id uuid := nullif(btrim(coalesce(payload->>''vendor_id'','''')) ,'''')::uuid;\n  v_vendor_id uuid;\n  v_bound public.purchase_orders%rowtype;\n  v_resolved record;';
 if (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 then raise exception 'PURCHASE_VENDOR_DECLARATION_ANCHOR_CHANGED';end if;
 definition:=replace(definition,anchor,replacement);
 anchor:=$anchor$  if v_supplier_name <> '' and lower(v_supplier_name) <> 'unassigned supplier' and not exists (
    select 1
    from public.vendors v
    where v.organization_id = v_org_id
      and (
        lower(trim(coalesce(v.display_name, ''))) = lower(v_supplier_name)
        or lower(trim(coalesce(v.company_name, ''))) = lower(v_supplier_name)
      )
  ) then
    raise exception 'Vendor was not found';
  end if;$anchor$;
 replacement:=$replacement$  -- Lock an existing binding before resolving any alias. In particular,
  -- posted vendor IDs and labels remain historical document snapshots.
  select * into v_bound from public.purchase_orders po
  where po.organization_id=v_org_id and po.id=v_order_id for update;
  if (v_bound.id is not null and lower(coalesce(v_bound.status,'draft')) in ('open','closed')) or
     (v_bound.vendor_id is not null and
      (v_supplied_vendor_id is null or v_supplied_vendor_id=v_bound.vendor_id) and
       lower(btrim(v_supplier_name))=lower(btrim(v_bound.supplier_name))) then
    if v_supplied_vendor_id is not null and v_supplied_vendor_id is distinct from v_bound.vendor_id then
      raise exception 'PURCHASE_VENDOR_POSTED_ID_IMMUTABLE';
    end if;
    if lower(coalesce(v_bound.status,'draft')) in ('open','closed') and
       lower(btrim(v_supplier_name)) is distinct from lower(btrim(v_bound.supplier_name)) then
      raise exception 'PURCHASE_VENDOR_POSTED_NAME_IMMUTABLE';
    end if;
    if v_bound.vendor_id is not null and not exists(select 1 from public.vendors v where v.id=v_bound.vendor_id and v.organization_id=v_org_id) then
      raise exception 'PURCHASE_VENDOR_BOUND_SCOPE_INVALID';
    end if;
    v_vendor_id:=v_bound.vendor_id;
    v_supplier_name:=v_bound.supplier_name;
  elsif v_supplier_name='' or lower(v_supplier_name)='unassigned supplier' then
    if v_supplied_vendor_id is not null then raise exception 'PURCHASE_VENDOR_INPUT_INVALID';end if;
    v_vendor_id:=null;
  else
    select * into strict v_resolved from purchase_vendor_resolution_private.resolve_one(v_org_id,v_supplier_name);
    if v_supplied_vendor_id is not null and v_supplied_vendor_id<>v_resolved.vendor_id then
      raise exception 'PURCHASE_VENDOR_IDENTITY_MISMATCH';
    end if;
    v_vendor_id:=v_resolved.vendor_id;
    v_supplier_name:=v_resolved.supplier_name;
  end if;$replacement$;
 if (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 then raise exception 'PURCHASE_VENDOR_VALIDATION_ANCHOR_CHANGED';end if;
 definition:=replace(definition,anchor,replacement);
 anchor:=E'    organization_id,\n    supplier_name,';
 if (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 then raise exception 'PURCHASE_VENDOR_COLUMN_ANCHOR_CHANGED';end if;
 definition:=replace(definition,anchor,E'    organization_id,\n    vendor_id,\n    supplier_name,');
 anchor:=E'    v_org_id,\n    v_supplier_name,';
 if (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 then raise exception 'PURCHASE_VENDOR_VALUE_ANCHOR_CHANGED';end if;
 definition:=replace(definition,anchor,E'    v_org_id,\n    v_vendor_id,\n    v_supplier_name,');
 anchor:='    set supplier_name = excluded.supplier_name,';
 if (length(definition)-length(replace(definition,anchor,'')))/length(anchor)<>1 then raise exception 'PURCHASE_VENDOR_UPDATE_ANCHOR_CHANGED';end if;
 definition:=replace(definition,anchor,E'    set supplier_name = excluded.supplier_name,\n        vendor_id = excluded.vendor_id,');
 execute definition;
end;
$migration$;
