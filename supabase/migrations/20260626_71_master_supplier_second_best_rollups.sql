-- Master supplier comparison second-best rollups.
-- Keeps the hot Master report path on supplier_price_rollups instead of
-- recalculating supplier_prices rankings at read time.

create extension if not exists pg_trgm;

alter table public.supplier_price_rollups
  add column if not exists second_supplier_id uuid null references public.suppliers(id) on delete set null,
  add column if not exists second_supplier_name text null,
  add column if not exists second_price numeric(14, 4) null,
  add column if not exists price_gap numeric(14, 4) null,
  add column if not exists price_gap_percent numeric(14, 4) null;

create index if not exists idx_supplier_price_rollups_org_brand_normoem
  on public.supplier_price_rollups (organization_id, brand_id, normalized_oem)
  where normalized_oem is not null and normalized_oem <> '';

create index if not exists idx_supplier_price_rollups_normalized_oem_trgm
  on public.supplier_price_rollups using gin (normalized_oem gin_trgm_ops);

create index if not exists idx_catalog_products_org_brand_normoem
  on public.catalog_products (organization_id, brand_id, normalized_oem)
  where normalized_oem is not null and normalized_oem <> '';

create index if not exists idx_catalog_products_product_code_trgm
  on public.catalog_products using gin (product_code gin_trgm_ops);

create index if not exists idx_catalog_products_normalized_code_trgm
  on public.catalog_products using gin (normalized_code gin_trgm_ops);

create index if not exists idx_catalog_products_normalized_oem_trgm
  on public.catalog_products using gin (normalized_oem gin_trgm_ops);

create index if not exists idx_supplier_prices_master_rollup_supplier_active
  on public.supplier_prices (
    organization_id,
    brand_id,
    normalized_code,
    supplier_id,
    buy_price asc,
    valid_from desc,
    updated_at desc,
    id desc
  )
  where is_active and buy_price is not null and normalized_code is not null;

create or replace function public.refresh_supplier_price_rollups(input_organization_id uuid default null)
returns integer
language plpgsql
security definer
set search_path = public
set statement_timeout = '180s'
as $$
declare
  v_org uuid := input_organization_id;
  v_count integer := 0;
begin
  if auth.uid() is not null and not public.is_superadmin() then
    if v_org is null or v_org <> public.current_profile_org_id() then
      raise exception 'Only active superadmin users can refresh supplier price rollups for another organization';
    end if;
  end if;

  delete from public.supplier_price_rollups spr
  where v_org is null or spr.organization_id = v_org;

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
      coalesce(sp.normalized_oem, public.normalize_part_code(coalesce(sp.oem_no, '')), '') as normalized_oem,
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
    where (v_org is null or sp.organization_id = v_org)
      and sp.is_active
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
          partition by active_prices.organization_id, active_prices.brand_id, active_prices.normalized_code, active_prices.supplier_id
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
        partition by supplier_best_prices.organization_id, supplier_best_prices.brand_id, supplier_best_prices.normalized_code
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
      string_agg(distinct nullif(trim(coalesce(active_prices.notes, '')), ''), ' | ')
        filter (where nullif(trim(coalesce(active_prices.notes, '')), '') is not null) as notes
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
      else round(((second_best.buy_price - best.buy_price) / nullif(best.buy_price, 0)) * 100, 4)
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
$$;

drop function if exists public.cloud_master_page(text, text, integer, integer, numeric, numeric, text);

create or replace function public.cloud_master_page(
  input_search text default '',
  input_brand text default '',
  input_page integer default 1,
  input_page_size integer default 250,
  input_margin_a numeric default 0.10,
  input_margin_b numeric default 0.15,
  input_scope text default 'catalog'
)
returns table (
  total_count bigint,
  product_id uuid,
  product_code text,
  brand text,
  description text,
  oem_no text,
  hs_code text,
  origin text,
  weight_kg numeric,
  cheapest_supplier text,
  cheapest_price numeric,
  second_supplier_name text,
  second_price numeric,
  price_gap numeric,
  price_gap_percent numeric,
  price_date date,
  sales_a numeric,
  sales_b numeric,
  supplier_count bigint,
  catalog_status text,
  notes text,
  has_notes boolean
)
language sql
stable
security definer
set search_path = public
as $$
  with current_org as (
    select public.current_profile_org_id() as organization_id
  ),
  params as (
    select
      nullif(trim(coalesce(input_search, '')), '') as raw_search,
      public.normalize_part_code(input_search) as search_norm,
      nullif(trim(coalesce(input_brand, '')), '') as raw_brand,
      public.normalize_part_code(input_brand) as brand_norm,
      least(greatest(input_page_size, 1), 1000) as page_size,
      greatest(0, (greatest(input_page, 1) - 1) * least(greatest(input_page_size, 1), 1000)) as row_offset,
      coalesce(nullif(trim(input_scope), ''), 'catalog') as scope_name
  ),
  brand_filter as (
    select
      p.raw_search,
      p.search_norm,
      p.raw_brand,
      p.brand_norm,
      p.page_size,
      p.row_offset,
      p.scope_name,
      (p.search_norm <> '' and length(p.search_norm) >= 5) as search_is_code,
      array_remove(array_agg(b.id), null) as brand_ids
    from params p
    cross join current_org org
    left join public.brands b
      on b.organization_id = org.organization_id
     and (
       p.raw_brand is null
       or coalesce(b.normalized_name, public.normalize_part_code(b.name)) = p.brand_norm
     )
    group by
      p.raw_search,
      p.search_norm,
      p.raw_brand,
      p.brand_norm,
      p.page_size,
      p.row_offset,
      p.scope_name
  ),
  catalog_filtered as (
    select
      cp.id,
      cp.brand_id,
      cp.product_code,
      coalesce(nullif(cp.normalized_code, ''), public.normalize_part_code(cp.product_code)) as normalized_code,
      coalesce(cp.description, '') as description,
      coalesce(cp.oem_no, '') as oem_no,
      cp.hs_code,
      cp.origin,
      cp.weight_kg,
      'In Catalog'::text as catalog_status
    from public.catalog_products cp
    cross join current_org org
    cross join brand_filter f
    where cp.organization_id = org.organization_id
      and (
        f.raw_brand is null
        or cp.brand_id = any(f.brand_ids)
      )
      and (
        f.raw_search is null
        or (
          f.search_is_code
          and (
            coalesce(nullif(cp.normalized_code, ''), public.normalize_part_code(cp.product_code)) = f.search_norm
            or coalesce(nullif(cp.normalized_oem, ''), public.normalize_part_code(coalesce(cp.oem_no, ''))) = f.search_norm
            or coalesce(nullif(cp.normalized_code, ''), public.normalize_part_code(cp.product_code)) like f.search_norm || '%'
            or coalesce(nullif(cp.normalized_oem, ''), public.normalize_part_code(coalesce(cp.oem_no, ''))) like f.search_norm || '%'
          )
        )
        or (
          not f.search_is_code
          and (
            cp.product_code ilike '%' || f.raw_search || '%'
            or coalesce(cp.description, '') ilike '%' || f.raw_search || '%'
            or coalesce(cp.oem_no, '') ilike '%' || f.raw_search || '%'
            or (
              f.search_norm <> ''
              and (
                coalesce(nullif(cp.normalized_code, ''), public.normalize_part_code(cp.product_code)) like '%' || f.search_norm || '%'
                or coalesce(nullif(cp.normalized_oem, ''), public.normalize_part_code(coalesce(cp.oem_no, ''))) like '%' || f.search_norm || '%'
              )
            )
          )
        )
      )
  ),
  supplier_only_filtered as (
    select
      null::uuid as id,
      spr.brand_id,
      spr.product_code,
      spr.normalized_code,
      spr.description,
      spr.oem_no,
      null::text as hs_code,
      null::text as origin,
      null::numeric as weight_kg,
      'Supplier Only'::text as catalog_status
    from public.supplier_price_rollups spr
    cross join current_org org
    cross join brand_filter f
    left join public.catalog_products cp
      on cp.organization_id = spr.organization_id
     and cp.brand_id = spr.brand_id
     and cp.normalized_code = spr.normalized_code
    where spr.organization_id = org.organization_id
      and f.scope_name = 'all'
      and cp.id is null
      and (
        f.raw_brand is null
        or spr.brand_id = any(f.brand_ids)
      )
      and (
        f.raw_search is null
        or (
          f.search_is_code
          and (
            spr.normalized_code = f.search_norm
            or spr.normalized_oem = f.search_norm
            or spr.normalized_code like f.search_norm || '%'
            or spr.normalized_oem like f.search_norm || '%'
          )
        )
        or (
          not f.search_is_code
          and (
            spr.product_code ilike '%' || f.raw_search || '%'
            or coalesce(spr.description, '') ilike '%' || f.raw_search || '%'
            or coalesce(spr.oem_no, '') ilike '%' || f.raw_search || '%'
            or (
              f.search_norm <> ''
              and (
                spr.normalized_code like '%' || f.search_norm || '%'
                or spr.normalized_oem like '%' || f.search_norm || '%'
              )
            )
          )
        )
      )
  ),
  combined_base as (
    select * from catalog_filtered
    union all
    select * from supplier_only_filtered
  ),
  combined as (
    select
      base.id,
      base.brand_id,
      base.product_code,
      base.normalized_code,
      base.description,
      base.oem_no,
      base.hs_code,
      base.origin,
      base.weight_kg,
      base.catalog_status,
      spr.cheapest_supplier_id,
      spr.cheapest_price,
      spr.second_supplier_id,
      spr.second_supplier_name,
      spr.second_price,
      spr.price_gap,
      spr.price_gap_percent,
      spr.price_date,
      coalesce(spr.supplier_count, 0)::bigint as supplier_count,
      spr.notes,
      coalesce(spr.has_notes, false) as has_notes
    from combined_base base
    cross join current_org org
    left join public.supplier_price_rollups spr
      on spr.organization_id = org.organization_id
     and spr.brand_id = base.brand_id
     and spr.normalized_code = base.normalized_code
  ),
  counted as (
    select
      combined.*,
      b.name as brand,
      count(*) over () as total_count,
      row_number() over (order by b.name, combined.product_code, combined.normalized_code) as row_no
    from combined
    join public.brands b
      on b.id = combined.brand_id
  ),
  paged as (
    select counted.*
    from counted
    cross join brand_filter f
    where counted.row_no > f.row_offset
      and counted.row_no <= (f.row_offset + f.page_size)
  )
  select
    paged.total_count,
    paged.id as product_id,
    paged.product_code,
    paged.brand,
    paged.description,
    paged.oem_no,
    paged.hs_code,
    paged.origin,
    paged.weight_kg,
    coalesce(supplier.name, '') as cheapest_supplier,
    paged.cheapest_price,
    coalesce(nullif(paged.second_supplier_name, ''), second_supplier.name, '') as second_supplier_name,
    paged.second_price,
    paged.price_gap,
    paged.price_gap_percent,
    paged.price_date,
    case
      when paged.cheapest_price is null then null
      else round(paged.cheapest_price * (1 + coalesce(input_margin_a, 0)), 2)
    end as sales_a,
    case
      when paged.cheapest_price is null then null
      else round(paged.cheapest_price * (1 + coalesce(input_margin_b, 0)), 2)
    end as sales_b,
    paged.supplier_count,
    paged.catalog_status,
    paged.notes,
    paged.has_notes
  from paged
  left join public.suppliers supplier
    on supplier.id = paged.cheapest_supplier_id
  left join public.suppliers second_supplier
    on second_supplier.id = paged.second_supplier_id;
$$;

drop function if exists public.cloud_master_export(text, text, integer, integer, numeric, numeric, text);

create or replace function public.cloud_master_export(
  input_search text default '',
  input_brand text default '',
  input_page integer default 1,
  input_page_size integer default 1000,
  input_margin_a numeric default 0.10,
  input_margin_b numeric default 0.15,
  input_scope text default 'catalog'
)
returns table (
  total_count bigint,
  product_id uuid,
  product_code text,
  brand text,
  description text,
  oem_no text,
  hs_code text,
  origin text,
  weight_kg numeric,
  cheapest_supplier text,
  cheapest_price numeric,
  second_supplier_name text,
  second_price numeric,
  price_gap numeric,
  price_gap_percent numeric,
  price_date date,
  sales_a numeric,
  sales_b numeric,
  supplier_count bigint,
  catalog_status text,
  notes text,
  has_notes boolean
)
language sql
stable
security definer
set search_path = public
as $$
  with current_org as (
    select public.current_profile_org_id() as organization_id
  ),
  params as (
    select
      nullif(trim(coalesce(input_search, '')), '') as raw_search,
      public.normalize_part_code(input_search) as search_norm,
      nullif(trim(coalesce(input_brand, '')), '') as raw_brand,
      public.normalize_part_code(input_brand) as brand_norm,
      least(greatest(input_page_size, 1), 1000) as page_size,
      greatest(0, (greatest(input_page, 1) - 1) * least(greatest(input_page_size, 1), 1000)) as row_offset,
      coalesce(nullif(trim(input_scope), ''), 'catalog') as scope_name
  ),
  brand_filter as (
    select
      p.raw_search,
      p.search_norm,
      p.raw_brand,
      p.brand_norm,
      p.page_size,
      p.row_offset,
      p.scope_name,
      (p.search_norm <> '' and length(p.search_norm) >= 5) as search_is_code,
      array_remove(array_agg(b.id), null) as brand_ids
    from params p
    cross join current_org org
    left join public.brands b
      on b.organization_id = org.organization_id
     and (
       p.raw_brand is null
       or coalesce(b.normalized_name, public.normalize_part_code(b.name)) = p.brand_norm
     )
    group by
      p.raw_search,
      p.search_norm,
      p.raw_brand,
      p.brand_norm,
      p.page_size,
      p.row_offset,
      p.scope_name
  ),
  catalog_filtered as (
    select
      cp.id,
      cp.brand_id,
      cp.product_code,
      coalesce(nullif(cp.normalized_code, ''), public.normalize_part_code(cp.product_code)) as normalized_code,
      coalesce(cp.description, '') as description,
      coalesce(cp.oem_no, '') as oem_no,
      cp.hs_code,
      cp.origin,
      cp.weight_kg,
      'In Catalog'::text as catalog_status
    from public.catalog_products cp
    cross join current_org org
    cross join brand_filter f
    where cp.organization_id = org.organization_id
      and (
        f.raw_brand is null
        or cp.brand_id = any(f.brand_ids)
      )
      and (
        f.raw_search is null
        or (
          f.search_is_code
          and (
            coalesce(nullif(cp.normalized_code, ''), public.normalize_part_code(cp.product_code)) = f.search_norm
            or coalesce(nullif(cp.normalized_oem, ''), public.normalize_part_code(coalesce(cp.oem_no, ''))) = f.search_norm
            or coalesce(nullif(cp.normalized_code, ''), public.normalize_part_code(cp.product_code)) like f.search_norm || '%'
            or coalesce(nullif(cp.normalized_oem, ''), public.normalize_part_code(coalesce(cp.oem_no, ''))) like f.search_norm || '%'
          )
        )
        or (
          not f.search_is_code
          and (
            cp.product_code ilike '%' || f.raw_search || '%'
            or coalesce(cp.description, '') ilike '%' || f.raw_search || '%'
            or coalesce(cp.oem_no, '') ilike '%' || f.raw_search || '%'
            or (
              f.search_norm <> ''
              and (
                coalesce(nullif(cp.normalized_code, ''), public.normalize_part_code(cp.product_code)) like '%' || f.search_norm || '%'
                or coalesce(nullif(cp.normalized_oem, ''), public.normalize_part_code(coalesce(cp.oem_no, ''))) like '%' || f.search_norm || '%'
              )
            )
          )
        )
      )
  ),
  supplier_only_filtered as (
    select
      null::uuid as id,
      spr.brand_id,
      spr.product_code,
      spr.normalized_code,
      spr.description,
      spr.oem_no,
      null::text as hs_code,
      null::text as origin,
      null::numeric as weight_kg,
      'Supplier Only'::text as catalog_status
    from public.supplier_price_rollups spr
    cross join current_org org
    cross join brand_filter f
    left join public.catalog_products cp
      on cp.organization_id = spr.organization_id
     and cp.brand_id = spr.brand_id
     and cp.normalized_code = spr.normalized_code
    where spr.organization_id = org.organization_id
      and f.scope_name = 'all'
      and cp.id is null
      and (
        f.raw_brand is null
        or spr.brand_id = any(f.brand_ids)
      )
      and (
        f.raw_search is null
        or (
          f.search_is_code
          and (
            spr.normalized_code = f.search_norm
            or spr.normalized_oem = f.search_norm
            or spr.normalized_code like f.search_norm || '%'
            or spr.normalized_oem like f.search_norm || '%'
          )
        )
        or (
          not f.search_is_code
          and (
            spr.product_code ilike '%' || f.raw_search || '%'
            or coalesce(spr.description, '') ilike '%' || f.raw_search || '%'
            or coalesce(spr.oem_no, '') ilike '%' || f.raw_search || '%'
            or (
              f.search_norm <> ''
              and (
                spr.normalized_code like '%' || f.search_norm || '%'
                or spr.normalized_oem like '%' || f.search_norm || '%'
              )
            )
          )
        )
      )
  ),
  combined_base as (
    select * from catalog_filtered
    union all
    select * from supplier_only_filtered
  ),
  combined as (
    select
      base.id,
      base.brand_id,
      base.product_code,
      base.normalized_code,
      base.description,
      base.oem_no,
      base.hs_code,
      base.origin,
      base.weight_kg,
      base.catalog_status,
      spr.cheapest_supplier_id,
      spr.cheapest_price,
      spr.second_supplier_id,
      spr.second_supplier_name,
      spr.second_price,
      spr.price_gap,
      spr.price_gap_percent,
      spr.price_date,
      coalesce(spr.supplier_count, 0)::bigint as supplier_count,
      spr.notes,
      coalesce(spr.has_notes, false) as has_notes
    from combined_base base
    cross join current_org org
    left join public.supplier_price_rollups spr
      on spr.organization_id = org.organization_id
     and spr.brand_id = base.brand_id
     and spr.normalized_code = base.normalized_code
  )
  select
    0::bigint as total_count,
    combined.id as product_id,
    combined.product_code,
    b.name as brand,
    combined.description,
    combined.oem_no,
    combined.hs_code,
    combined.origin,
    combined.weight_kg,
    coalesce(supplier.name, '') as cheapest_supplier,
    combined.cheapest_price,
    coalesce(nullif(combined.second_supplier_name, ''), second_supplier.name, '') as second_supplier_name,
    combined.second_price,
    combined.price_gap,
    combined.price_gap_percent,
    combined.price_date,
    case
      when combined.cheapest_price is null then null
      else round(combined.cheapest_price * (1 + coalesce(input_margin_a, 0)), 2)
    end as sales_a,
    case
      when combined.cheapest_price is null then null
      else round(combined.cheapest_price * (1 + coalesce(input_margin_b, 0)), 2)
    end as sales_b,
    combined.supplier_count,
    combined.catalog_status,
    combined.notes,
    combined.has_notes
  from combined
  join public.brands b
    on b.id = combined.brand_id
  cross join brand_filter f
  left join public.suppliers supplier
    on supplier.id = combined.cheapest_supplier_id
  left join public.suppliers second_supplier
    on second_supplier.id = combined.second_supplier_id
  order by b.name, combined.product_code, combined.normalized_code
  limit (select page_size from params)
  offset (select row_offset from params);
$$;

grant execute on function public.refresh_supplier_price_rollups(uuid) to authenticated;
grant execute on function public.refresh_supplier_price_rollups(uuid) to service_role;
grant execute on function public.cloud_master_page(text, text, integer, integer, numeric, numeric, text) to authenticated;
grant execute on function public.cloud_master_export(text, text, integer, integer, numeric, numeric, text) to authenticated;
