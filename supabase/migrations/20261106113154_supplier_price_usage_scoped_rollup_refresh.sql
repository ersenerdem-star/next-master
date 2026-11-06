-- Rebuild only affected legacy price keys when a supplier is opened/closed.
CREATE OR REPLACE FUNCTION supplier_price_usage_internal.refresh_affected_rollups(p_organization_id uuid, input_supplier_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '120s'
AS $function$
declare
  v_count integer := 0;
begin
  if p_organization_id is null then
    raise exception 'Organization id is required';
  end if;

  if input_supplier_id is null then raise exception 'Supplier id is required';end if;

  -- Serialize rollup writers for this organization. The operation remains
  -- atomic: a failure rolls back the scoped delete and insert together.
  perform pg_advisory_xact_lock(
    hashtextextended(p_organization_id::text || ':supplier_price_rollups', 0)
  );

  delete from public.supplier_price_rollups spr
  where spr.organization_id = p_organization_id
    and (spr.brand_id,spr.normalized_code) in (select src.brand_id,src.normalized_code from public.supplier_prices src
    where src.organization_id=p_organization_id and src.supplier_id=input_supplier_id and src.is_active);

  insert into public.supplier_price_rollups (
    organization_id,
    brand_id,
    normalized_code,
    product_code,
    description,
    oem_no,
    normalized_oem,
    cheapest_supplier_id,
    cheapest_price,
    price_date,
    supplier_count,
    notes,
    has_notes,
    refreshed_at,
    second_supplier_id,
    second_supplier_name,
    second_price,
    price_gap,
    price_gap_percent
  )
  with active_prices as (
    select
      sp.organization_id,
      sp.brand_id,
      sp.normalized_code,
      coalesce(sp.product_code, '') as product_code,
      coalesce(sp.description, '') as description,
      coalesce(sp.oem_no, '') as oem_no,
      coalesce(
        sp.normalized_oem,
        public.normalize_part_code(coalesce(sp.oem_no, '')),
        ''
      ) as normalized_oem,
      sp.supplier_id,
      coalesce(s.name, '') as supplier_name,
      sp.buy_price,
      sp.valid_from,
      sp.updated_at,
      sp.notes,
      sp.id
    from public.supplier_prices sp
    left join public.suppliers s
      on s.id = sp.supplier_id
    where sp.organization_id = p_organization_id
      and (sp.brand_id,sp.normalized_code) in (select src.brand_id,src.normalized_code from public.supplier_prices src
    where src.organization_id=p_organization_id and src.supplier_id=input_supplier_id and src.is_active)
      and sp.is_active and exists(select 1 from public.suppliers usage_supplier where usage_supplier.id=sp.supplier_id and usage_supplier.organization_id=sp.organization_id and usage_supplier.price_usage_enabled)
      and sp.buy_price is not null
      and sp.normalized_code is not null
      and sp.normalized_code <> ''
  ),
  supplier_best_prices as (
    select ranked.*
    from (
      select
        active_prices.*,
        row_number() over (
          partition by
            active_prices.organization_id,
            active_prices.brand_id,
            active_prices.normalized_code,
            active_prices.supplier_id
          order by
            active_prices.buy_price asc nulls last,
            active_prices.valid_from desc nulls last,
            active_prices.updated_at desc nulls last,
            active_prices.id desc
        ) as supplier_row_no
      from active_prices
    ) ranked
    where ranked.supplier_row_no = 1
  ),
  ranked_prices as (
    select
      supplier_best_prices.*,
      row_number() over (
        partition by
          supplier_best_prices.organization_id,
          supplier_best_prices.brand_id,
          supplier_best_prices.normalized_code
        order by
          supplier_best_prices.buy_price asc nulls last,
          supplier_best_prices.valid_from desc nulls last,
          supplier_best_prices.updated_at desc nulls last,
          supplier_best_prices.supplier_id asc nulls last,
          supplier_best_prices.id desc
      ) as price_rank
    from supplier_best_prices
  ),
  grouped as (
    select
      active_prices.organization_id,
      active_prices.brand_id,
      active_prices.normalized_code,
      count(distinct active_prices.supplier_id)::integer as supplier_count,
      string_agg(
        distinct nullif(trim(coalesce(active_prices.notes, '')), ''),
        ' | '
      ) filter (
        where nullif(trim(coalesce(active_prices.notes, '')), '') is not null
      ) as notes
    from active_prices
    group by
      active_prices.organization_id,
      active_prices.brand_id,
      active_prices.normalized_code
  ),
  best as (
    select *
    from ranked_prices
    where price_rank = 1
  ),
  second_best as (
    select *
    from ranked_prices
    where price_rank = 2
  )
  select
    best.organization_id,
    best.brand_id,
    best.normalized_code,
    best.product_code,
    best.description,
    best.oem_no,
    best.normalized_oem,
    best.supplier_id,
    best.buy_price,
    best.valid_from,
    grouped.supplier_count,
    grouped.notes,
    grouped.notes is not null,
    now(),
    second_best.supplier_id,
    nullif(second_best.supplier_name, ''),
    second_best.buy_price,
    case
      when second_best.buy_price is null or best.buy_price is null then null
      else round(second_best.buy_price - best.buy_price, 4)
    end,
    case
      when second_best.buy_price is null or coalesce(best.buy_price, 0) = 0 then null
      else round(
        ((second_best.buy_price - best.buy_price) / nullif(best.buy_price, 0)) * 100,
        4
      )
    end
  from best
  join grouped
    on grouped.organization_id = best.organization_id
   and grouped.brand_id = best.brand_id
   and grouped.normalized_code = best.normalized_code
  left join second_best
    on second_best.organization_id = best.organization_id
   and second_best.brand_id = best.brand_id
   and second_best.normalized_code = best.normalized_code;

  get diagnostics v_count = row_count;
  return v_count;
end;
$function$
;
revoke all on function supplier_price_usage_internal.refresh_affected_rollups(uuid,uuid) from public,anon,authenticated,service_role;

create or replace function supplier_price_usage_internal.after_change()
returns trigger language plpgsql security definer set search_path='' as $$
declare b uuid;
begin
 if new.price_usage_enabled is not distinct from old.price_usage_enabled then return new;end if;
 if not new.price_usage_enabled then
  perform supplier_price_usage_internal.capture_order_lines(new.organization_id,new.id);
 end if;
 insert into supplier_price_usage_internal.events(organization_id,supplier_id,enabled,actor_id,reason)
 values(new.organization_id,new.id,new.price_usage_enabled,auth.uid(),
  coalesce(nullif(pg_catalog.current_setting('supplier_price_usage.reason',true),''),'Database operator'));
 perform supplier_price_usage_internal.refresh_affected_rollups(new.organization_id,new.id);
 for b in
  select distinct brand_id from public.supplier_prices where organization_id=new.organization_id and supplier_id=new.id
  union select brand_id from public.supplier_current_price_pointers where organization_id=new.organization_id and supplier_id=new.id
 loop
  -- Both cache refresh and version changes commit with the switch, or all roll back.
  insert into public.supplier_price_source_versions(organization_id,brand_id,source_revision,updated_at)
  values(new.organization_id,b,1,clock_timestamp())
  on conflict(organization_id,brand_id) do update
   set source_revision=public.supplier_price_source_versions.source_revision+1,updated_at=clock_timestamp();
 end loop;
 return new;
end $$;
