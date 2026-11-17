-- Staged foundation for individually entered supplier prices. This migration
-- intentionally does not alter any published release or existing price reader.
-- Do not deploy until all pricing readers and prepared exports consume it.
create schema if not exists supplier_manual_price_internal;
revoke all on schema supplier_manual_price_internal from public, anon, authenticated;

create table supplier_manual_price_internal.entries (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  supplier_id uuid not null references public.suppliers(id),
  brand_id uuid not null references public.brands(id),
  product_code text not null,
  exact_code text not null,
  description text not null default '',
  oem_no text not null default '',
  buy_price numeric not null check (buy_price > 0),
  currency text not null default 'EUR' check (currency = 'EUR'),
  valid_from date not null,
  moq integer check (moq is null or moq > 0),
  order_multiple integer check (order_multiple is null or order_multiple > 0),
  lead_time_days integer check (lead_time_days is null or lead_time_days >= 0),
  notes text not null default '',
  actor_id uuid not null references public.profiles(id),
  active boolean not null default true,
  retired_by_publication_id uuid references public.supplier_price_publications(id),
  retired_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  unique (organization_id,supplier_id,brand_id,exact_code)
);
alter table supplier_manual_price_internal.entries enable row level security;
revoke all on supplier_manual_price_internal.entries from public, anon, authenticated, service_role;

create table supplier_manual_price_internal.events (
  id bigint generated always as identity primary key,
  entry_id uuid not null references supplier_manual_price_internal.entries(id),
  organization_id uuid not null,
  actor_id uuid references public.profiles(id),
  previous_value jsonb,
  new_value jsonb not null,
  created_at timestamptz not null default clock_timestamp()
);
alter table supplier_manual_price_internal.events enable row level security;
revoke all on supplier_manual_price_internal.events from public, anon, authenticated, service_role;

create function public.save_manual_supplier_price(
  input_supplier_id uuid,input_brand_id uuid,input_product_code text,input_buy_price numeric,
  input_valid_from date,input_description text default '',input_oem_no text default '',
  input_moq integer default null,input_order_multiple integer default null,
  input_lead_time_days integer default null,input_notes text default ''
) returns jsonb language plpgsql security definer set search_path='' as $fn$
declare
  org uuid := public.current_profile_org_id();
  actor uuid := auth.uid();
  code text := pg_catalog.btrim(coalesce(input_product_code,''));
  exact text := public.normalize_catalog_product_code(input_product_code);
  old_entry supplier_manual_price_internal.entries%rowtype;
  entry supplier_manual_price_internal.entries%rowtype;
begin
  if actor is null or org is null or not coalesce(public.is_superadmin() or
    (public.current_profile_role()='admin' and public.profile_has_permission('supplier_prices.manage')),false) then
    raise exception 'MANUAL_SUPPLIER_PRICE_ADMIN_REQUIRED';
  end if;
  if not exists(select 1 from public.suppliers s where s.id=input_supplier_id and s.organization_id=org and s.is_active)
     or not exists(select 1 from public.brands b where b.id=input_brand_id and b.organization_id=org) then
    raise exception 'MANUAL_SUPPLIER_PRICE_SCOPE_INVALID';
  end if;
  if pg_catalog.length(code) not between 1 and 128 or exact !~ '[A-Z0-9]'
    or input_buy_price is null or input_buy_price::text in ('NaN','Infinity','-Infinity') or input_buy_price<=0 or input_buy_price>1000000000
    or input_moq is not null and input_moq<=0
    or input_order_multiple is not null and input_order_multiple<=0
    or input_lead_time_days is not null and input_lead_time_days<0
    or length(coalesce(input_description,''))>1000 or length(coalesce(input_oem_no,''))>1000
    or length(coalesce(input_notes,''))>2000 then
    raise exception 'MANUAL_SUPPLIER_PRICE_INPUT_INVALID';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('supplier-price-publication:'||org::text,0));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('manual-supplier-price:'||org::text||':'||input_supplier_id::text||':'||input_brand_id::text||':'||exact,0));
  select * into old_entry from supplier_manual_price_internal.entries
    where organization_id=org and supplier_id=input_supplier_id and brand_id=input_brand_id and exact_code=exact for update;
  insert into supplier_manual_price_internal.entries(organization_id,supplier_id,brand_id,product_code,exact_code,description,oem_no,buy_price,valid_from,moq,order_multiple,lead_time_days,notes,actor_id)
  values(org,input_supplier_id,input_brand_id,code,exact,coalesce(input_description,''),coalesce(input_oem_no,''),input_buy_price,coalesce(input_valid_from,current_date),input_moq,input_order_multiple,input_lead_time_days,coalesce(input_notes,''),actor)
  on conflict(organization_id,supplier_id,brand_id,exact_code) do update set
    product_code=excluded.product_code,description=excluded.description,oem_no=excluded.oem_no,
    buy_price=excluded.buy_price,valid_from=excluded.valid_from,moq=excluded.moq,
    order_multiple=excluded.order_multiple,lead_time_days=excluded.lead_time_days,
    notes=excluded.notes,actor_id=excluded.actor_id,active=true,retired_by_publication_id=null,retired_at=null,created_at=clock_timestamp()
  returning * into entry;
  insert into supplier_manual_price_internal.events(entry_id,organization_id,actor_id,previous_value,new_value)
  values(entry.id,org,actor,case when old_entry.id is null then null else pg_catalog.to_jsonb(old_entry) end,pg_catalog.to_jsonb(entry));
  insert into public.supplier_price_source_versions(organization_id,brand_id,source_revision,updated_at)
  values(org,input_brand_id,1,clock_timestamp()) on conflict(organization_id,brand_id) do update
    set source_revision=public.supplier_price_source_versions.source_revision+1,updated_at=clock_timestamp();
  return pg_catalog.jsonb_build_object('id',entry.id,'supplier_id',entry.supplier_id,'brand_id',entry.brand_id,'product_code',entry.product_code);
end;
$fn$;
revoke all on function public.save_manual_supplier_price(uuid,uuid,text,numeric,date,text,text,integer,integer,integer,text) from public,anon,authenticated;
grant execute on function public.save_manual_supplier_price(uuid,uuid,text,numeric,date,text,text,integer,integer,integer,text) to authenticated;

-- Exact, active manual prices take precedence for the same supplier and SKU.
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
  effective_candidates as (
    select c.* from candidates c
    where not exists (
      select 1 from supplier_manual_price_internal.entries m
      where m.organization_id=input_organization_id and m.supplier_id=c.supplier_id
        and m.brand_id=c.brand_id and m.exact_code=public.normalize_catalog_product_code(c.product_code)
        and m.active and m.valid_from<=current_date
    )
    union all
    select m.supplier_id,s.name,b.id,b.name,m.product_code,m.description,m.buy_price,
      m.valid_from,m.notes,m.moq,m.order_multiple,null::integer,null::date,m.id::text
    from requested_brand b
    join supplier_manual_price_internal.entries m on m.organization_id=b.organization_id
      and m.brand_id=b.id and m.exact_code=b.exact_code and m.active and m.valid_from<=current_date
    join public.suppliers s on s.id=m.supplier_id and s.organization_id=m.organization_id
      and s.is_active and s.price_usage_enabled
  ),
  latest_per_supplier as (
    select c.*, row_number() over (
      partition by c.supplier_id, upper(pg_catalog.regexp_replace(pg_catalog.btrim(c.product_code),'[[:space:]]+','','g'))
      order by c.price_date desc, c.source_id desc
    ) as supplier_rank
    from effective_candidates c
  )
  select c.supplier_id,c.supplier_name,c.brand_id,c.brand,c.product_code,
    c.description,c.buy_price,c.price_date,c.notes,c.moq,c.order_multiple,c.stock_qty,c.valid_to
  from latest_per_supplier c
  where c.supplier_rank=1
  order by c.buy_price asc,c.price_date desc,c.supplier_id
  limit 25;
$function$
;


-- The pointer changes in the same transaction as publication. A rollback
-- also rolls back retirement; absent SKUs and other supplier scopes survive.
create function supplier_manual_price_internal.retire_published_entries()
returns trigger language plpgsql security definer set search_path='' as $fn$
declare changed record;
begin
  if tg_op='UPDATE' and new.release_id is not distinct from old.release_id
     and new.publication_id is not distinct from old.publication_id then return null; end if;
  if not exists(select 1 from public.supplier_price_publications p
    where p.id=new.publication_id and p.release_id=new.release_id and p.organization_id=new.organization_id
      and p.supplier_id=new.supplier_id and p.brand_id=new.brand_id and p.status='published') then return null; end if;
  for changed in
    update supplier_manual_price_internal.entries m
       set active=false,retired_at=clock_timestamp(),retired_by_publication_id=new.publication_id
     where m.organization_id=new.organization_id and m.supplier_id=new.supplier_id and m.brand_id=new.brand_id
       and m.active and exists (select 1 from public.supplier_price_release_rows r
         where r.release_id=new.release_id and r.row_status='accepted'
           and r.normalized_code=m.exact_code
           and r.normalized_code=public.normalize_catalog_product_code(r.product_code))
    returning m.*
  loop
    insert into supplier_manual_price_internal.events(entry_id,organization_id,actor_id,previous_value,new_value)
    values(changed.id,changed.organization_id,null,pg_catalog.to_jsonb(changed)||pg_catalog.jsonb_build_object('active',true,'retired_at',null,'retired_by_publication_id',null),pg_catalog.to_jsonb(changed));
  end loop;
  return null;
end;
$fn$;
revoke all on function supplier_manual_price_internal.retire_published_entries() from public,anon,authenticated,service_role;
create trigger retire_manual_prices_after_publication
after insert or update of release_id,publication_id on public.supplier_current_price_pointers
for each row execute function supplier_manual_price_internal.retire_published_entries();


-- Manual prices in prepared price-list sources and supplier preview.
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
      and not exists(select 1 from supplier_manual_price_internal.entries m where m.organization_id=sp.organization_id and m.supplier_id=sp.supplier_id and m.brand_id=sp.brand_id and m.exact_code=public.normalize_catalog_product_code(sp.product_code) and m.active and m.valid_from<=current_date)
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
        and not exists(select 1 from supplier_manual_price_internal.entries m where m.organization_id=p.org_id and m.brand_id=p.brand_id and m.supplier_id=rel.supplier_id and m.exact_code=r.normalized_code and m.active and m.valid_from<=current_date)
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
  ), manual_page as materialized (
    select distinct on (m.exact_code collate "C") m.* from supplier_manual_price_internal.entries m cross join params p
    join public.suppliers s on s.id=m.supplier_id and s.organization_id=m.organization_id and s.price_usage_enabled
    where m.organization_id=p.org_id and m.brand_id=p.brand_id and m.active and m.valid_from<=current_date
      and m.exact_code collate "C">coalesce(p.after_code,'') collate "C"
    order by m.exact_code collate "C",m.buy_price,m.supplier_id limit (select page_size from params)
  ), candidates as (
    select r.code,r.supplier_id,r.product_code,r.description,r.buy_price,r.valid_from,r.source_id,r.published_order_id from release_pages r
    union all
    select l.code,l.supplier_id,l.product_code,l.description,l.buy_price,l.valid_from,l.source_id,null from legacy_page l
    union all
    select m.exact_code collate "C",m.supplier_id,m.product_code,m.description,m.buy_price,m.valid_from,m.id::text,null from manual_page m
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
      union all
      select m.exact_code collate "C" from supplier_manual_price_internal.entries m cross join params p
      join public.suppliers s on s.id=m.supplier_id and s.organization_id=m.organization_id and s.price_usage_enabled
      where p.after_code is null and m.organization_id=p.org_id and m.brand_id=p.brand_id and m.active and m.valid_from<=current_date
    ) codes
  )
  select page.code,page.product_code,page.description,page.buy_price,page.valid_from,
    case when p.after_code is null then t.n else null end
  from page cross join params p cross join first_total t
  order by page.code;
$function$
;

create or replace function public.cloud_supplier_price_commercial_page_v3(
 input_supplier_id uuid,input_search text default '',input_page integer default 1,
 input_page_size integer default 250,input_freshness text default 'all')
returns table(total_count bigint,price_id uuid,product_code text,brand text,description text,oem_no text,
 buy_price numeric,currency text,price_date date,moq integer,order_multiple integer,
 lead_time_days integer,notes text,freshness text,stock_qty integer,valid_to date)
language plpgsql stable security definer set search_path='' as $function$
declare org uuid;page_size integer;page_offset bigint;wanted bigint;q text;f text;
begin
 org:=public.current_profile_org_id();
 if auth.uid() is null or org is null then raise exception 'SUPPLIER_PRICE_AUTH_REQUIRED';end if;
 if input_supplier_id is null or not exists(select 1 from public.suppliers s where s.id=input_supplier_id and s.organization_id=org)
 then raise exception 'SUPPLIER_PRICE_SCOPE_REQUIRED';end if;
 page_size:=least(greatest(coalesce(input_page_size,250),1),1000);
 page_offset:=(greatest(coalesce(input_page,1),1)::bigint-1)*page_size;wanted:=page_offset+page_size;
 q:=nullif(btrim(coalesce(input_search,'')),'');f:=lower(coalesce(nullif(btrim(input_freshness),''),'all'));
 if f not in('all','fresh','aging','stale','unknown') then raise exception 'SUPPLIER_PRICE_FRESHNESS_INVALID';end if;
 return query with pointers as materialized(
  select p.* from public.supplier_current_price_pointers p where p.organization_id=org and p.supplier_id=input_supplier_id
 ), published as materialized(
  select p.release_id,p.brand_id,b.name brand from pointers p join public.supplier_price_publications pub
   on pub.id=p.publication_id and pub.release_id=p.release_id and pub.organization_id=p.organization_id
   and pub.supplier_id=p.supplier_id and pub.brand_id=p.brand_id and pub.status='published'
  join public.brands b on b.id=p.brand_id and b.organization_id=org
 ), candidates as(
  select md5(r.id::text)::uuid price_id,r.product_code,p.brand,r.description,r.oem_no,r.buy_price,r.currency,
   r.valid_from price_date,r.moq,r.order_multiple,r.lead_time_days,r.notes,r.stock_qty,r.valid_to
  from published p cross join lateral(
   select rr.* from public.supplier_price_release_rows rr where rr.release_id=p.release_id and rr.row_status='accepted'
    and rr.normalized_code=public.normalize_catalog_product_code(rr.product_code) and rr.normalized_code~'[A-Z0-9]'
    and rr.buy_price>0 and rr.currency='EUR'
    and not exists(select 1 from supplier_manual_price_internal.entries m where m.organization_id=org and m.supplier_id=input_supplier_id and m.brand_id=p.brand_id and m.exact_code=rr.normalized_code and m.active and m.valid_from<=current_date)
    and(q is null or rr.product_code ilike '%'||q||'%' or rr.description ilike '%'||q||'%' or rr.oem_no ilike '%'||q||'%' or p.brand ilike '%'||q||'%')
    and(f='all' or(f='fresh' and rr.valid_from>=current_date-90)or(f='aging' and rr.valid_from>=current_date-180 and rr.valid_from<current_date-90)
      or(f='stale' and rr.valid_from<current_date-180)or(f='unknown' and rr.valid_from is null))
   order by rr.product_code collate "C",md5(rr.id::text)::uuid limit wanted
  )r
  union all
  select l.id,l.product_code,l.brand,l.description,l.oem_no,l.buy_price,l.currency,l.valid_from,l.moq,l.order_multiple,l.lead_time_days,l.notes,l.stock_qty,l.valid_to
  from lateral(
   select sp.*,b.name brand from public.supplier_prices sp left join public.brands b on b.id=sp.brand_id and b.organization_id=org
   where sp.organization_id=org and sp.supplier_id=input_supplier_id and sp.is_active
    and not exists(select 1 from pointers p where p.brand_id=sp.brand_id)
    and not exists(select 1 from supplier_manual_price_internal.entries m where m.organization_id=org and m.supplier_id=input_supplier_id and m.brand_id=sp.brand_id and m.exact_code=public.normalize_catalog_product_code(sp.product_code) and m.active and m.valid_from<=current_date)
    and(q is null or sp.product_code ilike '%'||q||'%' or sp.description ilike '%'||q||'%' or sp.oem_no ilike '%'||q||'%' or b.name ilike '%'||q||'%')
    and(f='all' or(f='fresh' and sp.valid_from>=current_date-90)or(f='aging' and sp.valid_from>=current_date-180 and sp.valid_from<current_date-90)
      or(f='stale' and sp.valid_from<current_date-180)or(f='unknown' and sp.valid_from is null))
   order by sp.product_code collate "C",sp.id limit wanted
  )l
  union all
  select m.id,m.product_code,b.name,m.description,m.oem_no,m.buy_price,m.currency,m.valid_from,m.moq,m.order_multiple,m.lead_time_days,m.notes,null::integer,null::date
  from supplier_manual_price_internal.entries m join public.brands b on b.id=m.brand_id and b.organization_id=m.organization_id
  where m.organization_id=org and m.supplier_id=input_supplier_id and m.active and m.valid_from<=current_date
   and(q is null or m.product_code ilike '%'||q||'%' or m.description ilike '%'||q||'%' or m.oem_no ilike '%'||q||'%' or b.name ilike '%'||q||'%')
   and(f='all' or(f='fresh' and m.valid_from>=current_date-90)or(f='aging' and m.valid_from>=current_date-180 and m.valid_from<current_date-90)or(f='stale' and m.valid_from<current_date-180))
 )select null::bigint,c.price_id,c.product_code,c.brand,c.description,c.oem_no,c.buy_price,c.currency,c.price_date,c.moq,c.order_multiple,c.lead_time_days,c.notes,
  case when c.price_date is null then 'unknown' when c.price_date<current_date-180 then 'stale' when c.price_date<current_date-90 then 'aging' else 'fresh' end,
  c.stock_qty,c.valid_to from candidates c order by c.product_code collate "C",c.price_id limit page_size offset page_offset;
end $function$;


-- Include the same manual overlay in the catalog export.
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
      and not exists(select 1 from supplier_manual_price_internal.entries m where m.organization_id=sp.organization_id and m.supplier_id=sp.supplier_id and m.brand_id=sp.brand_id and m.exact_code=public.normalize_catalog_product_code(sp.product_code) and m.active and m.valid_from<=current_date)
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
  ), manual_codes as materialized (
    select distinct m.exact_code collate "C" normalized_code from supplier_manual_price_internal.entries m cross join params p
    join public.suppliers s on s.id=m.supplier_id and s.organization_id=m.organization_id and s.price_usage_enabled
    where p.scope='priced' and m.organization_id=p.org_id and m.brand_id=p.brand_id and m.active and m.valid_from<=current_date
      and m.exact_code collate "C">coalesce(p.after_code,'') collate "C"
      and (p.search is null or m.product_code ilike '%'||p.search||'%' or m.description ilike '%'||p.search||'%' or m.oem_no ilike '%'||p.search||'%' or (p.search_norm is not null and (m.exact_code like p.search_norm||'%' or public.normalize_part_code(m.oem_no) like p.search_norm||'%')))
    order by normalized_code limit (select page_size from params)
  ), price_codes as materialized (
    select code.normalized_code from (
      select rc.normalized_code from release_candidates rc
      union select lc.normalized_code from legacy_codes lc
      union select mc.normalized_code from manual_codes mc
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
    and not exists(select 1 from supplier_manual_price_internal.entries m cross join params p where m.organization_id=p.org_id and m.brand_id=p.brand_id and m.supplier_id=rel.supplier_id and m.exact_code=r.normalized_code and m.active and m.valid_from<=current_date)
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
    union all
    select m.exact_code,m.supplier_id,m.product_code,m.description,m.oem_no,m.buy_price,m.valid_from,m.notes,null
    from supplier_manual_price_internal.entries m join page_codes pc on pc.normalized_code=m.exact_code cross join params p
    join public.suppliers su on su.id=m.supplier_id and su.organization_id=m.organization_id and su.price_usage_enabled
    where m.organization_id=p.org_id and m.brand_id=p.brand_id and m.active and m.valid_from<=current_date
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
        union all
        select m.exact_code collate "C" from supplier_manual_price_internal.entries m
        join public.suppliers su on su.id=m.supplier_id and su.organization_id=m.organization_id and su.price_usage_enabled
        where m.organization_id=p.org_id and m.brand_id=p.brand_id and m.active and m.valid_from<=current_date
          and (p.search is null or m.product_code ilike '%'||p.search||'%' or m.description ilike '%'||p.search||'%' or m.oem_no ilike '%'||p.search||'%' or (p.search_norm is not null and (m.exact_code like p.search_norm||'%' or public.normalize_part_code(m.oem_no) like p.search_norm||'%')))
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


-- Catalogless portal search sees the same active manual prices.
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
    select ptr.release_id,ptr.supplier_id
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
      r.buy_price, r.valid_from, r.id::text id
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
        and not exists(select 1 from supplier_manual_price_internal.entries m where m.organization_id=input_organization_id and m.brand_id=input_brand_id and m.supplier_id=cr.supplier_id and m.exact_code=r.normalized_code and m.active and m.valid_from<=current_date)
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
    union all
    select m.exact_code,m.product_code,m.description,m.buy_price,m.valid_from,m.id::text
    from supplier_manual_price_internal.entries m
    join public.suppliers s on s.id=m.supplier_id and s.organization_id=m.organization_id and s.price_usage_enabled
    where m.organization_id=input_organization_id and m.brand_id=input_brand_id and m.active and m.valid_from<=current_date
      and (v_prefix='' or left(m.exact_code,length(v_prefix))=v_prefix)
      and not exists(select 1 from public.catalog_products cp where cp.organization_id=input_organization_id and cp.brand_id=input_brand_id)
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

-- Supplier downloads use the same supplier/brand/code overlay as the screen.
create function supplier_manual_price_internal.export_overlay_page(
  input_organization_id uuid,input_supplier_id uuid,input_brand_id uuid,input_search text default '',
  input_freshness text default 'all',input_after_product_code text default null,input_after_id uuid default null,input_page_size integer default 1000
) returns table(total_count bigint,price_id uuid,product_code text,brand text,description text,oem_no text,
 buy_price numeric,currency text,price_date date,moq integer,order_multiple integer,lead_time_days integer,
 notes text,freshness text,stock_qty integer,valid_to date)
language plpgsql stable security definer set search_path='' as $function$
declare q text:=nullif(btrim(coalesce(input_search,'')),''); f text:=lower(coalesce(nullif(btrim(input_freshness),''),'all'));
begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception 'SUPPLIER_PRICE_EXPORT_SERVICE_ROLE_REQUIRED'; end if;
 if input_organization_id is null or input_supplier_id is null or input_brand_id is null then raise exception 'SUPPLIER_PRICE_EXPORT_SCOPE_REQUIRED'; end if;
 if f not in ('all','fresh','aging','stale','unknown') then raise exception 'SUPPLIER_PRICE_EXPORT_FRESHNESS_INVALID'; end if;
 return query with pointer as materialized (
   select p.release_id from public.supplier_current_price_pointers p join public.supplier_price_publications pub
     on pub.id=p.publication_id and pub.release_id=p.release_id and pub.organization_id=p.organization_id and pub.supplier_id=p.supplier_id and pub.brand_id=p.brand_id and pub.status='published'
   where p.organization_id=input_organization_id and p.supplier_id=input_supplier_id and p.brand_id=input_brand_id
 ), has_pointer as materialized (
   select exists(select 1 from public.supplier_current_price_pointers p where p.organization_id=input_organization_id and p.supplier_id=input_supplier_id and p.brand_id=input_brand_id) present
 ), source as not materialized (
   select md5(r.id::text)::uuid id,r.product_code,r.description,r.oem_no,r.buy_price,r.currency,r.valid_from,r.moq,r.order_multiple,r.lead_time_days,r.notes,r.stock_qty,r.valid_to
   from pointer p join public.supplier_price_release_rows r on r.release_id=p.release_id
   where r.row_status='accepted' and r.normalized_code=public.normalize_catalog_product_code(r.product_code) and r.normalized_code~'[A-Z0-9]' and r.buy_price>0 and r.currency='EUR'
     and not exists(select 1 from supplier_manual_price_internal.entries m where m.organization_id=input_organization_id and m.supplier_id=input_supplier_id and m.brand_id=input_brand_id and m.exact_code=r.normalized_code and m.active and m.valid_from<=current_date)
   union all
   select sp.id,sp.product_code,sp.description,sp.oem_no,sp.buy_price,sp.currency,sp.valid_from,sp.moq,sp.order_multiple,sp.lead_time_days,sp.notes,sp.stock_qty,sp.valid_to
   from public.supplier_prices sp cross join has_pointer hp
   where not hp.present and sp.organization_id=input_organization_id and sp.supplier_id=input_supplier_id and sp.brand_id=input_brand_id and sp.is_active
     and not exists(select 1 from supplier_manual_price_internal.entries m where m.organization_id=input_organization_id and m.supplier_id=input_supplier_id and m.brand_id=input_brand_id and m.exact_code=public.normalize_catalog_product_code(sp.product_code) and m.active and m.valid_from<=current_date)
   union all
   select m.id,m.product_code,m.description,m.oem_no,m.buy_price,m.currency,m.valid_from,m.moq,m.order_multiple,m.lead_time_days,m.notes,null::integer,null::date
   from supplier_manual_price_internal.entries m where m.organization_id=input_organization_id and m.supplier_id=input_supplier_id and m.brand_id=input_brand_id and m.active and m.valid_from<=current_date
 ), filtered as not materialized (
   select s.* from source s where
     (q is null or s.product_code ilike '%'||q||'%' or s.description ilike '%'||q||'%' or s.oem_no ilike '%'||q||'%' or (public.normalize_part_code(q)<>'' and (public.normalize_part_code(s.product_code) like public.normalize_part_code(q)||'%' or public.normalize_part_code(s.oem_no) like public.normalize_part_code(q)||'%')))
     and (f='all' or (f='fresh' and s.valid_from>=current_date-90) or (f='aging' and s.valid_from>=current_date-180 and s.valid_from<current_date-90) or (f='stale' and s.valid_from<current_date-180) or (f='unknown' and s.valid_from is null))
 ), page as materialized (
   select s.* from filtered s where input_after_product_code is null or (s.product_code collate "C",s.id)>(input_after_product_code collate "C",input_after_id)
   order by s.product_code collate "C",s.id limit least(greatest(coalesce(input_page_size,1000),1),5000)
 ), count_first as materialized (
   select count(*)::bigint n from filtered where input_after_product_code is null
 )
 select case when input_after_product_code is null then c.n else null end,p.id,p.product_code,b.name,p.description,p.oem_no,p.buy_price,p.currency,p.valid_from,p.moq,p.order_multiple,p.lead_time_days,p.notes,
 case when p.valid_from is null then 'unknown' when p.valid_from<current_date-180 then 'stale' when p.valid_from<current_date-90 then 'aging' else 'fresh' end,p.stock_qty,p.valid_to
 from page p cross join count_first c join public.brands b on b.id=input_brand_id and b.organization_id=input_organization_id
 order by p.product_code collate "C",p.id;
end $function$;


-- Invalidate prepared supplier downloads when manual prices change.
create or replace function public.get_supplier_price_export_version(input_organization_id uuid,input_supplier_id uuid,input_brand_id uuid)
returns text language sql stable security definer set search_path='' as $function$
 select md5('supplier-commercial-source-v3:'||coalesce(input_organization_id::text,'')||':'||coalesce(input_supplier_id::text,'')||':'||coalesce(input_brand_id::text,'')||':'||current_date::text||':'||
 coalesce((select jsonb_agg(jsonb_build_array(p.release_id,p.publication_id,pub.status) order by p.release_id)::text
 from public.supplier_current_price_pointers p left join public.supplier_price_publications pub on pub.id=p.publication_id and pub.release_id=p.release_id and pub.organization_id=p.organization_id and pub.supplier_id=p.supplier_id and pub.brand_id=p.brand_id
 where p.organization_id=input_organization_id and p.supplier_id=input_supplier_id and p.brand_id=input_brand_id),'[]')||':'||
 coalesce((select string_agg(md5(to_jsonb(sp)::text),',' order by sp.id) from public.supplier_prices sp
 where sp.organization_id=input_organization_id and sp.supplier_id=input_supplier_id and sp.brand_id=input_brand_id and sp.is_active
 and not exists(select 1 from public.supplier_current_price_pointers p where p.organization_id=sp.organization_id and p.supplier_id=sp.supplier_id and p.brand_id=sp.brand_id)),'')||':'||
 coalesce((select source_revision::text from public.supplier_price_source_versions where organization_id=input_organization_id and brand_id=input_brand_id),'0'));
$function$;


-- Catalog pages use the same supplier price overlay.
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
      and not exists(select 1 from supplier_manual_price_internal.entries m where m.organization_id=sp.organization_id and m.supplier_id=sp.supplier_id and m.brand_id=sp.brand_id and m.exact_code=public.normalize_catalog_product_code(sp.product_code) and m.active and m.valid_from<=current_date)
  ), page_codes as materialized (
    select distinct public.normalize_catalog_product_code(cp.product_code) normalized_code from catalog_page cp
  ), published_best as materialized (
    select distinct on (r.normalized_code,rel.supplier_id)
      r.normalized_code,rel.supplier_id,r.product_code,r.description,r.oem_no,r.buy_price,r.valid_from,r.notes,r.id
    from page_codes pc cross join releases rel
    join public.supplier_price_release_rows r on r.release_id=rel.release_id and r.normalized_code=pc.normalized_code
    where r.row_status='accepted' and r.normalized_code=public.normalize_catalog_product_code(r.product_code) and r.buy_price>0 and r.currency='EUR' and r.valid_from<=current_date and (r.valid_to is null or r.valid_to>=current_date)
    and not exists(select 1 from supplier_manual_price_internal.entries m cross join params p where m.organization_id=p.org_id and m.brand_id=p.brand_id and m.supplier_id=rel.supplier_id and m.exact_code=r.normalized_code and m.active and m.valid_from<=current_date)
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
    union all
    select m.exact_code,m.supplier_id,m.product_code,m.description,m.oem_no,m.buy_price,m.valid_from,m.notes,null
    from supplier_manual_price_internal.entries m join page_codes pc on pc.normalized_code=m.exact_code cross join params p
    join public.suppliers su on su.id=m.supplier_id and su.organization_id=m.organization_id and su.price_usage_enabled
    where m.organization_id=p.org_id and m.brand_id=p.brand_id and m.active and m.valid_from<=current_date
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


-- Priced catalog view includes manual-only parts and current overrides.
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
      and (exists(select 1 from pointer_scope) or exists(select 1 from supplier_manual_price_internal.entries m where m.organization_id=v_organization_id and m.brand_id=input_brand_id and m.active and m.valid_from<=current_date))
      and not exists(select 1 from pointer_scope ptr where ptr.supplier_id=sp.supplier_id)
      and not exists(select 1 from supplier_manual_price_internal.entries m where m.organization_id=sp.organization_id and m.supplier_id=sp.supplier_id and m.brand_id=sp.brand_id and m.exact_code=public.normalize_catalog_product_code(sp.product_code) and m.active and m.valid_from<=current_date)
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
    union select m.exact_code collate "C" from supplier_manual_price_internal.entries m
      join public.suppliers su on su.id=m.supplier_id and su.organization_id=m.organization_id and su.price_usage_enabled
      where m.organization_id=v_organization_id and m.brand_id=input_brand_id and m.active and m.valid_from<=current_date
        and (v_exact_code is null or m.exact_code=v_exact_code)
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
      and not exists(select 1 from supplier_manual_price_internal.entries m where m.organization_id=v_organization_id and m.brand_id=input_brand_id and m.supplier_id=cr.supplier_id and m.exact_code=r.normalized_code and m.active and m.valid_from<=current_date)
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
    union all select m.exact_code,m.product_code,m.description,m.buy_price,m.valid_from,m.notes,m.supplier_id,su.name,1::bigint
    from supplier_manual_price_internal.entries m join page_codes pc on pc.normalized_code=m.exact_code
    join public.suppliers su on su.id=m.supplier_id and su.organization_id=m.organization_id and su.price_usage_enabled
    where m.organization_id=v_organization_id and m.brand_id=input_brand_id and m.active and m.valid_from<=current_date
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
    select (exists(select 1 from pointer_scope) or exists(select 1 from supplier_manual_price_internal.entries m where m.organization_id=v_organization_id and m.brand_id=input_brand_id and m.active and m.valid_from<=current_date)) as has_published_scope,
      (coalesce(sum(accepted_rows), 0)+(select count(*) from legacy)+(select count(*) from supplier_manual_price_internal.entries m where m.organization_id=v_organization_id and m.brand_id=input_brand_id and m.active and m.valid_from<=current_date))::bigint as estimated_count
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


-- Future manual prices change the prepared-file version when they become valid.
create or replace function public.get_prepared_price_list_export_version(input_organization_id uuid,input_brand_id uuid)
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
  union all
  select min(m.valid_from) from supplier_manual_price_internal.entries m where m.organization_id=input_organization_id and m.brand_id=input_brand_id and m.active and m.valid_from>current_date
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


-- Make manual-only items authoritative for order price lookups.
CREATE OR REPLACE FUNCTION public.cloud_current_supplier_price_options_batch(input_requests jsonb)
 RETURNS TABLE(request_index integer, has_published_scope boolean, options jsonb)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_organization_id uuid;
begin
  if auth.uid() is null then
    raise exception 'SUPPLIER_PRICE_AUTH_REQUIRED';
  end if;
  v_organization_id := public.current_profile_org_id();
  if v_organization_id is null then
    raise exception 'SUPPLIER_PRICE_ORGANIZATION_REQUIRED';
  end if;
  if pg_catalog.jsonb_typeof(input_requests) is distinct from 'array' then
    raise exception 'SUPPLIER_PRICE_BATCH_SIZE_INVALID';
  end if;
  if pg_catalog.jsonb_array_length(input_requests) not between 1 and 25 then
    raise exception 'SUPPLIER_PRICE_BATCH_SIZE_INVALID';
  end if;
  if exists (
    select 1
    from pg_catalog.jsonb_array_elements(input_requests) as item(value)
    where pg_catalog.jsonb_typeof(item.value) is distinct from 'object'
      or pg_catalog.jsonb_typeof(item.value->'code') is distinct from 'string'
      or pg_catalog.jsonb_typeof(item.value->'brand') is distinct from 'string'
      or pg_catalog.length(pg_catalog.btrim(item.value->>'code')) not between 1 and 100
      or pg_catalog.length(pg_catalog.btrim(item.value->>'brand')) not between 1 and 100
  ) then
    raise exception 'SUPPLIER_PRICE_BATCH_INPUT_INVALID';
  end if;

  return query
  with requested as materialized (
    select (item.ordinality - 1)::integer as row_index,
      pg_catalog.btrim(item.value->>'code') as code,
      pg_catalog.btrim(item.value->>'brand') as brand
    from pg_catalog.jsonb_array_elements(input_requests) with ordinality as item(value, ordinality)
  ), scoped as materialized (
    select r.*,
      exists (
        select 1
        from public.brands b
        join public.supplier_current_price_pointers ptr
          on ptr.organization_id=b.organization_id and ptr.brand_id=b.id
        where b.organization_id=v_organization_id
          and b.normalized_name=supplier_price_validation_internal.canonical_automotive_brand_key(r.brand,r.code)
      ) or exists (
        select 1 from public.brands b join supplier_manual_price_internal.entries m
          on m.organization_id=b.organization_id and m.brand_id=b.id
        join public.suppliers su on su.organization_id=m.organization_id and su.id=m.supplier_id and su.is_active and su.price_usage_enabled
        where b.organization_id=v_organization_id and b.normalized_name=supplier_price_validation_internal.canonical_automotive_brand_key(r.brand,r.code)
          and m.exact_code=public.normalize_catalog_product_code(r.code) and m.active and m.valid_from<=current_date
      ) as published_scope
    from requested r
  )
  select s.row_index, s.published_scope,
    coalesce(p.options, '[]'::jsonb) as options
  from scoped s
  left join lateral (
    select pg_catalog.jsonb_agg(pg_catalog.to_jsonb(o)
      order by o.buy_price, o.price_date desc, o.supplier_id) as options
    from public.cloud_current_supplier_commercial_options_core(
      v_organization_id,s.code,s.brand) o
  ) p on true
  order by s.row_index;
end;
$function$
;


-- Service snapshots preserve exact supplier/SKU overrides.
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
    select coalesce(jsonb_agg(jsonb_build_object('normalized_code',public.normalize_part_code(m.exact_code),
      'product_code',m.product_code,'buy_price',m.buy_price::text,'currency',m.currency,
      'valid_from',to_char(m.valid_from,'YYYY-MM-DD')) order by m.exact_code),'[]'::jsonb) into v_prices
    from supplier_manual_price_internal.entries m where m.organization_id=input_organization_id
      and m.supplier_id=input_supplier_id and m.brand_id=input_brand_id and m.active and m.valid_from<=current_date
      and public.normalize_part_code(m.exact_code)=any(input_codes);
    if exists(select 1 from supplier_manual_price_internal.entries m where m.organization_id=input_organization_id
       and m.supplier_id=input_supplier_id and m.brand_id=input_brand_id and m.active and m.valid_from<=current_date
       and public.normalize_part_code(m.exact_code)=any(input_codes)
       group by public.normalize_part_code(m.exact_code) having count(distinct m.exact_code)>1) then
      raise exception 'SUPPLIER_PRICE_SNAPSHOT_AMBIGUOUS_CODE';
    end if;
    return jsonb_build_object(
      'status', case when jsonb_array_length(v_prices)>0 then 'current' else 'unpublished' end,
      'organization_id', input_organization_id,
      'supplier_id', input_supplier_id,
      'brand_id', input_brand_id,
      'release_id', null,
      'publication_id', null,
      'version', case when jsonb_array_length(v_prices)>0 then 'manual:'||coalesce((select source_revision::text from public.supplier_price_source_versions where organization_id=input_organization_id and brand_id=input_brand_id),'0') else null end,
      'prices', v_prices
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

  if exists (
    select 1 from (
      select rr.normalized_code exact_code from public.supplier_price_release_rows rr
      where rr.release_id=v_release.id and rr.row_status='accepted' and rr.buy_price>0
        and coalesce(rr.valid_from,v_release.source_date)<=current_date and (rr.valid_to is null or rr.valid_to>=current_date)
        and public.normalize_part_code(rr.normalized_code)=any(input_codes)
      union all
      select m.exact_code from supplier_manual_price_internal.entries m
      where m.organization_id=input_organization_id and m.supplier_id=input_supplier_id and m.brand_id=input_brand_id
        and m.active and m.valid_from<=current_date and public.normalize_part_code(m.exact_code)=any(input_codes)
    ) x group by public.normalize_part_code(x.exact_code) having count(distinct x.exact_code)>1
  ) then raise exception 'SUPPLIER_PRICE_SNAPSHOT_AMBIGUOUS_CODE'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('normalized_code',x.normalized_code,
    'product_code',x.product_code,'buy_price',x.buy_price::text,'currency',x.currency,
    'valid_from',to_char(x.valid_from,'YYYY-MM-DD')) order by x.normalized_code),'[]'::jsonb)
  into v_prices from (
    select public.normalize_part_code(rr.normalized_code) normalized_code,rr.product_code,rr.buy_price,upper(btrim(rr.currency)) currency,coalesce(rr.valid_from,v_release.source_date) valid_from
    from public.supplier_price_release_rows rr
    where rr.release_id=v_release.id and rr.row_status='accepted' and rr.buy_price is not null
      and coalesce(rr.valid_from,v_release.source_date)<=current_date and (rr.valid_to is null or rr.valid_to>=current_date)
      and public.normalize_part_code(rr.normalized_code)=any(input_codes)
      and not exists(select 1 from supplier_manual_price_internal.entries m where m.organization_id=input_organization_id
        and m.supplier_id=input_supplier_id and m.brand_id=input_brand_id and m.exact_code=rr.normalized_code and m.active and m.valid_from<=current_date)
    union all
    select public.normalize_part_code(m.exact_code),m.product_code,m.buy_price,m.currency,m.valid_from
    from supplier_manual_price_internal.entries m where m.organization_id=input_organization_id
      and m.supplier_id=input_supplier_id and m.brand_id=input_brand_id and m.active and m.valid_from<=current_date
      and public.normalize_part_code(m.exact_code)=any(input_codes)
  ) x;

  return jsonb_build_object(
    'status', 'current',
    'organization_id', input_organization_id,
    'supplier_id', input_supplier_id,
    'brand_id', input_brand_id,
    'release_id', v_release.id,
    'publication_id', v_publication.id,
    'version', v_publication.publication_version::text||':manual:'||coalesce((select source_revision::text from public.supplier_price_source_versions where organization_id=input_organization_id and brand_id=input_brand_id),'0'),
    'prices', v_prices
  );
end;
$function$
;


-- Preserve the existing indexed export path for scopes without manual prices.
create function supplier_manual_price_internal.export_original_page(
  input_organization_id uuid,
  input_supplier_id uuid,
  input_brand_id uuid,
  input_search text default '',
  input_freshness text default 'all',
  input_after_product_code text default null,
  input_after_id uuid default null,
  input_page_size integer default 1000
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
  order_multiple integer,
  lead_time_days integer,
  notes text,
  freshness text, stock_qty integer, valid_to date
)
language plpgsql
stable
security definer
set search_path to ''
as $function$
declare
  v_page_size integer;
  v_search text;
  v_search_norm text;
  v_original_norm text;
  v_freshness text;
  v_has_pointer boolean;
  v_release_id uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'SUPPLIER_PRICE_EXPORT_SERVICE_ROLE_REQUIRED';
  end if;
  if input_organization_id is null or input_supplier_id is null or input_brand_id is null then
    raise exception 'SUPPLIER_PRICE_EXPORT_SCOPE_REQUIRED';
  end if;

  v_page_size := least(greatest(coalesce(input_page_size, 1000), 1), 5000);
  v_search := nullif(pg_catalog.btrim(coalesce(input_search, '')), '');
  v_search_norm := public.normalize_part_code(coalesce(v_search, ''));
  v_original_norm := pg_catalog.regexp_replace(v_search_norm, '^([A-Z]{1,3})([0-9]{6,})$', '\2');
  v_freshness := lower(coalesce(nullif(pg_catalog.btrim(input_freshness), ''), 'all'));
  if v_freshness not in ('all', 'fresh', 'aging', 'stale', 'unknown') then
    raise exception 'SUPPLIER_PRICE_EXPORT_FRESHNESS_INVALID';
  end if;

  select exists(select 1 from public.supplier_current_price_pointers ptr
    where ptr.organization_id=input_organization_id and ptr.supplier_id=input_supplier_id and ptr.brand_id=input_brand_id)
    into v_has_pointer;
  if v_has_pointer then
    select ptr.release_id into v_release_id from public.supplier_current_price_pointers ptr
    join public.supplier_price_publications pub on pub.id=ptr.publication_id
      and pub.release_id=ptr.release_id and pub.organization_id=ptr.organization_id
      and pub.supplier_id=ptr.supplier_id and pub.brand_id=ptr.brand_id and pub.status='published'
    where ptr.organization_id=input_organization_id and ptr.supplier_id=input_supplier_id and ptr.brand_id=input_brand_id;
    -- An invalid pointer intentionally yields no rows; stale legacy prices are not substituted.
    return query with page as materialized (
      select r.* from public.supplier_price_release_rows r
      where r.release_id=v_release_id and r.row_status='accepted' and r.normalized_code=public.normalize_catalog_product_code(r.product_code) and r.buy_price>0 and r.currency='EUR'
          and r.normalized_code ~ '[A-Z0-9]'
          and (v_search is null or r.product_code ilike '%'||v_search||'%' or r.description ilike '%'||v_search||'%'
            or r.oem_no ilike '%'||v_search||'%' or (v_search_norm<>'' and
              (r.normalized_code like v_search_norm||'%' or public.normalize_part_code(r.oem_no) like v_search_norm||'%')))
          and (v_freshness='all'
            or (v_freshness='fresh' and r.valid_from>=current_date-90)
            or (v_freshness='aging' and r.valid_from>=current_date-180 and r.valid_from<current_date-90)
            or (v_freshness='stale' and r.valid_from<current_date-180)
            or (v_freshness='unknown' and r.valid_from is null))
        and (r.product_code collate "C",md5(r.id::text)::uuid)>
          (coalesce(input_after_product_code,'') collate "C",input_after_id)
      order by r.product_code collate "C",md5(r.id::text)::uuid limit v_page_size
    ), total as materialized (
      select count(*)::bigint n from public.supplier_price_release_rows r
      where input_after_product_code is null and r.release_id=v_release_id and r.row_status='accepted' and r.normalized_code=public.normalize_catalog_product_code(r.product_code) and r.buy_price>0 and r.currency='EUR'
          and r.normalized_code ~ '[A-Z0-9]'
          and (v_search is null or r.product_code ilike '%'||v_search||'%' or r.description ilike '%'||v_search||'%'
            or r.oem_no ilike '%'||v_search||'%' or (v_search_norm<>'' and
              (r.normalized_code like v_search_norm||'%' or public.normalize_part_code(r.oem_no) like v_search_norm||'%')))
          and (v_freshness='all'
            or (v_freshness='fresh' and r.valid_from>=current_date-90)
            or (v_freshness='aging' and r.valid_from>=current_date-180 and r.valid_from<current_date-90)
            or (v_freshness='stale' and r.valid_from<current_date-180)
            or (v_freshness='unknown' and r.valid_from is null))
    )
    select case when input_after_product_code is null then t.n else null end,
      md5(p.id::text)::uuid,p.product_code,b.name,p.description,p.oem_no,p.buy_price,p.currency,
      p.valid_from,p.moq,p.order_multiple,p.lead_time_days,p.notes,
      case when p.valid_from is null then 'unknown' when p.valid_from<current_date-180 then 'stale'
        when p.valid_from<current_date-90 then 'aging' else 'fresh' end,p.stock_qty,p.valid_to
    from page p cross join total t
    join public.brands b on b.id=input_brand_id and b.organization_id=input_organization_id
    order by p.product_code collate "C",md5(p.id::text)::uuid;
    return;
  end if;

  return query
  with scoped as not materialized (
    select
      sp.id,
      sp.product_code,
      b.name as brand,
      sp.description,
      sp.oem_no,
      sp.buy_price,
      sp.currency,
      sp.valid_from,
      sp.moq,
      sp.order_multiple,sp.stock_qty,sp.valid_to,
      sp.lead_time_days,
      sp.notes,
      case
        when sp.valid_from is null then 'unknown'
        when sp.valid_from < current_date - interval '180 days' then 'stale'
        when sp.valid_from < current_date - interval '90 days' then 'aging'
        else 'fresh'
      end as freshness
    from public.supplier_prices sp
    join public.brands b
      on b.id = sp.brand_id
     and b.organization_id = input_organization_id
    where sp.organization_id = input_organization_id
      and sp.supplier_id = input_supplier_id
      and sp.brand_id = input_brand_id
      and sp.is_active
      and (
        v_search is null
        or sp.product_code ilike '%' || v_search || '%'
        or coalesce(sp.description, '') ilike '%' || v_search || '%'
        or coalesce(sp.oem_no, '') ilike '%' || v_search || '%'
        or (v_search_norm <> '' and (
          sp.normalized_code = v_search_norm
          or sp.normalized_oem = v_search_norm
          or sp.normalized_code like v_search_norm || '%'
          or sp.normalized_oem like v_search_norm || '%'
          or (pg_catalog.length(v_original_norm) >= 6 and sp.normalized_oem like '%' || v_original_norm || '%')
        ))
      )
      and (
        v_freshness = 'all'
        or (v_freshness = 'fresh' and sp.valid_from >= current_date - interval '90 days')
        or (v_freshness = 'aging' and sp.valid_from >= current_date - interval '180 days' and sp.valid_from < current_date - interval '90 days')
        or (v_freshness = 'stale' and sp.valid_from < current_date - interval '180 days')
        or (v_freshness = 'unknown' and sp.valid_from is null)
      )
      and coalesce(sp.product_code,'') collate "C">=coalesce(input_after_product_code,'') collate "C"
      and (
        input_after_product_code is null
        or coalesce(sp.product_code, '') collate "C" > coalesce(input_after_product_code, '') collate "C"
        or (coalesce(sp.product_code, '') = coalesce(input_after_product_code, '') and input_after_id is not null and sp.id > input_after_id)
      )
  ),
  page as (
    select s.*
    from scoped s
    order by coalesce(s.product_code, '') collate "C" asc, s.id asc
    limit v_page_size
  ),
  first_page_count as materialized (
    select count(*)::bigint as total_count
    from (
      -- Count is deliberately emitted only for the first page. Subsequent
      -- keyset requests never repeat an all-row COUNT/window operation.
      select 1 from public.supplier_prices sp
      join public.brands b on b.id = sp.brand_id and b.organization_id = input_organization_id
      where input_after_product_code is null
        and sp.organization_id = input_organization_id
        and sp.supplier_id = input_supplier_id
        and sp.brand_id = input_brand_id
        and sp.is_active
        and (
          v_search is null
          or sp.product_code ilike '%' || v_search || '%'
          or coalesce(sp.description, '') ilike '%' || v_search || '%'
          or coalesce(sp.oem_no, '') ilike '%' || v_search || '%'
          or (v_search_norm <> '' and (
            sp.normalized_code = v_search_norm
            or sp.normalized_oem = v_search_norm
            or sp.normalized_code like v_search_norm || '%'
            or sp.normalized_oem like v_search_norm || '%'
            or (pg_catalog.length(v_original_norm) >= 6 and sp.normalized_oem like '%' || v_original_norm || '%')
          ))
        )
        and (
          v_freshness = 'all'
          or (v_freshness = 'fresh' and sp.valid_from >= current_date - interval '90 days')
          or (v_freshness = 'aging' and sp.valid_from >= current_date - interval '180 days' and sp.valid_from < current_date - interval '90 days')
          or (v_freshness = 'stale' and sp.valid_from < current_date - interval '180 days')
          or (v_freshness = 'unknown' and sp.valid_from is null)
        )
    ) counted
  )
  select
    case when input_after_product_code is null then fc.total_count else null end,
    p.id,
    p.product_code,
    p.brand,
    p.description,
    p.oem_no,
    p.buy_price,
    p.currency,
    p.valid_from,
    p.moq,
    p.order_multiple,
    p.lead_time_days,
    p.notes,
    p.freshness,p.stock_qty,p.valid_to
  from page p
  cross join first_page_count fc
  order by coalesce(p.product_code, '') collate "C" asc, p.id asc;
end;
$function$;

create or replace function public.cloud_supplier_price_export_commercial_page_v3(
 input_organization_id uuid,input_supplier_id uuid,input_brand_id uuid,input_search text default '',input_freshness text default 'all',
 input_after_product_code text default null,input_after_id uuid default null,input_page_size integer default 1000)
returns table(total_count bigint,price_id uuid,product_code text,brand text,description text,oem_no text,buy_price numeric,currency text,price_date date,moq integer,order_multiple integer,lead_time_days integer,notes text,freshness text,stock_qty integer,valid_to date)
language plpgsql stable security definer set search_path='' as $fn$
begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception 'SUPPLIER_PRICE_EXPORT_SERVICE_ROLE_REQUIRED'; end if;
 if exists(select 1 from supplier_manual_price_internal.entries m where m.organization_id=input_organization_id and m.supplier_id=input_supplier_id and m.brand_id=input_brand_id and m.active and m.valid_from<=current_date) then
   return query select * from supplier_manual_price_internal.export_overlay_page(input_organization_id,input_supplier_id,input_brand_id,input_search,input_freshness,input_after_product_code,input_after_id,input_page_size);
 else
   return query select * from supplier_manual_price_internal.export_original_page(input_organization_id,input_supplier_id,input_brand_id,input_search,input_freshness,input_after_product_code,input_after_id,input_page_size);
 end if;
end $fn$;
revoke all on function supplier_manual_price_internal.export_original_page(uuid,uuid,uuid,text,text,text,uuid,integer) from public,anon,authenticated,service_role;
revoke all on function supplier_manual_price_internal.export_overlay_page(uuid,uuid,uuid,text,text,text,uuid,integer) from public,anon,authenticated,service_role;
