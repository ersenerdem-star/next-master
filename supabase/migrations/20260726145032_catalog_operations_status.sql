-- NM-CATALOG-OPERATIONS-STATUS
--
-- Maintains truthful, tenant-scoped Catalog data-health counters independently
-- from the asynchronous integrity projection. The projection can remain
-- partial while Total Products and field completeness stay operational.

set lock_timeout = '5s';
set statement_timeout = '300s';

alter table public.catalog_integrity_summary
  add column if not exists catalog_complete_count bigint not null default 0,
  add column if not exists catalog_incomplete_count bigint not null default 0,
  add column if not exists missing_description_count bigint not null default 0,
  add column if not exists missing_origin_count bigint not null default 0,
  add column if not exists missing_hs_code_count bigint not null default 0,
  add column if not exists missing_weight_count bigint not null default 0,
  add column if not exists missing_ean_count bigint not null default 0,
  add column if not exists missing_oem_count bigint not null default 0,
  add column if not exists missing_vehicle_count bigint not null default 0,
  add column if not exists missing_image_count bigint not null default 0,
  add column if not exists last_catalog_change_at timestamptz;

create table if not exists public.catalog_operations_brand_summary (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  brand_id uuid not null references public.brands(id) on delete cascade,
  total_products bigint not null default 0 check (total_products >= 0),
  complete_count bigint not null default 0 check (complete_count >= 0),
  incomplete_count bigint not null default 0 check (incomplete_count >= 0),
  missing_description_count bigint not null default 0 check (missing_description_count >= 0),
  missing_origin_count bigint not null default 0 check (missing_origin_count >= 0),
  missing_hs_code_count bigint not null default 0 check (missing_hs_code_count >= 0),
  missing_weight_count bigint not null default 0 check (missing_weight_count >= 0),
  missing_ean_count bigint not null default 0 check (missing_ean_count >= 0),
  missing_oem_count bigint not null default 0 check (missing_oem_count >= 0),
  missing_vehicle_count bigint not null default 0 check (missing_vehicle_count >= 0),
  missing_image_count bigint not null default 0 check (missing_image_count >= 0),
  last_catalog_change_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (organization_id, brand_id)
);

alter table public.catalog_operations_brand_summary enable row level security;

drop policy if exists catalog_operations_brand_summary_select_org
  on public.catalog_operations_brand_summary;
create policy catalog_operations_brand_summary_select_org
on public.catalog_operations_brand_summary
for select
to authenticated
using (
  auth.uid() is not null
  and organization_id = public.current_profile_org_id()
);

revoke all on table public.catalog_operations_brand_summary
  from public, anon, authenticated, service_role;
grant select on table public.catalog_operations_brand_summary
  to authenticated, service_role;
grant insert, update, delete on table public.catalog_operations_brand_summary
  to service_role;

create or replace function public.ensure_catalog_operations_brand_summary(
  input_organization_id uuid,
  input_brand_id uuid
)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  insert into public.catalog_operations_brand_summary (
    organization_id,
    brand_id
  )
  select input_organization_id, input_brand_id
  where input_organization_id is not null
    and input_brand_id is not null
  on conflict (organization_id, brand_id) do nothing;
$$;

revoke all on function public.ensure_catalog_operations_brand_summary(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.ensure_catalog_operations_brand_summary(uuid, uuid)
  to service_role;

create or replace function public.apply_catalog_operations_snapshot_delta(
  input_organization_id uuid,
  input_brand_id uuid,
  input_total_delta integer,
  input_complete_delta integer,
  input_incomplete_delta integer,
  input_missing_description_delta integer,
  input_missing_origin_delta integer,
  input_missing_hs_code_delta integer,
  input_missing_weight_delta integer,
  input_missing_ean_delta integer,
  input_missing_oem_delta integer,
  input_missing_vehicle_delta integer,
  input_missing_image_delta integer,
  input_change_at timestamptz
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.ensure_catalog_integrity_summary(input_organization_id);
  perform public.ensure_catalog_operations_brand_summary(
    input_organization_id,
    input_brand_id
  );

  update public.catalog_integrity_summary
  set total_products = greatest(0, total_products + input_total_delta),
      catalog_complete_count = greatest(0, catalog_complete_count + input_complete_delta),
      catalog_incomplete_count = greatest(0, catalog_incomplete_count + input_incomplete_delta),
      missing_description_count = greatest(0, missing_description_count + input_missing_description_delta),
      missing_origin_count = greatest(0, missing_origin_count + input_missing_origin_delta),
      missing_hs_code_count = greatest(0, missing_hs_code_count + input_missing_hs_code_delta),
      missing_weight_count = greatest(0, missing_weight_count + input_missing_weight_delta),
      missing_ean_count = greatest(0, missing_ean_count + input_missing_ean_delta),
      missing_oem_count = greatest(0, missing_oem_count + input_missing_oem_delta),
      missing_vehicle_count = greatest(0, missing_vehicle_count + input_missing_vehicle_delta),
      missing_image_count = greatest(0, missing_image_count + input_missing_image_delta),
      last_catalog_change_at = greatest(
        coalesce(last_catalog_change_at, input_change_at),
        input_change_at
      ),
      updated_at = now()
  where organization_id = input_organization_id;

  update public.catalog_operations_brand_summary
  set total_products = greatest(0, total_products + input_total_delta),
      complete_count = greatest(0, complete_count + input_complete_delta),
      incomplete_count = greatest(0, incomplete_count + input_incomplete_delta),
      missing_description_count = greatest(0, missing_description_count + input_missing_description_delta),
      missing_origin_count = greatest(0, missing_origin_count + input_missing_origin_delta),
      missing_hs_code_count = greatest(0, missing_hs_code_count + input_missing_hs_code_delta),
      missing_weight_count = greatest(0, missing_weight_count + input_missing_weight_delta),
      missing_ean_count = greatest(0, missing_ean_count + input_missing_ean_delta),
      missing_oem_count = greatest(0, missing_oem_count + input_missing_oem_delta),
      missing_vehicle_count = greatest(0, missing_vehicle_count + input_missing_vehicle_delta),
      missing_image_count = greatest(0, missing_image_count + input_missing_image_delta),
      last_catalog_change_at = greatest(
        coalesce(last_catalog_change_at, input_change_at),
        input_change_at
      ),
      updated_at = now()
  where organization_id = input_organization_id
    and brand_id = input_brand_id;
end;
$$;

revoke all on function public.apply_catalog_operations_snapshot_delta(
  uuid,
  uuid,
  integer,
  integer,
  integer,
  integer,
  integer,
  integer,
  integer,
  integer,
  integer,
  integer,
  integer,
  timestamptz
) from public, anon, authenticated;
grant execute on function public.apply_catalog_operations_snapshot_delta(
  uuid,
  uuid,
  integer,
  integer,
  integer,
  integer,
  integer,
  integer,
  integer,
  integer,
  integer,
  integer,
  integer,
  timestamptz
) to service_role;

create or replace function public.apply_catalog_product_operations_delta()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_change_at timestamptz := now();
  v_old_complete integer := 0;
  v_new_complete integer := 0;
  v_old_incomplete integer := 0;
  v_new_incomplete integer := 0;
begin
  if tg_op in ('UPDATE', 'DELETE') then
    v_old_complete := case
      when nullif(trim(coalesce(old.description, '')), '') is not null
       and nullif(trim(coalesce(old.origin, '')), '') is not null
       and nullif(trim(coalesce(old.hs_code, '')), '') is not null
       and old.weight_kg is not null
      then 1 else 0
    end;
    v_old_incomplete := 1 - v_old_complete;

    perform public.apply_catalog_operations_snapshot_delta(
      old.organization_id,
      old.brand_id,
      -1,
      -v_old_complete,
      -v_old_incomplete,
      -case when nullif(trim(coalesce(old.description, '')), '') is null then 1 else 0 end,
      -case when nullif(trim(coalesce(old.origin, '')), '') is null then 1 else 0 end,
      -case when nullif(trim(coalesce(old.hs_code, '')), '') is null then 1 else 0 end,
      -case when old.weight_kg is null then 1 else 0 end,
      -case when nullif(trim(coalesce(old.ean, '')), '') is null then 1 else 0 end,
      -case when nullif(trim(coalesce(old.oem_no, '')), '') is null then 1 else 0 end,
      -case
        when nullif(trim(coalesce(old.vehicle, '')), '') is null
         and nullif(trim(coalesce(old.vehicle_model, '')), '') is null
        then 1 else 0
      end,
      -case when nullif(trim(coalesce(old.image_url, '')), '') is null then 1 else 0 end,
      v_change_at
    );
  end if;

  if tg_op in ('INSERT', 'UPDATE') then
    v_new_complete := case
      when nullif(trim(coalesce(new.description, '')), '') is not null
       and nullif(trim(coalesce(new.origin, '')), '') is not null
       and nullif(trim(coalesce(new.hs_code, '')), '') is not null
       and new.weight_kg is not null
      then 1 else 0
    end;
    v_new_incomplete := 1 - v_new_complete;

    perform public.apply_catalog_operations_snapshot_delta(
      new.organization_id,
      new.brand_id,
      1,
      v_new_complete,
      v_new_incomplete,
      case when nullif(trim(coalesce(new.description, '')), '') is null then 1 else 0 end,
      case when nullif(trim(coalesce(new.origin, '')), '') is null then 1 else 0 end,
      case when nullif(trim(coalesce(new.hs_code, '')), '') is null then 1 else 0 end,
      case when new.weight_kg is null then 1 else 0 end,
      case when nullif(trim(coalesce(new.ean, '')), '') is null then 1 else 0 end,
      case when nullif(trim(coalesce(new.oem_no, '')), '') is null then 1 else 0 end,
      case
        when nullif(trim(coalesce(new.vehicle, '')), '') is null
         and nullif(trim(coalesce(new.vehicle_model, '')), '') is null
        then 1 else 0
      end,
      case when nullif(trim(coalesce(new.image_url, '')), '') is null then 1 else 0 end,
      v_change_at
    );
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke all on function public.apply_catalog_product_operations_delta()
  from public, anon, authenticated;
grant execute on function public.apply_catalog_product_operations_delta()
  to service_role;

drop trigger if exists trg_catalog_products_integrity_summary_total
  on public.catalog_products;
create trigger trg_catalog_products_integrity_summary_total
after insert or delete or update of
  organization_id,
  brand_id,
  description,
  origin,
  hs_code,
  weight_kg,
  ean,
  oem_no,
  vehicle,
  vehicle_model,
  image_url
on public.catalog_products
for each row
execute function public.apply_catalog_product_operations_delta();

with catalog_snapshot as (
  select
    cp.organization_id,
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
    count(*) filter (where nullif(trim(coalesce(cp.origin, '')), '') is null)::bigint as missing_origin_count,
    count(*) filter (where nullif(trim(coalesce(cp.hs_code, '')), '') is null)::bigint as missing_hs_code_count,
    count(*) filter (where cp.weight_kg is null)::bigint as missing_weight_count,
    count(*) filter (where nullif(trim(coalesce(cp.ean, '')), '') is null)::bigint as missing_ean_count,
    count(*) filter (where nullif(trim(coalesce(cp.oem_no, '')), '') is null)::bigint as missing_oem_count,
    count(*) filter (
      where nullif(trim(coalesce(cp.vehicle, '')), '') is null
        and nullif(trim(coalesce(cp.vehicle_model, '')), '') is null
    )::bigint as missing_vehicle_count,
    count(*) filter (where nullif(trim(coalesce(cp.image_url, '')), '') is null)::bigint as missing_image_count,
    max(cp.updated_at) as last_catalog_change_at
  from public.catalog_products cp
  group by cp.organization_id
), ensure_summary_rows as (
  insert into public.catalog_integrity_summary (organization_id)
  select snapshot.organization_id
  from catalog_snapshot snapshot
  on conflict (organization_id) do nothing
  returning organization_id
)
update public.catalog_integrity_summary s
set total_products = snapshot.total_products,
    catalog_complete_count = snapshot.complete_count,
    catalog_incomplete_count = snapshot.incomplete_count,
    missing_description_count = snapshot.missing_description_count,
    missing_origin_count = snapshot.missing_origin_count,
    missing_hs_code_count = snapshot.missing_hs_code_count,
    missing_weight_count = snapshot.missing_weight_count,
    missing_ean_count = snapshot.missing_ean_count,
    missing_oem_count = snapshot.missing_oem_count,
    missing_vehicle_count = snapshot.missing_vehicle_count,
    missing_image_count = snapshot.missing_image_count,
    last_catalog_change_at = snapshot.last_catalog_change_at,
    updated_at = now()
from catalog_snapshot snapshot
where s.organization_id = snapshot.organization_id;

insert into public.catalog_operations_brand_summary (
  organization_id,
  brand_id,
  total_products,
  complete_count,
  incomplete_count,
  missing_description_count,
  missing_origin_count,
  missing_hs_code_count,
  missing_weight_count,
  missing_ean_count,
  missing_oem_count,
  missing_vehicle_count,
  missing_image_count,
  last_catalog_change_at
)
select
  cp.organization_id,
  cp.brand_id,
  count(*)::bigint,
  count(*) filter (
    where nullif(trim(coalesce(cp.description, '')), '') is not null
      and nullif(trim(coalesce(cp.origin, '')), '') is not null
      and nullif(trim(coalesce(cp.hs_code, '')), '') is not null
      and cp.weight_kg is not null
  )::bigint,
  count(*) filter (
    where nullif(trim(coalesce(cp.description, '')), '') is null
       or nullif(trim(coalesce(cp.origin, '')), '') is null
       or nullif(trim(coalesce(cp.hs_code, '')), '') is null
       or cp.weight_kg is null
  )::bigint,
  count(*) filter (where nullif(trim(coalesce(cp.description, '')), '') is null)::bigint,
  count(*) filter (where nullif(trim(coalesce(cp.origin, '')), '') is null)::bigint,
  count(*) filter (where nullif(trim(coalesce(cp.hs_code, '')), '') is null)::bigint,
  count(*) filter (where cp.weight_kg is null)::bigint,
  count(*) filter (where nullif(trim(coalesce(cp.ean, '')), '') is null)::bigint,
  count(*) filter (where nullif(trim(coalesce(cp.oem_no, '')), '') is null)::bigint,
  count(*) filter (
    where nullif(trim(coalesce(cp.vehicle, '')), '') is null
      and nullif(trim(coalesce(cp.vehicle_model, '')), '') is null
  )::bigint,
  count(*) filter (where nullif(trim(coalesce(cp.image_url, '')), '') is null)::bigint,
  max(cp.updated_at)
from public.catalog_products cp
group by cp.organization_id, cp.brand_id
on conflict (organization_id, brand_id) do update
set total_products = excluded.total_products,
    complete_count = excluded.complete_count,
    incomplete_count = excluded.incomplete_count,
    missing_description_count = excluded.missing_description_count,
    missing_origin_count = excluded.missing_origin_count,
    missing_hs_code_count = excluded.missing_hs_code_count,
    missing_weight_count = excluded.missing_weight_count,
    missing_ean_count = excluded.missing_ean_count,
    missing_oem_count = excluded.missing_oem_count,
    missing_vehicle_count = excluded.missing_vehicle_count,
    missing_image_count = excluded.missing_image_count,
    last_catalog_change_at = excluded.last_catalog_change_at,
    updated_at = now();

create or replace function public.get_catalog_integrity_summary()
returns jsonb
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
  with org as (
    select public.current_profile_org_id() as organization_id
  ), status as (
    select
      coalesce(s.total_products, 0) as total_products,
      coalesce(s.projected_products, 0) as projected_products,
      coalesce(s.clear_count, 0) as projected_clear_count,
      coalesce(s.incomplete_count, 0) as projected_incomplete_count,
      coalesce(s.conflict_count, 0) as conflict_count,
      coalesce(s.pending_count, 0) as queue_depth,
      coalesce(s.failed_count, 0) as failed_count,
      coalesce(s.catalog_complete_count, 0) as catalog_complete_count,
      coalesce(s.catalog_incomplete_count, 0) as catalog_incomplete_count,
      coalesce(s.missing_description_count, 0) as missing_description_count,
      coalesce(s.missing_origin_count, 0) as missing_origin_count,
      coalesce(s.missing_hs_code_count, 0) as missing_hs_code_count,
      coalesce(s.missing_weight_count, 0) as missing_weight_count,
      coalesce(s.missing_ean_count, 0) as missing_ean_count,
      coalesce(s.missing_oem_count, 0) as missing_oem_count,
      coalesce(s.missing_vehicle_count, 0) as missing_vehicle_count,
      coalesce(s.missing_image_count, 0) as missing_image_count,
      s.last_catalog_change_at,
      s.last_evaluated_at,
      coalesce(s.backfill_status, 'queued') as backfill_status,
      coalesce(s.backfill_queued_products, 0) as backfill_queued_products,
      s.backfill_updated_at,
      s.backfill_error
    from org
    left join public.catalog_integrity_summary s
      on s.organization_id = org.organization_id
  ), calculated as (
    select
      status.*,
      projected_clear_count
        + projected_incomplete_count
        + conflict_count
        + failed_count as evaluated_products
    from status
  )
  select jsonb_build_object(
    'total_products', total_products,
    'projected_products', projected_products,
    'evaluated_products', evaluated_products,
    'clear_count', catalog_complete_count,
    'incomplete_count', catalog_incomplete_count,
    'conflict_count', conflict_count,
    'pending_count', greatest(total_products - evaluated_products, 0),
    'queue_depth', queue_depth,
    'failed_count', failed_count,
    'evaluation_coverage_percent', case
      when total_products = 0 then 100
      else round((evaluated_products::numeric * 100) / total_products, 1)
    end,
    'data_completeness_percent', case
      when total_products = 0 then 100
      else round((catalog_complete_count::numeric * 100) / total_products, 1)
    end,
    'missing_description_count', missing_description_count,
    'missing_origin_count', missing_origin_count,
    'missing_hs_code_count', missing_hs_code_count,
    'missing_weight_count', missing_weight_count,
    'missing_ean_count', missing_ean_count,
    'missing_oem_count', missing_oem_count,
    'missing_vehicle_count', missing_vehicle_count,
    'missing_image_count', missing_image_count,
    'last_catalog_change_at', last_catalog_change_at,
    'last_evaluated_at', last_evaluated_at,
    'backfill_status', backfill_status,
    'backfill_queued_products', backfill_queued_products,
    'backfill_updated_at', backfill_updated_at,
    'backfill_error', backfill_error
  )
  from calculated;
$$;

revoke all on function public.get_catalog_integrity_summary()
  from public, anon;
grant execute on function public.get_catalog_integrity_summary()
  to authenticated;

create or replace function public.get_catalog_operations_brand_status(
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
  last_catalog_change_at timestamptz
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
    case
      when s.total_products = 0 then 100
      else round((s.complete_count::numeric * 100) / s.total_products, 1)
    end as data_completeness_percent,
    s.missing_ean_count,
    s.missing_oem_count,
    s.missing_vehicle_count,
    s.missing_image_count,
    s.last_catalog_change_at
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

comment on table public.catalog_operations_brand_summary is
  'Tenant and brand scoped Catalog Operations Status snapshot maintained transactionally from catalog_products.';
comment on function public.get_catalog_integrity_summary() is
  'Catalog Operations Status: direct full-catalog data health plus asynchronous integrity projection coverage.';
