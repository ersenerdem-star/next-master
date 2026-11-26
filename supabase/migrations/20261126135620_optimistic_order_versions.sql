-- No existing document data is changed by this migration. Version checks are
-- applied at the save boundary after acquiring the same row locks as writers.
create schema if not exists order_concurrency_private;
revoke all on schema order_concurrency_private from public, anon, authenticated, service_role;

alter function public.save_sales_order_atomic(jsonb, text) set schema order_concurrency_private;
alter function public.save_purchase_order_atomic(jsonb, text) set schema order_concurrency_private;
revoke all on function order_concurrency_private.save_sales_order_atomic(jsonb, text) from public, anon, authenticated, service_role;
revoke all on function order_concurrency_private.save_purchase_order_atomic(jsonb, text) from public, anon, authenticated, service_role;

create function public.save_sales_order_atomic(payload jsonb, previous_id text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := public.current_profile_org_id();
  v_role text := public.current_profile_role();
  v_id text := nullif(pg_catalog.btrim(coalesce(payload->>'id', '')), '');
  v_previous text := nullif(pg_catalog.btrim(coalesce(previous_id, '')), '');
  v_expected_text text := nullif(pg_catalog.btrim(coalesce(payload->>'expected_updated_at', '')), '');
  v_expected timestamptz;
  v_actual timestamptz;
begin
  if v_org is null or not coalesce(v_role in ('admin','sales') or public.is_superadmin(), false) then
    raise exception 'Only active staff users can save sales orders';
  end if;
  if v_id is null then raise exception 'Sales order id is required'; end if;
  if v_previous is not null and v_previous <> v_id then
    raise exception 'Sales order identity changes are not supported';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('sales-version|'||v_org::text||'|'||v_id, 0));
  select s.updated_at into v_actual from public.sales_orders s
    where s.organization_id = v_org and s.id = v_id for update;
  if found then
    if v_expected_text is null then raise exception using message='SALES_ORDER_VERSION_REQUIRED: Sipariş değişmiş veya eski ekran açık. Siparişi yeniden açıp değişiklikleri kontrol edin. / Order changed or session is old. Reopen the order and review changes.', errcode='P0001'; end if;
    begin v_expected := v_expected_text::timestamptz;
    exception when others then raise exception using message='SALES_ORDER_VERSION_REQUIRED: Sipariş değişmiş veya eski ekran açık. Siparişi yeniden açıp değişiklikleri kontrol edin. / Order changed or session is old. Reopen the order and review changes.', errcode='P0001'; end;
    if v_actual is distinct from v_expected then raise exception using message='SALES_ORDER_STALE_VERSION: Sipariş değişmiş veya eski ekran açık. Siparişi yeniden açıp değişiklikleri kontrol edin. / Order changed or session is old. Reopen the order and review changes.', errcode='P0001'; end if;
  elsif v_expected_text is not null then
    raise exception using message='SALES_ORDER_STALE_VERSION: Sipariş değişmiş veya eski ekran açık. Siparişi yeniden açıp değişiklikleri kontrol edin. / Order changed or session is old. Reopen the order and review changes.', errcode='P0001';
  end if;
  return order_concurrency_private.save_sales_order_atomic(payload, previous_id);
end;
$$;

create function public.save_purchase_order_atomic(payload jsonb, previous_id text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := public.current_profile_org_id();
  v_role text := public.current_profile_role();
  v_id text := nullif(pg_catalog.btrim(coalesce(payload->>'id', '')), '');
  v_previous text := nullif(pg_catalog.btrim(coalesce(previous_id, '')), '');
  v_sales_id text := nullif(pg_catalog.btrim(coalesce(payload->>'sales_order_id', '')), '');
  v_expected_text text := nullif(pg_catalog.btrim(coalesce(payload->>'expected_updated_at', '')), '');
  v_expected timestamptz;
  v_actual timestamptz;
begin
  if v_org is null or not coalesce(v_role in ('admin','sales') or public.is_superadmin(), false) then
    raise exception 'Only active staff users can save purchase orders';
  end if;
  if v_id is null then raise exception 'Purchase order id is required'; end if;
  -- The public editor does not support changing a persisted purchase id.
  if v_previous is not null and v_previous <> v_id then
    raise exception 'Purchase order identity changes are not supported';
  end if;
  -- Match the core RPC lock order: linked sales order, then purchase order.
  if v_sales_id is not null then
    perform 1 from public.sales_orders s where s.organization_id = v_org and s.id = v_sales_id for update;
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('purchase-version|'||v_org::text||'|'||v_id, 0));
  select p.updated_at into v_actual from public.purchase_orders p
    where p.organization_id = v_org and p.id = v_id for update;
  if found then
    if v_expected_text is null then raise exception using message='PURCHASE_ORDER_VERSION_REQUIRED: Sipariş değişmiş veya eski ekran açık. Siparişi yeniden açıp değişiklikleri kontrol edin. / Order changed or session is old. Reopen the order and review changes.', errcode='P0001'; end if;
    begin v_expected := v_expected_text::timestamptz;
    exception when others then raise exception using message='PURCHASE_ORDER_VERSION_REQUIRED: Sipariş değişmiş veya eski ekran açık. Siparişi yeniden açıp değişiklikleri kontrol edin. / Order changed or session is old. Reopen the order and review changes.', errcode='P0001'; end;
    if v_actual is distinct from v_expected then raise exception using message='PURCHASE_ORDER_STALE_VERSION: Sipariş değişmiş veya eski ekran açık. Siparişi yeniden açıp değişiklikleri kontrol edin. / Order changed or session is old. Reopen the order and review changes.', errcode='P0001'; end if;
  elsif v_expected_text is not null then
    raise exception using message='PURCHASE_ORDER_STALE_VERSION: Sipariş değişmiş veya eski ekran açık. Siparişi yeniden açıp değişiklikleri kontrol edin. / Order changed or session is old. Reopen the order and review changes.', errcode='P0001';
  end if;
  return order_concurrency_private.save_purchase_order_atomic(payload, previous_id);
end;
$$;

revoke all on function public.save_sales_order_atomic(jsonb,text) from public, anon;
revoke all on function public.save_purchase_order_atomic(jsonb,text) from public, anon;
grant execute on function public.save_sales_order_atomic(jsonb,text) to authenticated, service_role;
grant execute on function public.save_purchase_order_atomic(jsonb,text) to authenticated, service_role;
notify pgrst, 'reload schema';
