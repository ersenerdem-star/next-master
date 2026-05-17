-- Cloud supplier management: list suppliers, paginated supplier price rows, and import history.
-- Run this in Supabase SQL Editor.

create or replace function list_cloud_suppliers()
returns table (
  supplier_id uuid,
  name text,
  is_active boolean,
  line_count bigint,
  latest_price_date date,
  old_or_unknown_count bigint
)
language sql
stable
security definer
set search_path = public
as $$
  select
    s.id,
    s.name,
    s.is_active,
    count(sp.id) as line_count,
    max(sp.valid_from) as latest_price_date,
    count(sp.id) filter (
      where sp.valid_from is null
        or sp.valid_from < current_date - interval '180 days'
    ) as old_or_unknown_count
  from suppliers s
  left join supplier_prices sp
    on sp.supplier_id = s.id
   and sp.organization_id = s.organization_id
   and sp.is_active
  where s.organization_id = current_profile_org_id()
  group by s.id, s.name, s.is_active
  order by s.name;
$$;

create or replace function cloud_supplier_price_page(
  input_supplier_id uuid,
  input_search text default '',
  input_page integer default 1,
  input_page_size integer default 250,
  input_freshness text default 'all'
)
returns table (
  total_count bigint,
  price_id uuid,
  product_code text,
  brand text,
  description text,
  oem_no text,
  buy_price numeric,
  currency text,
  price_date date,
  moq integer,
  lead_time_days integer,
  notes text,
  freshness text
)
language sql
stable
security definer
set search_path = public
as $$
  with params as (
    select
      nullif(trim(coalesce(input_search, '')), '') as raw_search,
      normalize_part_code(input_search) as search_norm,
      greatest(input_page, 1) as page_no,
      least(greatest(input_page_size, 1), 1000) as page_size,
      greatest(0, (greatest(input_page, 1) - 1) * least(greatest(input_page_size, 1), 1000)) as row_offset
  ),
  search_flags as (
    select
      raw_search,
      search_norm,
      page_no,
      page_size,
      row_offset,
      (search_norm <> '' and length(search_norm) >= 5) as search_is_code
    from params
  ),
  scoped as (
    select
      sp.id,
      sp.product_code,
      b.name as brand,
      sp.description,
      sp.oem_no,
      sp.organization_id,
      sp.brand_id,
      sp.normalized_code,
      sp.normalized_oem,
      sp.buy_price,
      sp.currency,
      sp.valid_from,
      sp.moq,
      sp.lead_time_days,
      sp.notes,
      case
        when sp.valid_from is null then 'unknown'
        when sp.valid_from < current_date - interval '180 days' then 'stale'
        when sp.valid_from < current_date - interval '90 days' then 'aging'
        else 'fresh'
      end as freshness
    from supplier_prices sp
    left join brands b on b.id = sp.brand_id
    cross join search_flags f
    where sp.organization_id = current_profile_org_id()
      and sp.supplier_id = input_supplier_id
      and sp.is_active
      and (
        f.raw_search is null
        or (
          f.search_is_code
          and (
            sp.normalized_code = f.search_norm
            or sp.normalized_oem = f.search_norm
            or sp.normalized_code like f.search_norm || '%'
            or (
              nullif(sp.normalized_oem, '') is not null
              and sp.normalized_oem like f.search_norm || '%'
            )
          )
        )
        or (
          not f.search_is_code
          and (
            sp.product_code ilike '%' || f.raw_search || '%'
            or coalesce(sp.description, '') ilike '%' || f.raw_search || '%'
            or coalesce(sp.oem_no, '') ilike '%' || f.raw_search || '%'
            or coalesce(b.name, '') ilike '%' || f.raw_search || '%'
            or sp.normalized_code like '%' || f.search_norm || '%'
            or (
              nullif(sp.normalized_oem, '') is not null
              and sp.normalized_oem like '%' || f.search_norm || '%'
            )
          )
        )
      )
  ),
  filtered as (
    select *
    from scoped
    where coalesce(input_freshness, 'all') = 'all'
      or freshness = input_freshness
  ),
  counted as (
    select
      filtered.*,
      count(*) over () as total_count,
      row_number() over (order by filtered.product_code) as row_no
    from filtered
  ),
  paged as (
    select counted.*
    from counted
    cross join search_flags f
    where counted.row_no > f.row_offset
      and counted.row_no <= (f.row_offset + f.page_size)
  ),
  enriched as (
    select
      paged.*,
      nullif(trim(coalesce(cp.description, '')), '') as catalog_description
    from paged
    left join catalog_products cp
      on cp.organization_id = paged.organization_id
     and cp.brand_id = paged.brand_id
     and cp.normalized_code = paged.normalized_code
  )
  select
    enriched.total_count,
    enriched.id,
    enriched.product_code,
    enriched.brand,
    case
      when nullif(trim(coalesce(enriched.description, '')), '') is null then enriched.catalog_description
      when normalize_part_code(enriched.description) = enriched.normalized_code then coalesce(enriched.catalog_description, enriched.description)
      else enriched.description
    end as description,
    enriched.oem_no,
    enriched.buy_price,
    enriched.currency,
    enriched.valid_from,
    enriched.moq,
    enriched.lead_time_days,
    enriched.notes,
    enriched.freshness
  from enriched;
$$;

create or replace function update_cloud_supplier_price(
  input_price_id uuid,
  input_description text default null,
  input_oem_no text default null,
  input_buy_price numeric default null,
  input_moq integer default null,
  input_lead_time_days integer default null,
  input_notes text default null
)
returns table (
  price_id uuid,
  description text,
  oem_no text,
  buy_price numeric,
  moq integer,
  lead_time_days integer,
  notes text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  org_id uuid;
  role_name text;
begin
  org_id := current_profile_org_id();
  role_name := current_profile_role();

  if org_id is null or role_name not in ('admin', 'sales') then
    raise exception 'Only active admin or sales users can edit supplier prices';
  end if;

  if input_price_id is null then
    raise exception 'Supplier price row is required';
  end if;

  return query
  update supplier_prices sp
  set description = nullif(trim(coalesce(input_description, '')), ''),
      oem_no = nullif(trim(coalesce(input_oem_no, '')), ''),
      buy_price = case
        when input_buy_price is null then null
        else round(input_buy_price::numeric, 2)
      end,
      moq = input_moq,
      lead_time_days = input_lead_time_days,
      notes = nullif(trim(coalesce(input_notes, '')), ''),
      updated_at = now()
  where sp.id = input_price_id
    and sp.organization_id = org_id
  returning
    sp.id,
    sp.description,
    sp.oem_no,
    sp.buy_price,
    sp.moq,
    sp.lead_time_days,
    sp.notes;

  if not found then
    raise exception 'Supplier price row not found in your workspace';
  end if;

  perform sync_catalog_from_supplier_price_row(input_price_id);
end;
$$;

create or replace function cloud_supplier_brand_summary(
  input_supplier_id uuid default null
)
returns table (
  supplier_id uuid,
  supplier_name text,
  brand text,
  part_count bigint,
  line_count bigint,
  latest_price_date date,
  oldest_price_date date
)
language sql
stable
security definer
set search_path = public
as $$
  select
    s.id as supplier_id,
    s.name as supplier_name,
    coalesce(b.name, 'Unbranded') as brand,
    count(distinct sp.normalized_code) as part_count,
    count(sp.id) as line_count,
    max(sp.valid_from) as latest_price_date,
    min(sp.valid_from) as oldest_price_date
  from suppliers s
  join supplier_prices sp
    on sp.supplier_id = s.id
   and sp.organization_id = s.organization_id
   and sp.is_active
  left join brands b
    on b.id = sp.brand_id
   and b.organization_id = sp.organization_id
  where s.organization_id = current_profile_org_id()
    and (input_supplier_id is null or s.id = input_supplier_id)
  group by s.id, s.name, coalesce(b.name, 'Unbranded')
  order by s.name, part_count desc, brand;
$$;

create or replace function list_cloud_import_jobs(
  input_kind text default 'supplier_prices',
  input_limit integer default 12
)
returns table (
  job_id uuid,
  kind text,
  source_name text,
  status text,
  row_count integer,
  inserted_count integer,
  updated_count integer,
  skipped_count integer,
  skipped_reason text,
  error_message text,
  created_at timestamptz,
  completed_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    j.id,
    j.kind,
    j.source_name,
    j.status,
    j.row_count,
    j.inserted_count,
    j.updated_count,
    j.skipped_count,
    j.skipped_reason,
    j.error_message,
    j.created_at,
    j.completed_at
  from import_jobs j
  where j.organization_id = current_profile_org_id()
    and (
      coalesce(input_kind, '') = ''
      or input_kind = 'all'
      or j.kind = input_kind
    )
  order by j.created_at desc
  limit least(greatest(coalesce(input_limit, 12), 1), 50);
$$;

create or replace function deactivate_old_supplier_prices(
  input_supplier_id uuid default null,
  input_before_days integer default 180
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  org_id uuid;
  affected integer := 0;
begin
  org_id := current_profile_org_id();

  if org_id is null or current_profile_role() <> 'admin' then
    raise exception 'Only active admin users can deactivate supplier prices';
  end if;

  update supplier_prices sp
  set is_active = false,
      updated_at = now()
  where sp.organization_id = org_id
    and sp.is_active
    and (input_supplier_id is null or sp.supplier_id = input_supplier_id)
    and (
      sp.valid_from is null
      or sp.valid_from < current_date - (greatest(coalesce(input_before_days, 180), 1) || ' days')::interval
    );

  get diagnostics affected = row_count;
  return affected;
end;
$$;

create or replace function deactivate_supplier_prices_by_filter(
  input_supplier_id uuid,
  input_brand text default '',
  input_price_date date default null,
  input_search text default ''
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  org_id uuid;
  affected integer := 0;
  batch_affected integer := 0;
  brand_norm text := normalize_part_code(input_brand);
  search_norm text := normalize_part_code(input_search);
begin
  org_id := current_profile_org_id();

  if org_id is null or current_profile_role() <> 'admin' then
    raise exception 'Only active admin users can deactivate supplier prices';
  end if;

  if input_supplier_id is null then
    raise exception 'Supplier is required';
  end if;

  loop
    with target_ids as (
      select sp.id
      from supplier_prices sp
      left join brands b
        on b.id = sp.brand_id
       and b.organization_id = sp.organization_id
      where sp.organization_id = org_id
        and sp.supplier_id = input_supplier_id
        and sp.is_active
        and (
          coalesce(input_brand, '') = ''
          or b.normalized_name = brand_norm
        )
        and (
          input_price_date is null
          or sp.valid_from = input_price_date
        )
        and (
          coalesce(input_search, '') = ''
          or sp.normalized_code = search_norm
          or sp.normalized_oem = search_norm
          or sp.normalized_code like search_norm || '%'
          or (
            nullif(sp.normalized_oem, '') is not null
            and sp.normalized_oem like search_norm || '%'
          )
          or sp.product_code ilike '%' || input_search || '%'
          or coalesce(sp.description, '') ilike '%' || input_search || '%'
          or coalesce(sp.oem_no, '') ilike '%' || input_search || '%'
        )
      order by sp.id
      limit 5000
    ),
    updated as (
      update supplier_prices sp
      set is_active = false,
          updated_at = now()
      where sp.id in (select id from target_ids)
      returning sp.id
    )
    select count(*) into batch_affected
    from updated;

    affected := affected + batch_affected;
    exit when batch_affected = 0;
  end loop;

  return affected;
end;
$$;

grant execute on function list_cloud_suppliers() to authenticated;
grant execute on function cloud_supplier_price_page(uuid, text, integer, integer, text) to authenticated;
grant execute on function update_cloud_supplier_price(uuid, text, text, numeric, integer, integer, text) to authenticated;
grant execute on function cloud_supplier_brand_summary(uuid) to authenticated;
grant execute on function list_cloud_import_jobs(text, integer) to authenticated;
grant execute on function deactivate_old_supplier_prices(uuid, integer) to authenticated;
grant execute on function deactivate_supplier_prices_by_filter(uuid, text, date, text) to authenticated;
