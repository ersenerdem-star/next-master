-- Keep export source versions O(1) for legacy supplier_prices scopes.
--
-- The previous admin/master version functions hashed every legacy row with
-- string_agg(md5(...)).  That made a version read scale with the full legacy
-- table and could consume the same timeout budget as the export itself.  A
-- statement-level transition trigger records one monotonic revision per
-- organization/brand whenever supplier_prices changes.  The export version
-- only reads these small metadata rows; the source rows themselves remain the
-- authoritative export input.

create table if not exists public.supplier_price_source_versions (
  organization_id uuid not null,
  brand_id uuid not null,
  source_revision bigint not null default 0,
  updated_at timestamptz not null default pg_catalog.clock_timestamp(),
  primary key (organization_id, brand_id)
);

create table if not exists public.supplier_price_source_global_version (
  singleton boolean primary key default true,
  source_revision bigint not null default 0,
  updated_at timestamptz not null default pg_catalog.clock_timestamp(),
  constraint supplier_price_source_global_version_singleton check (singleton)
);

insert into public.supplier_price_source_global_version(singleton)
values (true)
on conflict (singleton) do nothing;

comment on table public.supplier_price_source_versions is
  'Monotonic legacy supplier_prices revisions used by export source fingerprints.';
comment on table public.supplier_price_source_global_version is
  'Global legacy supplier_prices revision; covers TRUNCATE statements.';

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
           updated_at = pg_catalog.clock_timestamp()
     where singleton;
    return null;
  end if;

  if tg_op = 'INSERT' then
    insert into public.supplier_price_source_versions(
      organization_id, brand_id, source_revision, updated_at
    )
    select distinct n.organization_id, n.brand_id, 1, pg_catalog.clock_timestamp()
      from new_rows n
     where n.organization_id is not null
       and n.brand_id is not null
    on conflict (organization_id, brand_id) do update
      set source_revision = public.supplier_price_source_versions.source_revision + 1,
          updated_at = pg_catalog.clock_timestamp();
  elsif tg_op = 'DELETE' then
    insert into public.supplier_price_source_versions(
      organization_id, brand_id, source_revision, updated_at
    )
    select distinct o.organization_id, o.brand_id, 1, pg_catalog.clock_timestamp()
      from old_rows o
     where o.organization_id is not null
       and o.brand_id is not null
    on conflict (organization_id, brand_id) do update
      set source_revision = public.supplier_price_source_versions.source_revision + 1,
          updated_at = pg_catalog.clock_timestamp();
  else
    insert into public.supplier_price_source_versions(
      organization_id, brand_id, source_revision, updated_at
    )
    select distinct scopes.organization_id, scopes.brand_id, 1, pg_catalog.clock_timestamp()
      from (
        select o.organization_id, o.brand_id from old_rows o
        union
        select n.organization_id, n.brand_id from new_rows n
      ) scopes
     where scopes.organization_id is not null
       and scopes.brand_id is not null
    on conflict (organization_id, brand_id) do update
      set source_revision = public.supplier_price_source_versions.source_revision + 1,
          updated_at = pg_catalog.clock_timestamp();
  end if;

  return null;
end;
$function$;

revoke all on function public.touch_supplier_price_source_revision() from public, anon, authenticated;

drop trigger if exists supplier_prices_source_revision_insert on public.supplier_prices;
create trigger supplier_prices_source_revision_insert
after insert on public.supplier_prices
referencing new table as new_rows
for each statement execute function public.touch_supplier_price_source_revision();

drop trigger if exists supplier_prices_source_revision_update on public.supplier_prices;
create trigger supplier_prices_source_revision_update
after update on public.supplier_prices
referencing old table as old_rows new table as new_rows
for each statement execute function public.touch_supplier_price_source_revision();

drop trigger if exists supplier_prices_source_revision_delete on public.supplier_prices;
create trigger supplier_prices_source_revision_delete
after delete on public.supplier_prices
referencing old table as old_rows
for each statement execute function public.touch_supplier_price_source_revision();

drop trigger if exists supplier_prices_source_revision_truncate on public.supplier_prices;
create trigger supplier_prices_source_revision_truncate
after truncate on public.supplier_prices
for each statement execute function public.touch_supplier_price_source_revision();

-- The metadata table is private.  Only the definer functions and service role
-- may read it; no browser role needs direct access.
revoke all on table public.supplier_price_source_versions from public, anon, authenticated;
revoke all on table public.supplier_price_source_global_version from public, anon, authenticated;
grant select on table public.supplier_price_source_versions, public.supplier_price_source_global_version to service_role;

create or replace function public.get_admin_price_list_export_version(
  input_organization_id uuid,
  input_brand_id uuid
)
returns text
language sql
stable
security definer
set search_path to ''
as $function$
  with pointers as materialized (
    select ptr.*, pub.status publication_status, pub.published_at, pub.created_at
    from public.supplier_current_price_pointers ptr
    left join public.supplier_price_publications pub
      on pub.id = ptr.publication_id
     and pub.release_id = ptr.release_id
     and pub.organization_id = ptr.organization_id
     and pub.supplier_id = ptr.supplier_id
     and pub.brand_id = ptr.brand_id
    where ptr.organization_id = input_organization_id
      and ptr.brand_id = input_brand_id
  )
  select pg_catalog.md5(
    'price-source-commercial-v4:'
    || coalesce(input_organization_id::text, '') || ':'
    || coalesce(input_brand_id::text, '') || ':'
    || coalesce((
      select count(*)::text || ':' ||
        coalesce(extract(epoch from max(cp.updated_at))::text, '')
      from public.catalog_products cp
      where cp.organization_id = input_organization_id
        and cp.brand_id = input_brand_id
    ), '') || ':'
    || coalesce((
      select b.name
      from public.brands b
      where b.id = input_brand_id
        and b.organization_id = input_organization_id
    ), '') || ':'
    || coalesce((
      select pg_catalog.string_agg(
        pg_catalog.jsonb_build_array(
          ptr.supplier_id, ptr.release_id, ptr.publication_id,
          ptr.publication_status,
          extract(epoch from ptr.published_at),
          extract(epoch from ptr.created_at)
        )::text,
        ',' order by ptr.supplier_id
      )
      from pointers ptr
    ), '') || ':'
    || coalesce((
      select pg_catalog.min(r.valid_from)::text
      from pointers ptr
      cross join lateral (
        select rr.valid_from
        from public.supplier_price_release_rows rr
        where ptr.publication_status = 'published'
          and rr.release_id = ptr.release_id
          and rr.row_status = 'accepted'
          and rr.buy_price > 0
          and rr.currency = 'EUR'
          and rr.valid_from > current_date
        order by rr.valid_from
        limit 1
      ) r
    ), '') || ':'
    || coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_array(
          ref.id, ref.old_code, ref.new_code, ref.is_active,
          extract(epoch from ref.updated_at)
        ) order by ref.id
      )::text
      from public.item_code_references ref
      where ref.organization_id = input_organization_id
        and ref.brand_id = input_brand_id
    ), '[]') || ':'
    || coalesce((
      select source_revision::text
      from public.supplier_price_source_versions
      where organization_id = input_organization_id
        and brand_id = input_brand_id
    ), '0') || ':'
    || coalesce((
      select source_revision::text
      from public.supplier_price_source_global_version
      where singleton
    ), '0') || ':'
    || current_date::text
  );
$function$;

revoke all on function public.get_admin_price_list_export_version(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.get_admin_price_list_export_version(uuid, uuid)
  to service_role;

-- Master export versions are derived from the same source scope.  The old
-- function hashed every legacy row's id/oem/notes; the monotonic revision
-- already changes for those writes, so keep this derived version bounded too.
create or replace function public.get_catalog_master_export_version(
  input_organization_id uuid,
  input_brand_id uuid,
  input_scope text default 'priced'
)
returns text
language sql
stable
security definer
set search_path to ''
as $function$
  select pg_catalog.md5(
    'mixed-supplier-master-v2:'
    || coalesce(input_scope, 'priced') || ':'
    || public.get_admin_price_list_export_version(input_organization_id, input_brand_id) || ':'
    || coalesce((
      select pg_catalog.string_agg(
        pg_catalog.jsonb_build_array(s.id, s.name)::text,
        ',' order by s.id
      )
      from public.suppliers s
      where s.organization_id = input_organization_id
    ), '')
  );
$function$;

revoke all on function public.get_catalog_master_export_version(uuid, uuid, text)
  from public, anon, authenticated;
grant execute on function public.get_catalog_master_export_version(uuid, uuid, text)
  to service_role;
