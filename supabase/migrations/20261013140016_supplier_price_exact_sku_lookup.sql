-- A current supplier price must belong to the requested commercial SKU.
-- The loose catalog key maps 61/1 and 611 to the same value, so it can only
-- narrow a legacy lookup; it must never authorize a different raw SKU.
create or replace function public.cloud_current_supplier_price_options_core(
  input_organization_id uuid,
  input_code text,
  input_brand text
)
returns table (
  supplier_id uuid,
  supplier_name text,
  brand_id uuid,
  brand text,
  product_code text,
  description text,
  buy_price numeric,
  price_date date,
  notes text
)
language sql
stable
security definer
set search_path to ''
as $function$
  with request as materialized (
    select input_organization_id as organization_id,
      upper(pg_catalog.regexp_replace(pg_catalog.btrim(coalesce(input_code,'')), '[[:space:]]+', '', 'g')) as exact_code,
      public.normalize_part_code(input_code) as loose_code,
      public.normalize_part_code(input_brand) as brand_code
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
      and pub.status='published'
  ),
  exact_rows as materialized (
    select ptr.supplier_id, s.name as supplier_name, b.id as brand_id,
      b.name as brand, r.product_code, r.description, r.buy_price,
      r.valid_from as price_date, r.notes, r.id::text as source_id
    from requested_brand b
    join current_publications ptr on true
    join public.supplier_price_release_rows r on r.release_id=ptr.release_id
      and r.normalized_code=b.exact_code
    join public.suppliers s on s.id=ptr.supplier_id and s.organization_id=b.organization_id
    where r.row_status='accepted' and r.buy_price>0 and r.currency='EUR'
      and r.valid_from<=current_date
      and r.normalized_code=upper(pg_catalog.regexp_replace(r.product_code,'[[:space:]]+','','g'))
    union all
    select sp.supplier_id, s.name, b.id, b.name, sp.product_code,
      sp.description, sp.buy_price, sp.valid_from, sp.notes, sp.id::text
    from requested_brand b
    join public.supplier_prices sp on sp.organization_id=b.organization_id
      and sp.brand_id=b.id and sp.normalized_code=b.loose_code
      and sp.is_active and sp.buy_price>0 and sp.currency='EUR'
      and sp.valid_from<=current_date
      and (sp.valid_to is null or sp.valid_to>=current_date)
    join public.suppliers s on s.id=sp.supplier_id and s.organization_id=b.organization_id
    where upper(pg_catalog.btrim(sp.product_code))=upper(pg_catalog.btrim(input_code))
      and not exists (select 1 from pointer_scope ptr where ptr.supplier_id=sp.supplier_id)
  ),
  legacy_loose_rows as materialized (
    select sp.supplier_id, s.name as supplier_name, b.id as brand_id,
      b.name as brand, sp.product_code, sp.description, sp.buy_price,
      sp.valid_from as price_date, sp.notes, sp.id::text as source_id
    from requested_brand b
    join public.supplier_prices sp on sp.organization_id=b.organization_id
      and sp.brand_id=b.id and sp.normalized_code=b.loose_code
      and sp.is_active and sp.buy_price>0 and sp.currency='EUR'
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
    c.description,c.buy_price,c.price_date,c.notes
  from latest_per_supplier c
  where c.supplier_rank=1
  order by c.buy_price asc,c.price_date desc,c.supplier_id
  limit 25;
$function$;

revoke all on function public.cloud_current_supplier_price_options_core(uuid,text,text)
  from public, anon, authenticated;
grant execute on function public.cloud_current_supplier_price_options_core(uuid,text,text)
  to service_role;

-- The old quote RPCs use the compact catalog key and can still pair a
-- correctly labelled catalog row with a different supplier SKU. V3 resolves
-- only through the exact current-price bridge for published and legacy brands.
create or replace function public.cloud_resolve_quote_line_v3(
  input_code text,
  input_brand text default '',
  input_customer_type text default 'A',
  input_margin_a numeric default 0.10,
  input_margin_b numeric default 0.15
)
returns table (
  found boolean,product_id uuid,product_code text,brand text,description text,
  oem_no text,hs_code text,origin text,weight_kg numeric,supplier_id uuid,
  supplier_name text,buy_price numeric,price_date date,sell_price numeric,notes text
)
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  v_best record;
  v_margin numeric;
begin
  if auth.uid() is null or public.current_profile_org_id() is null then return; end if;
  select * into v_best
  from public.cloud_current_supplier_price_options(input_code,input_brand)
  limit 1;
  if not found then
    return query select false,null::uuid,pg_catalog.btrim(coalesce(input_code,'')),
      input_brand,null::text,null::text,null::text,null::text,null::numeric,
      null::uuid,null::text,null::numeric,null::date,null::numeric,null::text;
    return;
  end if;
  v_margin := case when upper(coalesce(input_customer_type,'A'))='B'
    then input_margin_b else input_margin_a end;
  return query select true,null::uuid,v_best.product_code,v_best.brand,
    v_best.description,null::text,null::text,null::text,null::numeric,
    v_best.supplier_id,v_best.supplier_name,v_best.buy_price,v_best.price_date,
    round(v_best.buy_price*(1+coalesce(v_margin,0)),2),v_best.notes;
end;
$function$;

create or replace function public.cloud_quote_supplier_options_v3(
  input_code text,
  input_brand text default '',
  input_customer_type text default 'A',
  input_margin_a numeric default 0.10,
  input_margin_b numeric default 0.15
)
returns table (
  supplier_id uuid,supplier_name text,buy_price numeric,price_date date,
  sell_price numeric,notes text
)
language sql
stable
security definer
set search_path to ''
as $function$
  select o.supplier_id,o.supplier_name,o.buy_price,o.price_date,
    round(o.buy_price*(1+coalesce(case when upper(coalesce(input_customer_type,'A'))='B'
      then input_margin_b else input_margin_a end,0)),2),o.notes
  from public.cloud_current_supplier_price_options(input_code,input_brand) o;
$function$;

revoke all on function public.cloud_resolve_quote_line_v3(text,text,text,numeric,numeric)
  from public,anon;
revoke all on function public.cloud_quote_supplier_options_v3(text,text,text,numeric,numeric)
  from public,anon;
grant execute on function public.cloud_resolve_quote_line_v3(text,text,text,numeric,numeric)
  to authenticated,service_role;
grant execute on function public.cloud_quote_supplier_options_v3(text,text,text,numeric,numeric)
  to authenticated,service_role;
