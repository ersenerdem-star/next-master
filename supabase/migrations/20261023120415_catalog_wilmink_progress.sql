set local lock_timeout='2s';
set local statement_timeout='10s';
create function public.get_catalog_wilmink_application_progress(input_org uuid,input_source text)
returns jsonb language plpgsql stable security invoker set search_path='' set statement_timeout='3s' as $$
declare result_value jsonb;
begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception 'BRAND_DISPATCH_SERVICE_REQUIRED';end if;
 if input_source is null or input_source not in('wilmink_kolbenschmidt_v1','wilmink_elring_support_v1','wilmink_ina_support_v1') then raise exception 'WILMINK_SOURCE_UNAVAILABLE';end if;
 select jsonb_build_object(
  'updatedProducts',count(distinct a.catalog_product_id)filter(where a.result->'changes'<>'{}'::jsonb),
  'lastAppliedAt',max(a.applied_at)filter(where a.result->'changes'<>'{}'::jsonb),
  'heldProducts',count(distinct i.observation->'before'->>'id')filter(where i.checkpoint->>'status'='held' or i.observation->'issues' @> '[{"code":"EAN_IDENTITY_CONFLICT"}]'::jsonb),
  'pendingProducts',count(*)filter(where a.job_id is null and j.status in('reviewed','queued','running','paused')
   and i.state<>'completed' and i.observation->>'unavailable' is null
   and not coalesce(i.observation->'issues' @> '[{"code":"EAN_IDENTITY_CONFLICT"}]'::jsonb,false)
   and i.observation->'fields'<>'{}'::jsonb)) into result_value
 from public.catalog_brand_jobs j join public.catalog_brand_job_items i on i.job_id=j.id and i.organization_id=j.organization_id
 left join public.catalog_brand_item_applications a on a.job_id=i.job_id and a.item_index=i.item_index and a.organization_id=j.organization_id
 where j.organization_id=input_org and j.manifest->>'source_key'=input_source and j.manifest->>'adapter'='brand-exact.v1';
 return result_value;
end$$;
revoke all on function public.get_catalog_wilmink_application_progress(uuid,text) from public,anon,authenticated;
grant execute on function public.get_catalog_wilmink_application_progress(uuid,text) to service_role;
select pg_notify('pgrst','reload schema');
