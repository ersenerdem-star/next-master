-- The legacy signature remains callable but cannot delete without a version.
create or replace function public.delete_payment_received_guarded(id text)
returns jsonb language plpgsql set search_path = '' as $$
begin
  raise exception using message = 'PAYMENT_VERSION_REQUIRED', errcode = 'P0001';
end;
$$;
create or replace function public.delete_payment_made_guarded(id text)
returns jsonb language plpgsql set search_path = '' as $$
begin
  raise exception using message = 'PAYMENT_VERSION_REQUIRED', errcode = 'P0001';
end;
$$;

create or replace function public.delete_payment_received_guarded(id text, expected_updated_at text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_id uuid := public.current_profile_org_id();
  v_role text := public.current_profile_role();
  v_payment public.payments_received%rowtype;
  v_expected_updated_at timestamptz;
  v_invoice_status jsonb;
begin
  if v_org_id is null or not coalesce(v_role = 'admin' or public.is_superadmin(), false) then
    raise exception 'Only active admin users can delete received payments';
  end if;

  if nullif(trim(coalesce(delete_payment_received_guarded.id, '')), '') is null then
    raise exception 'Payment id is required';
  end if;

  select *
    into v_payment
  from public.payments_received pr
  where pr.organization_id = v_org_id
    and pr.id = delete_payment_received_guarded.id
  for update;

  if not found then
    raise exception 'Received payment was not found';
  end if;

  begin
    v_expected_updated_at := nullif(expected_updated_at, '')::timestamptz;
  exception when invalid_datetime_format or datetime_field_overflow then
    raise exception using message = 'PAYMENT_VERSION_REQUIRED', errcode = 'P0001';
  end;
  if v_payment.updated_at is distinct from v_expected_updated_at then
    raise exception using message = 'PAYMENT_VERSION_CONFLICT', errcode = 'P0001';
  end if;

  delete from public.payments_received
   where organization_id = v_org_id
     and payments_received.id = v_payment.id;

  v_invoice_status := public.recalculate_invoice_paid_status_for_org(v_org_id, v_payment.invoice_id);

  return jsonb_build_object(
    'deleted', true,
    'payment_id', v_payment.id,
    'invoice', v_invoice_status
  );
end;
$$;

create or replace function public.delete_payment_made_guarded(id text, expected_updated_at text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_id uuid := public.current_profile_org_id();
  v_role text := public.current_profile_role();
  v_payment public.payments_made%rowtype;
  v_expected_updated_at timestamptz;
  v_bill_status jsonb;
begin
  if v_org_id is null or not coalesce(v_role = 'admin' or public.is_superadmin(), false) then
    raise exception 'Only active admin users can delete made payments';
  end if;

  if nullif(trim(coalesce(delete_payment_made_guarded.id, '')), '') is null then
    raise exception 'Payment id is required';
  end if;

  select *
    into v_payment
  from public.payments_made pm
  where pm.organization_id = v_org_id
    and pm.id = delete_payment_made_guarded.id
  for update;

  if not found then
    raise exception 'Made payment was not found';
  end if;

  begin
    v_expected_updated_at := nullif(expected_updated_at, '')::timestamptz;
  exception when invalid_datetime_format or datetime_field_overflow then
    raise exception using message = 'PAYMENT_VERSION_REQUIRED', errcode = 'P0001';
  end;
  if v_payment.updated_at is distinct from v_expected_updated_at then
    raise exception using message = 'PAYMENT_VERSION_CONFLICT', errcode = 'P0001';
  end if;

  delete from public.payments_made
   where organization_id = v_org_id
     and payments_made.id = v_payment.id;

  v_bill_status := public.recalculate_bill_paid_status_for_org(v_org_id, v_payment.bill_id);

  return jsonb_build_object(
    'deleted', true,
    'payment_id', v_payment.id,
    'bill', v_bill_status
  );
end;
$$;


revoke all on function public.delete_payment_received_guarded(text, text) from public, anon;
revoke all on function public.delete_payment_made_guarded(text, text) from public, anon;
grant execute on function public.delete_payment_received_guarded(text, text) to authenticated, service_role;
grant execute on function public.delete_payment_made_guarded(text, text) to authenticated, service_role;
notify pgrst, 'reload schema';
