CREATE OR REPLACE FUNCTION public.cloud_current_supplier_price_options_batch(input_requests jsonb)
 RETURNS TABLE(request_index integer, has_published_scope boolean, options jsonb)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_organization_id uuid;
begin
  if auth.uid() is null then
    raise exception 'SUPPLIER_PRICE_AUTH_REQUIRED';
  end if;
  v_organization_id := public.current_profile_org_id();
  if v_organization_id is null then
    raise exception 'SUPPLIER_PRICE_ORGANIZATION_REQUIRED';
  end if;
  if pg_catalog.jsonb_typeof(input_requests) is distinct from 'array' then
    raise exception 'SUPPLIER_PRICE_BATCH_SIZE_INVALID';
  end if;
  if pg_catalog.jsonb_array_length(input_requests) not between 1 and 25 then
    raise exception 'SUPPLIER_PRICE_BATCH_SIZE_INVALID';
  end if;
  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(input_requests) as item(value)
    where pg_catalog.jsonb_typeof(item.value) is distinct from 'object'
      or pg_catalog.jsonb_typeof(item.value->'code') is distinct from 'string'
      or pg_catalog.jsonb_typeof(item.value->'brand') is distinct from 'string'
      or pg_catalog.length(pg_catalog.btrim(item.value->>'code')) not between 1 and 100
      or pg_catalog.length(pg_catalog.btrim(item.value->>'brand')) not between 1 and 100
  ) then
    raise exception 'SUPPLIER_PRICE_BATCH_INPUT_INVALID';
  end if;

  return query
  with requested as materialized (
    select (item.ordinality - 1)::integer as row_index,
      pg_catalog.btrim(item.value->>'code') as code,
      pg_catalog.btrim(item.value->>'brand') as brand,
      case when pg_catalog.jsonb_typeof(item.value->'quantity') = 'number' then
        case when (item.value->>'quantity')::numeric between 1 and 2147483647
          and (item.value->>'quantity')::numeric = trunc((item.value->>'quantity')::numeric)
          then ((item.value->>'quantity')::numeric)::integer end
      end as quantity
    from pg_catalog.jsonb_array_elements(input_requests) with ordinality as item(value, ordinality)
  ), scoped as materialized (
    select r.*,
      exists (
        select 1
        from public.brands b
        join public.supplier_current_price_pointers ptr
          on ptr.organization_id=b.organization_id and ptr.brand_id=b.id
        where b.organization_id=v_organization_id
          and b.normalized_name=supplier_price_validation_internal.canonical_automotive_brand_key(r.brand,r.code)
      ) or exists (
        select 1 from public.brands b join supplier_manual_price_internal.entries m
          on m.organization_id=b.organization_id and m.brand_id=b.id
        join public.suppliers su on su.organization_id=m.organization_id and su.id=m.supplier_id and su.is_active and su.price_usage_enabled
        where b.organization_id=v_organization_id and b.normalized_name=supplier_price_validation_internal.canonical_automotive_brand_key(r.brand,r.code)
          and m.exact_code=public.normalize_catalog_product_code(r.code) and m.active and m.valid_from<=current_date
      ) as published_scope
    from requested r
  )
  select s.row_index, s.published_scope,
    coalesce(p.options, '[]'::jsonb) as options
  from scoped s
  left join lateral (
    select pg_catalog.jsonb_agg(case when o.applied_min_quantity is null then pg_catalog.to_jsonb(o) - 'applied_min_quantity' else pg_catalog.to_jsonb(o) end
      order by o.buy_price, o.price_date desc, o.supplier_id) as options
    from supplier_price_ingestion_internal.current_supplier_quantity_options(
      v_organization_id,s.code,s.brand,s.quantity) o
  ) p on true
  order by s.row_index;
end;
$function$
;


create or replace function public.cloud_quote_supplier_quantity_options(
  input_code text,
  input_brand text default '',
  input_customer_type text default 'A',
  input_margin_a numeric default 0.10,
  input_margin_b numeric default 0.15,
  input_quantity integer default null
)
returns table (
  supplier_id uuid,supplier_name text,buy_price numeric,price_date date,
  sell_price numeric,notes text,moq integer,order_multiple integer,stock_qty integer,valid_to date,applied_min_quantity integer
)
language sql
stable
security definer
set search_path to ''
as $function$
  select o.supplier_id,o.supplier_name,o.buy_price,o.price_date,
    round(o.buy_price*(1+coalesce(case when upper(coalesce(input_customer_type,'A'))='B'
      then input_margin_b else input_margin_a end,0)),2),o.notes,o.moq,o.order_multiple,o.stock_qty,o.valid_to,o.applied_min_quantity
  from supplier_price_ingestion_internal.current_supplier_quantity_options(public.current_profile_org_id(),input_code,input_brand,input_quantity) o
 where auth.uid() is not null;
$function$;

revoke all on function public.cloud_quote_supplier_quantity_options(text,text,text,numeric,numeric,integer) from public,anon,authenticated,service_role;
grant execute on function public.cloud_quote_supplier_quantity_options(text,text,text,numeric,numeric,integer) to authenticated,service_role;

-- Use the saved purchase line quantity in the atomic supplier reassignment.
do $migration$
declare
  definition text := pg_get_functiondef('public.reassign_purchase_order_supplier_atomic(jsonb)'::regprocedure);
  old_reader text := $match$public.cloud_current_supplier_commercial_options_core(v_org,v_line->>'product_code',v_line->>'brand')$match$;
  new_reader text := $replacement$supplier_price_ingestion_internal.current_supplier_quantity_options(
    v_org,v_line->>'product_code',v_line->>'brand',
    case when (v_line->>'qty')::numeric between 1 and 2147483647
      and (v_line->>'qty')::numeric = trunc((v_line->>'qty')::numeric)
      then ((v_line->>'qty')::numeric)::integer end)$replacement$;
begin
  if strpos(definition,old_reader) = 0 then
    raise exception 'PURCHASE_QUANTITY_READER_DEFINITION_CHANGED';
  end if;
  execute replace(definition,old_reader,new_reader);
end
$migration$;
