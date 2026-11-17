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
