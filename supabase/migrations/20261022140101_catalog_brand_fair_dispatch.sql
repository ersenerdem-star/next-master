set local lock_timeout='2s';
set local statement_timeout='10s';

-- Selection is read-only. Existing signed workers still acquire the sole
-- organization lease; selecting a job does not reset its cursor or approval.
create function public.next_catalog_brand_dispatch()
returns jsonb language plpgsql stable security invoker set search_path=''
set statement_timeout='3s' as $$
declare result_value jsonb;
begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception 'BRAND_DISPATCH_SERVICE_REQUIRED';end if;
 with lanes as (
  select organization_id,manifest->>'source_key' source_key,manifest->>'brand' brand,max(updated_at) last_activity
  from public.catalog_brand_jobs group by organization_id,manifest->>'source_key',manifest->>'brand'
 )
 select jsonb_build_object('id',j.id,'organization_id',j.organization_id,'status',j.status)
 into result_value
 from public.catalog_brand_jobs j
 join lanes l on l.organization_id=j.organization_id and l.source_key=j.manifest->>'source_key' and l.brand=j.manifest->>'brand'
 join public.catalog_external_sources s on s.organization_id=j.organization_id and s.source_key=l.source_key
 where s.is_active and s.metadata->'allowed_brands' ? l.brand
 and (j.status='queued' or (j.status='paused' and (j.retry_after is null or j.retry_after<=now()))
  or (j.status='running' and j.lease_expires_at<=now()))
 and not exists(select 1 from public.catalog_brand_jobs active_job
  where active_job.organization_id=j.organization_id and active_job.status='running' and active_job.lease_expires_at>now())
 order by l.last_activity,j.updated_at,j.created_at,j.id limit 1;
 return result_value;
end$$;
revoke all on function public.next_catalog_brand_dispatch() from public,anon,authenticated;
grant execute on function public.next_catalog_brand_dispatch() to service_role;
select pg_notify('pgrst','reload schema');
