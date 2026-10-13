-- Confirming an order must use the current customer account and list
-- margin at the database write boundary. The browser's loaded margin can be
-- stale even when its supplier-price check has just passed. This trigger runs
-- after sales_orders_active_customer_pricing_guard (alphabetical trigger order),
-- which resolves customer_id and enforces the active A/B/Other account type.
create or replace function sales_order_guard_private.guard_confirmed_sales_order_margin()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_customer public.customers%rowtype;
  v_meta_text text;
  v_meta jsonb := '{}'::jsonb;
  v_embedded_type text;
  v_customer_type text;
  v_override numeric;
  v_list_margin numeric;
  v_margin numeric;
  v_line jsonb;
  v_buy numeric;
  v_sell numeric;
  v_expected numeric;
begin
  -- An INSERT arm of INSERT ... ON CONFLICT is evaluated even when only an
  -- existing row will be updated. Leave that arm alone and validate the real
  -- UPDATE below; the row lock also serializes concurrent confirmations.
  if tg_op = 'INSERT' then
    perform 1 from public.sales_orders so
    where so.id = new.id and so.organization_id = new.organization_id
    for update;
    if found then return new; end if;
  end if;

  if new.status is distinct from 'confirmed' then
    return new;
  end if;

  -- Notes and acknowledgements on a historical confirmed order do not
  -- reopen its saved commercial prices after the account margin changes.
  if tg_op = 'UPDATE' and old.status = 'confirmed' and
     (pg_catalog.to_jsonb(new) - 'notes' - 'portal_seen_at' - 'updated_at' - 'confirmed_at')
       is not distinct from
     (pg_catalog.to_jsonb(old) - 'notes' - 'portal_seen_at' - 'updated_at' - 'confirmed_at') then
    return new;
  end if;

  if new.customer_id is null then
    raise exception 'Confirmed sales order requires a bound customer account'
      using errcode = '23514';
  end if;

  -- Every price-list row references this organization. Its FOR UPDATE lock
  -- conflicts with the FK's KEY SHARE lock for a new list row, so a newer
  -- active list cannot appear between margin selection and order commit.
  -- Confirmations are infrequent and serialize only within one organization.
  perform 1 from public.organizations o
  where o.id = new.organization_id
  for update;
  if not found then
    raise exception 'Confirmed sales order organization is unavailable'
      using errcode = '23514';
  end if;

  -- Lock the account before reading its profile/margin. A concurrent account
  -- update either finishes first and is seen here, or waits for this order.
  select c.* into v_customer
  from public.customers c
  where c.id = new.customer_id and c.organization_id = new.organization_id
  for share;
  if not found then
    raise exception 'Confirmed sales order customer account is unavailable'
      using errcode = '23514';
  end if;

  if pg_catalog.strpos(coalesce(v_customer.custom_fields, ''), '[[NEXT_MASTER_META]]') > 0 then
    v_meta_text := pg_catalog.btrim(pg_catalog.split_part(
      v_customer.custom_fields,
      '[[NEXT_MASTER_META]]',
      pg_catalog.array_length(pg_catalog.string_to_array(
        v_customer.custom_fields, '[[NEXT_MASTER_META]]'), 1)
    ));
    begin
      v_meta := v_meta_text::jsonb;
      if pg_catalog.jsonb_typeof(v_meta) is distinct from 'object' then
        v_meta := '{}'::jsonb;
      end if;
    exception when data_exception then
      v_meta := '{}'::jsonb;
    end;
  end if;
  v_embedded_type := v_meta->>'price_list_type';
  if v_embedded_type not in ('A', 'B', 'C', 'Other') then
    v_embedded_type := null;
  end if;
  v_customer_type := case pg_catalog.lower(pg_catalog.btrim(
    coalesce(nullif(v_customer.price_list_type, ''), v_embedded_type, 'A')
  ))
    when 'a' then 'A'
    when 'a price list' then 'A'
    when 'b' then 'B'
    when 'b price list' then 'B'
    when 'c' then 'C'
    when 'c price list' then 'C'
    when 'other' then 'Other'
    when 'other margin' then 'Other'
    else null
  end;
  if v_customer_type is distinct from new.customer_type or
     v_customer_type not in ('A', 'B', 'Other') then
    raise exception 'Confirmed sales order pricing profile changed; refresh the customer account'
      using errcode = '23514';
  end if;

  v_override := v_customer.price_list_margin_percent;
  if v_override is null then
    begin
      v_override := nullif(pg_catalog.btrim(v_meta->>'price_list_margin_percent'), '')::numeric;
    exception when data_exception then
      v_override := null;
    end;
  end if;
  if v_override is not null and v_override::text in ('NaN', 'Infinity', '-Infinity') then
    raise exception 'Confirmed sales order customer margin is invalid'
      using errcode = '23514';
  end if;
  if v_customer_type = 'Other' and v_override is null then
    raise exception 'Confirmed sales order requires the current account margin'
      using errcode = '23514';
  end if;

  if v_override is not null then
    v_margin := v_override;
  else
    -- Lock active and inactive rows so changing is_active cannot change the
    -- selected list during this write. Match the portal worker's newest-first
    -- order, with id as a deterministic final tie breaker.
    with locked_lists as materialized (
      select l.id, l.margin_percent, l.is_active, l.updated_at, l.created_at
      from public.customer_price_lists l
      where l.organization_id = new.organization_id
        and l.list_type = v_customer_type
      for share
    )
    select ll.margin_percent into v_list_margin
    from locked_lists ll
    where ll.is_active
    order by ll.updated_at desc, ll.created_at desc, ll.id desc
    limit 1;
    v_margin := coalesce(v_list_margin, case when v_customer_type = 'B' then 15 else 10 end);
    if v_margin::text in ('NaN', 'Infinity', '-Infinity') then
      raise exception 'Confirmed sales order price-list margin is invalid'
        using errcode = '23514';
    end if;
  end if;

  if pg_catalog.jsonb_typeof(new.lines) is distinct from 'array' then
    raise exception 'Confirmed sales order lines must be an array'
      using errcode = '23514';
  end if;
  for v_line in select value from pg_catalog.jsonb_array_elements(new.lines)
  loop
    if pg_catalog.jsonb_typeof(v_line) is distinct from 'object' then
      raise exception 'Confirmed sales order line is invalid'
        using errcode = '23514';
    end if;
    if pg_catalog.jsonb_typeof(v_line->'manual_sell_price') = 'boolean' and
       v_line->>'manual_sell_price' = 'true' then
      continue;
    end if;
    begin
      v_buy := nullif(pg_catalog.btrim(v_line->>'buy_price'), '')::numeric;
      v_sell := nullif(pg_catalog.btrim(v_line->>'sell_price'), '')::numeric;
    exception when data_exception then
      raise exception 'Confirmed sales order line price is invalid'
        using errcode = '23514';
    end;
    if v_buy is null or v_sell is null or v_buy <= 0 or v_sell <= 0 or
       v_buy::text in ('NaN', 'Infinity', '-Infinity') or
       v_sell::text in ('NaN', 'Infinity', '-Infinity') then
      raise exception 'Confirmed sales order line requires valid positive prices'
        using errcode = '23514';
    end if;
    v_expected := pg_catalog.round(v_buy * (1 + v_margin / 100), 2);
    if v_sell is distinct from v_expected then
      raise exception 'Confirmed sales order margin changed; refresh the customer price before confirming'
        using errcode = '23514';
    end if;
  end loop;
  return new;
end;
$function$;

revoke all on function sales_order_guard_private.guard_confirmed_sales_order_margin()
  from public, anon, authenticated, service_role;

drop trigger if exists sales_orders_current_margin_guard on public.sales_orders;
create trigger sales_orders_current_margin_guard
before insert or update on public.sales_orders
for each row execute function sales_order_guard_private.guard_confirmed_sales_order_margin();
