-- Require the version read by the editor; no existing payments are modified.
create or replace function public.save_payment_received_atomic(payload jsonb, previous_id text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := public.current_profile_org_id();
  v_role text := public.current_profile_role();
  v_id text := nullif(pg_catalog.btrim(coalesce(payload->>'id', '')), '');
  v_previous text := nullif(pg_catalog.btrim(coalesce(previous_id, '')), '');
  v_old_invoice text;
  v_old_updated_at timestamptz;
  v_expected_updated_at timestamptz;
  v_result jsonb;
  v_old_status jsonb;
begin
  if v_org is null or not coalesce(v_role = 'admin' or public.is_superadmin(), false) then
    raise exception 'Only active admin users can save received payments';
  end if;
  if v_id is null then raise exception 'Payment id is required'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('payment|payments_received|' || v_org::text || '|' || payment_integrity_private.normalized_number(v_id), 0));
  if v_previous is not null then
    select p.invoice_id, p.updated_at into v_old_invoice, v_old_updated_at from public.payments_received p
      where p.organization_id = v_org and p.id = v_previous for update;
    if not found then raise exception 'Previous received payment was not found'; end if;
    if not (payload ? 'expected_updated_at') then
      raise exception using message = 'PAYMENT_VERSION_REQUIRED', errcode = 'P0001';
    end if;
    begin
      v_expected_updated_at := nullif(payload->>'expected_updated_at', '')::timestamptz;
    exception when invalid_datetime_format or datetime_field_overflow then
      raise exception using message = 'PAYMENT_VERSION_REQUIRED', errcode = 'P0001';
    end;
    if v_old_updated_at is distinct from v_expected_updated_at then
      raise exception using message = 'PAYMENT_VERSION_CONFLICT', errcode = 'P0001';
    end if;
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

create or replace function public.save_payment_made_atomic(payload jsonb, previous_id text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := public.current_profile_org_id();
  v_role text := public.current_profile_role();
  v_id text := nullif(pg_catalog.btrim(coalesce(payload->>'id', '')), '');
  v_previous text := nullif(pg_catalog.btrim(coalesce(previous_id, '')), '');
  v_old_bill text;
  v_old_updated_at timestamptz;
  v_expected_updated_at timestamptz;
  v_result jsonb;
  v_old_status jsonb;
begin
  if v_org is null or not coalesce(v_role = 'admin' or public.is_superadmin(), false) then
    raise exception 'Only active admin users can save made payments';
  end if;
  if v_id is null then raise exception 'Payment id is required'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('payment|payments_made|' || v_org::text || '|' || payment_integrity_private.normalized_number(v_id), 0));
  if v_previous is not null then
    select p.bill_id, p.updated_at into v_old_bill, v_old_updated_at from public.payments_made p
      where p.organization_id = v_org and p.id = v_previous for update;
    if not found then raise exception 'Previous made payment was not found'; end if;
    if not (payload ? 'expected_updated_at') then
      raise exception using message = 'PAYMENT_VERSION_REQUIRED', errcode = 'P0001';
    end if;
    begin
      v_expected_updated_at := nullif(payload->>'expected_updated_at', '')::timestamptz;
    exception when invalid_datetime_format or datetime_field_overflow then
      raise exception using message = 'PAYMENT_VERSION_REQUIRED', errcode = 'P0001';
    end;
    if v_old_updated_at is distinct from v_expected_updated_at then
      raise exception using message = 'PAYMENT_VERSION_CONFLICT', errcode = 'P0001';
    end if;
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


-- All authenticated mutations must use the guarded RPCs, including deletion,
-- so direct table writes cannot bypass version checks or balance recalculation.
revoke insert, update, delete on public.payments_received from public, anon, authenticated;
revoke insert, update, delete on public.payments_made from public, anon, authenticated;
notify pgrst, 'reload schema';
