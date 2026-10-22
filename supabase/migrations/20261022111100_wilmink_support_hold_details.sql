set local lock_timeout='2s';
set local statement_timeout='15s';
create or replace function public.get_catalog_wilmink_support_status(input_org uuid,input_brand text)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare scan text;result_value jsonb;
begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception 'WILMINK_SERVICE_REQUIRED';end if;
 if input_brand is null or input_brand not in('Elring','INA') then raise exception 'WILMINK_BRAND_UNAVAILABLE';end if;
 select manifest->>'scan_id' into scan from public.catalog_brand_jobs where organization_id=input_org and manifest->>'adapter'='wilmink-support-discovery.v1' and manifest->>'brand'=input_brand order by created_at desc limit 1;
 if scan is null then return null;end if;
 select jsonb_build_object('pages',count(*)filter(where j.status='reviewed'),'lastPage',max((coalesce(i.observation->'page',i.checkpoint->'page')->>'lastPage')::integer),'observed',coalesce(sum((i.checkpoint->>'observed')::integer),0),
 'matched',coalesce(sum((i.checkpoint->>'matched')::integer),0),
 'held',coalesce(sum((select count(*) from jsonb_array_elements(coalesce(i.observation->'products','[]'::jsonb))v where v->>'unavailable' is not null or v->'issues' @> '[{"code":"EAN_IDENTITY_CONFLICT"}]'::jsonb)),0),
 'failed',count(*)filter(where j.status='failed'),'active',count(*)filter(where j.status in('queued','running','paused')))
 into result_value from public.catalog_brand_jobs j join public.catalog_brand_job_items i on i.job_id=j.id where j.organization_id=input_org and j.manifest->>'adapter'='wilmink-support-discovery.v1' and j.manifest->>'brand'=input_brand and j.manifest->>'scan_id'=scan;
 result_value:=result_value||jsonb_build_object('heldItems',coalesce((select jsonb_agg(x) from (
 select v->>'code' as code,v->>'sourceUrl' as "sourceUrl",coalesce(v->>'unavailable','EAN_IDENTITY_CONFLICT') as reason
 from public.catalog_brand_jobs j join public.catalog_brand_job_items i on i.job_id=j.id
 cross join lateral jsonb_array_elements(coalesce(i.observation->'products','[]'::jsonb)) v
 where j.organization_id=input_org and j.manifest->>'adapter'='wilmink-support-discovery.v1' and j.manifest->>'brand'=input_brand and j.manifest->>'scan_id'=scan
 and (v->>'unavailable' is not null or v->'issues' @> '[{"code":"EAN_IDENTITY_CONFLICT"}]'::jsonb)
 order by j.created_at desc limit 25)x),'[]'::jsonb));
 return result_value;
end$$;
revoke all on function public.get_catalog_wilmink_support_status(uuid,text) from public,anon,authenticated;
grant execute on function public.get_catalog_wilmink_support_status(uuid,text) to service_role;
select pg_notify('pgrst','reload schema');
