-- Security hardening for legacy/internal catalog tables and trigger-only functions.
-- These tables are not used by the browser clients; worker scripts use service_role.

alter table public.external_catalog_observations enable row level security;
alter table public.catalog_products_clean enable row level security;

-- Remove Data API access from client roles. service_role/postgres retain access for
-- controlled worker and server-side operations. No client policies are added because
-- neither table is part of the browser-facing application contract.
revoke all on table public.external_catalog_observations from public, anon, authenticated;
revoke all on table public.catalog_products_clean from public, anon, authenticated;

-- Trigger functions are invoked by PostgreSQL triggers, not by RPC/API callers.
-- Keep EXECUTE with the owner only; trigger execution does not require client grants.
do $$
declare
  fn record;
begin
  for fn in
    select p.oid::regprocedure as identity
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prorettype = 'pg_catalog.trigger'::regtype
  loop
    execute format(
      'revoke all on function %s from public, anon, authenticated, service_role',
      fn.identity
    );
  end loop;
end;
$$;

-- Pin search_path for immutable helper functions flagged by the database linter.
alter function public.normalize_stock_snapshot_key(text)
  set search_path = pg_catalog;
alter function public.reporting_to_numeric(text)
  set search_path = pg_catalog;
alter function public.reporting_to_date(text)
  set search_path = pg_catalog;
alter function public.reporting_line_uuid(text, text, integer)
  set search_path = pg_catalog;
