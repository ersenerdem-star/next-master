-- Guard only the automatic full-order conversion. Existing invoices and the
-- separate manual invoice edit path are not rewritten or restricted.
create function public.create_full_sales_invoices_atomic(input_payloads jsonb, input_order_versions jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := public.current_profile_org_id();
  v_role text := public.current_profile_role();
  v_payload jsonb;
  v_id text;
  v_all_ids text[];
  v_seen text[] := '{}'::text[];
  v_ids text[];
  v_order public.sales_orders%rowtype;
  v_saved jsonb;
  v_results jsonb := '[]'::jsonb;
begin
  if v_org is null or not coalesce(v_role = 'admin' or public.is_superadmin(), false) then
    raise exception 'Only active admin users can save invoices';
  end if;
  if pg_catalog.jsonb_typeof(input_payloads) is distinct from 'array'
     or pg_catalog.jsonb_array_length(input_payloads) = 0 then
    raise exception 'At least one invoice is required';
  end if;

  -- Sorted exclusive locks coordinate with the existing invoice identity
  -- trigger's FOR SHARE locks and serialise concurrent automatic conversions.
  select pg_catalog.array_agg(distinct ids.id order by ids.id) into v_all_ids
  from pg_catalog.jsonb_array_elements(input_payloads) payload(value)
  cross join lateral (
    select nullif(pg_catalog.btrim(payload.value->>'sales_order_id'), '') as id
    union all
    select nullif(pg_catalog.btrim(q.value), '')
    from pg_catalog.jsonb_array_elements_text(coalesce(payload.value->'sales_order_ids','[]'::jsonb)) q(value)
  ) ids where ids.id is not null;
  if coalesce(pg_catalog.cardinality(v_all_ids), 0) = 0 then
    raise exception 'Linked sales order is required';
  end if;
  for v_id in select pg_catalog.unnest(v_all_ids) order by 1 loop
    select * into v_order from public.sales_orders s
      where s.organization_id = v_org and s.id = v_id for update;
    if not found then raise exception 'Linked sales order was not found'; end if;
    if v_order.status <> 'confirmed' then raise exception 'SALES_ORDER_NOT_CONFIRMED'; end if;
    if nullif(input_order_versions->>v_id, '') is null
       or (input_order_versions->>v_id)::timestamptz is distinct from v_order.updated_at then
      raise exception 'INVOICE_SOURCE_ORDER_STALE';
    end if;
    if pg_catalog.jsonb_typeof(v_order.lines) is distinct from 'array'
       or pg_catalog.jsonb_array_length(v_order.lines) = 0
       or exists (select 1 from pg_catalog.jsonb_array_elements(v_order.lines) l(value)
         where nullif(pg_catalog.btrim(coalesce(l.value->>'sell_price', '')), '') is null
            or nullif(pg_catalog.btrim(coalesce(l.value->>'buy_price', '')), '') is null) then
      raise exception 'INVOICE_SOURCE_PRICE_MISSING';
    end if;
    if exists (select 1 from public.invoices i where i.organization_id = v_org
      and lower(coalesce(i.status, 'draft')) <> 'void'
      and (i.sales_order_id = v_id or v_id = any(coalesce(i.sales_order_ids, '{}'::text[])))) then
      raise exception 'SALES_ORDER_ALREADY_INVOICED';
    end if;
  end loop;

  for v_payload in select value from pg_catalog.jsonb_array_elements(input_payloads) loop
    if pg_catalog.jsonb_typeof(v_payload->'lines') is distinct from 'array'
       or pg_catalog.jsonb_array_length(v_payload->'lines') = 0
       or exists (select 1 from pg_catalog.jsonb_array_elements(v_payload->'lines') l(value)
         where nullif(pg_catalog.btrim(coalesce(l.value->>'sell_price', '')), '') is null
            or nullif(pg_catalog.btrim(coalesce(l.value->>'buy_price', '')), '') is null) then
      raise exception 'INVOICE_SOURCE_PRICE_MISSING';
    end if;
    select pg_catalog.array_agg(distinct ids.id order by ids.id) into v_ids
    from (
      select nullif(pg_catalog.btrim(v_payload->>'sales_order_id'), '') as id
      union all
      select nullif(pg_catalog.btrim(q.value), '')
      from pg_catalog.jsonb_array_elements_text(coalesce(v_payload->'sales_order_ids','[]'::jsonb)) q(value)
    ) ids where ids.id is not null;
    if coalesce(pg_catalog.cardinality(v_ids), 0) = 0 then raise exception 'Linked sales order is required'; end if;
    if v_seen && v_ids then raise exception 'SALES_ORDER_ALREADY_INVOICED'; end if;
    v_seen := v_seen || v_ids;
    v_saved := public.save_invoice_atomic(v_payload, null);
    v_results := v_results || pg_catalog.jsonb_build_array(v_saved->'invoice');
  end loop;
  return pg_catalog.jsonb_build_object('invoices', v_results);
end;
$$;
revoke all on function public.create_full_sales_invoices_atomic(jsonb, jsonb) from public, anon;
grant execute on function public.create_full_sales_invoices_atomic(jsonb, jsonb) to authenticated, service_role;
notify pgrst, 'reload schema';
