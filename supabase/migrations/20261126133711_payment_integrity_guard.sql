-- Preserve existing payments. New writes are guarded; no historical data is changed.
create schema if not exists payment_integrity_private;
revoke all on schema payment_integrity_private from public, anon, authenticated, service_role;

create function payment_integrity_private.normalized_number(value text)
returns text language sql immutable parallel safe set search_path = '' as $$
  select pg_catalog.regexp_replace(pg_catalog.upper(coalesce(value, '')), '[[:space:]]+', '', 'g');
$$;

-- Payment ids are user-visible document numbers. Each type is independent.
create function payment_integrity_private.guard_number()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_number text := payment_integrity_private.normalized_number(new.id);
  v_previous text := pg_catalog.current_setting('payment_integrity.previous_id', true);
  v_exists boolean;
  v_same_owner boolean;
begin
  if v_number = '' then return new; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('payment|' || tg_table_name || '|' || new.organization_id::text || '|' || v_number, 0));
  if tg_op = 'UPDATE' and new.organization_id = old.organization_id
     and v_number = payment_integrity_private.normalized_number(old.id) then return new; end if;
  if tg_table_name = 'payments_received' then
    select exists(select 1 from public.payments_received p where p.id = new.id),
           exists(select 1 from public.payments_received p where p.id = new.id and p.organization_id = new.organization_id)
      into v_exists, v_same_owner;
    if tg_op = 'INSERT' and v_exists then
      if v_previous is distinct from new.id or not v_same_owner then
        raise exception using message = 'PAYMENT_NUMBER_ALREADY_USED', errcode = '23505';
      end if;
      return new;
    end if;
    if exists(select 1 from public.payments_received p where p.organization_id = new.organization_id
      and (tg_op <> 'UPDATE' or p.id is distinct from old.id)
      and payment_integrity_private.normalized_number(p.id) = v_number) then
      raise exception using message = 'PAYMENT_NUMBER_ALREADY_USED', errcode = '23505';
    end if;
  elsif tg_table_name = 'payments_made' then
    select exists(select 1 from public.payments_made p where p.id = new.id),
           exists(select 1 from public.payments_made p where p.id = new.id and p.organization_id = new.organization_id)
      into v_exists, v_same_owner;
    if tg_op = 'INSERT' and v_exists then
      if v_previous is distinct from new.id or not v_same_owner then
        raise exception using message = 'PAYMENT_NUMBER_ALREADY_USED', errcode = '23505';
      end if;
      return new;
    end if;
    if exists(select 1 from public.payments_made p where p.organization_id = new.organization_id
      and (tg_op <> 'UPDATE' or p.id is distinct from old.id)
      and payment_integrity_private.normalized_number(p.id) = v_number) then
      raise exception using message = 'PAYMENT_NUMBER_ALREADY_USED', errcode = '23505';
    end if;
  end if;
  return new;
end;
$$;

create trigger payments_received_number_guard before insert or update on public.payments_received
for each row execute function payment_integrity_private.guard_number();
create trigger payments_made_number_guard before insert or update on public.payments_made
for each row execute function payment_integrity_private.guard_number();

alter function public.save_payment_received_atomic(jsonb, text) set schema payment_integrity_private;
alter function public.save_payment_made_atomic(jsonb, text) set schema payment_integrity_private;
revoke all on function payment_integrity_private.save_payment_received_atomic(jsonb, text) from public, anon, authenticated, service_role;
revoke all on function payment_integrity_private.save_payment_made_atomic(jsonb, text) from public, anon, authenticated, service_role;

create function public.save_payment_received_atomic(payload jsonb, previous_id text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := public.current_profile_org_id();
  v_role text := public.current_profile_role();
  v_id text := nullif(pg_catalog.btrim(coalesce(payload->>'id', '')), '');
  v_previous text := nullif(pg_catalog.btrim(coalesce(previous_id, '')), '');
  v_old_invoice text;
  v_result jsonb;
  v_old_status jsonb;
begin
  if v_org is null or not coalesce(v_role = 'admin' or public.is_superadmin(), false) then
    raise exception 'Only active admin users can save received payments';
  end if;
  if v_id is null then raise exception 'Payment id is required'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('payment|payments_received|' || v_org::text || '|' || payment_integrity_private.normalized_number(v_id), 0));
  if v_previous is not null then
    select p.invoice_id into v_old_invoice from public.payments_received p
      where p.organization_id = v_org and p.id = v_previous for update;
    if not found then raise exception 'Previous received payment was not found'; end if;
  end if;
  if (v_previous is null or v_id <> v_previous) and exists(select 1 from public.payments_received p
    where p.organization_id = v_org and (v_previous is null or p.id <> v_previous)
      and payment_integrity_private.normalized_number(p.id) = payment_integrity_private.normalized_number(v_id)) then
    raise exception using message = 'PAYMENT_NUMBER_ALREADY_USED', errcode = '23505';
  end if;
  perform pg_catalog.set_config('payment_integrity.previous_id', coalesce(v_previous, ''), true);
  begin
    v_result := payment_integrity_private.save_payment_received_atomic(payload, previous_id);
  exception when others then
    perform pg_catalog.set_config('payment_integrity.previous_id', '', true);
    raise;
  end;
  perform pg_catalog.set_config('payment_integrity.previous_id', '', true);
  -- The original function already handles renumbering. For a same-id transfer
  -- it did not recalculate the invoice from which this payment was removed.
  if v_previous = v_id and v_old_invoice is not null and v_old_invoice is distinct from payload->>'invoice_id' then
    v_old_status := public.recalculate_invoice_paid_status_for_org(v_org, v_old_invoice);
    v_result := pg_catalog.jsonb_set(v_result, '{previous_invoice}', coalesce(v_old_status, 'null'::jsonb));
  end if;
  return v_result;
end;
$$;

create function public.save_payment_made_atomic(payload jsonb, previous_id text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := public.current_profile_org_id();
  v_role text := public.current_profile_role();
  v_id text := nullif(pg_catalog.btrim(coalesce(payload->>'id', '')), '');
  v_previous text := nullif(pg_catalog.btrim(coalesce(previous_id, '')), '');
  v_old_bill text;
  v_result jsonb;
  v_old_status jsonb;
begin
  if v_org is null or not coalesce(v_role = 'admin' or public.is_superadmin(), false) then
    raise exception 'Only active admin users can save made payments';
  end if;
  if v_id is null then raise exception 'Payment id is required'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('payment|payments_made|' || v_org::text || '|' || payment_integrity_private.normalized_number(v_id), 0));
  if v_previous is not null then
    select p.bill_id into v_old_bill from public.payments_made p
      where p.organization_id = v_org and p.id = v_previous for update;
    if not found then raise exception 'Previous made payment was not found'; end if;
  end if;
  if (v_previous is null or v_id <> v_previous) and exists(select 1 from public.payments_made p
    where p.organization_id = v_org and (v_previous is null or p.id <> v_previous)
      and payment_integrity_private.normalized_number(p.id) = payment_integrity_private.normalized_number(v_id)) then
    raise exception using message = 'PAYMENT_NUMBER_ALREADY_USED', errcode = '23505';
  end if;
  perform pg_catalog.set_config('payment_integrity.previous_id', coalesce(v_previous, ''), true);
  begin
    v_result := payment_integrity_private.save_payment_made_atomic(payload, previous_id);
  exception when others then
    perform pg_catalog.set_config('payment_integrity.previous_id', '', true);
    raise;
  end;
  perform pg_catalog.set_config('payment_integrity.previous_id', '', true);
  if v_previous = v_id and v_old_bill is not null and v_old_bill is distinct from payload->>'bill_id' then
    v_old_status := public.recalculate_bill_paid_status_for_org(v_org, v_old_bill);
    v_result := pg_catalog.jsonb_set(v_result, '{previous_bill}', coalesce(v_old_status, 'null'::jsonb));
  end if;
  return v_result;
end;
$$;

revoke all on function public.save_payment_received_atomic(jsonb, text) from public, anon;
revoke all on function public.save_payment_made_atomic(jsonb, text) from public, anon;
grant execute on function public.save_payment_received_atomic(jsonb, text) to authenticated, service_role;
grant execute on function public.save_payment_made_atomic(jsonb, text) to authenticated, service_role;
revoke all on all functions in schema payment_integrity_private from public, anon, authenticated, service_role;
notify pgrst, 'reload schema';
