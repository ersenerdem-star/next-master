-- A profile is woken by source/profile events. Retain a weekly reconciliation
-- and explicitly schedule date boundaries (including future manual prices).
create function public.prepared_price_next_boundary(input_org uuid, input_brand uuid)
returns timestamptz language sql stable security definer set search_path='' set timezone='UTC' as $fn$
with pointers as materialized (
  select ptr.*, pub.status publication_status
  from public.supplier_current_price_pointers ptr
  left join public.supplier_price_publications pub on pub.id=ptr.publication_id
    and pub.release_id=ptr.release_id and pub.organization_id=ptr.organization_id
    and pub.supplier_id=ptr.supplier_id and pub.brand_id=ptr.brand_id
  where ptr.organization_id=input_org and ptr.brand_id=input_brand
), boundaries as (
  select min(d.boundary) boundary from pointers ptr cross join lateral (
    (select rr.valid_from boundary from public.supplier_price_release_rows rr
     where ptr.publication_status='published' and rr.release_id=ptr.release_id
       and rr.row_status='accepted' and rr.buy_price>0 and rr.currency='EUR'
       and rr.valid_from>current_date order by rr.valid_from limit 1)
    union all
    (select rr.valid_to+1 from public.supplier_price_release_rows rr
     where ptr.publication_status='published' and rr.release_id=ptr.release_id
       and rr.row_status='accepted' and rr.buy_price>0 and rr.currency='EUR'
       and rr.valid_to>=current_date and rr.valid_to<'infinity'::date order by rr.valid_to limit 1)
  ) d
  union all
  select min(d.boundary) from (
    (select sp.valid_from boundary from public.supplier_prices sp
     where sp.organization_id=input_org and sp.brand_id=input_brand and sp.is_active
       and sp.buy_price>0 and sp.currency='EUR' and sp.valid_from>current_date
       and not exists(select 1 from pointers ptr where ptr.supplier_id=sp.supplier_id)
     order by sp.valid_from limit 1)
    union all
    (select sp.valid_to+1 from public.supplier_prices sp
     where sp.organization_id=input_org and sp.brand_id=input_brand and sp.is_active
       and sp.buy_price>0 and sp.currency='EUR' and sp.valid_to>=current_date
       and sp.valid_to<'infinity'::date
       and not exists(select 1 from pointers ptr where ptr.supplier_id=sp.supplier_id)
     order by sp.valid_to limit 1)
  ) d
  union all
  select min(m.valid_from) from supplier_manual_price_internal.entries m
    where m.organization_id=input_org and m.brand_id=input_brand and m.active and m.valid_from>current_date
)
select min(boundary)::timestamp at time zone 'UTC' from boundaries;
$fn$;
revoke all on function public.prepared_price_next_boundary(uuid,uuid) from public,anon,authenticated,service_role;

create or replace function public.finish_prepared_price_profile(input_id uuid,input_lease_token uuid,input_revision bigint,input_error_code text default null)
returns boolean language plpgsql security definer set search_path='' set timezone='UTC' as $fn$
begin
  update public.prepared_price_export_profiles p set
    next_check_at=case
      when input_error_code is not null and input_error_code<>'PREPARED_PRICE_SOURCE_UNAVAILABLE'
        then pg_catalog.clock_timestamp()+interval '15 minutes'
      when p.revision<>input_revision then 'epoch'::timestamptz
      else least(pg_catalog.clock_timestamp()+interval '7 days',
        coalesce(public.prepared_price_next_boundary(p.organization_id,p.brand_id),'infinity'::timestamptz)) end,
    last_checked_at=pg_catalog.clock_timestamp(),last_error_code=input_error_code,lease_token=null,lease_expires_at=null
  where p.id=input_id and p.lease_token=input_lease_token;
  return found;
end;
$fn$;
revoke all on function public.finish_prepared_price_profile(uuid,uuid,bigint,text) from public,anon,authenticated;
grant execute on function public.finish_prepared_price_profile(uuid,uuid,bigint,text) to service_role;
