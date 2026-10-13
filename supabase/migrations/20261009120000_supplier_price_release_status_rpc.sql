-- Read-only status lookup used by the hosted staging worker to reconcile
-- terminal DBOS history without exposing release rows through PostgREST.
create or replace function public.get_supplier_price_release_status(
  input_release_ids uuid[]
)
returns table (
  id uuid,
  status text
)
language sql
stable
security definer
set search_path = ''
as $$
  select r.id, r.status
    from public.supplier_price_releases as r
   where r.id = any(input_release_ids);
$$;

revoke all on function public.get_supplier_price_release_status(uuid[])
  from public, anon, authenticated, service_role;
grant execute on function public.get_supplier_price_release_status(uuid[])
  to service_role;
