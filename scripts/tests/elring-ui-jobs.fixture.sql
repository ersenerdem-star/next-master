-- Disposable DB only, after elring-guarded-enrichment.fixture.sql.
\set ON_ERROR_STOP on
create table public.organizations(id uuid primary key);
insert into public.organizations values('00000000-0000-0000-0000-000000000001');
create table public.profiles(id uuid,organization_id uuid,role text,is_active boolean);
insert into public.profiles values('00000000-0000-0000-0000-000000000010','00000000-0000-0000-0000-000000000001','superadmin',true);
create function public.current_profile_org_id() returns uuid language sql stable as $$select null::uuid$$;
create function public.current_profile_role() returns text language sql stable as $$select ''::text$$;
create function public.normalize_part_code(text) returns text language sql immutable as $$select upper(regexp_replace($1,'[^a-zA-Z0-9]','','g'))$$;
update public.catalog_external_sources set metadata=metadata||'{"internal_observation_allowed":true,"automated_read_only_approved":true}';
\i :jobs_migration_file
set test.role='service_role';
do $$ declare j jsonb;again jsonb;worker jsonb;second_worker jsonb;second_job jsonb; begin
 j:=public.start_catalog_elring_job('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000010','["115.100"]','pc','00000000-0000-0000-0000-000000000020');
 again:=public.start_catalog_elring_job('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000010','["115.100"]','pc','00000000-0000-0000-0000-000000000020');
 if j->>'id'<>again->>'id' or (select count(*) from public.catalog_elring_job_items)<>1 then raise exception 'TEST: duplicate start'; end if;
 begin
  perform public.start_catalog_elring_job('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000010','["999.000"]','pc','00000000-0000-0000-0000-000000000020');
  raise exception 'TEST: request key conflict ignored';
 exception when raise_exception then if sqlerrm<>'Elring request key conflict' then raise; end if; end;
 worker:=public.claim_catalog_elring_job('00000000-0000-0000-0000-000000000001',(j->>'id')::uuid);
 second_worker:=public.claim_catalog_elring_job('00000000-0000-0000-0000-000000000001',(j->>'id')::uuid);
 if worker->>'lease_token' is null or second_worker is not null then raise exception 'TEST: duplicate claim'; end if;
 second_job:=public.start_catalog_elring_job('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000010','["300.000"]','pc','00000000-0000-0000-0000-000000000021');
 if public.claim_catalog_elring_job('00000000-0000-0000-0000-000000000001',(second_job->>'id')::uuid) is not null then raise exception 'TEST: source concurrency exceeded'; end if;
 begin
  perform public.checkpoint_catalog_elring_job('00000000-0000-0000-0000-000000000001',(j->>'id')::uuid,gen_random_uuid(),0,null,'{}','reviewed',null,true);
  raise exception 'TEST: forged lease accepted';
 exception when raise_exception then if sqlerrm<>'Elring worker lease lost' then raise; end if; end;
 perform public.checkpoint_catalog_elring_job('00000000-0000-0000-0000-000000000001',(j->>'id')::uuid,(worker->>'lease_token')::uuid,0,'{"fields":{"product_code":"115.100"}}','{"sealed":true}','reviewed',null,true);
 if not exists(select 1 from public.catalog_elring_jobs where id=(j->>'id')::uuid and status='reviewed' and next_index=1) then raise exception 'TEST: reviewed reported as published'; end if;
 perform public.schedule_catalog_elring_job('00000000-0000-0000-0000-000000000001',(j->>'id')::uuid,true);
 second_worker:=public.claim_catalog_elring_job('00000000-0000-0000-0000-000000000001',(j->>'id')::uuid);
 if second_worker->>'mode'<>'publish' or second_worker->>'next_index'<>'0' then raise exception 'TEST: publication cursor'; end if;
 begin
  perform public.heartbeat_catalog_elring_job('00000000-0000-0000-0000-000000000001',(j->>'id')::uuid,(worker->>'lease_token')::uuid);
  raise exception 'TEST: stale worker not fenced';
 exception when raise_exception then if sqlerrm<>'Elring worker lease lost' then raise; end if; end;
 perform public.checkpoint_catalog_elring_job('00000000-0000-0000-0000-000000000001',(j->>'id')::uuid,(second_worker->>'lease_token')::uuid,0,'{}','{"state":"reread_verified"}','completed',null,true);
 if not exists(select 1 from public.catalog_elring_jobs where id=(j->>'id')::uuid and status='completed') then raise exception 'TEST: verified completion lost'; end if;
 if has_function_privilege('authenticated','public.claim_catalog_elring_job(uuid,uuid)','execute') or has_table_privilege('authenticated','public.catalog_elring_jobs','insert') then raise exception 'TEST: privilege leak'; end if;
end $$;
select 'ELRING_UI_JOB_CONTRACT_PASSED' as result;
