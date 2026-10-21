-- Code matches and held metadata can overlap: an EAN conflict holds every
-- proposed field even when the manufacturer article itself matches exactly.
create or replace function public.get_catalog_wilmink_status(input_org uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare scan text;result_value jsonb;
begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception 'WILMINK_SERVICE_REQUIRED';end if;
 select manifest->>'scan_id' into scan from public.catalog_brand_jobs where organization_id=input_org and manifest->>'adapter'='wilmink-kolbenschmidt-discovery.v1' order by created_at desc limit 1;
 if scan is null then return null;end if;
 select jsonb_build_object('pages',count(*)filter(where j.status='reviewed'),'lastPage',max((coalesce(i.observation->'page',i.checkpoint->'page')->>'lastPage')::integer),'observed',coalesce(sum((i.checkpoint->>'observed')::integer),0),
 'matched',coalesce(sum((i.checkpoint->>'matched')::integer),0),
 'held',coalesce(sum((select count(*) from jsonb_array_elements(coalesce(i.observation->'products','[]'::jsonb))v where v->>'unavailable' is not null or v->'issues' @> '[{"code":"EAN_IDENTITY_CONFLICT"}]'::jsonb)),0),
 'failed',count(*)filter(where j.status='failed'),'active',count(*)filter(where j.status in('queued','running','paused')))
 into result_value from public.catalog_brand_jobs j join public.catalog_brand_job_items i on i.job_id=j.id where j.organization_id=input_org and j.manifest->>'adapter'='wilmink-kolbenschmidt-discovery.v1' and j.manifest->>'scan_id'=scan;
 return result_value;
end$$;
revoke all on function public.get_catalog_wilmink_status(uuid) from public,anon,authenticated;
grant execute on function public.get_catalog_wilmink_status(uuid) to service_role;
