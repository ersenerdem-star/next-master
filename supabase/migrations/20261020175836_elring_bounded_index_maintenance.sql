set statement_timeout='5s';set lock_timeout='250ms';
create function public.maintain_elring_completion_index(input_run_id uuid,input_index text)
returns jsonb language plpgsql security definer set search_path=public,pg_temp
set statement_timeout='45s' set lock_timeout='250ms'
as $$
declare pages bigint;started timestamptz:=clock_timestamp();
begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception 'Service role required'; end if;
 if input_index is null or input_index not in ('idx_catalog_products_search_text_trgm','idx_catalog_products_desc_trgm',
  'idx_catalog_products_oem_trgm','idx_catalog_products_product_code_trgm','idx_catalog_products_normalized_code_trgm','idx_catalog_products_normalized_oem_trgm')
 then raise exception 'Unapproved maintenance index'; end if;
 if not exists(select 1 from public.catalog_elring_completion_jobs j join public.catalog_external_sources s
   on s.id=j.source_id and s.organization_id=j.organization_id
   where j.run_id=input_run_id and j.approved_until>now() and j.status in ('approved','running','completed')
    and s.source_key='tecalliance_elring' and s.is_active=false and s.license_posture='allowed')
 then raise exception 'Elring maintenance approval unavailable'; end if;
 perform set_config('application_name','elring_maint_'||input_run_id::text,true);
 pages:=pg_catalog.gin_clean_pending_list(('public.'||input_index)::regclass);
 return jsonb_build_object('index',input_index,'pages',pages,'database_ms',extract(epoch from clock_timestamp()-started)*1000);
end $$;
create function public.cancel_elring_completion_maintenance(input_run_id uuid)
returns integer language plpgsql security definer set search_path=public,pg_temp as $$
declare cancelled integer;
begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception 'Service role required'; end if;
 if not exists(select 1 from public.catalog_elring_completion_jobs where run_id=input_run_id and approved_until>now())
 then raise exception 'Elring maintenance approval unavailable'; end if;
 select count(*) into cancelled from pg_catalog.pg_stat_activity
  where application_name='elring_maint_'||input_run_id::text and state='active' and pid<>pg_backend_pid() and pg_catalog.pg_cancel_backend(pid);
 return cancelled;
end $$;
revoke all on function public.maintain_elring_completion_index(uuid,text),public.cancel_elring_completion_maintenance(uuid) from public,anon,authenticated;
grant execute on function public.maintain_elring_completion_index(uuid,text),public.cancel_elring_completion_maintenance(uuid) to service_role;
notify pgrst,'reload schema';
