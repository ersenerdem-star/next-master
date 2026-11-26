-- Reject stale edits and deletion of existing invoices without rewriting data.
create schema if not exists invoice_edit_version_private;
revoke all on schema invoice_edit_version_private from public, anon, authenticated, service_role;
alter function public.save_invoice_atomic(jsonb, text) set schema invoice_edit_version_private;
alter function public.delete_invoice_guarded(text) set schema invoice_edit_version_private;
revoke all on function invoice_edit_version_private.save_invoice_atomic(jsonb,text) from public, anon, authenticated, service_role;
revoke all on function invoice_edit_version_private.delete_invoice_guarded(text) from public, anon, authenticated, service_role;

create function public.save_invoice_atomic(payload jsonb, previous_id text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := public.current_profile_org_id();
  v_role text := public.current_profile_role();
  v_previous_id text := nullif(pg_catalog.btrim(coalesce(previous_id, '')), '');
  v_expected text := nullif(pg_catalog.btrim(coalesce(payload->>'expected_updated_at', '')), '');
  v_updated timestamptz;
begin
  if v_org is null or not coalesce(v_role = 'admin' or public.is_superadmin(), false) then
    raise exception 'Only active admin users can save invoices';
  end if;
  if v_previous_id is not null then
    select i.updated_at into v_updated from public.invoices i
      where i.organization_id = v_org and i.id = v_previous_id for update;
    if not found then raise exception 'Previous invoice was not found'; end if;
    if v_expected is null then raise exception 'INVOICE_VERSION_REQUIRED'; end if;
    if v_expected::timestamptz is distinct from v_updated then raise exception 'INVOICE_VERSION_CONFLICT'; end if;
  end if;
  return invoice_edit_version_private.save_invoice_atomic(payload, previous_id);
end;
$$;

create function public.delete_invoice_guarded(id text, expected_updated_at text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := public.current_profile_org_id();
  v_role text := public.current_profile_role();
  v_updated timestamptz;
begin
  if v_org is null or not coalesce(v_role = 'admin' or public.is_superadmin(), false) then
    raise exception 'Only active admin users can delete invoices';
  end if;
  select i.updated_at into v_updated from public.invoices i
    where i.organization_id = v_org and i.id = delete_invoice_guarded.id for update;
  if not found then raise exception 'Invoice was not found'; end if;
  if nullif(pg_catalog.btrim(coalesce(expected_updated_at, '')), '') is null then
    raise exception 'INVOICE_VERSION_REQUIRED';
  end if;
  if expected_updated_at::timestamptz is distinct from v_updated then raise exception 'INVOICE_VERSION_CONFLICT'; end if;
  return invoice_edit_version_private.delete_invoice_guarded(id);
end;
$$;
revoke all on function public.save_invoice_atomic(jsonb,text) from public, anon;
revoke all on function public.delete_invoice_guarded(text,text) from public, anon;
grant execute on function public.save_invoice_atomic(jsonb,text) to authenticated, service_role;
grant execute on function public.delete_invoice_guarded(text,text) to authenticated, service_role;
notify pgrst, 'reload schema';
