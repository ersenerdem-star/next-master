-- Normalize only report display; never modify historical sales orders.
-- Read historical sales order snapshots, including draft orders. Never update orders.
-- SECURITY INVOKER preserves the sales_orders/customers RLS and office-IP policy.
create or replace function public.reporting_sales_orders_brand_rows(
 input_org uuid, input_from date default null, input_to date default null,
 input_customer uuid default null, input_status text default null, input_brand text default null,
 input_customer_name text default null
) returns table (
 order_id text, order_no text, order_date text, customer_id uuid, customer_name text,
 status text, brand text, product_code text, requested_code text, description text,
 quantity numeric, unit_price numeric, amount numeric, currency text, line_index bigint
) language plpgsql stable security invoker set search_path = '' as $$
begin
 if auth.uid() is null or input_org is distinct from public.current_profile_org_id()
   or not coalesce(public.current_profile_role() = 'admin' or
     (public.current_profile_role() = 'sales'
      and public.profile_has_permission('reports.view')
      and public.profile_has_permission('sales.orders')), false)
 then raise exception 'SALES_ORDER_REPORT_ACCESS_DENIED'; end if;
 if input_from is not null and input_to is not null and input_from > input_to
 then raise exception 'SALES_ORDER_REPORT_INVALID_DATES'; end if;

 return query
 with customer_names as materialized (
   select lower(trim(c.display_name)) n, min(c.id::text)::uuid id, count(*) n_matches
   from public.customers c
   where c.organization_id = input_org and nullif(trim(c.display_name),'') is not null
   group by lower(trim(c.display_name))
 ), brand_names as materialized (
   select lower(trim(b.name)) normalized, min(trim(b.name)) canonical
   from public.brands b
   where b.organization_id = input_org and nullif(trim(b.name),'') is not null
   group by lower(trim(b.name))
 ), orders as (
   select s.*, case when s.customer_id is not null then s.customer_id
     when cn.n_matches = 1 and
       (public.current_profile_role()='admin' or public.current_profile_customer_scope_mode()='all')
       then cn.id else null end as report_customer_id
   from public.sales_orders s
   left join customer_names cn on cn.n = lower(trim(s.customer_name))
   where s.organization_id = input_org
    and (input_from is null or s.quote_date >= input_from::text)
    and (input_to is null or s.quote_date <= input_to::text)
    and (nullif(trim(input_status),'') is null or s.status = trim(input_status))
 ), lines as (
   select o.*, l.value item, coalesce(l.ordinality,0)::bigint ordinal
   from orders o
   left join lateral pg_catalog.jsonb_array_elements(
     case when pg_catalog.jsonb_typeof(o.lines)='array' then o.lines else '[]'::jsonb end
   ) with ordinality l(value,ordinality) on true
   where (input_customer is null or o.report_customer_id = input_customer)
    and (nullif(trim(input_customer_name),'') is null
      or (input_customer is null and o.report_customer_id is null
       and lower(trim(o.customer_name)) = lower(trim(input_customer_name))))
    and (public.current_profile_role()='admin' or public.current_profile_customer_scope_mode()='all'
      or (o.report_customer_id is not null and public.can_access_customer(o.report_customer_id)))
 ), parsed as (
   select l.*,
     coalesce(bn.canonical, nullif(upper(trim(l.item->>'brand')),''), '(Marka belirtilmemiş)') line_brand,
     case when coalesce(l.item->>'qty','') ~ '^-?[0-9]+(\.[0-9]+)?$' then (l.item->>'qty')::numeric else null end line_qty,
     case when coalesce(l.item->>'sell_price','') ~ '^-?[0-9]+(\.[0-9]+)?$' then (l.item->>'sell_price')::numeric else null end line_price
   from lines l
   left join brand_names bn on bn.normalized = lower(trim(l.item->>'brand'))
 )
 select p.id, p.sales_order_no, p.quote_date, p.report_customer_id, p.customer_name,
   p.status, p.line_brand,
   coalesce(nullif(trim(p.item->>'resolvedCode'),''),nullif(trim(p.item->>'requestedCode'),''),''),
   coalesce(p.item->>'requestedCode',''), coalesce(p.item->>'description',''),
   p.line_qty, p.line_price, p.line_qty * p.line_price,
   coalesce(nullif(trim(p.currency),''),'(Para birimi belirtilmemiş)'), p.ordinal
 from parsed p
 where nullif(trim(input_brand),'') is null or lower(p.line_brand) = lower(trim(input_brand));
end;
$$;

notify pgrst, 'reload schema';
