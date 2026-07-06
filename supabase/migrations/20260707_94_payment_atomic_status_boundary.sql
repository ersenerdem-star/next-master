-- Payments and their linked document paid/open status must commit together.

drop function if exists public.save_payment_received_atomic(jsonb, text);
drop function if exists public.save_payment_made_atomic(jsonb, text);
drop function if exists public.delete_payment_received_guarded(text);
drop function if exists public.delete_payment_made_guarded(text);
drop function if exists public.recalculate_invoice_paid_status_for_org(uuid, text);
drop function if exists public.recalculate_bill_paid_status_for_org(uuid, text);

create or replace function public.recalculate_invoice_paid_status_for_org(
  input_organization_id uuid,
  input_invoice_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_invoice public.invoices%rowtype;
  v_confirmed_amount numeric(14, 2) := 0;
  v_total_amount numeric(14, 2) := 0;
  v_next_status text;
begin
  if input_organization_id is null then
    raise exception 'Organization is required';
  end if;

  if nullif(trim(coalesce(input_invoice_id, '')), '') is null then
    raise exception 'Invoice is required';
  end if;

  select *
    into v_invoice
  from public.invoices i
  where i.organization_id = input_organization_id
    and i.id = input_invoice_id
  for update;

  if not found then
    raise exception 'Invoice was not found';
  end if;

  select coalesce(sum(coalesce(pr.amount, 0)), 0)
    into v_confirmed_amount
  from public.payments_received pr
  where pr.organization_id = input_organization_id
    and pr.invoice_id = input_invoice_id
    and lower(coalesce(pr.status, '')) = 'confirmed';

  v_total_amount := coalesce(v_invoice.total_amount, 0);
  v_next_status := case
    when v_total_amount > 0 and v_confirmed_amount >= v_total_amount then 'paid'
    when lower(coalesce(v_invoice.status, 'draft')) = 'paid' then 'confirmed'
    else coalesce(v_invoice.status, 'draft')
  end;

  if v_invoice.status is distinct from v_next_status then
    update public.invoices
       set status = v_next_status,
           updated_at = now()
     where organization_id = input_organization_id
       and id = input_invoice_id
    returning * into v_invoice;
  end if;

  return jsonb_build_object(
    'id', v_invoice.id,
    'status', v_invoice.status,
    'paid_amount', v_confirmed_amount,
    'total_amount', v_total_amount
  );
end;
$$;

create or replace function public.recalculate_bill_paid_status_for_org(
  input_organization_id uuid,
  input_bill_id text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_bill public.bills%rowtype;
  v_confirmed_amount numeric(14, 2) := 0;
  v_total_amount numeric(14, 2) := 0;
  v_next_status text;
begin
  if input_organization_id is null then
    raise exception 'Organization is required';
  end if;

  if nullif(trim(coalesce(input_bill_id, '')), '') is null then
    raise exception 'Bill is required';
  end if;

  select *
    into v_bill
  from public.bills b
  where b.organization_id = input_organization_id
    and b.id = input_bill_id
  for update;

  if not found then
    raise exception 'Bill was not found';
  end if;

  select coalesce(sum(coalesce(pm.amount, 0)), 0)
    into v_confirmed_amount
  from public.payments_made pm
  where pm.organization_id = input_organization_id
    and pm.bill_id = input_bill_id
    and lower(coalesce(pm.status, '')) = 'confirmed';

  v_total_amount := coalesce(v_bill.total_amount, 0);
  v_next_status := case
    when v_total_amount > 0 and v_confirmed_amount >= v_total_amount then 'paid'
    when lower(coalesce(v_bill.status, 'draft')) = 'paid' then 'confirmed'
    else coalesce(v_bill.status, 'draft')
  end;

  if v_bill.status is distinct from v_next_status then
    update public.bills
       set status = v_next_status,
           updated_at = now()
     where organization_id = input_organization_id
       and id = input_bill_id
    returning * into v_bill;
  end if;

  return jsonb_build_object(
    'id', v_bill.id,
    'status', v_bill.status,
    'paid_amount', v_confirmed_amount,
    'total_amount', v_total_amount
  );
end;
$$;

create or replace function public.save_payment_received_atomic(
  payload jsonb,
  previous_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_id uuid := public.current_profile_org_id();
  v_role text := public.current_profile_role();
  v_payment_id text := nullif(trim(coalesce(payload->>'id', '')), '');
  v_invoice_id text := nullif(trim(coalesce(payload->>'invoice_id', '')), '');
  v_previous_id text := nullif(trim(coalesce(previous_id, '')), '');
  v_amount numeric(14, 2);
  v_status text := lower(trim(coalesce(nullif(payload->>'status', ''), 'draft')));
  v_invoice public.invoices%rowtype;
  v_payment public.payments_received%rowtype;
  v_previous_invoice_id text;
  v_current_status jsonb;
  v_previous_status jsonb;
begin
  if v_org_id is null or (v_role <> 'admin' and not public.is_superadmin()) then
    raise exception 'Only active admin users can save received payments';
  end if;

  if v_payment_id is null then
    raise exception 'Payment id is required';
  end if;

  if v_invoice_id is null then
    raise exception 'Invoice is required';
  end if;

  if v_status not in ('draft', 'confirmed', 'void') then
    raise exception 'Payment status is invalid';
  end if;

  begin
    v_amount := coalesce(nullif(payload->>'amount', '')::numeric, 0);
  exception when invalid_text_representation then
    raise exception 'Payment amount is invalid';
  end;

  if v_amount <= 0 then
    raise exception 'Payment amount must be greater than zero';
  end if;

  select *
    into v_invoice
  from public.invoices i
  where i.organization_id = v_org_id
    and i.id = v_invoice_id
  for update;

  if not found then
    raise exception 'Invoice was not found';
  end if;

  if nullif(trim(coalesce(payload->>'currency', '')), '') is not null
     and nullif(trim(coalesce(v_invoice.currency, '')), '') is not null
     and upper(trim(payload->>'currency')) <> upper(trim(v_invoice.currency)) then
    raise exception 'Payment currency must match invoice currency';
  end if;

  if v_previous_id is not null and v_previous_id <> v_payment_id then
    select pr.invoice_id
      into v_previous_invoice_id
    from public.payments_received pr
    where pr.organization_id = v_org_id
      and pr.id = v_previous_id
    for update;

    if not found then
      raise exception 'Previous received payment was not found';
    end if;

    delete from public.payments_received
     where organization_id = v_org_id
       and id = v_previous_id;
  end if;

  insert into public.payments_received (
    id,
    organization_id,
    invoice_id,
    invoice_no,
    customer_name,
    currency,
    received_date,
    amount,
    method,
    reference_no,
    notes,
    status,
    created_at,
    updated_at
  )
  values (
    v_payment_id,
    v_org_id,
    v_invoice.id,
    coalesce(nullif(payload->>'invoice_no', ''), v_invoice.id),
    coalesce(nullif(payload->>'customer_name', ''), v_invoice.customer_name, ''),
    coalesce(nullif(payload->>'currency', ''), v_invoice.currency, 'EUR'),
    coalesce(nullif(payload->>'received_date', ''), to_char(current_date, 'YYYY-MM-DD')),
    v_amount,
    coalesce(nullif(payload->>'method', ''), 'Bank Transfer'),
    coalesce(payload->>'reference_no', ''),
    coalesce(payload->>'notes', ''),
    v_status,
    coalesce(nullif(payload->>'created_at', '')::timestamptz, now()),
    now()
  )
  on conflict (id) do update
    set invoice_id = excluded.invoice_id,
        invoice_no = excluded.invoice_no,
        customer_name = excluded.customer_name,
        currency = excluded.currency,
        received_date = excluded.received_date,
        amount = excluded.amount,
        method = excluded.method,
        reference_no = excluded.reference_no,
        notes = excluded.notes,
        status = excluded.status,
        updated_at = now()
    where public.payments_received.organization_id = v_org_id
  returning * into v_payment;

  if v_payment.organization_id is distinct from v_org_id then
    raise exception 'Payment belongs to a different organization';
  end if;

  if v_previous_invoice_id is not null and v_previous_invoice_id <> v_invoice.id then
    v_previous_status := public.recalculate_invoice_paid_status_for_org(v_org_id, v_previous_invoice_id);
  end if;

  v_current_status := public.recalculate_invoice_paid_status_for_org(v_org_id, v_invoice.id);

  return jsonb_build_object(
    'payment', to_jsonb(v_payment),
    'invoice', v_current_status,
    'previous_invoice', v_previous_status
  );
end;
$$;

create or replace function public.save_payment_made_atomic(
  payload jsonb,
  previous_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_id uuid := public.current_profile_org_id();
  v_role text := public.current_profile_role();
  v_payment_id text := nullif(trim(coalesce(payload->>'id', '')), '');
  v_bill_id text := nullif(trim(coalesce(payload->>'bill_id', '')), '');
  v_previous_id text := nullif(trim(coalesce(previous_id, '')), '');
  v_amount numeric(14, 2);
  v_status text := lower(trim(coalesce(nullif(payload->>'status', ''), 'draft')));
  v_bill public.bills%rowtype;
  v_payment public.payments_made%rowtype;
  v_previous_bill_id text;
  v_current_status jsonb;
  v_previous_status jsonb;
begin
  if v_org_id is null or (v_role <> 'admin' and not public.is_superadmin()) then
    raise exception 'Only active admin users can save made payments';
  end if;

  if v_payment_id is null then
    raise exception 'Payment id is required';
  end if;

  if v_bill_id is null then
    raise exception 'Bill is required';
  end if;

  if v_status not in ('draft', 'confirmed', 'void') then
    raise exception 'Payment status is invalid';
  end if;

  begin
    v_amount := coalesce(nullif(payload->>'amount', '')::numeric, 0);
  exception when invalid_text_representation then
    raise exception 'Payment amount is invalid';
  end;

  if v_amount <= 0 then
    raise exception 'Payment amount must be greater than zero';
  end if;

  select *
    into v_bill
  from public.bills b
  where b.organization_id = v_org_id
    and b.id = v_bill_id
  for update;

  if not found then
    raise exception 'Bill was not found';
  end if;

  if nullif(trim(coalesce(payload->>'currency', '')), '') is not null
     and nullif(trim(coalesce(v_bill.currency, '')), '') is not null
     and upper(trim(payload->>'currency')) <> upper(trim(v_bill.currency)) then
    raise exception 'Payment currency must match bill currency';
  end if;

  if v_previous_id is not null and v_previous_id <> v_payment_id then
    select pm.bill_id
      into v_previous_bill_id
    from public.payments_made pm
    where pm.organization_id = v_org_id
      and pm.id = v_previous_id
    for update;

    if not found then
      raise exception 'Previous made payment was not found';
    end if;

    delete from public.payments_made
     where organization_id = v_org_id
       and id = v_previous_id;
  end if;

  insert into public.payments_made (
    id,
    organization_id,
    bill_id,
    bill_no,
    supplier_name,
    purchase_company,
    currency,
    payment_date,
    amount,
    method,
    reference_no,
    notes,
    status,
    created_at,
    updated_at
  )
  values (
    v_payment_id,
    v_org_id,
    v_bill.id,
    coalesce(nullif(payload->>'bill_no', ''), v_bill.id),
    coalesce(nullif(payload->>'supplier_name', ''), v_bill.supplier_name, ''),
    coalesce(nullif(payload->>'purchase_company', ''), v_bill.purchase_company, ''),
    coalesce(nullif(payload->>'currency', ''), v_bill.currency, 'EUR'),
    coalesce(nullif(payload->>'payment_date', ''), to_char(current_date, 'YYYY-MM-DD')),
    v_amount,
    coalesce(nullif(payload->>'method', ''), 'Bank Transfer'),
    coalesce(payload->>'reference_no', ''),
    coalesce(payload->>'notes', ''),
    v_status,
    coalesce(nullif(payload->>'created_at', '')::timestamptz, now()),
    now()
  )
  on conflict (id) do update
    set bill_id = excluded.bill_id,
        bill_no = excluded.bill_no,
        supplier_name = excluded.supplier_name,
        purchase_company = excluded.purchase_company,
        currency = excluded.currency,
        payment_date = excluded.payment_date,
        amount = excluded.amount,
        method = excluded.method,
        reference_no = excluded.reference_no,
        notes = excluded.notes,
        status = excluded.status,
        updated_at = now()
    where public.payments_made.organization_id = v_org_id
  returning * into v_payment;

  if v_payment.organization_id is distinct from v_org_id then
    raise exception 'Payment belongs to a different organization';
  end if;

  if v_previous_bill_id is not null and v_previous_bill_id <> v_bill.id then
    v_previous_status := public.recalculate_bill_paid_status_for_org(v_org_id, v_previous_bill_id);
  end if;

  v_current_status := public.recalculate_bill_paid_status_for_org(v_org_id, v_bill.id);

  return jsonb_build_object(
    'payment', to_jsonb(v_payment),
    'bill', v_current_status,
    'previous_bill', v_previous_status
  );
end;
$$;

create or replace function public.delete_payment_received_guarded(id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_id uuid := public.current_profile_org_id();
  v_role text := public.current_profile_role();
  v_payment public.payments_received%rowtype;
  v_invoice_status jsonb;
begin
  if v_org_id is null or (v_role <> 'admin' and not public.is_superadmin()) then
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

create or replace function public.delete_payment_made_guarded(id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_id uuid := public.current_profile_org_id();
  v_role text := public.current_profile_role();
  v_payment public.payments_made%rowtype;
  v_bill_status jsonb;
begin
  if v_org_id is null or (v_role <> 'admin' and not public.is_superadmin()) then
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

grant execute on function public.save_payment_received_atomic(jsonb, text) to authenticated, service_role;
grant execute on function public.save_payment_made_atomic(jsonb, text) to authenticated, service_role;
grant execute on function public.delete_payment_received_guarded(text) to authenticated, service_role;
grant execute on function public.delete_payment_made_guarded(text) to authenticated, service_role;
