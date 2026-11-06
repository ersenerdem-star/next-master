-- Keep saved commercial lines usable after supplier prices are closed to new orders.
-- Evidence is captured beside orders; this migration never writes an order.
create schema if not exists supplier_price_usage_internal;
revoke all on schema supplier_price_usage_internal from public,anon,authenticated,service_role;

create table if not exists supplier_price_usage_internal.preserved_order_lines (
 organization_id uuid not null,
 order_id text not null,
 supplier_id uuid not null,
 line_index integer not null check(line_index>=0),
 disabled_at timestamptz not null,
 commercial_line jsonb not null,
 customer_id uuid,
 customer_name text,
 customer_type text,
 currency text,
 primary key(organization_id,order_id,supplier_id,line_index)
);
alter table supplier_price_usage_internal.preserved_order_lines enable row level security;
revoke all on supplier_price_usage_internal.preserved_order_lines from public,anon,authenticated,service_role;

create or replace function supplier_price_usage_internal.commercial_signature(input_line jsonb)
returns jsonb language sql immutable set search_path='' as $function$
 select jsonb_build_array(
  coalesce(input_line->>'requestedCode',input_line->>'resolvedCode',''),
  coalesce(input_line->>'resolvedCode',input_line->>'requestedCode',''),
  coalesce(input_line->>'brand',''),input_line->'qty',input_line->'requested_qty',
  coalesce(input_line->>'supplier_name',''),input_line->'buy_price',input_line->'sell_price',
  input_line->'c_sell_price',coalesce(input_line->'manual_sell_price','false'::jsonb),
  coalesce(input_line->>'price_date',''),coalesce(input_line->>'selectedSupplierKey',''),
  input_line->'moq',input_line->'order_multiple',input_line->'valid_to');
$function$;
revoke all on function supplier_price_usage_internal.commercial_signature(jsonb) from public,anon,authenticated,service_role;

create or replace function supplier_price_usage_internal.capture_order_lines(input_org uuid,input_supplier uuid)
returns void language plpgsql security definer set search_path='' as $function$
declare disabled_time timestamptz;
begin
 select s.price_usage_disabled_at into disabled_time from public.suppliers s
 where s.organization_id=input_org and s.id=input_supplier and not s.price_usage_enabled;
 if disabled_time is null then raise exception 'SUPPLIER_USAGE_DISABLE_EVIDENCE_REQUIRED';end if;
 delete from supplier_price_usage_internal.preserved_order_lines
 where organization_id=input_org and supplier_id=input_supplier;
 insert into supplier_price_usage_internal.preserved_order_lines
  (organization_id,order_id,supplier_id,line_index,disabled_at,commercial_line,customer_id,customer_name,customer_type,currency)
 select o.organization_id,o.id,s.id,(line.ordinality-1)::integer,disabled_time,
  supplier_price_usage_internal.commercial_signature(line.value),o.customer_id,o.customer_name,o.customer_type,o.currency
 from public.sales_orders o join public.suppliers s on s.id=input_supplier and s.organization_id=o.organization_id
 cross join lateral jsonb_array_elements(case when jsonb_typeof(o.lines)='array' then o.lines else '[]'::jsonb end)
  with ordinality as line(value,ordinality)
 where o.organization_id=input_org and o.created_at<=disabled_time
 and (public.normalize_part_code(line.value->>'supplier_name')=s.normalized_name
  or exists(select 1 from jsonb_array_elements(case when jsonb_typeof(line.value->'supplierOptions')='array'
   then line.value->'supplierOptions' else '[]'::jsonb end) with ordinality opt(value,ordinality)
   where opt.value->>'supplier_id'=s.id::text
    and (coalesce(line.value->>'selectedSupplierKey','')=coalesce(opt.value->>'supplier_name','')||'-'||(opt.ordinality-1)::text
     or (coalesce(line.value->>'selectedSupplierKey','')='' and opt.ordinality=1))));
end;
$function$;
revoke all on function supplier_price_usage_internal.capture_order_lines(uuid,uuid) from public,anon,authenticated,service_role;

create or replace function public.cloud_sales_order_preserved_supplier_lines(
 input_order_id text,input_lines jsonb,input_currency text,input_customer_type text,
 input_customer_id uuid,input_customer_name text
) returns jsonb language plpgsql stable security definer set search_path='' as $function$
declare org uuid; result jsonb;
begin
 org:=public.current_profile_org_id();
 if auth.uid() is null or org is null or not coalesce(public.is_superadmin() or public.profile_has_permission('customers.view'),false)
 then raise exception 'SUPPLIER_USAGE_CONFIRMATION_ADMIN_REQUIRED';end if;
 if not coalesce(public.is_superadmin() or public.current_profile_role()='admin',false)
 and (input_customer_id is null or not coalesce(public.can_access_customer(input_customer_id),false))
 then raise exception 'SUPPLIER_USAGE_CONFIRMATION_CUSTOMER_DENIED';end if;
 if jsonb_typeof(input_lines) is distinct from 'array' or jsonb_array_length(input_lines)>10000
 or exists(select 1 from jsonb_array_elements(input_lines) x where jsonb_typeof(x) is distinct from 'object')
 then raise exception 'SUPPLIER_USAGE_CONFIRMATION_LINES_INVALID';end if;

 with lines as materialized (
  select (l.ordinality-1)::integer line_index,l.value from jsonb_array_elements(input_lines) with ordinality l(value,ordinality)
 ), disabled as materialized (
  select distinct l.line_index,s.id supplier_id,s.price_usage_disabled_at,l.value
  from lines l join public.suppliers s on s.organization_id=org and not s.price_usage_enabled
  where public.normalize_part_code(l.value->>'supplier_name')=s.normalized_name
   or exists(select 1 from jsonb_array_elements(case when jsonb_typeof(l.value->'supplierOptions')='array'
    then l.value->'supplierOptions' else '[]'::jsonb end) with ordinality opt(value,ordinality)
    where opt.value->>'supplier_id'=s.id::text
      and (coalesce(l.value->>'selectedSupplierKey','')=coalesce(opt.value->>'supplier_name','')||'-'||(opt.ordinality-1)::text
       or (coalesce(l.value->>'selectedSupplierKey','')='' and opt.ordinality=1)))
 ), preserved as materialized (
  select d.line_index,d.supplier_id from disabled d
  join supplier_price_usage_internal.preserved_order_lines p on p.organization_id=org
   and p.order_id=input_order_id and p.supplier_id=d.supplier_id and p.line_index=d.line_index
   and p.disabled_at=d.price_usage_disabled_at
  join public.sales_orders o on o.id=p.order_id and o.organization_id=p.organization_id
  where o.created_at<=p.disabled_at
   and p.customer_id is not distinct from input_customer_id and o.customer_id is not distinct from p.customer_id
   and p.customer_name is not distinct from input_customer_name and o.customer_name is not distinct from p.customer_name
   and p.customer_type is not distinct from input_customer_type and o.customer_type is not distinct from p.customer_type
   and p.currency is not distinct from input_currency and o.currency is not distinct from p.currency
   and p.commercial_line=supplier_price_usage_internal.commercial_signature(d.value)
   and p.commercial_line=supplier_price_usage_internal.commercial_signature(o.lines->d.line_index)
 )
 select jsonb_build_object(
  'preserved_indices',coalesce((select jsonb_agg(distinct p.line_index order by p.line_index) from preserved p),'[]'::jsonb),
  'disabled_indices',coalesce((select jsonb_agg(distinct d.line_index order by d.line_index) from disabled d
   where not exists(select 1 from preserved p where p.line_index=d.line_index and p.supplier_id=d.supplier_id)),'[]'::jsonb)) into result;
 return result;
end;
$function$;
revoke all on function public.cloud_sales_order_preserved_supplier_lines(text,jsonb,text,text,uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.cloud_sales_order_preserved_supplier_lines(text,jsonb,text,text,uuid,text) to authenticated;
