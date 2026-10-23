-- A broken/disabled profile must yield even when events continue arriving.
create or replace function public.finish_prepared_price_profile(input_id uuid,input_lease_token uuid,input_revision bigint,input_error_code text default null)
returns boolean language plpgsql security definer set search_path='' as $fn$
begin
  update public.prepared_price_export_profiles set
    next_check_at=case
      when input_error_code is not null then pg_catalog.clock_timestamp()+interval '15 minutes'
      when revision<>input_revision then 'epoch'::timestamptz
      else pg_catalog.clock_timestamp()+interval '15 minutes' end,
    last_checked_at=pg_catalog.clock_timestamp(),last_error_code=input_error_code,lease_token=null,lease_expires_at=null
  where id=input_id and lease_token=input_lease_token;
  return found;
end;
$fn$;
revoke all on function public.finish_prepared_price_profile(uuid,uuid,bigint,text) from public,anon,authenticated;
grant execute on function public.finish_prepared_price_profile(uuid,uuid,bigint,text) to service_role;
