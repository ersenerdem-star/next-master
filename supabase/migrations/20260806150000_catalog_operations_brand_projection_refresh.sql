-- Keep the brand operations scorecard truthful after bulk catalog imports.
-- Bulk publication intentionally bypasses row-level delta triggers; this
-- projection is refreshed once when an import run becomes finalized.

set lock_timeout = '5s';
set statement_timeout = '300s';

alter table public.catalog_operations_brand_summary
  add column if not exists missing_description_tr_count bigint not null default 0,
  add column if not exists missing_vehicle_model_count bigint not null default 0,
  add column if not exists missing_market_segment_count bigint not null default 0;

create or replace function public.refresh_catalog_operations_brand_summary(
  input_organization_id uuid,
  input_brand_id uuid default null
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
set statement_timeout = '300s'
as $$
declare
  v_count integer := 0;
begin
  if input_organization_id is null then
    raise exception 'Organization is required for brand operations refresh';
  end if;

  with snapshot as (
    select
      cp.organization_id,
      cp.brand_id,
      count(*)::bigint as total_products,
      count(*) filter (
        where nullif(trim(coalesce(cp.description, '')), '') is not null
          and nullif(trim(coalesce(cp.origin, '')), '') is not null
          and nullif(trim(coalesce(cp.hs_code, '')), '') is not null
          and cp.weight_kg is not null
      )::bigint as complete_count,
      count(*) filter (
        where nullif(trim(coalesce(cp.description, '')), '') is null
           or nullif(trim(coalesce(cp.origin, '')), '') is null
           or nullif(trim(coalesce(cp.hs_code, '')), '') is null
           or cp.weight_kg is null
      )::bigint as incomplete_count,
      count(*) filter (where nullif(trim(coalesce(cp.description, '')), '') is null)::bigint as missing_description_count,
      count(*) filter (where nullif(trim(coalesce(cp.description_tr, '')), '') is null)::bigint as missing_description_tr_count,
      count(*) filter (where nullif(trim(coalesce(cp.origin, '')), '') is null)::bigint as missing_origin_count,
      count(*) filter (where nullif(trim(coalesce(cp.hs_code, '')), '') is null)::bigint as missing_hs_code_count,
      count(*) filter (where cp.weight_kg is null)::bigint as missing_weight_count,
      count(*) filter (where nullif(trim(coalesce(cp.ean, '')), '') is null)::bigint as missing_ean_count,
      count(*) filter (where nullif(trim(coalesce(cp.oem_no, '')), '') is null)::bigint as missing_oem_count,
      count(*) filter (
        where nullif(trim(coalesce(cp.vehicle, '')), '') is null
          and nullif(trim(coalesce(cp.vehicle_model, '')), '') is null
      )::bigint as missing_vehicle_count,
      count(*) filter (where nullif(trim(coalesce(cp.vehicle_model, '')), '') is null)::bigint as missing_vehicle_model_count,
      count(*) filter (where nullif(trim(coalesce(cp.market_segment, '')), '') is null)::bigint as missing_market_segment_count,
      count(*) filter (where nullif(trim(coalesce(cp.image_url, '')), '') is null)::bigint as missing_image_count,
      max(cp.updated_at) as last_catalog_change_at
    from public.catalog_products cp
    where cp.organization_id = input_organization_id
      and (input_brand_id is null or cp.brand_id = input_brand_id)
    group by cp.organization_id, cp.brand_id
  ), upserted as (
    insert into public.catalog_operations_brand_summary (
      organization_id,
      brand_id,
      total_products,
      complete_count,
      incomplete_count,
      missing_description_count,
      missing_description_tr_count,
      missing_origin_count,
      missing_hs_code_count,
      missing_weight_count,
      missing_ean_count,
      missing_oem_count,
      missing_vehicle_count,
      missing_vehicle_model_count,
      missing_market_segment_count,
      missing_image_count,
      last_catalog_change_at,
      updated_at
    )
    select
      organization_id,
      brand_id,
      total_products,
      complete_count,
      incomplete_count,
      missing_description_count,
      missing_description_tr_count,
      missing_origin_count,
      missing_hs_code_count,
      missing_weight_count,
      missing_ean_count,
      missing_oem_count,
      missing_vehicle_count,
      missing_vehicle_model_count,
      missing_market_segment_count,
      missing_image_count,
      last_catalog_change_at,
      now()
    from snapshot
    on conflict (organization_id, brand_id) do update
    set total_products = excluded.total_products,
        complete_count = excluded.complete_count,
        incomplete_count = excluded.incomplete_count,
        missing_description_count = excluded.missing_description_count,
        missing_description_tr_count = excluded.missing_description_tr_count,
        missing_origin_count = excluded.missing_origin_count,
        missing_hs_code_count = excluded.missing_hs_code_count,
        missing_weight_count = excluded.missing_weight_count,
        missing_ean_count = excluded.missing_ean_count,
        missing_oem_count = excluded.missing_oem_count,
        missing_vehicle_count = excluded.missing_vehicle_count,
        missing_vehicle_model_count = excluded.missing_vehicle_model_count,
        missing_market_segment_count = excluded.missing_market_segment_count,
        missing_image_count = excluded.missing_image_count,
        last_catalog_change_at = excluded.last_catalog_change_at,
        updated_at = now()
    returning 1
  )
  select count(*)::integer into v_count from upserted;

  return v_count;
end;
$$;
revoke all on function public.refresh_catalog_operations_brand_summary(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.refresh_catalog_operations_brand_summary(uuid, uuid)
  to service_role;

drop function if exists public.get_catalog_operations_brand_status(integer);

create function public.get_catalog_operations_brand_status(
  input_limit integer default 12
)
returns table (
  brand_id uuid,
  brand text,
  total_products bigint,
  complete_count bigint,
  incomplete_count bigint,
  data_completeness_percent numeric,
  missing_ean_count bigint,
  missing_oem_count bigint,
  missing_vehicle_count bigint,
  missing_image_count bigint,
  missing_description_count bigint,
  missing_description_tr_count bigint,
  missing_vehicle_model_count bigint,
  missing_market_segment_count bigint,
  last_catalog_change_at timestamptz,
  projection_updated_at timestamptz
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  select
    s.brand_id,
    b.name as brand,
    s.total_products,
    s.complete_count,
    s.incomplete_count,
    case when s.total_products = 0 then 100
      else round((s.complete_count::numeric * 100) / s.total_products, 1)
    end as data_completeness_percent,
    s.missing_ean_count,
    s.missing_oem_count,
    s.missing_vehicle_count,
    s.missing_image_count,
    s.missing_description_count,
    s.missing_description_tr_count,
    s.missing_vehicle_model_count,
    s.missing_market_segment_count,
    s.last_catalog_change_at,
    s.updated_at as projection_updated_at
  from public.catalog_operations_brand_summary s
  join public.brands b
    on b.organization_id = s.organization_id
   and b.id = s.brand_id
  where s.organization_id = public.current_profile_org_id()
    and s.total_products > 0
  order by s.total_products desc, b.name
  limit least(greatest(coalesce(input_limit, 12), 1), 100);
$$;

revoke all on function public.get_catalog_operations_brand_status(integer)
  from public, anon;
grant execute on function public.get_catalog_operations_brand_status(integer)
  to authenticated;

create or replace function public.refresh_catalog_operations_brand_summary_after_import()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status = 'finalized' and old.status is distinct from 'finalized' then
    perform public.refresh_catalog_operations_brand_summary(new.organization_id, null);
  end if;
  return new;
end;
$$;

drop trigger if exists trg_catalog_operations_brand_summary_after_import
  on public.catalog_import_runs;
create trigger trg_catalog_operations_brand_summary_after_import
after update of status on public.catalog_import_runs
for each row
when (new.status = 'finalized' and old.status is distinct from 'finalized')
execute function public.refresh_catalog_operations_brand_summary_after_import();

-- Repair the existing projection once, so the dashboard is useful immediately
-- after this migration instead of waiting for the next import.
do $$
declare
  v_org_id uuid;
begin
  for v_org_id in select id from public.organizations loop
    perform public.refresh_catalog_operations_brand_summary(v_org_id, null);
  end loop;
end;
$$;
