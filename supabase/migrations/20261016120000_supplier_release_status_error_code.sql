-- Include the explicit operator-interruption marker when the worker reconciles
-- terminal DBOS history.  A quarantined, unpublished release must remain
-- visible for review without blocking intake of unrelated new uploads.
drop function if exists public.get_supplier_price_release_status(uuid[]);

create function public.get_supplier_price_release_status(input_release_ids uuid[])
returns table (id uuid, status text, error_code text)
language sql
stable
security definer
set search_path = ''
as $$
  select r.id, r.status, r.error_code
    from public.supplier_price_releases as r
   where r.id = any(input_release_ids);
$$;

revoke all on function public.get_supplier_price_release_status(uuid[])
  from public, anon, authenticated, service_role;
grant execute on function public.get_supplier_price_release_status(uuid[])
  to service_role;
