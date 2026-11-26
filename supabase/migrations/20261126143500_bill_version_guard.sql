-- No data is rewritten. Keep local bootstrap INSERT, but enforce number identity.
create schema if not exists bill_integrity_private;
revoke all on schema bill_integrity_private from public, anon, authenticated, service_role;
create function bill_integrity_private.normalized_number(value text)
returns text language sql immutable parallel safe set search_path = '' as $$
  select pg_catalog.regexp_replace(pg_catalog.upper(coalesce(value, '')), '[[:space:]]+', '', 'g');
$$;
create function bill_integrity_private.guard_insert()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_number text := bill_integrity_private.normalized_number(new.id);
  v_previous text := pg_catalog.current_setting('bill_integrity.previous_id', true);
begin
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('bill|' || new.organization_id::text || '|' || v_number, 0));
  if exists(select 1 from public.bills b where b.id = new.id) then
    if v_previous is distinct from new.id or not exists(select 1 from public.bills b where b.id = new.id and b.organization_id = new.organization_id) then
      raise exception using message = 'BILL_NUMBER_ALREADY_USED', errcode = '23505';
    end if;
    return new;
  end if;
  if exists(select 1 from public.bills b where b.organization_id = new.organization_id and bill_integrity_private.normalized_number(b.id) = v_number) then
    raise exception using message = 'BILL_NUMBER_ALREADY_USED', errcode = '23505';
  end if;
  return new;
end;
$$;
create trigger bills_number_guard before insert on public.bills for each row execute function bill_integrity_private.guard_insert();

alter function public.save_bill_atomic(jsonb, text) set schema bill_integrity_private;
alter function public.delete_bill_guarded(text) set schema bill_integrity_private;
revoke all on all functions in schema bill_integrity_private from public, anon, authenticated, service_role;

create function public.save_bill_atomic(payload jsonb, previous_id text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := public.current_profile_org_id();
  v_role text := public.current_profile_role();
  v_id text := nullif(pg_catalog.btrim(coalesce(payload->>'id', '')), '');
  v_previous text := nullif(pg_catalog.btrim(coalesce(previous_id, '')), '');
  v_actual timestamptz;
  v_expected timestamptz;
  v_result jsonb;
begin
  if v_org is null or not coalesce(v_role = 'admin' or public.is_superadmin(), false) then raise exception 'Only active admin users can save bills'; end if;
  if v_id is null then raise exception 'Bill id is required'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('bill|' || v_org::text || '|' || bill_integrity_private.normalized_number(v_id), 0));
  if v_previous is not null then
    select b.updated_at into v_actual from public.bills b where b.organization_id = v_org and b.id = v_previous for update;
    if not found then raise exception 'Previous bill was not found'; end if;
    if not (payload ? 'expected_updated_at') then raise exception using message = 'BILL_VERSION_REQUIRED', errcode = 'P0001'; end if;
    begin
      v_expected := nullif(payload->>'expected_updated_at', '')::timestamptz;
    exception when invalid_datetime_format or datetime_field_overflow then raise exception using message = 'BILL_VERSION_REQUIRED', errcode = 'P0001'; end;
    if v_actual is distinct from v_expected then raise exception using message = 'BILL_VERSION_CONFLICT', errcode = 'P0001'; end if;
  end if;
  if (v_previous is null or v_id <> v_previous) and exists(select 1 from public.bills b where b.organization_id = v_org and (v_previous is null or b.id <> v_previous) and bill_integrity_private.normalized_number(b.id) = bill_integrity_private.normalized_number(v_id)) then
    raise exception using message = 'BILL_NUMBER_ALREADY_USED', errcode = '23505';
  end if;
  perform pg_catalog.set_config('bill_integrity.previous_id', coalesce(v_previous, ''), true);
  begin
    v_result := bill_integrity_private.save_bill_atomic(payload, previous_id);
  exception when others then
    perform pg_catalog.set_config('bill_integrity.previous_id', '', true);
    raise;
  end;
  perform pg_catalog.set_config('bill_integrity.previous_id', '', true);
  return v_result;
end;
$$;
create function public.delete_bill_guarded(id text)
returns jsonb language plpgsql set search_path = '' as $$
begin raise exception using message = 'BILL_VERSION_REQUIRED', errcode = 'P0001'; end;
$$;
create function public.delete_bill_guarded(id text, expected_updated_at text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := public.current_profile_org_id();
  v_role text := public.current_profile_role();
  v_actual timestamptz;
  v_expected timestamptz;
begin
  if v_org is null or not coalesce(v_role = 'admin' or public.is_superadmin(), false) then raise exception 'Only active admin users can delete bills'; end if;
  select b.updated_at into v_actual from public.bills b where b.organization_id = v_org and b.id = delete_bill_guarded.id for update;
  if not found then raise exception 'Bill was not found'; end if;
  begin
    v_expected := nullif(expected_updated_at, '')::timestamptz;
  exception when invalid_datetime_format or datetime_field_overflow then raise exception using message = 'BILL_VERSION_REQUIRED', errcode = 'P0001'; end;
  if v_actual is distinct from v_expected then raise exception using message = 'BILL_VERSION_CONFLICT', errcode = 'P0001'; end if;
  return bill_integrity_private.delete_bill_guarded(id);
end;
$$;
revoke all on function public.save_bill_atomic(jsonb, text) from public, anon;
revoke all on function public.delete_bill_guarded(text) from public, anon;
revoke all on function public.delete_bill_guarded(text, text) from public, anon;
grant execute on function public.save_bill_atomic(jsonb, text) to authenticated, service_role;
grant execute on function public.delete_bill_guarded(text) to authenticated, service_role;
grant execute on function public.delete_bill_guarded(text, text) to authenticated, service_role;
revoke update, delete, truncate, references, trigger on public.bills from public, anon, authenticated;
revoke truncate, references, trigger on public.payments_received, public.payments_made from public, anon, authenticated;
notify pgrst, 'reload schema';
