-- DISTINCT must deduplicate scopes, not a different volatile timestamp per source row.
-- Keep one monotonic revision per affected brand and SQL statement.
create or replace function public.touch_supplier_price_source_revision()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if tg_op = 'TRUNCATE' then
    update public.supplier_price_source_global_version
       set source_revision = source_revision + 1,
           updated_at = pg_catalog.statement_timestamp()
     where singleton;
    return null;
  end if;

  if tg_op = 'INSERT' then
    insert into public.supplier_price_source_versions(
      organization_id, brand_id, source_revision, updated_at
    )
    select distinct n.organization_id, n.brand_id, 1, pg_catalog.statement_timestamp()
      from new_rows n
     where n.organization_id is not null
       and n.brand_id is not null
    on conflict (organization_id, brand_id) do update
      set source_revision = public.supplier_price_source_versions.source_revision + 1,
          updated_at = pg_catalog.statement_timestamp();
  elsif tg_op = 'DELETE' then
    insert into public.supplier_price_source_versions(
      organization_id, brand_id, source_revision, updated_at
    )
    select distinct o.organization_id, o.brand_id, 1, pg_catalog.statement_timestamp()
      from old_rows o
     where o.organization_id is not null
       and o.brand_id is not null
    on conflict (organization_id, brand_id) do update
      set source_revision = public.supplier_price_source_versions.source_revision + 1,
          updated_at = pg_catalog.statement_timestamp();
  else
    insert into public.supplier_price_source_versions(
      organization_id, brand_id, source_revision, updated_at
    )
    select distinct scopes.organization_id, scopes.brand_id, 1, pg_catalog.statement_timestamp()
      from (
        select o.organization_id, o.brand_id from old_rows o
        union
        select n.organization_id, n.brand_id from new_rows n
      ) scopes
     where scopes.organization_id is not null
       and scopes.brand_id is not null
    on conflict (organization_id, brand_id) do update
      set source_revision = public.supplier_price_source_versions.source_revision + 1,
          updated_at = pg_catalog.statement_timestamp();
  end if;

  return null;
end;
$function$;

revoke all on function public.touch_supplier_price_source_revision() from public, anon, authenticated;

