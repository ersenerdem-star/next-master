-- Price workbooks are publication snapshots, not daily catalog exports.
-- Keep the old fingerprint for in-flight/legacy jobs and catalog exports.
-- Descriptions are captured when a price file is prepared. Unrelated enrichment
-- (description, image, origin, tariff, weight, etc.) does not rebuild that file.
-- Product identity, lifecycle, replacement and commercial validity still do.
set local lock_timeout='5s';
set local statement_timeout='90s';
create table public.prepared_price_catalog_versions (
  organization_id uuid not null,
  brand_id uuid not null,
  revision bigint not null default 1,
  primary key(organization_id,brand_id)
);
create table public.prepared_price_catalog_global_version (
  singleton boolean primary key default true check(singleton),
  revision bigint not null default 0
);
insert into public.prepared_price_catalog_global_version(singleton) values(true);
alter table public.prepared_price_catalog_versions enable row level security;
alter table public.prepared_price_catalog_global_version enable row level security;
revoke all on public.prepared_price_catalog_versions,public.prepared_price_catalog_global_version from public,anon,authenticated,service_role;
grant select on public.prepared_price_catalog_versions,public.prepared_price_catalog_global_version to service_role;

create function public.touch_prepared_price_catalog_version()
returns trigger language plpgsql security definer set search_path='' as $fn$
begin
  if tg_op='TRUNCATE' then
    update public.prepared_price_catalog_global_version set revision=revision+1 where singleton;
  elsif tg_op='INSERT' then
    insert into public.prepared_price_catalog_versions(organization_id,brand_id)
    select distinct organization_id,brand_id from new_rows
    on conflict(organization_id,brand_id) do update set revision=public.prepared_price_catalog_versions.revision+1;
  elsif tg_op='DELETE' then
    insert into public.prepared_price_catalog_versions(organization_id,brand_id)
    select distinct organization_id,brand_id from old_rows
    on conflict(organization_id,brand_id) do update set revision=public.prepared_price_catalog_versions.revision+1;
  else
    insert into public.prepared_price_catalog_versions(organization_id,brand_id)
    select distinct s.organization_id,s.brand_id from (
      select o.organization_id,o.brand_id from old_rows o join new_rows n using(id)
      where (o.organization_id,o.brand_id,o.product_code,o.normalized_code,o.lifecycle_status,o.lifecycle_note)
        is distinct from (n.organization_id,n.brand_id,n.product_code,n.normalized_code,n.lifecycle_status,n.lifecycle_note)
      union
      select n.organization_id,n.brand_id from old_rows o join new_rows n using(id)
      where (o.organization_id,o.brand_id,o.product_code,o.normalized_code,o.lifecycle_status,o.lifecycle_note)
        is distinct from (n.organization_id,n.brand_id,n.product_code,n.normalized_code,n.lifecycle_status,n.lifecycle_note)
    ) s
    on conflict(organization_id,brand_id) do update set revision=public.prepared_price_catalog_versions.revision+1;
  end if;
  return null;
end;
$fn$;
revoke all on function public.touch_prepared_price_catalog_version() from public,anon,authenticated,service_role;
create trigger prepared_price_catalog_insert after insert on public.catalog_products
referencing new table as new_rows for each statement execute function public.touch_prepared_price_catalog_version();
create trigger prepared_price_catalog_update after update on public.catalog_products
referencing old table as old_rows new table as new_rows for each statement execute function public.touch_prepared_price_catalog_version();
create trigger prepared_price_catalog_delete after delete on public.catalog_products
referencing old table as old_rows for each statement execute function public.touch_prepared_price_catalog_version();
create trigger prepared_price_catalog_truncate after truncate on public.catalog_products
for each statement execute function public.touch_prepared_price_catalog_version();

-- Null expiries occupy no index entries. Existing valid_from index is reused.
create index idx_release_rows_prepared_expiry on public.supplier_price_release_rows(release_id,valid_to)
where row_status='accepted' and buy_price>0 and currency='EUR' and valid_to is not null;
create index idx_legacy_prepared_start on public.supplier_prices(organization_id,brand_id,valid_from)
where is_active and buy_price>0 and currency='EUR';
create index idx_legacy_prepared_expiry on public.supplier_prices(organization_id,brand_id,valid_to)
where is_active and buy_price>0 and currency='EUR' and valid_to is not null;

create function public.get_prepared_price_list_export_version(input_organization_id uuid,input_brand_id uuid)
returns text language sql stable security definer set search_path='' set timezone='UTC' as $fn$
with pointers as materialized (
  select ptr.*,pub.status publication_status,pub.published_at,pub.created_at
  from public.supplier_current_price_pointers ptr
  left join public.supplier_price_publications pub
    on pub.id=ptr.publication_id and pub.release_id=ptr.release_id
    and pub.organization_id=ptr.organization_id and pub.supplier_id=ptr.supplier_id and pub.brand_id=ptr.brand_id
  where ptr.organization_id=input_organization_id and ptr.brand_id=input_brand_id
), boundaries as (
  select min(d.boundary) boundary from pointers ptr cross join lateral (
    (select rr.valid_from boundary from public.supplier_price_release_rows rr
     where ptr.publication_status='published' and rr.release_id=ptr.release_id
       and rr.row_status='accepted' and rr.buy_price>0 and rr.currency='EUR'
       and rr.valid_from>current_date order by rr.valid_from limit 1)
    union all
    (select rr.valid_to+1 boundary from public.supplier_price_release_rows rr
     where ptr.publication_status='published' and rr.release_id=ptr.release_id
       and rr.row_status='accepted' and rr.buy_price>0 and rr.currency='EUR'
       and rr.valid_to>=current_date and rr.valid_to<'infinity'::date order by rr.valid_to limit 1)
  ) d
  union all
  select min(d.boundary) from (
    (select sp.valid_from boundary from public.supplier_prices sp
     where sp.organization_id=input_organization_id and sp.brand_id=input_brand_id
       and sp.is_active and sp.buy_price>0 and sp.currency='EUR' and sp.valid_from>current_date
       and not exists(select 1 from pointers ptr where ptr.supplier_id=sp.supplier_id)
     order by sp.valid_from limit 1)
    union all
    (select sp.valid_to+1 boundary from public.supplier_prices sp
     where sp.organization_id=input_organization_id and sp.brand_id=input_brand_id
       and sp.is_active and sp.buy_price>0 and sp.currency='EUR'
       and sp.valid_to>=current_date and sp.valid_to<'infinity'::date
       and not exists(select 1 from pointers ptr where ptr.supplier_id=sp.supplier_id)
     order by sp.valid_to limit 1)
  ) d
)
select pg_catalog.md5(pg_catalog.jsonb_build_array(
  'prepared-price-publication-v1',input_organization_id,input_brand_id,
  (select b.name from public.brands b where b.organization_id=input_organization_id and b.id=input_brand_id),
  (select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(ptr.supplier_id,ptr.release_id,ptr.publication_id,
    ptr.publication_status,extract(epoch from ptr.published_at),extract(epoch from ptr.created_at)) order by ptr.supplier_id) from pointers ptr),
  (select min(boundary) from boundaries),
  (select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_array(ref.id,ref.old_code,ref.new_code,ref.is_active,
    extract(epoch from ref.updated_at)) order by ref.id) from public.item_code_references ref
    where ref.organization_id=input_organization_id and ref.brand_id=input_brand_id),
  coalesce((select source_revision from public.supplier_price_source_versions where organization_id=input_organization_id and brand_id=input_brand_id),0),
  (select source_revision from public.supplier_price_source_global_version where singleton),
  coalesce((select revision from public.prepared_price_catalog_versions where organization_id=input_organization_id and brand_id=input_brand_id),0),
  (select revision from public.prepared_price_catalog_global_version where singleton)
)::text);
$fn$;
revoke all on function public.get_prepared_price_list_export_version(uuid,uuid) from public,anon,authenticated;
grant execute on function public.get_prepared_price_list_export_version(uuid,uuid) to service_role;
