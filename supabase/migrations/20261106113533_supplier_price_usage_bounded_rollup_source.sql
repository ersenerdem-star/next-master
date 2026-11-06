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
  with affected_keys as materialized (
    select distinct src.brand_id,src.normalized_code from public.supplier_prices src
    where src.organization_id=p_organization_id and src.supplier_id=input_supplier_id and src.is_active
      and src.normalized_code is not null and src.normalized_code<>''
  ), scoped_prices as materialized (
    -- Keep the indexed code lookup inside the lateral boundary. A supplier-first
    -- join can otherwise repeat every affected key once for each supplier.
    select price.* from affected_keys k cross join lateral (
      select sp.* from public.supplier_prices sp
      where sp.organization_id=p_organization_id and sp.brand_id=k.brand_id
        and sp.normalized_code=k.normalized_code and sp.is_active and sp.buy_price is not null
      offset 0
    ) price
  ), active_prices as (
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
    from scoped_prices sp
    left join public.suppliers s
      on s.id = sp.supplier_id
    where sp.organization_id = p_organization_id
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

