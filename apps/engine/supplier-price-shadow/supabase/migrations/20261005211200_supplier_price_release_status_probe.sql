create or replace function public.get_supplier_price_release_status(input_release_ids uuid[])
returns table(id uuid, status text)
language sql
security definer
set search_path = ''
as $$
  select r.id, r.status
  from public.supplier_price_releases r
  where r.id = any(coalesce(input_release_ids, '{}'::uuid[]))
$$;

revoke all on function public.get_supplier_price_release_status(uuid[]) from public, anon, authenticated, service_role;
grant execute on function public.get_supplier_price_release_status(uuid[]) to service_role;
