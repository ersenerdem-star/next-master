-- Existing duplicate document numbers are deliberately left untouched.
-- New documents and number changes are checked within each organisation and
-- each document type.  A sales order and its invoice may share a number.
create schema if not exists document_number_guard_private;
revoke all on schema document_number_guard_private from public, anon, authenticated, service_role;

create function document_number_guard_private.normalized_number(input text)
returns text language sql immutable parallel safe set search_path = '' as $$
  select pg_catalog.regexp_replace(pg_catalog.upper(coalesce(input, '')), '[[:space:]]+', '', 'g');
$$;

-- SECURITY DEFINER is necessary for duplicate checks across customer-scoped
-- RLS, but the lookup is restricted to NEW.organization_id and reveals no
-- information other than the fixed error code. RLS still governs the write.
create function document_number_guard_private.guard_sales_order_number()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_number text := document_number_guard_private.normalized_number(new.sales_order_no);
  v_existing public.sales_orders%rowtype;
begin
  if v_number = '' then return new; end if; -- retain existing empty-number rules
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('sales-order|' || new.organization_id::text || '|' || v_number, 0));
  if tg_op = 'UPDATE' and new.organization_id = old.organization_id
     and v_number = document_number_guard_private.normalized_number(old.sales_order_no) then
    return new;
  end if;
  -- BEFORE INSERT also runs for INSERT ... ON CONFLICT DO UPDATE. Existing
  -- orders must remain editable even if legacy duplicate numbers exist.
  if tg_op = 'INSERT' then
    select * into v_existing from public.sales_orders s
      where s.id = new.id and s.organization_id = new.organization_id;
    if found and v_number = document_number_guard_private.normalized_number(v_existing.sales_order_no) then
      return new;
    end if;
  end if;
  if exists (select 1 from public.sales_orders s
    where s.organization_id = new.organization_id and s.id is distinct from new.id
      and document_number_guard_private.normalized_number(s.sales_order_no) = v_number) then
    raise exception using message = 'SALES_ORDER_NUMBER_ALREADY_USED', errcode = '23505';
  end if;
  return new;
end;
$$;

create trigger sales_orders_document_number_guard before insert or update on public.sales_orders
for each row execute function document_number_guard_private.guard_sales_order_number();

-- An invoice's id is its visible number.  In particular, the historical RPC
-- upserts on id: a new invoice with an existing id could overwrite that row.
-- The wrapper distinguishes an explicit edit (previous_id) from a creation.
alter function public.save_invoice_atomic(jsonb, text) set schema document_number_guard_private;
revoke all on function document_number_guard_private.save_invoice_atomic(jsonb, text)
  from public, anon, authenticated, service_role;

create function document_number_guard_private.guard_invoice_number()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_number text := document_number_guard_private.normalized_number(new.id);
  v_previous text := pg_catalog.current_setting('document_number_guard.invoice_previous_id', true);
begin
  if v_number = '' then return new; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('invoice|' || new.organization_id::text || '|' || v_number, 0));
  if tg_op = 'UPDATE' and new.organization_id = old.organization_id
     and v_number = document_number_guard_private.normalized_number(old.id) then
    return new;
  end if;
  -- Only the guarded save RPC can perform an upsert of an existing invoice.
  if tg_op = 'INSERT' and exists (select 1 from public.invoices i where i.id = new.id) then
    if v_previous is null or v_previous = '' or v_previous <> new.id
       or not exists (select 1 from public.invoices i where i.id = new.id and i.organization_id = new.organization_id) then
      raise exception using message = 'INVOICE_NUMBER_ALREADY_USED', errcode = '23505';
    end if;
    return new;
  end if;
  if exists (select 1 from public.invoices i
    where i.organization_id = new.organization_id
      and (tg_op <> 'UPDATE' or i.id is distinct from old.id)
      and document_number_guard_private.normalized_number(i.id) = v_number) then
    raise exception using message = 'INVOICE_NUMBER_ALREADY_USED', errcode = '23505';
  end if;
  return new;
end;
$$;

create trigger invoices_document_number_guard before insert or update on public.invoices
for each row execute function document_number_guard_private.guard_invoice_number();

create function public.save_invoice_atomic(payload jsonb, previous_id text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_org_id uuid := public.current_profile_org_id();
  v_role text := public.current_profile_role();
  v_id text := nullif(pg_catalog.btrim(coalesce(payload->>'id', '')), '');
  v_previous_id text := nullif(pg_catalog.btrim(coalesce(previous_id, '')), '');
  v_number text := document_number_guard_private.normalized_number(v_id);
  v_result jsonb;
begin
  -- Match the original authorization before looking up any invoice numbers.
  if v_org_id is null or not coalesce(v_role = 'admin' or public.is_superadmin(), false) then
    raise exception 'Only active admin users can save invoices';
  end if;
  if v_id is null then raise exception 'Invoice id is required'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('invoice|' || v_org_id::text || '|' || v_number, 0));
  if v_previous_id is not null and not exists (select 1 from public.invoices i
    where i.organization_id = v_org_id and i.id = v_previous_id) then
    raise exception 'Previous invoice was not found';
  end if;
  if (v_previous_id is null or v_id <> v_previous_id) and exists (select 1 from public.invoices i
    where i.organization_id = v_org_id
      and (v_previous_id is null or i.id <> v_previous_id)
      and document_number_guard_private.normalized_number(i.id) = v_number) then
    raise exception using message = 'INVOICE_NUMBER_ALREADY_USED', errcode = '23505';
  end if;
  perform pg_catalog.set_config('document_number_guard.invoice_previous_id', coalesce(v_previous_id, ''), true);
  begin
    v_result := document_number_guard_private.save_invoice_atomic(payload, previous_id);
  exception when others then
    perform pg_catalog.set_config('document_number_guard.invoice_previous_id', '', true);
    raise;
  end;
  perform pg_catalog.set_config('document_number_guard.invoice_previous_id', '', true);
  return v_result;
end;
$$;
revoke all on function public.save_invoice_atomic(jsonb, text) from public, anon;
grant execute on function public.save_invoice_atomic(jsonb, text) to authenticated, service_role;
revoke all on all functions in schema document_number_guard_private from public, anon, authenticated, service_role;
notify pgrst, 'reload schema';
