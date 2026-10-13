-- The browser blocks retired C pricing, but save_sales_order_atomic accepts a
-- caller-supplied customer_type and customer_name. Bind every commercial write
-- to one current customer card so a forged A payload cannot price a C account.
-- Historical documents remain readable; portal acknowledgement may still set
-- portal_seen_at without changing their commercial contents.
create schema if not exists sales_order_guard_private;
revoke all on schema sales_order_guard_private from public, anon, authenticated, service_role;

create or replace function sales_order_guard_private.guard_sales_order_active_customer_pricing()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_customer public.customers%rowtype;
  v_match_ids uuid[];
  v_customer_name text := pg_catalog.lower(pg_catalog.btrim(coalesce(new.customer_name, '')));
  v_old_customer_name text;
  v_existing_customer_id uuid;
  v_existing_customer_name text;
  v_preserve_snapshot_name boolean := false;
  v_meta_text text;
  v_meta jsonb := '{}'::jsonb;
  v_embedded_type text;
  v_effective_customer_type text;
  v_margin numeric;
begin
  -- BEFORE triggers can run before the table's RLS WITH CHECK. A service-role
  -- request is trusted; staff writes must still belong to their current org.
  if pg_catalog.current_setting('role', true) is distinct from 'service_role' and
     (new.organization_id is distinct from public.current_profile_org_id() or
      (coalesce(public.current_profile_role(), '') not in ('admin', 'sales') and
       not coalesce(public.is_superadmin(), false))) then
    raise exception 'Sales order customer account is outside the active staff scope'
      using errcode = '42501';
  end if;

  if tg_op = 'UPDATE' and
     (pg_catalog.to_jsonb(new) - 'portal_seen_at' - 'updated_at')
       is not distinct from
     (pg_catalog.to_jsonb(old) - 'portal_seen_at' - 'updated_at') then
    return new;
  end if;

  -- A retired C document may receive operational notes/status/acknowledgement
  -- without reopening its stored customer or line prices.
  if tg_op = 'UPDATE' and old.customer_type = 'C' and new.customer_type = 'C' and
     (pg_catalog.to_jsonb(new) - 'notes' - 'status' - 'confirmed_at' - 'portal_seen_at' - 'updated_at')
       is not distinct from
     (pg_catalog.to_jsonb(old) - 'notes' - 'status' - 'confirmed_at' - 'portal_seen_at' - 'updated_at') then
    return new;
  end if;

  -- PostgreSQL runs BEFORE INSERT before ON CONFLICT DO UPDATE. Lock a matching
  -- historical C row, then let the UPDATE trigger inspect the actual write.
  if tg_op = 'INSERT' and new.customer_type = 'C' then
    perform 1 from public.sales_orders so
    where so.id = new.id and so.organization_id = new.organization_id
      and so.customer_type = 'C'
    for update;
    if found then return new; end if;
  end if;

  if new.customer_type is null or new.customer_type not in ('A', 'B', 'Other') then
    raise exception 'Set A, B, or Other on the customer account before saving a sales order'
      using errcode = '23514';
  end if;
  if v_customer_name = '' then
    raise exception 'Sales order customer name is required'
      using errcode = '23514';
  end if;

  -- An existing ID-bound order keeps its customer name as a document snapshot.
  -- This also covers INSERT ... ON CONFLICT, whose INSERT trigger runs first.
  if tg_op = 'UPDATE' then
    v_old_customer_name := pg_catalog.lower(pg_catalog.btrim(coalesce(old.customer_name, '')));
    if v_customer_name is distinct from v_old_customer_name then
      -- The guarded RPC can update customer_name without updating customer_id.
      -- Rebind a deliberate switch by a unique current name, never the stale ID.
      new.customer_id := null;
    elsif new.customer_id is null and old.customer_id is not null then
      new.customer_id := old.customer_id;
    end if;
    v_preserve_snapshot_name := new.customer_id is not distinct from old.customer_id
      and v_customer_name is not distinct from v_old_customer_name
      and old.customer_id is not null;
  elsif new.customer_id is null then
    select so.customer_id, so.customer_name
      into v_existing_customer_id, v_existing_customer_name
    from public.sales_orders so
    where so.id = new.id and so.organization_id = new.organization_id
    for update;
    if v_existing_customer_id is not null and
       v_existing_customer_name is not distinct from new.customer_name then
      new.customer_id := v_existing_customer_id;
      v_preserve_snapshot_name := true;
    end if;
  else
    select so.customer_id, so.customer_name
      into v_existing_customer_id, v_existing_customer_name
    from public.sales_orders so
    where so.id = new.id and so.organization_id = new.organization_id
    for update;
    v_preserve_snapshot_name := v_existing_customer_id is not null
      and v_existing_customer_id = new.customer_id
      and v_existing_customer_name is not distinct from new.customer_name;
  end if;

  if new.customer_id is not null then
    select c.* into v_customer
    from public.customers c
    where c.id = new.customer_id
      and c.organization_id = new.organization_id;
    if not found then
      raise exception 'Sales order customer account is missing or outside this organization'
        using errcode = '23514';
    end if;
    if not v_preserve_snapshot_name and
       (pg_catalog.btrim(coalesce(v_customer.display_name, '')) <> '' or
        pg_catalog.btrim(coalesce(v_customer.company_name, '')) <> '') and
       (pg_catalog.lower(pg_catalog.btrim(coalesce(v_customer.display_name, ''))) <> v_customer_name and
        pg_catalog.lower(pg_catalog.btrim(coalesce(v_customer.company_name, ''))) <> v_customer_name) then
      raise exception 'Sales order customer name does not match the selected account'
        using errcode = '23514';
    end if;
  else
    select pg_catalog.array_agg(candidate.id) into v_match_ids
    from (
      select c.id
      from public.customers c
      where c.organization_id = new.organization_id
        and v_customer_name <> ''
        and (pg_catalog.lower(pg_catalog.btrim(coalesce(c.display_name, ''))) = v_customer_name
          or pg_catalog.lower(pg_catalog.btrim(coalesce(c.company_name, ''))) = v_customer_name)
      limit 2
    ) candidate;
    if coalesce(pg_catalog.cardinality(v_match_ids), 0) <> 1 then
      raise exception 'Sales order customer name must identify exactly one account'
        using errcode = '23514';
    end if;
    select c.* into v_customer
    from public.customers c
    where c.id = v_match_ids[1]
      and c.organization_id = new.organization_id;
    new.customer_id := v_customer.id;
  end if;

  -- Match the portal/customer mapper: physical profile, then valid embedded
  -- legacy profile, then A. A malformed metadata suffix contributes nothing.
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
  v_effective_customer_type := case pg_catalog.lower(pg_catalog.btrim(
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
  if v_effective_customer_type is distinct from new.customer_type then
    raise exception 'Sales order price profile differs from the current customer account'
      using errcode = '23514';
  end if;
  if new.customer_type = 'Other' then
    v_margin := v_customer.price_list_margin_percent;
    if v_margin is null then
      begin
        v_margin := nullif(pg_catalog.btrim(v_meta->>'price_list_margin_percent'), '')::numeric;
      exception when data_exception then
        v_margin := null;
      end;
    end if;
    if v_margin is null or v_margin::text in ('NaN', 'Infinity', '-Infinity') then
      raise exception 'Other customer pricing requires a valid account margin'
        using errcode = '23514';
    end if;
  end if;
  return new;
end;
$function$;

revoke all on function sales_order_guard_private.guard_sales_order_active_customer_pricing()
  from public, anon, authenticated, service_role;

drop trigger if exists sales_orders_active_customer_pricing_guard on public.sales_orders;
create trigger sales_orders_active_customer_pricing_guard
before insert or update on public.sales_orders
for each row execute function sales_order_guard_private.guard_sales_order_active_customer_pricing();
