-- Service-role-only queue peek for the hosted staging worker. The candidate
-- contains only the release identity; validation remains idempotent and never
-- publishes prices or changes the current supplier-price pointer.
create or replace function public.get_supplier_price_validation_candidate()
returns table (id uuid)
language sql
stable
security definer
set search_path = ''
as $$
  select r.id
    from public.supplier_price_releases as r
   where r.source_verification_required is true
     and r.status = 'staged'
   order by r.updated_at, r.id
   limit 1;
$$;

revoke all on function public.get_supplier_price_validation_candidate()
  from public, anon, authenticated, service_role;
grant execute on function public.get_supplier_price_validation_candidate()
  to service_role;
