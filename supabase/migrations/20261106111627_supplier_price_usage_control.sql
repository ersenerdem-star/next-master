-- Supplier eligibility for current pricing. Price sources and saved orders remain immutable.
alter table public.suppliers add column if not exists price_usage_enabled boolean not null default true;
alter table public.suppliers add column if not exists price_usage_disabled_at timestamptz;

create schema if not exists supplier_price_usage_internal;
revoke all on schema supplier_price_usage_internal from public,anon,authenticated;
create table if not exists supplier_price_usage_internal.events (
 id bigint generated always as identity primary key,
 organization_id uuid not null references public.organizations(id),
 supplier_id uuid not null references public.suppliers(id),
 enabled boolean not null, actor_id uuid, reason text not null,
 changed_at timestamptz not null default clock_timestamp()
);
alter table supplier_price_usage_internal.events enable row level security;
revoke all on supplier_price_usage_internal.events from public,anon,authenticated;

create or replace function public.supplier_price_usage_enabled(input_organization_id uuid,input_supplier_id uuid)
returns boolean language sql stable set search_path='' as $$
 select exists(select 1 from public.suppliers s where s.organization_id=input_organization_id
  and s.id=input_supplier_id and s.price_usage_enabled);
$$;
revoke all on function public.supplier_price_usage_enabled(uuid,uuid) from public,anon;
grant execute on function public.supplier_price_usage_enabled(uuid,uuid) to authenticated,service_role;

create or replace function supplier_price_usage_internal.before_change()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.price_usage_enabled is not distinct from old.price_usage_enabled then
   new.price_usage_disabled_at:=old.price_usage_disabled_at;
   return new;
 end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('supplier-price-publication:'||new.organization_id::text,0));
 new.price_usage_disabled_at:=case when new.price_usage_enabled then null else clock_timestamp() end;
 return new;
end $$;
revoke all on function supplier_price_usage_internal.before_change() from public,anon,authenticated;

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
 for b in
  select distinct brand_id from public.supplier_prices where organization_id=new.organization_id and supplier_id=new.id
  union select brand_id from public.supplier_current_price_pointers where organization_id=new.organization_id and supplier_id=new.id
 loop
  -- Both cache refresh and version changes commit with the switch, or all roll back.
  perform public.refresh_supplier_price_rollups_for_brand(new.organization_id,b);
  insert into public.supplier_price_source_versions(organization_id,brand_id,source_revision,updated_at)
  values(new.organization_id,b,1,clock_timestamp())
  on conflict(organization_id,brand_id) do update
   set source_revision=public.supplier_price_source_versions.source_revision+1,updated_at=clock_timestamp();
 end loop;
 return new;
end $$;
revoke all on function supplier_price_usage_internal.after_change() from public,anon,authenticated;
drop trigger if exists supplier_price_usage_before_change on public.suppliers;
create trigger supplier_price_usage_before_change before update of price_usage_enabled,price_usage_disabled_at on public.suppliers
for each row execute function supplier_price_usage_internal.before_change();
drop trigger if exists supplier_price_usage_after_change on public.suppliers;
create trigger supplier_price_usage_after_change after update of price_usage_enabled on public.suppliers
for each row execute function supplier_price_usage_internal.after_change();

create or replace function public.set_supplier_price_usage(input_supplier_id uuid,input_enabled boolean,input_expected_enabled boolean,input_reason text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare s public.suppliers%rowtype; org uuid:=public.current_profile_org_id();
begin
 if auth.uid() is null or org is null or not coalesce(public.is_superadmin() or
   (public.current_profile_role()='admin' and public.profile_has_permission('supplier_prices.manage')),false) then
  raise exception 'SUPPLIER_PRICE_USAGE_ADMIN_REQUIRED';
 end if;
 if input_supplier_id is null or input_enabled is null or input_expected_enabled is null
  or length(btrim(coalesce(input_reason,''))) not between 3 and 500 then
  raise exception 'SUPPLIER_PRICE_USAGE_INVALID_INPUT';
 end if;
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('supplier-price-publication:'||org::text,0));
 select * into s from public.suppliers where id=input_supplier_id and organization_id=org for update;
 if not found then raise exception 'SUPPLIER_PRICE_USAGE_NOT_FOUND';end if;
 if s.price_usage_enabled is distinct from input_expected_enabled then raise exception 'SUPPLIER_PRICE_USAGE_STALE';end if;
 if s.price_usage_enabled=input_enabled then
  return jsonb_build_object('supplier_id',s.id,'price_usage_enabled',s.price_usage_enabled,'changed',false);
 end if;
 perform pg_catalog.set_config('supplier_price_usage.reason',btrim(input_reason),true);
 update public.suppliers set price_usage_enabled=input_enabled,updated_at=clock_timestamp() where id=s.id;
 return jsonb_build_object('supplier_id',s.id,'price_usage_enabled',input_enabled,'changed',true);
end $$;
revoke all on function public.set_supplier_price_usage(uuid,boolean,boolean,text) from public,anon;
grant execute on function public.set_supplier_price_usage(uuid,boolean,boolean,text) to authenticated;

-- Legacy best-price consumers receive only eligible current price sources.
create or replace view public.active_best_supplier_prices with (security_invoker=true) as
select distinct on (organization_id,brand_id,normalized_code)
 organization_id,brand_id,normalized_code,supplier_id,buy_price,currency,lead_time_days,stock_qty,updated_at
from public.supplier_prices sp where is_active and buy_price is not null
 and exists(select 1 from public.suppliers usage_supplier where usage_supplier.organization_id=sp.organization_id and usage_supplier.id=sp.supplier_id and usage_supplier.price_usage_enabled)
order by organization_id,brand_id,normalized_code,buy_price,updated_at desc;

-- Current commercial reader: cloud_resolve_quote_line
CREATE OR REPLACE FUNCTION public.cloud_resolve_quote_line(input_code text, input_brand text DEFAULT ''::text, input_customer_type text DEFAULT 'A'::text, input_margin_a numeric DEFAULT 0.10, input_margin_b numeric DEFAULT 0.15)
 RETURNS TABLE(found boolean, product_id uuid, product_code text, brand text, description text, oem_no text, hs_code text, origin text, weight_kg numeric, supplier_id uuid, supplier_name text, buy_price numeric, price_date date, sell_price numeric, notes text, has_product_conflict boolean, product_conflict_fields text[])
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with requested_brand as (
    select b.id from public.brands b
    where b.organization_id = public.current_profile_org_id()
      and b.normalized_name = public.normalize_part_code(input_brand) limit 1
  ),
  catalog_exact as (
    select cp.id, cp.product_code, cp.normalized_code, cp.description, cp.oem_no,
      cp.hs_code, cp.origin, cp.weight_kg, cp.brand_id, b.name as brand
    from public.catalog_products cp join public.brands b on b.id = cp.brand_id
    where cp.organization_id = public.current_profile_org_id()
      and (cp.normalized_code = public.normalize_part_code(input_code)
        or cp.normalized_oem = public.normalize_part_code(input_code))
      and (coalesce(input_brand, '') = '' or cp.brand_id in (select id from requested_brand))
    order by case when cp.brand_id in (select id from requested_brand) then 0 else 1 end,
      case when cp.normalized_code = public.normalize_part_code(input_code) then 0 else 1 end,
      case when cp.normalized_oem = public.normalize_part_code(input_code) then 0 else 1 end,
      b.name, cp.product_code limit 1
  ),
  supplier_exact as (
    select null::uuid as id, sp.product_code, sp.normalized_code, sp.description, sp.oem_no,
      null::text as hs_code, null::text as origin, null::numeric as weight_kg,
      sp.brand_id, b.name as brand
    from public.supplier_prices sp join public.brands b on b.id = sp.brand_id
    where sp.organization_id = public.current_profile_org_id()
      and sp.is_active and exists(select 1 from public.suppliers usage_supplier where usage_supplier.organization_id=sp.organization_id and usage_supplier.id=sp.supplier_id and usage_supplier.price_usage_enabled) and sp.buy_price is not null
      and sp.valid_from <= current_date
      and (sp.valid_to is null or sp.valid_to >= current_date)
      and sp.normalized_code = public.normalize_part_code(input_code)
      and (coalesce(input_brand, '') = '' or sp.brand_id in (select id from requested_brand))
      and not exists (select 1 from catalog_exact)
    order by case when sp.brand_id in (select id from requested_brand) then 0 else 1 end,
      sp.buy_price asc, sp.valid_from desc, sp.updated_at desc limit 1
  ),
  catalog_fuzzy as (
    select cp.id, cp.product_code, cp.normalized_code, cp.description, cp.oem_no,
      cp.hs_code, cp.origin, cp.weight_kg, cp.brand_id, b.name as brand
    from public.catalog_products cp join public.brands b on b.id = cp.brand_id
    where cp.organization_id = public.current_profile_org_id()
      and not exists (select 1 from catalog_exact)
      and not exists (select 1 from supplier_exact)
      and (
        cp.normalized_code like '%' || public.normalize_part_code(input_code) || '%'
        or public.normalize_part_code(input_code) like '%' || cp.normalized_code || '%'
        or (nullif(cp.normalized_oem, '') is not null and cp.normalized_oem like '%' || public.normalize_part_code(input_code) || '%')
        or (nullif(cp.normalized_oem, '') is not null and public.normalize_part_code(input_code) like '%' || cp.normalized_oem || '%')
      )
      and (coalesce(input_brand, '') = '' or cp.brand_id in (select id from requested_brand))
    order by case when cp.brand_id in (select id from requested_brand) then 0 else 1 end,
      b.name, cp.product_code limit 1
  ),
  product_match as (
    select * from catalog_exact
    union all select * from supplier_exact
    union all select * from catalog_fuzzy limit 1
  )
  select product_match.id is not null, product_match.id,
    coalesce(product_match.product_code, input_code), product_match.brand,
    product_match.description, product_match.oem_no, product_match.hs_code, product_match.origin,
    product_match.weight_kg, best.supplier_id, supplier.name, best.buy_price, best.valid_from,
    case when upper(coalesce(input_customer_type, 'A')) = 'B'
      then round(coalesce(best.buy_price, 0) * (1 + coalesce(input_margin_b, 0)), 2)
      else round(coalesce(best.buy_price, 0) * (1 + coalesce(input_margin_a, 0)), 2) end,
    nullif(trim(coalesce(best.notes, '')), ''),
    coalesce(conflicts.has_conflict, false),
    coalesce(conflicts.fields, array[]::text[])
  from product_match
  left join lateral (
    select sp.supplier_id, sp.buy_price, sp.valid_from, sp.notes
    from public.supplier_prices sp
    where sp.organization_id = public.current_profile_org_id()
      and sp.is_active and exists(select 1 from public.suppliers usage_supplier where usage_supplier.organization_id=sp.organization_id and usage_supplier.id=sp.supplier_id and usage_supplier.price_usage_enabled) and sp.brand_id = product_match.brand_id
      and sp.normalized_code = product_match.normalized_code and sp.buy_price is not null
      and sp.valid_from <= current_date
      and (sp.valid_to is null or sp.valid_to >= current_date)
    order by sp.buy_price asc, sp.valid_from desc, sp.updated_at desc limit 1
  ) best on true
  left join public.suppliers supplier on supplier.id = best.supplier_id
  left join lateral (
    select true as has_conflict, array_agg(distinct pac.field_name order by pac.field_name) as fields
    from public.product_attribute_conflicts pac
    where pac.organization_id = public.current_profile_org_id()
      and pac.product_id = product_match.id and pac.status = 'pending_review'
    having count(*) > 0
  ) conflicts on true
  union all
  select false, null::uuid, input_code, null::text, null::text, null::text, null::text,
    null::text, null::numeric, null::uuid, null::text, null::numeric, null::date,
    null::numeric, null::text, false, array[]::text[]
  where not exists (select 1 from product_match);
$function$
;

-- Current commercial reader: cloud_master_published_price_page_v3
CREATE OR REPLACE FUNCTION public.cloud_master_published_price_page_v3(input_search text DEFAULT ''::text, input_brand_id uuid DEFAULT NULL::uuid, input_page integer DEFAULT 1, input_page_size integer DEFAULT 50, input_margin_a numeric DEFAULT 0.10, input_margin_b numeric DEFAULT 0.15)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_organization_id uuid;
  v_brand_name text;
  v_page integer;
  v_page_size integer;
  v_scan_limit integer;
  v_exact_code text;
  v_result jsonb;
begin
  if auth.uid() is null then
    raise exception 'MASTER_AUTH_REQUIRED';
  end if;
  v_organization_id := public.current_profile_org_id();
  if v_organization_id is null then
    raise exception 'MASTER_ACCESS_DENIED';
  end if;
  if input_brand_id is null or input_page is null or input_page not between 1 and 100
     or input_page_size is null or input_page_size not between 1 and 100
     or pg_catalog.length(coalesce(input_search, '')) > 100
     or input_margin_a is null or input_margin_a not between -1 and 10
     or input_margin_b is null or input_margin_b not between -1 and 10 then
    raise exception 'MASTER_PAGE_INPUT_INVALID';
  end if;
  select b.name into v_brand_name
  from public.brands b
  where b.id = input_brand_id and b.organization_id = v_organization_id;
  if v_brand_name is null then
    raise exception 'MASTER_BRAND_SCOPE_INVALID';
  end if;

  v_page := input_page;
  v_page_size := input_page_size;
  v_scan_limit := v_page * v_page_size;
  v_exact_code := nullif(
    pg_catalog.upper(pg_catalog.regexp_replace(
      pg_catalog.btrim(coalesce(input_search, '')), '[[:space:]]+', '', 'g')),
    '');
  -- Search is exact SKU identity. A punctuation-preserving code such as 61/1
  -- must never be merged with 611 by the legacy alphanumeric normalizer.

  with pointer_scope as materialized (
    select ptr.*
    from public.supplier_current_price_pointers ptr
    where ptr.organization_id = v_organization_id
      and ptr.brand_id = input_brand_id
  ),
  legacy as not materialized (
    select sp.*,public.normalize_catalog_product_code(sp.product_code) collate "C" exact_code
    from public.supplier_prices sp
    where sp.organization_id=v_organization_id and sp.brand_id=input_brand_id and sp.is_active and exists(select 1 from public.suppliers usage_supplier where usage_supplier.organization_id=sp.organization_id and usage_supplier.id=sp.supplier_id and usage_supplier.price_usage_enabled)
      and sp.buy_price>0 and sp.currency='EUR' and sp.valid_from<=current_date
      and (sp.valid_to is null or sp.valid_to>=current_date)
      and public.normalize_catalog_product_code(sp.product_code) ~ '[A-Z0-9]'
      and exists(select 1 from pointer_scope)
      and not exists(select 1 from pointer_scope ptr where ptr.supplier_id=sp.supplier_id)
  ),
  current_releases as materialized (
    select ptr.release_id, ptr.supplier_id, s.name as supplier_name,
      rel.accepted_rows
    from pointer_scope ptr
    join public.supplier_price_publications pub
      on pub.id = ptr.publication_id and pub.release_id = ptr.release_id
     and pub.organization_id = ptr.organization_id
     and pub.supplier_id = ptr.supplier_id and pub.brand_id = ptr.brand_id
     and pub.status='published' and public.supplier_price_usage_enabled(pub.organization_id,pub.supplier_id)
    left join public.suppliers s
      on s.id = ptr.supplier_id and s.organization_id = ptr.organization_id
    left join public.supplier_price_releases rel
      on rel.id = ptr.release_id and rel.organization_id = ptr.organization_id
     and rel.supplier_id = ptr.supplier_id and rel.brand_id = ptr.brand_id
  ),
  release_codes as materialized (
    select candidate.normalized_code
    from current_releases cr
    cross join lateral (
      select distinct r.normalized_code
      from public.supplier_price_release_rows r
      where r.release_id = cr.release_id
        and (v_exact_code is null or r.normalized_code = v_exact_code)
        and r.row_status = 'accepted' and r.buy_price > 0
        and r.currency = 'EUR' and r.valid_from <= current_date and (r.valid_to is null or r.valid_to>=current_date)
        and r.normalized_code ~ '[A-Z0-9]'
        and r.normalized_code = pg_catalog.upper(
          pg_catalog.regexp_replace(r.product_code, '[[:space:]]+', '', 'g'))
      order by r.normalized_code
      limit v_scan_limit
    ) candidate
  ),
  legacy_codes as materialized (
    select distinct l.exact_code normalized_code from legacy l
    where v_exact_code is null or l.exact_code=v_exact_code
    order by l.exact_code limit v_scan_limit
  ),
  candidate_codes as materialized (
    select rc.normalized_code collate "C" normalized_code from release_codes rc
    union select lc.normalized_code from legacy_codes lc
  ),
  page_codes as materialized (
    select normalized_code
    from candidate_codes
    order by normalized_code collate "C"
    limit v_page_size offset ((v_page - 1) * v_page_size)
  ),
  published_rows as materialized (
    select r.normalized_code, r.product_code, r.description, r.buy_price,
      r.valid_from, r.notes, cr.supplier_id, cr.supplier_name,
      row_number() over (
        partition by r.normalized_code, cr.supplier_id
        order by r.valid_from desc, r.id desc
      ) as supplier_rank
    from page_codes pc
    join current_releases cr on true
    join public.supplier_price_release_rows r
      on r.release_id = cr.release_id and r.normalized_code = pc.normalized_code
    where r.row_status = 'accepted' and r.buy_price > 0
      and r.currency = 'EUR' and r.valid_from <= current_date and (r.valid_to is null or r.valid_to>=current_date)
      and r.normalized_code = pg_catalog.upper(
        pg_catalog.regexp_replace(r.product_code, '[[:space:]]+', '', 'g'))
  ),
  legacy_rows as materialized (
    select l.exact_code normalized_code,l.product_code,l.description,l.buy_price,l.valid_from,l.notes,
      l.supplier_id,s.name supplier_name,
      row_number() over(partition by l.exact_code,l.supplier_id order by l.valid_from desc,l.id::text desc) supplier_rank
    from page_codes pc join legacy l on l.exact_code=pc.normalized_code
    left join public.suppliers s on s.id=l.supplier_id and s.organization_id=v_organization_id
  ),
  supplier_rows as materialized (
    select * from published_rows union all select * from legacy_rows
  ),
  ranked as materialized (
    select sr.*,
      row_number() over (
        partition by sr.normalized_code
        order by sr.buy_price, sr.valid_from desc, sr.supplier_id
      ) as price_rank
    from supplier_rows sr
    where sr.supplier_rank = 1
  ),
  summary as materialized (
    select normalized_code,
      max(product_code) filter (where price_rank = 1) as product_code,
      max(description) filter (where price_rank = 1) as description,
      max(supplier_name) filter (where price_rank = 1) as cheapest_supplier,
      max(buy_price) filter (where price_rank = 1) as cheapest_price,
      max(supplier_name) filter (where price_rank = 2) as second_supplier_name,
      max(buy_price) filter (where price_rank = 2) as second_price,
      max(valid_from) filter (where price_rank = 1) as price_date,
      max(notes) filter (where price_rank = 1) as notes,
      count(*)::bigint as supplier_count
    from ranked
    group by normalized_code
  ),
  scope_totals as (
    -- Accepted-row metadata avoids a full 1M-row COUNT(DISTINCT) on every
    -- page. It is an upper-bound estimate when suppliers share SKUs or a
    -- historical release contains filtered rows.
    select exists(select 1 from pointer_scope) as has_published_scope,
      (coalesce(sum(accepted_rows), 0)+(select count(*) from legacy))::bigint as estimated_count
    from current_releases
  )
  select pg_catalog.jsonb_build_object(
    'has_published_scope', st.has_published_scope,
    'rows', coalesce((
      select pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'total_count', case when v_exact_code is null then st.estimated_count
          else 1 end,
        'product_id', null,
        'product_code', sm.product_code,
        'brand', v_brand_name,
        'description', sm.description,
        'oem_no', null, 'hs_code', null, 'origin', null, 'weight_kg', null,
        'cheapest_supplier', sm.cheapest_supplier,
        'cheapest_price', sm.cheapest_price,
        'second_supplier_name', sm.second_supplier_name,
        'second_price', sm.second_price,
        'price_gap', case when sm.second_price is null then null
          else sm.second_price - sm.cheapest_price end,
        'price_gap_percent', case when sm.second_price is null then null
          else pg_catalog.round((sm.second_price - sm.cheapest_price)
            * 100 / sm.cheapest_price, 2) end,
        'price_date', sm.price_date,
        'sales_a', pg_catalog.round(sm.cheapest_price * (1 + input_margin_a), 2),
        'sales_b', pg_catalog.round(sm.cheapest_price * (1 + input_margin_b), 2),
        'supplier_count', sm.supplier_count,
        'catalog_status', 'Supplier Price Only',
        'notes', sm.notes,
        'has_notes', nullif(pg_catalog.btrim(coalesce(sm.notes, '')), '') is not null
      ) order by sm.normalized_code)
      from summary sm
    ), '[]'::jsonb)
  ) into v_result
  from scope_totals st;

  return v_result;
end;
$function$
;

-- Current commercial reader: refresh_supplier_price_rollups_for_brand
CREATE OR REPLACE FUNCTION public.refresh_supplier_price_rollups_for_brand(p_organization_id uuid, p_brand_id uuid)
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

  if p_brand_id is null then
    raise exception 'Brand id is required';
  end if;

  -- Serialize rollup writers for this organization. The operation remains
  -- atomic: a failure rolls back the scoped delete and insert together.
  perform pg_advisory_xact_lock(
    hashtextextended(p_organization_id::text || ':supplier_price_rollups', 0)
  );

  delete from public.supplier_price_rollups spr
  where spr.organization_id = p_organization_id
    and spr.brand_id = p_brand_id;

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
      and sp.brand_id = p_brand_id
      and sp.is_active and exists(select 1 from public.suppliers usage_supplier where usage_supplier.organization_id=sp.organization_id and usage_supplier.id=sp.supplier_id and usage_supplier.price_usage_enabled)
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

-- Current commercial reader: cloud_supplier_order_rules
CREATE OR REPLACE FUNCTION public.cloud_supplier_order_rules(input_code text, input_brand text DEFAULT ''::text)
 RETURNS TABLE(supplier_name text, moq integer, order_multiple integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with requested_brand as (
    select b.id
    from public.brands b
    where b.organization_id = public.current_profile_org_id()
      and b.normalized_name = public.normalize_part_code(input_brand)
    limit 1
  ),
  catalog_exact as (
    select cp.brand_id, cp.normalized_code
    from public.catalog_products cp
    where cp.organization_id = public.current_profile_org_id()
      and (cp.normalized_code = public.normalize_part_code(input_code)
        or cp.normalized_oem = public.normalize_part_code(input_code))
      and (coalesce(input_brand, '') = '' or cp.brand_id in (select id from requested_brand))
    order by
      case when cp.brand_id in (select id from requested_brand) then 0 else 1 end,
      case when cp.normalized_code = public.normalize_part_code(input_code) then 0 else 1 end,
      cp.product_code
    limit 1
  ),
  supplier_exact as (
    select sp.brand_id, sp.normalized_code
    from public.supplier_prices sp
    where sp.organization_id = public.current_profile_org_id()
      and sp.is_active and exists(select 1 from public.suppliers usage_supplier where usage_supplier.organization_id=sp.organization_id and usage_supplier.id=sp.supplier_id and usage_supplier.price_usage_enabled)
      and sp.normalized_code = public.normalize_part_code(input_code)
      and sp.valid_from <= current_date
      and (sp.valid_to is null or sp.valid_to >= current_date)
      and (coalesce(input_brand, '') = '' or sp.brand_id in (select id from requested_brand))
      and not exists (select 1 from catalog_exact)
    order by sp.valid_from desc, sp.id desc
    limit 1
  ),
  product_match as (
    select * from catalog_exact
    union all
    select * from supplier_exact
    limit 1
  ),
  ranked as (
    select
      supplier.name as supplier_name,
      sp.moq,
      sp.order_multiple,
      row_number() over (
        partition by sp.supplier_id
        order by sp.valid_from desc, sp.updated_at desc, sp.id desc
      ) as supplier_rank
    from product_match pm
    join public.supplier_prices sp
      on sp.organization_id = public.current_profile_org_id()
     and sp.brand_id = pm.brand_id
     and sp.normalized_code = pm.normalized_code
     and sp.is_active and exists(select 1 from public.suppliers usage_supplier where usage_supplier.organization_id=sp.organization_id and usage_supplier.id=sp.supplier_id and usage_supplier.price_usage_enabled)
     and sp.valid_from <= current_date
     and (sp.valid_to is null or sp.valid_to >= current_date)
    join public.suppliers supplier on supplier.id = sp.supplier_id
  )
  select supplier_name, moq, order_multiple
  from ranked
  where supplier_rank = 1
  order by supplier_name;
$function$
;

-- Current commercial reader: cloud_quote_supplier_options
CREATE OR REPLACE FUNCTION public.cloud_quote_supplier_options(input_code text, input_customer_type text DEFAULT 'A'::text, input_margin_a numeric DEFAULT 0.10, input_margin_b numeric DEFAULT 0.15)
 RETURNS TABLE(supplier_id uuid, supplier_name text, buy_price numeric, price_date date, sell_price numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with product_match as (
    select cp.brand_id, cp.normalized_code
    from public.catalog_products cp
    where cp.organization_id = public.current_profile_org_id()
      and cp.normalized_code = public.normalize_part_code(input_code)
    order by cp.product_code limit 1
  )
  select sp.supplier_id, supplier.name, sp.buy_price, sp.valid_from,
    case when upper(coalesce(input_customer_type, 'A')) = 'B'
      then round(coalesce(sp.buy_price, 0) * (1 + coalesce(input_margin_b, 0)), 2)
      else round(coalesce(sp.buy_price, 0) * (1 + coalesce(input_margin_a, 0)), 2) end
  from product_match pm
  join public.supplier_prices sp on sp.organization_id = public.current_profile_org_id()
    and sp.brand_id = pm.brand_id and sp.normalized_code = pm.normalized_code
    and sp.is_active and exists(select 1 from public.suppliers usage_supplier where usage_supplier.organization_id=sp.organization_id and usage_supplier.id=sp.supplier_id and usage_supplier.price_usage_enabled) and sp.buy_price is not null
    and sp.valid_from <= current_date
    and (sp.valid_to is null or sp.valid_to >= current_date)
  join public.suppliers supplier on supplier.id = sp.supplier_id
  order by sp.buy_price asc, sp.valid_from desc, sp.updated_at desc limit 25;
$function$
;

-- Current commercial reader: cloud_quote_supplier_options
CREATE OR REPLACE FUNCTION public.cloud_quote_supplier_options(input_code text, input_brand text DEFAULT ''::text, input_customer_type text DEFAULT 'A'::text, input_margin_a numeric DEFAULT 0.10, input_margin_b numeric DEFAULT 0.15)
 RETURNS TABLE(supplier_id uuid, supplier_name text, buy_price numeric, price_date date, sell_price numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with requested_brand as (
    select b.id from public.brands b
    where b.organization_id = public.current_profile_org_id()
      and b.normalized_name = public.normalize_part_code(input_brand) limit 1
  ),
  catalog_exact as (
    select cp.brand_id, cp.normalized_code
    from public.catalog_products cp
    where cp.organization_id = public.current_profile_org_id()
      and (cp.normalized_code = public.normalize_part_code(input_code)
        or cp.normalized_oem = public.normalize_part_code(input_code))
      and (coalesce(input_brand, '') = '' or cp.brand_id in (select id from requested_brand))
    order by case when cp.brand_id in (select id from requested_brand) then 0 else 1 end,
      case when cp.normalized_code = public.normalize_part_code(input_code) then 0 else 1 end,
      case when cp.normalized_oem = public.normalize_part_code(input_code) then 0 else 1 end, cp.product_code
    limit 1
  ),
  supplier_exact as (
    select sp.brand_id, sp.normalized_code
    from public.supplier_prices sp
    where sp.organization_id = public.current_profile_org_id()
      and sp.is_active and exists(select 1 from public.suppliers usage_supplier where usage_supplier.organization_id=sp.organization_id and usage_supplier.id=sp.supplier_id and usage_supplier.price_usage_enabled) and sp.buy_price is not null
      and sp.valid_from <= current_date
      and (sp.valid_to is null or sp.valid_to >= current_date)
      and sp.normalized_code = public.normalize_part_code(input_code)
      and (coalesce(input_brand, '') = '' or sp.brand_id in (select id from requested_brand))
      and not exists (select 1 from catalog_exact)
    order by case when sp.brand_id in (select id from requested_brand) then 0 else 1 end,
      sp.buy_price asc, sp.valid_from desc, sp.updated_at desc limit 1
  ),
  catalog_fuzzy as (
    select cp.brand_id, cp.normalized_code
    from public.catalog_products cp
    where cp.organization_id = public.current_profile_org_id()
      and not exists (select 1 from catalog_exact)
      and not exists (select 1 from supplier_exact)
      and (
        cp.normalized_code like '%' || public.normalize_part_code(input_code) || '%'
        or public.normalize_part_code(input_code) like '%' || cp.normalized_code || '%'
        or (nullif(cp.normalized_oem, '') is not null and cp.normalized_oem like '%' || public.normalize_part_code(input_code) || '%')
        or (nullif(cp.normalized_oem, '') is not null and public.normalize_part_code(input_code) like '%' || cp.normalized_oem || '%')
      )
      and (coalesce(input_brand, '') = '' or cp.brand_id in (select id from requested_brand))
    order by case when cp.brand_id in (select id from requested_brand) then 0 else 1 end, cp.product_code limit 1
  ),
  product_match as (
    select * from catalog_exact
    union all select * from supplier_exact
    union all select * from catalog_fuzzy limit 1
  )
  select sp.supplier_id, supplier.name, sp.buy_price, sp.valid_from,
    case when upper(coalesce(input_customer_type, 'A')) = 'B'
      then round(coalesce(sp.buy_price, 0) * (1 + coalesce(input_margin_b, 0)), 2)
      else round(coalesce(sp.buy_price, 0) * (1 + coalesce(input_margin_a, 0)), 2) end
  from product_match pm
  join public.supplier_prices sp on sp.organization_id = public.current_profile_org_id()
    and sp.brand_id = pm.brand_id and sp.normalized_code = pm.normalized_code
    and sp.is_active and exists(select 1 from public.suppliers usage_supplier where usage_supplier.organization_id=sp.organization_id and usage_supplier.id=sp.supplier_id and usage_supplier.price_usage_enabled) and sp.buy_price is not null
    and sp.valid_from <= current_date
    and (sp.valid_to is null or sp.valid_to >= current_date)
  join public.suppliers supplier on supplier.id = sp.supplier_id
  order by sp.buy_price asc, sp.valid_from desc, sp.updated_at desc limit 25;
$function$
;

-- Current commercial reader: cloud_resolve_quote_line
CREATE OR REPLACE FUNCTION public.cloud_resolve_quote_line(input_code text, input_customer_type text DEFAULT 'A'::text, input_margin_a numeric DEFAULT 0.10, input_margin_b numeric DEFAULT 0.15)
 RETURNS TABLE(found boolean, product_id uuid, product_code text, brand text, description text, oem_no text, hs_code text, origin text, weight_kg numeric, supplier_id uuid, supplier_name text, buy_price numeric, price_date date, sell_price numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with product_match as (
    select cp.id, cp.product_code, cp.normalized_code, cp.description, cp.oem_no,
      cp.hs_code, cp.origin, cp.weight_kg, cp.brand_id, b.name as brand
    from public.catalog_products cp join public.brands b on b.id = cp.brand_id
    where cp.organization_id = public.current_profile_org_id()
      and cp.normalized_code = public.normalize_part_code(input_code)
    order by b.name, cp.product_code limit 1
  )
  select product_match.id is not null, product_match.id,
    coalesce(product_match.product_code, input_code), product_match.brand, product_match.description,
    product_match.oem_no, product_match.hs_code, product_match.origin, product_match.weight_kg,
    best.supplier_id, supplier.name, best.buy_price, best.valid_from,
    case when upper(coalesce(input_customer_type, 'A')) = 'B'
      then round(coalesce(best.buy_price, 0) * (1 + coalesce(input_margin_b, 0)), 2)
      else round(coalesce(best.buy_price, 0) * (1 + coalesce(input_margin_a, 0)), 2) end
  from product_match
  left join lateral (
    select sp.supplier_id, sp.buy_price, sp.valid_from
    from public.supplier_prices sp
    where sp.organization_id = public.current_profile_org_id()
      and sp.is_active and exists(select 1 from public.suppliers usage_supplier where usage_supplier.organization_id=sp.organization_id and usage_supplier.id=sp.supplier_id and usage_supplier.price_usage_enabled) and sp.brand_id = product_match.brand_id
      and sp.normalized_code = product_match.normalized_code and sp.buy_price is not null
      and sp.valid_from <= current_date
      and (sp.valid_to is null or sp.valid_to >= current_date)
    order by sp.buy_price asc, sp.valid_from desc, sp.updated_at desc limit 1
  ) best on true
  left join public.suppliers supplier on supplier.id = best.supplier_id
  union all
  select false, null::uuid, input_code, null::text, null::text, null::text, null::text,
    null::text, null::numeric, null::uuid, null::text, null::numeric, null::date, null::numeric
  where not exists (select 1 from product_match);
$function$
;

-- Current commercial reader: refresh_supplier_price_rollups_core
CREATE OR REPLACE FUNCTION public.refresh_supplier_price_rollups_core(input_organization_id uuid DEFAULT NULL::uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '180s'
AS $function$
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
      and sp.is_active and exists(select 1 from public.suppliers usage_supplier where usage_supplier.organization_id=sp.organization_id and usage_supplier.id=sp.supplier_id and usage_supplier.price_usage_enabled)
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
$function$
;

-- Current commercial reader: cloud_price_list_source_page
CREATE OR REPLACE FUNCTION public.cloud_price_list_source_page(input_organization_id uuid, input_brand_id uuid, input_after_normalized_code text DEFAULT NULL::text, input_page_size integer DEFAULT 1000)
 RETURNS TABLE(normalized_code text, product_code text, description text, buy_price numeric, price_date date, total_count bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  with params as materialized (
    select input_organization_id org_id,input_brand_id brand_id,
      nullif(btrim(input_after_normalized_code),'') after_code,
      least(greatest(coalesce(input_page_size,1000),1),5000) page_size
  ), pointers as materialized (
    select ptr.* from public.supplier_current_price_pointers ptr cross join params p
    where ptr.organization_id=p.org_id and ptr.brand_id=p.brand_id
  ), releases as materialized (
    select ptr.release_id,ptr.supplier_id from pointers ptr
    join public.supplier_price_publications pub on pub.id=ptr.publication_id
      and pub.release_id=ptr.release_id and pub.organization_id=ptr.organization_id
      and pub.supplier_id=ptr.supplier_id and pub.brand_id=ptr.brand_id and pub.status='published' and public.supplier_price_usage_enabled(pub.organization_id,pub.supplier_id)
  ), legacy as not materialized (
    select public.normalize_catalog_product_code(sp.product_code) collate "C" code,
      sp.supplier_id,sp.product_code,sp.description,sp.buy_price,sp.valid_from,sp.id::text source_id
    from public.supplier_prices sp cross join params p
    where sp.organization_id=p.org_id and sp.brand_id=p.brand_id and sp.is_active and exists(select 1 from public.suppliers usage_supplier where usage_supplier.organization_id=sp.organization_id and usage_supplier.id=sp.supplier_id and usage_supplier.price_usage_enabled)
      and sp.buy_price>0 and sp.currency='EUR' and sp.valid_from<=current_date
      and (sp.valid_to is null or sp.valid_to>=current_date)
      and public.normalize_catalog_product_code(sp.product_code) ~ '[A-Z0-9]'
      and not exists(select 1 from pointers ptr where ptr.supplier_id=sp.supplier_id)
  ), release_pages as materialized (
    select rel.supplier_id,candidate.* from releases rel cross join params p
    cross join lateral (
      select distinct on (r.normalized_code collate "C") r.normalized_code collate "C" code,
        r.product_code,r.description,r.buy_price,r.valid_from,r.id::text source_id,r.id published_order_id
      from public.supplier_price_release_rows r
      where r.release_id=rel.release_id and r.row_status='accepted'
        and r.normalized_code=upper(regexp_replace(r.product_code, '[[:space:]]+', '', 'g'))
        and r.normalized_code<>''
        and r.normalized_code ~ '[A-Z0-9]' and r.buy_price>0 and r.currency='EUR'
        and r.valid_from<=current_date and (r.valid_to is null or r.valid_to>=current_date)
        and r.normalized_code collate "C">coalesce(p.after_code,'') collate "C"
      order by r.normalized_code collate "C",r.buy_price,r.id
      limit p.page_size
    ) candidate
  ), legacy_latest as materialized (
    select distinct on (l.code,l.supplier_id) l.* from legacy l cross join params p
    where l.code>coalesce(p.after_code,'') collate "C"
    order by l.code,l.supplier_id,l.valid_from desc,l.source_id desc
  ), legacy_page as materialized (
    select distinct on (l.code) l.* from legacy_latest l
    order by l.code,l.buy_price,l.valid_from desc,l.supplier_id
    limit (select page_size from params)
  ), candidates as (
    select r.code,r.supplier_id,r.product_code,r.description,r.buy_price,r.valid_from,r.source_id,r.published_order_id from release_pages r
    union all
    select l.code,l.supplier_id,l.product_code,l.description,l.buy_price,l.valid_from,l.source_id,null from legacy_page l
  ), page as materialized (
    select distinct on (c.code) c.* from candidates c
    -- Preserve existing published equal-price selection by the native row ID.
    -- Legacy-only candidates retain newest-date/supplier deterministic ties.
    order by c.code,c.buy_price,c.published_order_id asc nulls last,c.valid_from desc,c.supplier_id
    limit (select page_size from params)
  ), first_total as materialized (
    select count(distinct codes.code)::bigint n from (
      select r.normalized_code collate "C" code from releases rel cross join params p
      join public.supplier_price_release_rows r on r.release_id=rel.release_id
      where p.after_code is null and r.row_status='accepted'
        and r.normalized_code=upper(regexp_replace(r.product_code, '[[:space:]]+', '', 'g'))
        and r.normalized_code<>''
        and r.normalized_code ~ '[A-Z0-9]' and r.buy_price>0 and r.currency='EUR'
        and r.valid_from<=current_date and (r.valid_to is null or r.valid_to>=current_date)
      union all
      select l.code from legacy l cross join params p where p.after_code is null
    ) codes
  )
  select page.code,page.product_code,page.description,page.buy_price,page.valid_from,
    case when p.after_code is null then t.n else null end
  from page cross join params p cross join first_total t
  order by page.code;
$function$
;

-- Current commercial reader: cloud_catalog_master_export_page_v3
CREATE OR REPLACE FUNCTION public.cloud_catalog_master_export_page_v3(input_organization_id uuid, input_brand_id uuid, input_scope text DEFAULT 'priced'::text, input_search text DEFAULT ''::text, input_after_code text DEFAULT NULL::text, input_after_id uuid DEFAULT NULL::uuid, input_page_size integer DEFAULT 1000, input_margin_a numeric DEFAULT 0.10, input_margin_b numeric DEFAULT 0.15)
 RETURNS TABLE(total_count bigint, product_id uuid, product_code text, brand text, description text, oem_no text, hs_code text, origin text, weight_kg numeric, cheapest_supplier text, cheapest_price numeric, second_supplier_name text, second_price numeric, price_gap numeric, price_gap_percent numeric, price_date date, sales_a numeric, sales_b numeric, sales_c numeric, supplier_count bigint, catalog_status text, notes text, has_notes boolean, cursor_code text, cursor_id uuid)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  with params as materialized (
    select input_organization_id org_id,input_brand_id brand_id,
      case when lower(coalesce(input_scope,''))='catalog' then 'catalog' else 'priced' end scope,
      nullif(btrim(input_search),'') search,
      nullif(public.normalize_part_code(input_search),'') search_norm,
      input_after_code after_code,input_after_id after_id,
      least(greatest(coalesce(input_page_size,1000),1),5000) page_size
  ), pointers as materialized (
    select ptr.* from public.supplier_current_price_pointers ptr
    join params p on ptr.organization_id=p.org_id and ptr.brand_id=p.brand_id
  ), releases as materialized (
    select ptr.release_id,ptr.supplier_id from pointers ptr
    join public.supplier_price_publications pub on pub.id=ptr.publication_id
      and pub.release_id=ptr.release_id and pub.organization_id=ptr.organization_id
      and pub.supplier_id=ptr.supplier_id and pub.brand_id=ptr.brand_id and pub.status='published' and public.supplier_price_usage_enabled(pub.organization_id,pub.supplier_id)
  ), legacy as not materialized (
    select sp.*,public.normalize_catalog_product_code(sp.product_code) collate "C" exact_code
    from public.supplier_prices sp cross join params p
    where sp.organization_id=p.org_id and sp.brand_id=p.brand_id and sp.is_active and exists(select 1 from public.suppliers usage_supplier where usage_supplier.organization_id=sp.organization_id and usage_supplier.id=sp.supplier_id and usage_supplier.price_usage_enabled)
      and sp.buy_price>0 and sp.currency='EUR' and sp.valid_from<=current_date
      and (sp.valid_to is null or sp.valid_to>=current_date)
      and public.normalize_catalog_product_code(sp.product_code) ~ '[A-Z0-9]'
      and not exists(select 1 from pointers ptr where ptr.supplier_id=sp.supplier_id)
  ), release_candidates as materialized (
    select candidate.normalized_code from releases rel cross join params p
    cross join lateral (
      select distinct r.normalized_code collate "C" as normalized_code from public.supplier_price_release_rows r
      where p.scope='priced' and r.release_id=rel.release_id
        and r.row_status='accepted' and r.normalized_code=public.normalize_catalog_product_code(r.product_code) and r.buy_price>0 and r.currency='EUR' and r.valid_from<=current_date and (r.valid_to is null or r.valid_to>=current_date)
        and r.normalized_code ~ '[A-Z0-9]'
        and r.normalized_code collate "C">coalesce(p.after_code,'') collate "C"
        and (p.search is null or r.product_code ilike '%'||p.search||'%'
          or r.description ilike '%'||p.search||'%' or r.oem_no ilike '%'||p.search||'%'
          or (p.search_norm is not null and (r.normalized_code like p.search_norm||'%'
            or public.normalize_part_code(r.oem_no) like p.search_norm||'%')))
      order by r.normalized_code collate "C" limit p.page_size
    ) candidate
  ), legacy_codes as materialized (
    select distinct l.exact_code normalized_code from legacy l cross join params p
    where p.scope='priced' and l.exact_code>coalesce(p.after_code,'') collate "C"
      and (p.search is null or l.product_code ilike '%'||p.search||'%'
        or l.description ilike '%'||p.search||'%' or l.oem_no ilike '%'||p.search||'%'
        or (p.search_norm is not null and (l.exact_code like p.search_norm||'%'
          or public.normalize_part_code(l.oem_no) like p.search_norm||'%')))
    order by normalized_code limit (select page_size from params)
  ), price_codes as materialized (
    select code.normalized_code from (
      select rc.normalized_code from release_candidates rc
      union select lc.normalized_code from legacy_codes lc
    ) code order by code.normalized_code collate "C" limit (select page_size from params)
  ), catalog_page as materialized (
    -- Separate guarded branches retain a tuple index seek in generic plans.
    -- An OR around the cursor otherwise scans the preceding catalog pages.
    select candidate.* from params p cross join lateral (
      (select cp.* from public.catalog_products cp
       where p.scope='catalog' and p.after_code is null
         and cp.organization_id=p.org_id and cp.brand_id=p.brand_id
      and (p.search is null or cp.product_code ilike '%'||p.search||'%'
        or cp.description ilike '%'||p.search||'%' or cp.oem_no ilike '%'||p.search||'%'
        or (p.search_norm is not null and (cp.normalized_code like p.search_norm||'%'
          or cp.normalized_oem like p.search_norm||'%')))
       order by cp.product_code collate "C",cp.id limit p.page_size)
      union all
      (select cp.* from public.catalog_products cp
       where p.scope='catalog' and p.after_code is not null
         and cp.organization_id=p.org_id and cp.brand_id=p.brand_id
         and (cp.product_code collate "C",cp.id)>(p.after_code collate "C",p.after_id)
      and (p.search is null or cp.product_code ilike '%'||p.search||'%'
        or cp.description ilike '%'||p.search||'%' or cp.oem_no ilike '%'||p.search||'%'
        or (p.search_norm is not null and (cp.normalized_code like p.search_norm||'%'
          or cp.normalized_oem like p.search_norm||'%')))
       order by cp.product_code collate "C",cp.id limit p.page_size)
    ) candidate
  ), page_codes as materialized (
    select rc.normalized_code from price_codes rc
    union
    select public.normalize_catalog_product_code(cp.product_code) from catalog_page cp
  ), published_best as materialized (
    select distinct on (r.normalized_code,rel.supplier_id)
      r.normalized_code,rel.supplier_id,r.product_code,r.description,r.oem_no,r.buy_price,r.valid_from,r.notes,r.id
    from page_codes pc cross join releases rel
    join public.supplier_price_release_rows r on r.release_id=rel.release_id and r.normalized_code=pc.normalized_code
    where r.row_status='accepted' and r.normalized_code=public.normalize_catalog_product_code(r.product_code) and r.buy_price>0 and r.currency='EUR' and r.valid_from<=current_date and (r.valid_to is null or r.valid_to>=current_date)
    order by r.normalized_code,rel.supplier_id,r.buy_price,r.id
  ), legacy_best as materialized (
    select distinct on (l.exact_code,l.supplier_id)
      l.exact_code normalized_code,l.supplier_id,l.product_code,l.description,l.oem_no,
      l.buy_price,l.valid_from,l.notes,l.id
    from page_codes pc join legacy l on l.exact_code=pc.normalized_code
    order by l.exact_code,l.supplier_id,l.valid_from desc,l.id::text desc
  ), supplier_best as materialized (
    select pb.normalized_code,pb.supplier_id,pb.product_code,pb.description,pb.oem_no,
      pb.buy_price,pb.valid_from,pb.notes,pb.id published_order_id from published_best pb
    union all
    select lb.normalized_code,lb.supplier_id,lb.product_code,lb.description,lb.oem_no,
      lb.buy_price,lb.valid_from,lb.notes,null from legacy_best lb
  ), ranked as materialized (
    select sb.*,row_number() over(partition by sb.normalized_code order by sb.buy_price,sb.published_order_id asc nulls last,sb.valid_from desc,sb.supplier_id) rank,
      s.name supplier_name
    from supplier_best sb cross join params p
    left join public.suppliers s on s.id=sb.supplier_id and s.organization_id=p.org_id
  ), price_summary as materialized (
    select r.normalized_code,
      max(r.product_code) filter(where r.rank=1) product_code,
      max(r.description) filter(where r.rank=1) description,
      max(r.oem_no) filter(where r.rank=1) oem_no,
      max(r.supplier_name) filter(where r.rank=1) cheapest_supplier,
      max(r.buy_price) filter(where r.rank=1) cheapest_price,
      max(r.supplier_name) filter(where r.rank=2) second_supplier_name,
      max(r.buy_price) filter(where r.rank=2) second_price,
      max(r.valid_from) filter(where r.rank=1) price_date,
      max(r.notes) filter(where r.rank=1) notes,count(*)::bigint supplier_count
    from ranked r group by r.normalized_code
  ), priced_rows as materialized (
    select ps.normalized_code,cp.id product_id,
      coalesce(nullif(cp.product_code,''),ps.product_code,ps.normalized_code) product_code,
      coalesce(nullif(cp.description,''),ps.description,'') description,
      coalesce(nullif(cp.oem_no,''),ps.oem_no,'') oem_no,
      cp.hs_code,cp.origin,cp.weight_kg,ps.cheapest_supplier,ps.cheapest_price,
      ps.second_supplier_name,ps.second_price,ps.price_date,ps.supplier_count,ps.notes
    from price_summary ps join params p on p.scope='priced'
    left join lateral (
      select c.* from public.catalog_products c where c.organization_id=p.org_id and c.brand_id=p.brand_id
        -- The catalog expression index uses the database default collation.
        -- Keep byte-ordered export cursors separate from this equality lookup.
        and public.normalize_catalog_product_code(c.product_code)=ps.normalized_code collate "default"
      order by c.product_code,c.id limit 1
    ) cp on true
  ), catalog_rows as materialized (
    select cp.id product_id,cp.product_code,coalesce(cp.description,'') description,coalesce(cp.oem_no,'') oem_no,
      cp.hs_code,cp.origin,cp.weight_kg,
      ps.cheapest_supplier,ps.cheapest_price,ps.second_supplier_name,ps.second_price,
      ps.price_date,coalesce(ps.supplier_count,0) supplier_count,ps.notes
    from catalog_page cp
    left join price_summary ps on ps.normalized_code=public.normalize_catalog_product_code(cp.product_code)
  ), source_total as materialized (
    select case when p.after_code is not null then null::bigint
      when p.scope='catalog' then (select count(*) from public.catalog_products cp
        where cp.organization_id=p.org_id and cp.brand_id=p.brand_id
          and (p.search is null or cp.product_code ilike '%'||p.search||'%' or cp.description ilike '%'||p.search||'%'
            or cp.oem_no ilike '%'||p.search||'%' or (p.search_norm is not null and
              (cp.normalized_code like p.search_norm||'%' or cp.normalized_oem like p.search_norm||'%'))))
      else (select count(distinct all_codes.normalized_code) from (
        select r.normalized_code collate "C" normalized_code
        from releases rel join public.supplier_price_release_rows r on r.release_id=rel.release_id
        where r.row_status='accepted' and r.normalized_code=public.normalize_catalog_product_code(r.product_code)
          and r.buy_price>0 and r.currency='EUR' and r.valid_from<=current_date and (r.valid_to is null or r.valid_to>=current_date)
          and r.normalized_code ~ '[A-Z0-9]'
          and (p.search is null or r.product_code ilike '%'||p.search||'%' or r.description ilike '%'||p.search||'%'
            or r.oem_no ilike '%'||p.search||'%' or (p.search_norm is not null and
              (r.normalized_code like p.search_norm||'%' or public.normalize_part_code(r.oem_no) like p.search_norm||'%')))
        union all
        select l.exact_code from legacy l
        where p.search is null or l.product_code ilike '%'||p.search||'%' or l.description ilike '%'||p.search||'%'
          or l.oem_no ilike '%'||p.search||'%' or (p.search_norm is not null and
            (l.exact_code like p.search_norm||'%' or public.normalize_part_code(l.oem_no) like p.search_norm||'%'))
      ) all_codes)
      end n from params p
  ), result as (
    select pr.product_id,pr.product_code,pr.description,pr.oem_no,pr.hs_code,pr.origin,pr.weight_kg,
      pr.cheapest_supplier,pr.cheapest_price,pr.second_supplier_name,pr.second_price,pr.price_date,pr.supplier_count,pr.notes,
      case when pr.product_id is null then 'Supplier Only' else 'In Catalog' end catalog_status,
      pr.normalized_code cursor_code,null::uuid cursor_id from priced_rows pr
    union all
    select cr.product_id,cr.product_code,cr.description,cr.oem_no,cr.hs_code,cr.origin,cr.weight_kg,
      cr.cheapest_supplier,cr.cheapest_price,cr.second_supplier_name,cr.second_price,cr.price_date,cr.supplier_count,cr.notes,
      'In Catalog',cr.product_code,cr.product_id from catalog_rows cr
  )
  select st.n,r.product_id,r.product_code,b.name,r.description,r.oem_no,r.hs_code,r.origin,r.weight_kg,
    coalesce(r.cheapest_supplier,''),r.cheapest_price,coalesce(r.second_supplier_name,''),r.second_price,
    r.second_price-r.cheapest_price,
    case when r.cheapest_price>0 then round((r.second_price-r.cheapest_price)*100/r.cheapest_price,2) else null end,
    r.price_date,round(r.cheapest_price*(1+coalesce(input_margin_a,0)),2),
    round(r.cheapest_price*(1+coalesce(input_margin_b,0)),2),null::numeric,
    r.supplier_count,r.catalog_status,r.notes,nullif(btrim(r.notes),'') is not null,r.cursor_code,r.cursor_id
  from result r cross join params p cross join source_total st
  join public.brands b on b.organization_id=p.org_id and b.id=p.brand_id
  order by r.cursor_code collate "C",r.cursor_id;
$function$
;

-- Current commercial reader: cloud_admin_price_list_brands
CREATE OR REPLACE FUNCTION public.cloud_admin_price_list_brands(input_organization_id uuid)
 RETURNS TABLE(id uuid, name text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select b.id,b.name from public.brands b
  where b.organization_id=input_organization_id and (
    exists(select 1 from public.supplier_current_price_pointers ptr
      join public.supplier_price_publications pub on pub.id=ptr.publication_id
        and pub.release_id=ptr.release_id and pub.organization_id=ptr.organization_id
        and pub.supplier_id=ptr.supplier_id and pub.brand_id=ptr.brand_id and pub.status='published' and public.supplier_price_usage_enabled(pub.organization_id,pub.supplier_id)
      join public.supplier_price_release_rows r on r.release_id=ptr.release_id
      where ptr.organization_id=b.organization_id and ptr.brand_id=b.id
        and r.row_status='accepted' and r.buy_price>0 and r.currency='EUR' and r.valid_from<=current_date and (r.valid_to is null or r.valid_to>=current_date)
        and r.normalized_code=public.normalize_catalog_product_code(r.product_code)
        and r.normalized_code ~ '[A-Z0-9]'
      offset 0)
    or exists(select 1 from public.supplier_prices sp
      where sp.organization_id=b.organization_id and sp.brand_id=b.id and sp.is_active and exists(select 1 from public.suppliers usage_supplier where usage_supplier.organization_id=sp.organization_id and usage_supplier.id=sp.supplier_id and usage_supplier.price_usage_enabled)
        and sp.buy_price>0 and sp.currency='EUR' and sp.valid_from<=current_date
        and (sp.valid_to is null or sp.valid_to>=current_date)
        and public.normalize_catalog_product_code(sp.product_code) ~ '[A-Z0-9]'
        and not exists(select 1 from public.supplier_current_price_pointers ptr
          where ptr.organization_id=sp.organization_id and ptr.supplier_id=sp.supplier_id and ptr.brand_id=sp.brand_id)
      offset 0)
  ) order by b.name,b.id;
$function$
;

-- Current commercial reader: cloud_master_page_fast
CREATE OR REPLACE FUNCTION public.cloud_master_page_fast(input_search text DEFAULT ''::text, input_brand_id uuid DEFAULT NULL::uuid, input_page integer DEFAULT 1, input_page_size integer DEFAULT 50, input_margin_a numeric DEFAULT 0.10, input_margin_b numeric DEFAULT 0.15)
 RETURNS TABLE(total_count bigint, product_id uuid, product_code text, brand text, description text, oem_no text, hs_code text, origin text, weight_kg numeric, cheapest_supplier text, cheapest_price numeric, second_supplier_name text, second_price numeric, price_gap numeric, price_gap_percent numeric, price_date date, sales_a numeric, sales_b numeric, supplier_count bigint, catalog_status text, notes text, has_notes boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_org uuid;
  v_size integer:=least(greatest(coalesce(input_page_size,50),1),250);
  v_offset bigint:=(greatest(coalesce(input_page,1),1)::bigint-1)*least(greatest(coalesce(input_page_size,50),1),250);
begin
  if auth.uid() is null then raise exception 'MASTER_AUTH_REQUIRED'; end if;
  v_org:=public.current_profile_org_id();
  if v_org is null then raise exception 'MASTER_ACCESS_DENIED'; end if;
  if not exists(select 1 from public.brands b where b.id=input_brand_id and b.organization_id=v_org) then
    raise exception 'MASTER_BRAND_SCOPE_INVALID';
  end if;
  return query
  with params as materialized (
    select v_org org_id,input_brand_id brand_id,nullif(btrim(input_search),'') search,
      nullif(public.normalize_part_code(input_search),'') search_norm
  ), catalog_page as materialized (
    -- Keep ordering and pagination inside the tenant-scoped catalog lookup.
    -- A generic plan must not sort the whole catalog before the 50-row page.
    select candidate.* from params p cross join lateral (
      select cp.* from public.catalog_products cp
      where cp.organization_id=p.org_id and cp.brand_id=p.brand_id
        and (p.search is null or cp.product_code ilike '%'||p.search||'%'
          or cp.description ilike '%'||p.search||'%' or cp.oem_no ilike '%'||p.search||'%'
          or (p.search_norm is not null and (cp.normalized_code like p.search_norm||'%'
            or cp.normalized_oem like p.search_norm||'%')))
      order by cp.product_code collate "C",cp.id limit v_size offset v_offset
    ) candidate
  ), pointers as materialized (
    select ptr.* from public.supplier_current_price_pointers ptr
    join params p on ptr.organization_id=p.org_id and ptr.brand_id=p.brand_id
  ), releases as materialized (
    select ptr.release_id,ptr.supplier_id from pointers ptr
    join public.supplier_price_publications pub on pub.id=ptr.publication_id
      and pub.release_id=ptr.release_id and pub.organization_id=ptr.organization_id
      and pub.supplier_id=ptr.supplier_id and pub.brand_id=ptr.brand_id and pub.status='published' and public.supplier_price_usage_enabled(pub.organization_id,pub.supplier_id)
  ), legacy as not materialized (
    select sp.*,public.normalize_catalog_product_code(sp.product_code) collate "C" exact_code
    from public.supplier_prices sp cross join params p
    where sp.organization_id=p.org_id and sp.brand_id=p.brand_id and sp.is_active and exists(select 1 from public.suppliers usage_supplier where usage_supplier.organization_id=sp.organization_id and usage_supplier.id=sp.supplier_id and usage_supplier.price_usage_enabled)
      and sp.buy_price>0 and sp.currency='EUR' and sp.valid_from<=current_date
      and (sp.valid_to is null or sp.valid_to>=current_date)
      and public.normalize_catalog_product_code(sp.product_code) ~ '[A-Z0-9]'
      and not exists(select 1 from pointers ptr where ptr.supplier_id=sp.supplier_id)
  ), page_codes as materialized (
    select distinct public.normalize_catalog_product_code(cp.product_code) normalized_code from catalog_page cp
  ), published_best as materialized (
    select distinct on (r.normalized_code,rel.supplier_id)
      r.normalized_code,rel.supplier_id,r.product_code,r.description,r.oem_no,r.buy_price,r.valid_from,r.notes,r.id
    from page_codes pc cross join releases rel
    join public.supplier_price_release_rows r on r.release_id=rel.release_id and r.normalized_code=pc.normalized_code
    where r.row_status='accepted' and r.normalized_code=public.normalize_catalog_product_code(r.product_code) and r.buy_price>0 and r.currency='EUR' and r.valid_from<=current_date and (r.valid_to is null or r.valid_to>=current_date)
    order by r.normalized_code,rel.supplier_id,r.buy_price,r.id
  ), legacy_best as materialized (
    select distinct on (l.exact_code,l.supplier_id)
      l.exact_code normalized_code,l.supplier_id,l.product_code,l.description,l.oem_no,
      l.buy_price,l.valid_from,l.notes,l.id
    from page_codes pc join legacy l on l.exact_code=pc.normalized_code
    order by l.exact_code,l.supplier_id,l.valid_from desc,l.id::text desc
  ), supplier_best as materialized (
    select pb.normalized_code,pb.supplier_id,pb.product_code,pb.description,pb.oem_no,
      pb.buy_price,pb.valid_from,pb.notes,pb.id published_order_id from published_best pb
    union all
    select lb.normalized_code,lb.supplier_id,lb.product_code,lb.description,lb.oem_no,
      lb.buy_price,lb.valid_from,lb.notes,null from legacy_best lb
  ), ranked as materialized (
    select sb.*,row_number() over(partition by sb.normalized_code order by sb.buy_price,sb.published_order_id asc nulls last,sb.valid_from desc,sb.supplier_id) rank,
      s.name supplier_name
    from supplier_best sb cross join params p
    left join public.suppliers s on s.id=sb.supplier_id and s.organization_id=p.org_id
  ), price_summary as materialized (
    select r.normalized_code,
      max(r.product_code) filter(where r.rank=1) product_code,
      max(r.description) filter(where r.rank=1) description,
      max(r.oem_no) filter(where r.rank=1) oem_no,
      max(r.supplier_name) filter(where r.rank=1) cheapest_supplier,
      max(r.buy_price) filter(where r.rank=1) cheapest_price,
      max(r.supplier_name) filter(where r.rank=2) second_supplier_name,
      max(r.buy_price) filter(where r.rank=2) second_price,
      max(r.valid_from) filter(where r.rank=1) price_date,
      max(r.notes) filter(where r.rank=1) notes,count(*)::bigint supplier_count
    from ranked r group by r.normalized_code
  )
  select null::bigint,cp.id,cp.product_code,b.name,coalesce(cp.description,''),coalesce(cp.oem_no,''),
    cp.hs_code,cp.origin,cp.weight_kg,coalesce(ps.cheapest_supplier,''),ps.cheapest_price,
    coalesce(ps.second_supplier_name,''),ps.second_price,ps.second_price-ps.cheapest_price,
    case when ps.cheapest_price>0 then round((ps.second_price-ps.cheapest_price)*100/ps.cheapest_price,2) else null end,
    ps.price_date,round(ps.cheapest_price*(1+coalesce(input_margin_a,0)),2),
    round(ps.cheapest_price*(1+coalesce(input_margin_b,0)),2),coalesce(ps.supplier_count,0),
    'In Catalog'::text,ps.notes,nullif(btrim(ps.notes),'') is not null
  from catalog_page cp cross join params p join public.brands b on b.id=p.brand_id and b.organization_id=p.org_id
  left join price_summary ps on ps.normalized_code=public.normalize_catalog_product_code(cp.product_code)
  order by cp.product_code collate "C",cp.id;
end;
$function$
;

-- Current commercial reader: cloud_current_supplier_commercial_options_core
CREATE OR REPLACE FUNCTION public.cloud_current_supplier_commercial_options_core(input_organization_id uuid, input_code text, input_brand text)
 RETURNS TABLE(supplier_id uuid, supplier_name text, brand_id uuid, brand text, product_code text, description text, buy_price numeric, price_date date, notes text, moq integer, order_multiple integer, stock_qty integer, valid_to date)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  with request as materialized (
    select input_organization_id as organization_id,
      upper(pg_catalog.regexp_replace(pg_catalog.btrim(coalesce(input_code,'')), '[[:space:]]+', '', 'g')) as exact_code,
      public.normalize_part_code(input_code) as loose_code,
      supplier_price_validation_internal.canonical_automotive_brand_key(input_brand,input_code) as brand_code
  ),
  requested_brand as materialized (
    select b.id, b.name, r.organization_id, r.exact_code, r.loose_code
    from request r
    join public.brands b on b.organization_id=r.organization_id
      and b.normalized_name=r.brand_code
    where r.exact_code<>'' and r.loose_code<>'' and r.brand_code<>''
  ),
  pointer_scope as materialized (
    select ptr.supplier_id, ptr.release_id, ptr.publication_id
    from requested_brand b
    join public.supplier_current_price_pointers ptr
      on ptr.organization_id=b.organization_id and ptr.brand_id=b.id
  ),
  current_publications as materialized (
    select ptr.supplier_id, ptr.release_id
    from requested_brand b
    join pointer_scope ptr on true
    join public.supplier_price_publications pub
      on pub.id=ptr.publication_id and pub.release_id=ptr.release_id
      and pub.organization_id=b.organization_id
      and pub.supplier_id=ptr.supplier_id and pub.brand_id=b.id
      and pub.status='published' and public.supplier_price_usage_enabled(pub.organization_id,pub.supplier_id)
  ),
  exact_rows as materialized (
    select ptr.supplier_id, s.name as supplier_name, b.id as brand_id,
      b.name as brand, r.product_code, r.description, r.buy_price,
      r.valid_from as price_date, r.notes, r.moq, r.order_multiple, r.stock_qty, r.valid_to, r.id::text as source_id
    from requested_brand b
    join current_publications ptr on true
    join public.supplier_price_release_rows r on r.release_id=ptr.release_id
      and r.normalized_code=b.exact_code
    join public.suppliers s on s.id=ptr.supplier_id and s.organization_id=b.organization_id
    where r.row_status='accepted' and r.buy_price>0 and r.currency='EUR'
      and r.valid_from<=current_date and (r.valid_to is null or r.valid_to>=current_date)
      and r.normalized_code=upper(pg_catalog.regexp_replace(r.product_code,'[[:space:]]+','','g'))
    union all
    select sp.supplier_id, s.name, b.id, b.name, sp.product_code,
      sp.description, sp.buy_price, sp.valid_from, sp.notes, sp.moq, sp.order_multiple, sp.stock_qty, sp.valid_to, sp.id::text
    from requested_brand b
    join public.supplier_prices sp on sp.organization_id=b.organization_id
      and sp.brand_id=b.id and sp.normalized_code=b.loose_code
      and sp.is_active and exists(select 1 from public.suppliers usage_supplier where usage_supplier.organization_id=sp.organization_id and usage_supplier.id=sp.supplier_id and usage_supplier.price_usage_enabled) and sp.buy_price>0 and sp.currency='EUR'
      and sp.valid_from<=current_date
      and (sp.valid_to is null or sp.valid_to>=current_date)
    join public.suppliers s on s.id=sp.supplier_id and s.organization_id=b.organization_id
    where upper(pg_catalog.btrim(sp.product_code))=upper(pg_catalog.btrim(input_code))
      and not exists (select 1 from pointer_scope ptr where ptr.supplier_id=sp.supplier_id)
  ),
  legacy_loose_rows as materialized (
    select sp.supplier_id, s.name as supplier_name, b.id as brand_id,
      b.name as brand, sp.product_code, sp.description, sp.buy_price,
      sp.valid_from as price_date, sp.notes, sp.moq, sp.order_multiple, sp.stock_qty, sp.valid_to, sp.id::text as source_id
    from requested_brand b
    join public.supplier_prices sp on sp.organization_id=b.organization_id
      and sp.brand_id=b.id and sp.normalized_code=b.loose_code
      and sp.is_active and exists(select 1 from public.suppliers usage_supplier where usage_supplier.organization_id=sp.organization_id and usage_supplier.id=sp.supplier_id and usage_supplier.price_usage_enabled) and sp.buy_price>0 and sp.currency='EUR'
      and sp.valid_from<=current_date
      and (sp.valid_to is null or sp.valid_to>=current_date)
    join public.suppliers s on s.id=sp.supplier_id and s.organization_id=b.organization_id
    where b.loose_code<>'' and not exists (select 1 from exact_rows)
      and not exists (select 1 from pointer_scope ptr where ptr.supplier_id=sp.supplier_id)
      and upper(pg_catalog.regexp_replace(pg_catalog.btrim(sp.product_code),'[[:space:]]+','','g'))=b.exact_code
  ),
  unambiguous as materialized (
    select count(distinct upper(pg_catalog.regexp_replace(pg_catalog.btrim(product_code),'[[:space:]]+','','g')))=1 as safe
    from legacy_loose_rows
  ),
  candidates as (
    select * from exact_rows
    union all
    select lr.* from legacy_loose_rows lr
    cross join unambiguous u
    where u.safe
  ),
  latest_per_supplier as (
    select c.*, row_number() over (
      partition by c.supplier_id, upper(pg_catalog.regexp_replace(pg_catalog.btrim(c.product_code),'[[:space:]]+','','g'))
      order by c.price_date desc, c.source_id desc
    ) as supplier_rank
    from candidates c
  )
  select c.supplier_id,c.supplier_name,c.brand_id,c.brand,c.product_code,
    c.description,c.buy_price,c.price_date,c.notes,c.moq,c.order_multiple,c.stock_qty,c.valid_to
  from latest_per_supplier c
  where c.supplier_rank=1
  order by c.buy_price asc,c.price_date desc,c.supplier_id
  limit 25;
$function$
;

-- Current commercial reader: cloud_portal_published_price_search_page_v3
CREATE OR REPLACE FUNCTION public.cloud_portal_published_price_search_page_v3(input_organization_id uuid, input_brand_id uuid, input_code_prefix text, input_limit integer)
 RETURNS TABLE(product_code text, normalized_code text, description text, buy_price numeric, price_date date)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_prefix text;
  v_limit integer;
begin
  v_prefix := pg_catalog.upper(pg_catalog.regexp_replace(
    pg_catalog.btrim(coalesce(input_code_prefix, '')),
    '[[:space:]]+', '', 'g'
  ));
  v_limit := least(greatest(coalesce(input_limit, 24), 1), 24);
  if input_organization_id is null or input_brand_id is null
    or pg_catalog.length(v_prefix) > 64
    or (v_prefix <> '' and v_prefix !~ '^[A-Z0-9][A-Z0-9._/+-]*$') then
    raise exception 'PORTAL_PUBLISHED_SEARCH_INPUT_INVALID';
  end if;

  return query
  with current_releases as materialized (
    select ptr.release_id
    from public.supplier_current_price_pointers ptr
    join public.supplier_price_publications pub
      on pub.id = ptr.publication_id
      and pub.release_id = ptr.release_id
      and pub.organization_id = ptr.organization_id
      and pub.supplier_id = ptr.supplier_id
      and pub.brand_id = ptr.brand_id
      and pub.status='published' and public.supplier_price_usage_enabled(pub.organization_id,pub.supplier_id)
    where ptr.organization_id = input_organization_id
      and ptr.brand_id = input_brand_id
      and not exists (
        select 1 from public.catalog_products cp
        where cp.organization_id = input_organization_id
          and cp.brand_id = input_brand_id
      )
  ),
  candidates as materialized (
    select r.normalized_code, r.product_code, r.description,
      r.buy_price, r.valid_from, r.id
    from current_releases cr
    cross join lateral (
      select r.normalized_code, r.product_code, r.description,
        r.buy_price, r.valid_from, r.id
      from public.supplier_price_release_rows r
      where r.release_id = cr.release_id
        and (v_prefix = '' or (
          r.normalized_code collate "C" >= v_prefix collate "C"
          and r.normalized_code collate "C" < (v_prefix || pg_catalog.chr(127)) collate "C"
          and pg_catalog.left(r.normalized_code, pg_catalog.length(v_prefix)) = v_prefix
        ))
        and r.row_status = 'accepted'
        and r.buy_price > 0
        and r.currency = 'EUR'
        and r.valid_from <= current_date and (r.valid_to is null or r.valid_to>=current_date)
        and r.normalized_code ~ '[A-Z0-9]'
        and r.normalized_code = pg_catalog.upper(pg_catalog.regexp_replace(
          r.product_code, '[[:space:]]+', '', 'g'
        ))
      order by r.normalized_code collate "C", r.id
      limit 96
    ) r
  ),
  winners as (
    select distinct on (c.normalized_code) c.normalized_code,
      c.product_code, c.description, c.buy_price, c.valid_from
    from candidates c
    order by c.normalized_code, c.buy_price, c.valid_from desc, c.id
  )
  select w.product_code, w.normalized_code, w.description,
    w.buy_price, w.valid_from
  from winners w
  order by w.normalized_code
  limit v_limit;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.supplier_price_current_snapshot(input_organization_id uuid, input_supplier_id uuid, input_brand_id uuid, input_codes text[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_pointer public.supplier_current_price_pointers%rowtype;
  v_publication public.supplier_price_publications%rowtype;
  v_release public.supplier_price_releases%rowtype;
  v_prices jsonb;
  v_code_count integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'SUPPLIER_PRICE_SNAPSHOT_SERVICE_REQUIRED';
  end if;

  if input_organization_id is null or input_supplier_id is null or input_brand_id is null then
    raise exception 'SUPPLIER_PRICE_SNAPSHOT_SCOPE_REQUIRED';
  end if;

  if input_codes is null or coalesce(array_length(input_codes, 1), 0) < 1
     or array_length(input_codes, 1) > 20 then
    raise exception 'SUPPLIER_PRICE_SNAPSHOT_CODES_INVALID';
  end if;

  select count(distinct code)::integer
    into v_code_count
    from unnest(input_codes) as codes(code)
   where code is not null and btrim(code) <> '' and btrim(code) = code and length(code) <= 128;
  if v_code_count <> array_length(input_codes, 1) then
    raise exception 'SUPPLIER_PRICE_SNAPSHOT_CODES_INVALID';
  end if;

  if not public.supplier_price_usage_enabled(input_organization_id,input_supplier_id) then
    return jsonb_build_object('status','current','organization_id',input_organization_id,'supplier_id',input_supplier_id,'brand_id',input_brand_id,'release_id',null,'publication_id',null,'version',null,'prices','[]'::jsonb);
  end if;

  select ptr.*
    into v_pointer
    from public.supplier_current_price_pointers ptr
   where ptr.organization_id = input_organization_id
     and ptr.supplier_id = input_supplier_id
     and ptr.brand_id = input_brand_id;

  if not found then
    return jsonb_build_object(
      'status', 'unpublished',
      'organization_id', input_organization_id,
      'supplier_id', input_supplier_id,
      'brand_id', input_brand_id,
      'release_id', null,
      'publication_id', null,
      'version', null,
      'prices', '[]'::jsonb
    );
  end if;

  select pub.*
    into v_publication
    from public.supplier_price_publications pub
   where pub.id = v_pointer.publication_id
     and pub.release_id = v_pointer.release_id
     and pub.organization_id = input_organization_id
     and pub.supplier_id = input_supplier_id
     and pub.brand_id = input_brand_id
     and pub.status = 'published';
  if not found then
    raise exception 'SUPPLIER_PRICE_SNAPSHOT_PUBLICATION_INVALID';
  end if;

  select rel.*
    into v_release
    from public.supplier_price_releases rel
   where rel.id = v_pointer.release_id
     and rel.organization_id = input_organization_id
     and rel.supplier_id = input_supplier_id
     and rel.brand_id = input_brand_id
     and rel.status = 'published';
  if not found then
    raise exception 'SUPPLIER_PRICE_SNAPSHOT_RELEASE_INVALID';
  end if;

  if exists (
    select 1
      from public.supplier_price_release_rows rr
     where rr.release_id = v_release.id
       and rr.row_status = 'accepted'
       and public.normalize_part_code(rr.normalized_code) = any(input_codes)
       and (rr.currency is null or btrim(rr.currency) = ''
            or coalesce(rr.valid_from, v_release.source_date) is null)
  ) then
    raise exception 'SUPPLIER_PRICE_SNAPSHOT_ROW_INVALID';
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'normalized_code', public.normalize_part_code(rr.normalized_code),
        'product_code', rr.product_code,
        'buy_price', rr.buy_price::text,
        'currency', upper(btrim(rr.currency)),
        'valid_from', to_char(coalesce(rr.valid_from, v_release.source_date), 'YYYY-MM-DD')
      ) order by public.normalize_part_code(rr.normalized_code)
    ),
    '[]'::jsonb
  )
    into v_prices
    from public.supplier_price_release_rows rr
   where rr.release_id = v_release.id
     and rr.row_status = 'accepted'
     and rr.buy_price is not null
     and coalesce(rr.valid_from,v_release.source_date)<=current_date
     and (rr.valid_to is null or rr.valid_to>=current_date)
     and public.normalize_part_code(rr.normalized_code) = any(input_codes);

  return jsonb_build_object(
    'status', 'current',
    'organization_id', input_organization_id,
    'supplier_id', input_supplier_id,
    'brand_id', input_brand_id,
    'release_id', v_release.id,
    'publication_id', v_publication.id,
    'version', v_publication.publication_version::text,
    'prices', v_prices
  );
end;
$function$
;

-- Include the source revision advanced by the eligibility switch in current export caches.
CREATE OR REPLACE FUNCTION public.get_admin_price_list_export_version(input_organization_id uuid, input_brand_id uuid)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
$function$
;
notify pgrst, 'reload schema';
