-- Separate trusted service-role reads from authenticated customer/staff reads.
-- The caller-supplied organization ID is accepted only after a service-role gate.

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
    where r.exact_code<>'' and r.brand_code<>''
  ),
  current_publications as materialized (
    select ptr.supplier_id, ptr.release_id
    from requested_brand b
    join public.supplier_current_price_pointers ptr
      on ptr.organization_id=b.organization_id and ptr.brand_id=b.id
    join public.supplier_price_publications pub
      on pub.id=ptr.publication_id and pub.release_id=ptr.release_id
      and pub.organization_id=ptr.organization_id
      and pub.supplier_id=ptr.supplier_id and pub.brand_id=ptr.brand_id
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
      and not exists (select 1 from current_publications ptr where ptr.supplier_id=sp.supplier_id)
  ),
  loose_rows as materialized (
    select ptr.supplier_id, s.name as supplier_name, b.id as brand_id,
      b.name as brand, r.product_code, r.description, r.buy_price,
      r.valid_from as price_date, r.notes, r.id::text as source_id
    from requested_brand b
    join current_publications ptr on true
    join public.supplier_price_release_rows r on r.release_id=ptr.release_id
      and public.normalize_part_code(r.product_code)=b.loose_code
    join public.suppliers s on s.id=ptr.supplier_id and s.organization_id=b.organization_id
    where b.loose_code<>'' and r.row_status='accepted'
      and r.buy_price>0 and r.currency='EUR' and r.valid_from<=current_date
      and not exists (select 1 from exact_rows)
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
    where b.loose_code<>'' and not exists (select 1 from exact_rows)
      and not exists (select 1 from current_publications ptr where ptr.supplier_id=sp.supplier_id)
  ),
  unambiguous as materialized (
    select count(distinct upper(pg_catalog.btrim(product_code)))=1 as safe
    from loose_rows
  ),
  candidates as (
    select * from exact_rows
    union all
    select lr.* from loose_rows lr
    cross join unambiguous u
    where u.safe
  ),
  latest_per_supplier as (
    select c.*, row_number() over (
      partition by c.supplier_id, upper(pg_catalog.btrim(c.product_code))
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


revoke all on function public.cloud_current_supplier_price_options_core(uuid,text,text) from public,anon,authenticated;
grant execute on function public.cloud_current_supplier_price_options_core(uuid,text,text) to service_role;

create or replace function public.cloud_current_supplier_price_options(
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
  select * from public.cloud_current_supplier_price_options_core(
    public.current_profile_org_id(),input_code,input_brand);
$function$;

create or replace function public.cloud_current_supplier_price_options_service(
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
language plpgsql
stable
security definer
set search_path to ''
as $function$
begin
  if coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'SUPPLIER_PRICE_SERVICE_ROLE_REQUIRED';
  end if;
  if input_organization_id is null or pg_catalog.btrim(coalesce(input_brand,''))=''
     or pg_catalog.btrim(coalesce(input_code,''))='' then
    raise exception 'SUPPLIER_PRICE_SCOPE_REQUIRED';
  end if;
  return query select * from public.cloud_current_supplier_price_options_core(
    input_organization_id,input_code,input_brand);
end;
$function$;

revoke all on function public.cloud_current_supplier_price_options_service(uuid,text,text) from public,anon,authenticated;
grant execute on function public.cloud_current_supplier_price_options_service(uuid,text,text) to service_role;
