-- A customer-list response can stop at the PostgREST row limit. Count matches
-- across the whole organization before applying the caller's customer scope:
-- a hidden duplicate must never make a visible account appear unique.

create or replace function public.find_invoice_price_customer_name_matches(
  p_organization_id uuid,
  p_customer_name text
)
returns table(customer_id uuid)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_actor_id uuid := auth.uid();
  v_organization_id uuid := public.current_profile_org_id();
  v_role text := public.raw_profile_role(v_actor_id);
  v_matches uuid[];
begin
  if v_actor_id is null
    or v_organization_id is null
    or p_organization_id is distinct from v_organization_id
    or pg_catalog.btrim(coalesce(p_customer_name, '')) = ''
    or coalesce(v_role, '') not in ('superadmin', 'admin', 'sales')
  then
    return;
  end if;

  if not exists (
    select 1
    from public.profiles p
    where p.id = v_actor_id
      and p.organization_id = v_organization_id
      and p.is_active
  ) then
    return;
  end if;

  if v_role = 'sales'
    and not coalesce(public.profile_has_permission('customers.view'), false)
  then
    return;
  end if;

  select pg_catalog.array_agg(candidate.id)
    into v_matches
  from (
    select c.id
    from public.customers c
    where c.organization_id = v_organization_id
      and (
        pg_catalog.lower(pg_catalog.btrim(c.display_name)) = pg_catalog.lower(pg_catalog.btrim(p_customer_name))
        or pg_catalog.lower(pg_catalog.btrim(c.company_name)) = pg_catalog.lower(pg_catalog.btrim(p_customer_name))
      )
    order by c.id
    limit 2
  ) candidate;

  if coalesce(pg_catalog.array_length(v_matches, 1), 0) > 1 then
    if v_role = 'sales'
      and coalesce(public.current_profile_customer_scope_mode(), '') <> 'all'
      and not exists (
        select 1
        from public.customers c
        where c.organization_id = v_organization_id
          and (
            pg_catalog.lower(pg_catalog.btrim(c.display_name)) = pg_catalog.lower(pg_catalog.btrim(p_customer_name))
            or pg_catalog.lower(pg_catalog.btrim(c.company_name)) = pg_catalog.lower(pg_catalog.btrim(p_customer_name))
          )
          and coalesce(public.can_access_customer(c.id), false)
      )
    then
      return;
    end if;
    raise exception 'AMBIGUOUS_CUSTOMER_ACCOUNT' using errcode = 'P0001';
  end if;

  if coalesce(pg_catalog.array_length(v_matches, 1), 0) = 0 then
    return;
  end if;

  if v_role = 'sales'
    and coalesce(public.current_profile_customer_scope_mode(), '') <> 'all'
    and not coalesce(public.can_access_customer(v_matches[1]), false)
  then
    return;
  end if;

  return query select v_matches[1];
end;
$$;

revoke all on function public.find_invoice_price_customer_name_matches(uuid, text)
  from public, anon, authenticated, service_role;
grant execute on function public.find_invoice_price_customer_name_matches(uuid, text)
  to authenticated;
