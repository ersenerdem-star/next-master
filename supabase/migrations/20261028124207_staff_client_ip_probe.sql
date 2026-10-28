-- Let an authenticated admin see the address observed by Supabase itself.
-- A browser may use IPv6 toward Supabase and IPv4 toward Netlify.
create or replace function public.current_staff_client_ip()
returns text
language sql stable security invoker
set search_path = pg_catalog, public
as $$
  select nullif(current_setting('request.headers', true)::jsonb ->> 'cf-connecting-ip', '');
$$;

revoke all on function public.current_staff_client_ip() from public, anon;
grant execute on function public.current_staff_client_ip() to authenticated, service_role;
