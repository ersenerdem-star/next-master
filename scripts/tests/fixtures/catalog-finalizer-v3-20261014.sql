CREATE OR REPLACE FUNCTION public.finalize_catalog_import_batch_system(input_run_id uuid, input_organization_id uuid, input_actor_id uuid, input_batch_size integer DEFAULT 500)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_actor_org uuid; v_actor_role text; v_result jsonb; v_cleanup_required boolean := false;
begin
 select organization_id,lower(role::text) into v_actor_org,v_actor_role from public.profiles where id=input_actor_id and is_active=true;
 if v_actor_org is null or v_actor_org<>input_organization_id or v_actor_role not in ('admin','superadmin') then raise exception 'System finalization actor is not an active organization admin'; end if;
 perform set_config('request.jwt.claim.sub',input_actor_id::text,true);
 if to_regprocedure('public.finalize_catalog_import_batch(uuid,integer)') is not null then execute 'select public.finalize_catalog_import_batch($1,$2)' into v_result using input_run_id,greatest(1,least(coalesce(input_batch_size,500),1000)); else execute 'select public.finalize_catalog_import($1)' into v_result using input_run_id; v_result:=v_result||jsonb_build_object('has_more',false); end if;
 if coalesce(v_result->>'has_more','true')='false' and coalesce(v_result->>'status','') in ('finalized','succeeded') then
  update public.catalog_import_sources set status='completed',completed_at=coalesce(completed_at,now()),lease_owner=null,lease_token=null,lease_expires_at=null,updated_at=now() where run_id=input_run_id and organization_id=input_organization_id and status in ('uploaded','processing','staged');
  select exists(select 1 from public.catalog_import_sources where run_id=input_run_id and organization_id=input_organization_id and status='completed' and storage_object_id is not null) into v_cleanup_required;
 end if;
 return v_result||jsonb_build_object('batch_size',greatest(1,least(coalesce(input_batch_size,500),1000)),'storage_cleanup_required',v_cleanup_required);
end; $function$;
