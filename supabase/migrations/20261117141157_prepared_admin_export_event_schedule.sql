-- Successful admin exports use the same event-led schedule as customer
-- prepared lists; failed refreshes retain a bounded retry. No prices change.
create or replace function public.finish_prepared_admin_export_profile(input_id uuid,input_lease_token uuid,input_revision bigint,input_error_code text default null)
returns boolean language plpgsql security definer set search_path='' set timezone='UTC' as $fn$
begin
 update public.prepared_admin_export_profiles p set
  next_check_at=case
   when input_error_code is not null and input_error_code<>'PREPARED_PRICE_SOURCE_UNAVAILABLE' then pg_catalog.clock_timestamp()+interval '15 minutes'
   when p.revision<>input_revision then 'epoch'::timestamptz
   else least(pg_catalog.clock_timestamp()+interval '7 days',coalesce(public.prepared_price_next_boundary(p.organization_id,p.brand_id),'infinity'::timestamptz)) end,
  last_checked_at=pg_catalog.clock_timestamp(),last_error_code=input_error_code,lease_token=null,lease_expires_at=null
 where p.id=input_id and p.lease_token=input_lease_token;
 return found;
end;
$fn$;
revoke all on function public.finish_prepared_admin_export_profile(uuid,uuid,bigint,text) from public,anon,authenticated;
grant execute on function public.finish_prepared_admin_export_profile(uuid,uuid,bigint,text) to service_role;
