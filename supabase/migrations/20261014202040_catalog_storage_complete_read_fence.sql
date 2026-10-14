-- Storage CSVs are not ready merely because a queue marker or last batch exists.
-- A fenced full-read receipt is committed only after the worker's independent
-- preflight/parser totals agree. Historical terminal runs are not backfilled.
create schema if not exists catalog_storage_internal;
revoke all on schema catalog_storage_internal from public,anon,authenticated,service_role;
alter table public.catalog_import_sources
 add column read_completed_at timestamptz,
 add column read_complete_rows bigint,
 add constraint catalog_source_read_complete_shape check (
  (read_completed_at is null and read_complete_rows is null)
  or (read_completed_at is not null and read_complete_rows is not null and read_complete_rows>0)
 );
create table catalog_storage_internal.read_completion_receipts (
 source_id uuid primary key,
 run_id uuid not null unique,
 organization_id uuid not null,
 actor_id uuid not null,
 source_sha256 text not null check(source_sha256~'^[0-9a-f]{64}$'),
 source_bytes bigint not null check(source_bytes>0),
 source_path text not null,
 storage_object_id uuid not null,
 sealed_object_version text not null,
 total_rows bigint not null check(total_rows>0),
 cursor_row bigint not null check(cursor_row=total_rows-1),
 lease_generation bigint not null check(lease_generation>0),
 batches_sha256 text not null check(batches_sha256~'^[0-9a-f]{64}$'),
 completed_at timestamptz not null default clock_timestamp(),
 foreign key(source_id,run_id,organization_id)
 references public.catalog_import_sources(id,run_id,organization_id)
);
alter table catalog_storage_internal.read_completion_receipts enable row level security;
revoke all on table catalog_storage_internal.read_completion_receipts from public,anon,authenticated,service_role;

create function catalog_storage_internal.immutable_read_receipt()
returns trigger language plpgsql security definer set search_path='' as $$
begin raise exception 'CATALOG_STORAGE_READ_RECEIPT_IMMUTABLE';end $$;
revoke all on function catalog_storage_internal.immutable_read_receipt() from public,anon,authenticated,service_role;
create trigger catalog_read_receipt_immutable before update or delete on catalog_storage_internal.read_completion_receipts
 for each row execute function catalog_storage_internal.immutable_read_receipt();

create function catalog_storage_internal.assert_read_complete(input_run_id uuid,input_organization_id uuid,input_actor_id uuid)
returns void language plpgsql security definer set search_path='' as $$
declare s public.catalog_import_sources%rowtype;r public.catalog_import_runs%rowtype;c catalog_storage_internal.read_completion_receipts%rowtype;
begin
 perform public.catalog_storage_assert_system_actor(input_organization_id,input_actor_id);
 -- NOWAIT also makes the run-trigger safety net fail closed if an older caller
 -- already holds the run lock while ingestion holds source -> run.
 begin
  select * into s from public.catalog_import_sources where run_id=input_run_id for update nowait;
 exception when lock_not_available then raise exception 'CATALOG_STORAGE_SOURCE_NOT_READY';end;
 select * into r from public.catalog_import_runs where id=input_run_id and organization_id=input_organization_id for update;
 if r.id is null then raise exception 'CATALOG_STORAGE_SOURCE_SCOPE';end if;
 if s.id is null then
  if r.input_scope->>'source_kind'='storage_csv' then raise exception 'CATALOG_STORAGE_SOURCE_NOT_READY';end if;
  return; -- Source-less browser/provider paths retain their existing contracts.
 end if;
 if s.organization_id is distinct from input_organization_id or s.created_by is distinct from input_actor_id
  or r.created_by is distinct from input_actor_id then raise exception 'CATALOG_STORAGE_SOURCE_SCOPE';end if;
 -- Existing terminal history remains replayable without inventing new proof.
 if r.status in('finalized','succeeded') and s.status='completed' then return;end if;
 select * into c from catalog_storage_internal.read_completion_receipts where source_id=s.id;
 if c.source_id is null or s.status<>'staged'
  or c.run_id is distinct from r.id or c.organization_id is distinct from s.organization_id or c.actor_id is distinct from s.created_by
  or c.source_sha256 is distinct from s.checksum_sha256 or c.source_bytes is distinct from s.total_bytes
  or c.source_path is distinct from s.storage_object_path or c.storage_object_id is distinct from s.storage_object_id or c.sealed_object_version is distinct from s.sealed_object_version
  or s.read_completed_at is distinct from c.completed_at or s.read_complete_rows is distinct from c.total_rows
  or s.cursor_row is distinct from c.cursor_row or s.rows_parsed is distinct from c.total_rows or s.rows_staged is distinct from c.total_rows
 then raise exception 'CATALOG_STORAGE_SOURCE_NOT_READY';end if;
end $$;
revoke all on function catalog_storage_internal.assert_read_complete(uuid,uuid,uuid) from public,anon,authenticated,service_role;

-- A full source does not imply that every row has finished validation.
create function catalog_storage_internal.assert_finalization_ready(input_run_id uuid,input_organization_id uuid,input_actor_id uuid)
returns void language plpgsql security definer set search_path='' as $$
declare r public.catalog_import_runs%rowtype;v_total bigint;
begin
 perform catalog_storage_internal.assert_read_complete(input_run_id,input_organization_id,input_actor_id);
 select * into r from public.catalog_import_runs where id=input_run_id and organization_id=input_organization_id;
 if r.status in('finalized','succeeded') then return;end if;
 select total_rows into v_total from catalog_storage_internal.read_completion_receipts where run_id=input_run_id;
 if v_total is not null and (r.staged_rows is distinct from v_total or r.valid_rows is distinct from v_total
  or r.error_rows is distinct from 0 or (coalesce(r.insert_rows,0)+coalesce(r.update_rows,0)+coalesce(r.skip_rows,0)) is distinct from v_total)
 then raise exception 'CATALOG_STORAGE_VALIDATION_INCOMPLETE';end if;
end $$;
revoke all on function catalog_storage_internal.assert_finalization_ready(uuid,uuid,uuid) from public,anon,authenticated,service_role;

create function catalog_storage_internal.assert_stage_open(input_run_id uuid,input_organization_id uuid,input_actor_id uuid)
returns void language plpgsql security definer set search_path='' as $$
declare s public.catalog_import_sources%rowtype;
begin
 select * into s from public.catalog_import_sources where run_id=input_run_id for update;
 if s.id is null then return;end if;
 perform public.catalog_storage_assert_system_actor(input_organization_id,input_actor_id);
 if s.organization_id is distinct from input_organization_id or s.created_by is distinct from input_actor_id then raise exception 'CATALOG_STORAGE_SOURCE_SCOPE';end if;
 perform 1 from public.catalog_import_runs where id=input_run_id and organization_id=input_organization_id for update;
 if exists(select 1 from catalog_storage_internal.read_completion_receipts where source_id=s.id)
 then raise exception 'CATALOG_STORAGE_READ_ALREADY_COMPLETE';end if;
end $$;
revoke all on function catalog_storage_internal.assert_stage_open(uuid,uuid,uuid) from public,anon,authenticated,service_role;

create function public.complete_catalog_import_storage_read_system(
 input_run_id uuid,input_organization_id uuid,input_actor_id uuid,input_worker_id text,input_lease_token uuid,input_lease_generation bigint,input_total_rows bigint
) returns jsonb language plpgsql security definer set search_path='' as $$
declare s public.catalog_import_sources%rowtype;r public.catalog_import_runs%rowtype;c catalog_storage_internal.read_completion_receipts%rowtype;
 v_count bigint;v_distinct bigint;v_min bigint;v_max bigint;v_batch_rows bigint;v_bad bigint;v_finals bigint;v_batch_hash text;v_completed timestamptz;
begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception 'CATALOG_STORAGE_SERVICE_REQUIRED';end if;
 if input_run_id is null or input_organization_id is null or input_actor_id is null or nullif(btrim(input_worker_id),'') is null
  or input_lease_token is null or input_lease_generation is null or input_lease_generation<1 or input_total_rows is null or input_total_rows<1 or input_total_rows>2147483647
 then raise exception 'CATALOG_STORAGE_READ_INPUT_INVALID';end if;
 perform public.catalog_storage_assert_system_actor(input_organization_id,input_actor_id);
 select * into s from public.catalog_import_sources where run_id=input_run_id and organization_id=input_organization_id and created_by=input_actor_id for update;
 if s.id is null then raise exception 'CATALOG_STORAGE_SOURCE_SCOPE';end if;
 select * into r from public.catalog_import_runs where id=input_run_id and organization_id=input_organization_id and created_by=input_actor_id for update;
 if r.id is null then raise exception 'CATALOG_STORAGE_SOURCE_SCOPE';end if;
 select * into c from catalog_storage_internal.read_completion_receipts where source_id=s.id;
 if c.source_id is not null then
  if c.total_rows is distinct from input_total_rows or c.source_sha256 is distinct from s.checksum_sha256 or c.source_bytes is distinct from s.total_bytes
   or c.cursor_row is distinct from s.cursor_row or c.run_id is distinct from r.id or c.actor_id is distinct from input_actor_id
  then raise exception 'CATALOG_STORAGE_READ_RECEIPT_CONFLICT';end if;
  return jsonb_build_object('queued',true,'status','queued','run_id',r.id,'source_id',s.id,'read_complete_rows',c.total_rows,'read_completed_at',c.completed_at,'replayed',true);
 end if;
 if r.status in('failed','cancelled','finalized','succeeded','validation_failed','finalize_failed') then raise exception 'CATALOG_STORAGE_RUN_TERMINAL:%',r.status;end if;
 if s.lease_owner is distinct from input_worker_id or s.lease_token is distinct from input_lease_token
  or s.lease_generation is distinct from input_lease_generation or s.lease_expires_at is null or s.lease_expires_at<=clock_timestamp()
 then raise exception 'CATALOG_STORAGE_LEASE_FENCE';end if;
 if s.status not in('processing','staged') or s.verified_at is null or s.verified_lease_generation is distinct from input_lease_generation
  or s.checksum_sha256 is null or s.checksum_sha256!~'^[0-9a-f]{64}$' or s.storage_object_id is null or s.sealed_object_version is null
  or (s.admitted_checksum_sha256 is not null and lower(s.admitted_checksum_sha256)<>s.checksum_sha256)
  or s.cursor_row<>input_total_rows-1 or s.rows_parsed<>input_total_rows or s.rows_staged<>input_total_rows
 then raise exception 'CATALOG_STORAGE_READ_COUNT_MISMATCH';end if;
 -- Receipt ranges are the durable parse boundary. Every batch must be complete,
 -- ordered 0..N-1 without holes/overlap, with exactly one final receipt at N-1.
 with ordered as (
  select b.*,lag(cursor_end,1,-1::bigint)over(order by cursor_start,cursor_end) previous_end
  from public.catalog_import_source_batches b where source_id=s.id
 ) select coalesce(sum(payload_rows),0),count(*)filter(where run_id<>r.id or organization_id<>s.organization_id or completed_at is null
   or cursor_start<>previous_end+1 or cursor_end-cursor_start+1<>payload_rows
   or (stage_result->>'staged_count')::bigint is distinct from payload_rows::bigint),
  count(*)filter(where is_final),max(cursor_end),
  public.catalog_provider_jsonb_sha256(coalesce(jsonb_agg(jsonb_build_array(cursor_start,cursor_end,payload_sha256,payload_rows,is_final)order by cursor_start,cursor_end),'[]'::jsonb))
 into v_batch_rows,v_bad,v_finals,v_max,v_batch_hash from ordered;
 if v_batch_rows<>input_total_rows or v_bad<>0 or v_finals<>1 or v_max<>input_total_rows-1
  or not exists(select 1 from public.catalog_import_source_batches where source_id=s.id and cursor_end=input_total_rows-1 and is_final and completed_at is not null)
 then raise exception 'CATALOG_STORAGE_READ_RECEIPTS_INCOMPLETE';end if;
 select count(*),count(distinct row_index),min(row_index),max(row_index)
 into v_count,v_distinct,v_min,v_max from public.catalog_import_stage where run_id=r.id and organization_id=s.organization_id;
 if v_count<>input_total_rows or v_distinct<>input_total_rows or v_min<>0 or v_max<>input_total_rows-1
  or exists(select 1 from public.catalog_import_stage where run_id=r.id and organization_id<>s.organization_id)
 then raise exception 'CATALOG_STORAGE_READ_STAGE_INCOMPLETE';end if;
 v_completed:=clock_timestamp();
 insert into catalog_storage_internal.read_completion_receipts(source_id,run_id,organization_id,actor_id,source_sha256,source_bytes,source_path,storage_object_id,sealed_object_version,total_rows,cursor_row,lease_generation,batches_sha256,completed_at)
 values(s.id,r.id,s.organization_id,input_actor_id,s.checksum_sha256,s.total_bytes,s.storage_object_path,s.storage_object_id,s.sealed_object_version,input_total_rows,s.cursor_row,input_lease_generation,v_batch_hash,v_completed);
 update public.catalog_import_sources set status='staged',read_completed_at=v_completed,read_complete_rows=input_total_rows,updated_at=v_completed where id=s.id;
 update public.catalog_import_runs set processing_queued_at=coalesce(processing_queued_at,v_completed),processing_queued_by=coalesce(processing_queued_by,input_actor_id) where id=r.id;
 return jsonb_build_object('queued',true,'status','queued','run_id',r.id,'source_id',s.id,'read_complete_rows',input_total_rows,'read_completed_at',v_completed,'replayed',false);
end $$;
revoke all on function public.complete_catalog_import_storage_read_system(uuid,uuid,uuid,text,uuid,bigint,bigint) from public,anon,authenticated,service_role;
grant execute on function public.complete_catalog_import_storage_read_system(uuid,uuid,uuid,text,uuid,bigint,bigint) to service_role;

-- Catch older direct validation/finalization callers too. Their transaction
-- rolls back before partial catalog work can commit; the normal entrypoints
-- below acquire source -> run first, so this is a nonblocking safety net.
create function catalog_storage_internal.guard_run_readiness()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_total bigint;
begin
 if new.status is distinct from old.status and new.status in('validating','validated','validation_failed','finalizing','finalized','succeeded') then
  perform catalog_storage_internal.assert_read_complete(new.id,new.organization_id,new.created_by);
  select total_rows into v_total from catalog_storage_internal.read_completion_receipts where run_id=new.id;
  if v_total is not null and new.status in('finalizing','finalized','succeeded') and (
    new.staged_rows is distinct from v_total or new.valid_rows is distinct from v_total or new.error_rows is distinct from 0
    or (coalesce(new.insert_rows,0)+coalesce(new.update_rows,0)+coalesce(new.skip_rows,0)) is distinct from v_total
    or (new.status in('finalized','succeeded') and (new.processed_rows is distinct from v_total or new.finalize_cursor is distinct from v_total-1)))
  then raise exception 'CATALOG_STORAGE_FINALIZATION_INCOMPLETE';end if;
 end if;
 return new;
end $$;
revoke all on function catalog_storage_internal.guard_run_readiness() from public,anon,authenticated,service_role;
create trigger catalog_storage_run_readiness before update of status on public.catalog_import_runs
 for each row execute function catalog_storage_internal.guard_run_readiness();

-- The service-role queue can update source rows directly; completed mirrors and
-- every receipt-bound identity remain immutable even through that narrow path.
create function catalog_storage_internal.guard_source_read_receipt()
returns trigger language plpgsql security definer set search_path='' as $$
declare c catalog_storage_internal.read_completion_receipts%rowtype;
begin
 select * into c from catalog_storage_internal.read_completion_receipts where source_id=old.id;
 if c.source_id is not null and (
  new.read_completed_at is distinct from c.completed_at or new.read_complete_rows is distinct from c.total_rows
  or new.cursor_row is distinct from c.cursor_row or new.rows_parsed is distinct from c.total_rows or new.rows_staged is distinct from c.total_rows
  or new.checksum_sha256 is distinct from c.source_sha256 or new.total_bytes is distinct from c.source_bytes
  or new.storage_object_path is distinct from c.source_path
  or (new.storage_object_id is distinct from c.storage_object_id and not(old.status='completed' and new.status='completed' and new.storage_object_id is null and (old.storage_object_id is null or old.storage_object_id=c.storage_object_id)))
  or new.sealed_object_version is distinct from c.sealed_object_version
 ) then raise exception 'CATALOG_STORAGE_READ_RECEIPT_IMMUTABLE';end if;
 return new;
end $$;
revoke all on function catalog_storage_internal.guard_source_read_receipt() from public,anon,authenticated,service_role;
create trigger catalog_storage_source_read_receipt before update on public.catalog_import_sources
 for each row execute function catalog_storage_internal.guard_source_read_receipt();


-- Preserve original signatures/configuration/ACL; only insert the source fence.
do $$begin
 if md5(pg_get_functiondef('claim_catalog_import_storage_source_system(uuid,uuid,uuid,text,integer)'::regprocedure)) <> '47abb975be5397772c7af7429d132887' then raise exception 'CATALOG_STORAGE_READ_BASELINE_DRIFT:claim_catalog_import_storage_source_system';end if;
 if md5(pg_get_functiondef('finalize_catalog_import(uuid)'::regprocedure)) <> '70bd1e1ce7d1183b8b6ff7393dd702a6' then raise exception 'CATALOG_STORAGE_READ_BASELINE_DRIFT:finalize_catalog_import';end if;
 if md5(pg_get_functiondef('finalize_catalog_import_batch(uuid,integer)'::regprocedure)) <> '655e49846046974970670ba4a5d6a770' then raise exception 'CATALOG_STORAGE_READ_BASELINE_DRIFT:finalize_catalog_import_batch';end if;
 -- The captured V3 wrapper differs from production only in whitespace/comments;
 -- exact SQL-token equality is checked by the migration's regression fixture.
 if md5(pg_get_functiondef('finalize_catalog_import_batch_system(uuid,uuid,uuid,integer)'::regprocedure)) not in ('3cedf9ed8542942ce507347803aac051','9130c22cb4eb8bb802597204edae666b') then raise exception 'CATALOG_STORAGE_READ_BASELINE_DRIFT:finalize_catalog_import_batch_system';end if;
 if md5(pg_get_functiondef('mark_catalog_import_storage_processing_queued_system(uuid,uuid,uuid,text,uuid,bigint)'::regprocedure)) <> '7c63b78c5eb40d890ba5b0d8301aa3cc' then raise exception 'CATALOG_STORAGE_READ_BASELINE_DRIFT:mark_catalog_import_storage_processing_queued_system';end if;
 if md5(pg_get_functiondef('stage_catalog_import_chunk(uuid,jsonb)'::regprocedure)) <> 'd32753ab22e73d0639c01055d5f26bc4' then raise exception 'CATALOG_STORAGE_READ_BASELINE_DRIFT:stage_catalog_import_chunk';end if;
 if md5(pg_get_functiondef('validate_catalog_import_storage_batch_system(uuid,uuid,uuid,integer)'::regprocedure)) <> '5e696a7d68467e08bf2543cae64c2436' then raise exception 'CATALOG_STORAGE_READ_BASELINE_DRIFT:validate_catalog_import_storage_batch_system';end if;
end $$;
CREATE OR REPLACE FUNCTION public.claim_catalog_import_storage_source_system(input_source_id uuid, input_organization_id uuid, input_actor_id uuid, input_worker_id text, input_lease_seconds integer DEFAULT 900)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_source public.catalog_import_sources%rowtype;
  v_run public.catalog_import_runs%rowtype;
  v_worker text := nullif(trim(coalesce(input_worker_id,'')),'');
  v_lease integer := coalesce(input_lease_seconds,900);
  v_token uuid := gen_random_uuid();
  v_generation bigint;
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception 'CATALOG_STORAGE_SERVICE_REQUIRED'; end if;
  perform public.catalog_storage_assert_system_actor(input_organization_id,input_actor_id);
  if v_worker is null or length(v_worker)>120 or v_lease<30 or v_lease>3600 then raise exception 'CATALOG_STORAGE_CLAIM_INPUT_INVALID'; end if;
  select * into v_source from public.catalog_import_sources s where s.id=input_source_id and s.organization_id=input_organization_id and s.created_by=input_actor_id for update;
  if not found then raise exception 'CATALOG_STORAGE_SOURCE_SCOPE'; end if;
  select * into v_run from public.catalog_import_runs r where r.id=v_source.run_id and r.organization_id=v_source.organization_id for update;
  if v_run.status in ('failed','cancelled','finalized','succeeded') then raise exception 'CATALOG_STORAGE_RUN_TERMINAL:%',v_run.status; end if;
  -- A staged source with no queue marker is a recoverable handoff window;
  -- uploaded/processing sources still require the run to be queued by the
  -- authenticated browser contract. Once staged and queued, finalization owns
  -- the run and the ingestion worker must not replay it.
  if v_run.processing_queued_at is null and v_source.status <> 'staged' then
    return jsonb_build_object('claimed',false,'status','not_queued','source_id',v_source.id);
  end if;
  if v_source.status = 'staged' and v_run.processing_queued_at is not null
     and exists(select 1 from catalog_storage_internal.read_completion_receipts c where c.source_id=v_source.id) then
    return jsonb_build_object('claimed',false,'status','handed_off','source_id',v_source.id);
  end if;
  if v_source.status not in ('uploaded','processing','staged') or v_source.sealed_object_version is null then return jsonb_build_object('claimed',false,'status',v_source.status,'source_id',v_source.id); end if;
  if v_source.lease_expires_at is not null and v_source.lease_expires_at > now() then return jsonb_build_object('claimed',false,'status','busy','source_id',v_source.id,'lease_expires_at',v_source.lease_expires_at,'lease_owner',v_source.lease_owner); end if;
  v_generation := v_source.lease_generation + 1;
  update public.catalog_import_sources set status='processing',lease_owner=v_worker,lease_token=v_token,lease_generation=v_generation,lease_expires_at=now()+make_interval(secs=>v_lease),attempt_count=attempt_count+1,processing_started_at=coalesce(processing_started_at,now()),updated_at=now() where id=v_source.id;
  return jsonb_build_object('claimed',true,'status','processing','source_id',v_source.id,'run_id',v_source.run_id,'organization_id',v_source.organization_id,'created_by',v_source.created_by,'storage_bucket',v_source.storage_bucket,'storage_object_path',v_source.storage_object_path,'total_bytes',v_source.total_bytes,'checksum_sha256',v_source.checksum_sha256,'cursor_row',v_source.cursor_row,'lease_owner',v_worker,'lease_token',v_token,'lease_generation',v_generation,'attempt_count',v_source.attempt_count+1,'lease_expires_at',now()+make_interval(secs=>v_lease));
end;
$function$;

CREATE OR REPLACE FUNCTION public.finalize_catalog_import(input_run_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_result jsonb;
  v_org_id uuid := public.current_profile_org_id();
begin
  perform catalog_storage_internal.assert_finalization_ready(input_run_id,public.current_profile_org_id(),auth.uid());
  v_result := public.finalize_catalog_import_pre_dimensions(input_run_id);

  update public.catalog_products cp
  set dimensions = s.dimensions,
      updated_at = now()
  from public.catalog_import_stage s
  where s.run_id = input_run_id
    and s.organization_id = v_org_id
    and s.validation_status = 'valid'
    and s.proposed_action in ('insert', 'update')
    and s.dimensions is not null
    and (cp.dimensions is null or cp.dimensions = '{}'::jsonb or cp.dimensions = '[]'::jsonb)
    and cp.organization_id = v_org_id
    and cp.brand_id = (
      select b.id from public.brands b
      where b.organization_id = v_org_id
        and public.normalize_catalog_brand_key(b.name) = public.normalize_catalog_brand_key(s.brand)
      limit 1
    )
    and cp.normalized_code = s.normalized_code;

  return v_result;
end;
$function$;

CREATE OR REPLACE FUNCTION public.finalize_catalog_import_batch(input_run_id uuid, input_batch_size integer DEFAULT 500)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_result jsonb;
  v_org_id uuid := public.current_profile_org_id();
  v_cursor integer;
begin
  perform catalog_storage_internal.assert_finalization_ready(input_run_id,public.current_profile_org_id(),auth.uid());
  v_result := public.finalize_catalog_import_batch_pre_dimensions(input_run_id, input_batch_size);

  select finalize_cursor into v_cursor
  from public.catalog_import_runs
  where id = input_run_id and organization_id = v_org_id;

  if v_cursor is not null then
    update public.catalog_products cp
    set dimensions = s.dimensions,
        updated_at = now()
    from public.catalog_import_stage s
    where s.run_id = input_run_id
      and s.organization_id = v_org_id
      and s.row_index <= v_cursor
      and s.validation_status = 'valid'
      and s.proposed_action in ('insert', 'update')
      and s.dimensions is not null
      and (cp.dimensions is null or cp.dimensions = '{}'::jsonb or cp.dimensions = '[]'::jsonb)
      and cp.organization_id = v_org_id
      and cp.brand_id = (
        select b.id from public.brands b
        where b.organization_id = v_org_id
          and public.normalize_catalog_brand_key(b.name) = public.normalize_catalog_brand_key(s.brand)
        limit 1
      )
      and cp.normalized_code = s.normalized_code;
  end if;

  return v_result;
end;
$function$;

CREATE OR REPLACE FUNCTION public.finalize_catalog_import_batch_system(input_run_id uuid, input_organization_id uuid, input_actor_id uuid, input_batch_size integer DEFAULT 500)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_actor_org uuid;
  v_actor_role text;
  v_result jsonb;
  v_cleanup_required boolean := false;
begin
  select organization_id, lower(role::text) into v_actor_org, v_actor_role
  from public.profiles
  where id = input_actor_id and is_active = true;
  if v_actor_org is null or v_actor_org <> input_organization_id
     or v_actor_role not in ('admin', 'superadmin') then
    raise exception 'System finalization actor is not an active organization admin';
  end if;
  if coalesce(auth.role(),'')<>'service_role' then raise exception 'CATALOG_STORAGE_SERVICE_REQUIRED';end if;
  perform catalog_storage_internal.assert_finalization_ready(input_run_id,input_organization_id,input_actor_id);
  perform set_config('request.jwt.claim.sub', input_actor_id::text, true);

  if to_regprocedure('public.finalize_catalog_import_batch(uuid,integer)') is not null then
    execute 'select public.finalize_catalog_import_batch($1,$2)'
      into v_result
      using input_run_id, greatest(1, least(coalesce(input_batch_size, 500), 1000));
  else
    execute 'select public.finalize_catalog_import($1)'
      into v_result
      using input_run_id;
    v_result := v_result || jsonb_build_object('has_more', false);
  end if;

  -- Mark the source complete only after canonical catalog writes succeed. The
  -- Storage API cleanup runs outside this transaction, so a protected storage
  -- table trigger cannot roll back the finalization itself.
  if coalesce(v_result ->> 'has_more', 'true') = 'false'
     and coalesce(v_result ->> 'status', '') in ('finalized', 'succeeded') then
    update public.catalog_import_sources
    set status = 'completed',
        completed_at = coalesce(completed_at, now()),
        lease_owner = null,
        lease_token = null,
        lease_expires_at = null,
        updated_at = now()
    where run_id = input_run_id
      and organization_id = input_organization_id
      and status = 'staged';
    select exists(
      select 1 from public.catalog_import_sources
      where run_id = input_run_id
        and organization_id = input_organization_id
        and status = 'completed'
        and storage_object_id is not null
    ) into v_cleanup_required;
  end if;

  return v_result || jsonb_build_object(
    'batch_size', greatest(1, least(coalesce(input_batch_size, 500), 1000)),
    'storage_cleanup_required', v_cleanup_required
  );
end;
$function$;

CREATE OR REPLACE FUNCTION public.mark_catalog_import_storage_processing_queued_system(input_run_id uuid, input_organization_id uuid, input_actor_id uuid, input_worker_id text, input_lease_token uuid, input_lease_generation bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_source public.catalog_import_sources%rowtype; v_run public.catalog_import_runs%rowtype; v_now timestamptz:=now();
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception 'CATALOG_STORAGE_SERVICE_REQUIRED'; end if;
  perform public.catalog_storage_assert_system_actor(input_organization_id,input_actor_id);
  perform catalog_storage_internal.assert_read_complete(input_run_id,input_organization_id,input_actor_id);
  select * into v_source from public.catalog_import_sources s where s.run_id=input_run_id and s.organization_id=input_organization_id and s.created_by=input_actor_id for update;
  if not found then raise exception 'CATALOG_STORAGE_SOURCE_SCOPE'; end if;
  select * into v_run from public.catalog_import_runs r where r.id=input_run_id and r.organization_id=input_organization_id for update;
  if v_run.status in ('failed','cancelled','finalized','succeeded') then raise exception 'CATALOG_STORAGE_RUN_TERMINAL:%',v_run.status; end if;
  if v_source.status<>'staged' then raise exception 'CATALOG_STORAGE_SOURCE_NOT_STAGED'; end if;
  if v_source.lease_owner is distinct from input_worker_id or v_source.lease_token is distinct from input_lease_token or v_source.lease_generation is distinct from input_lease_generation or v_source.lease_expires_at is null or v_source.lease_expires_at<=v_now then raise exception 'CATALOG_STORAGE_LEASE_FENCE'; end if;
  update public.catalog_import_runs set processing_queued_at=coalesce(processing_queued_at,v_now),processing_queued_by=coalesce(processing_queued_by,input_actor_id) where id=v_run.id;
  return jsonb_build_object('queued',true,'run_id',v_run.id,'organization_id',v_run.organization_id,'source_id',v_source.id,'source_status',v_source.status,'replayed',v_run.processing_queued_at is not null);
end;
$function$;

CREATE OR REPLACE FUNCTION public.stage_catalog_import_chunk(input_run_id uuid, payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_result jsonb;
  v_org_id uuid := public.current_profile_org_id();
begin
  perform catalog_storage_internal.assert_stage_open(input_run_id,public.current_profile_org_id(),auth.uid());
  v_result := public.stage_catalog_import_chunk_pre_dimensions(input_run_id, payload);

  update public.catalog_import_stage s
  set dimensions = case
    when jsonb_typeof(p.dimensions) in ('object', 'array') then p.dimensions
    else null
  end
  from (
    select
      case
        when nullif(trim(coalesce(item.value->>'row_index', '')), '') ~ '^[0-9]+$'
          then (item.value->>'row_index')::integer
        else null
      end as row_index,
      item.value->'dimensions' as dimensions
    from jsonb_array_elements(coalesce(payload, '[]'::jsonb)) with ordinality as item(value, ordinality)
  ) p
  where s.run_id = input_run_id
    and s.organization_id = v_org_id
    and p.row_index = s.row_index;

  return v_result;
end;
$function$;

CREATE OR REPLACE FUNCTION public.validate_catalog_import_storage_batch_system(input_run_id uuid, input_organization_id uuid, input_actor_id uuid, input_batch_size integer DEFAULT 1000)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_actor_org uuid;
  v_actor_role text;
  v_run public.catalog_import_runs%rowtype;
  v_cursor integer;
  v_next_cursor integer;
  v_batch_size integer := greatest(100, least(coalesce(input_batch_size, 1000), 1000));
  v_batch_count integer := 0;
  v_total integer := 0;
  v_insert integer := 0;
  v_update integer := 0;
  v_skip integer := 0;
  v_error integer := 0;
  v_duplicate integer := 0;
  v_has_more boolean := false;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'CATALOG_STORAGE_SERVICE_REQUIRED';
  end if;

  select organization_id, lower(role::text)
    into v_actor_org, v_actor_role
  from public.profiles
  where id = input_actor_id and is_active = true;
  if v_actor_org is null or v_actor_org <> input_organization_id
     or v_actor_role not in ('admin', 'superadmin') then
    raise exception 'System validation actor is not an active organization admin';
  end if;

  perform catalog_storage_internal.assert_read_complete(input_run_id,input_organization_id,input_actor_id);

  select * into v_run
  from public.catalog_import_runs
  where id = input_run_id and organization_id = input_organization_id
  for update;
  if not found then raise exception 'Catalog import run was not found'; end if;
  if v_run.status in ('failed','cancelled','finalized','succeeded','validation_failed','finalize_failed') then
    return jsonb_build_object('status',v_run.status,'run_id',v_run.id,'has_more',false,'replayed',true);
  end if;

  v_cursor := greatest(coalesce(v_run.validation_cursor, -1), -1);
  update public.catalog_import_runs
  set status = 'validating', error_message = null
  where id = v_run.id and organization_id = input_organization_id;

  with batch_rows as materialized (
    select s.id,
           s.organization_id,
           s.run_id,
           s.row_index,
           s.brand,
           s.product_code,
           s.normalized_code,
           s.description,
           s.oem_no,
           s.hs_code,
           s.origin,
           s.weight_kg,
           s.image_url,
           s.lifecycle_status,
           s.lifecycle_note,
           s.ean,
           s.vehicle,
           s.vehicle_model,
           s.market_segment,
           s.source_url,
           s.source_fingerprint,
           s.description_tr,
           b.id as brand_id,
           cp.id as existing_product_id,
           cp.product_code as existing_product_code,
           cp.description as existing_description,
           cp.oem_no as existing_oem_no,
           cp.hs_code as existing_hs_code,
           cp.origin as existing_origin,
           cp.weight_kg as existing_weight_kg,
           cp.image_url as existing_image_url,
           cp.lifecycle_status as existing_lifecycle_status,
           cp.lifecycle_note as existing_lifecycle_note,
           cp.ean as existing_ean,
           cp.vehicle as existing_vehicle,
           cp.vehicle_model as existing_vehicle_model,
           cp.market_segment as existing_market_segment,
           cp.description_tr as existing_description_tr
    from public.catalog_import_stage s
    left join public.brands b
      on b.organization_id = input_organization_id
     and public.normalize_catalog_brand_key(b.name) = public.normalize_catalog_brand_key(s.brand)
    left join public.catalog_products cp
      on cp.organization_id = input_organization_id
     and cp.brand_id = b.id
     and cp.normalized_code = s.normalized_code
    where s.run_id = v_run.id
      and s.organization_id = input_organization_id
      and s.row_index > v_cursor
    order by s.row_index asc
    limit v_batch_size
  ), scored as (
    select br.*,
      exists (
        select 1
        from public.catalog_import_stage d
        where d.run_id = br.run_id
          and d.organization_id = br.organization_id
          and d.row_index <> br.row_index
          and d.normalized_code = br.normalized_code
          and public.normalize_catalog_brand_key(d.brand) = public.normalize_catalog_brand_key(br.brand)
      ) as duplicate_in_run,
      array_remove(array[
        case when br.existing_product_id is not null and br.product_code is distinct from br.existing_product_code then 'product_code' end,
        case when br.existing_product_id is not null and br.description is distinct from br.existing_description then 'description' end,
        case when br.existing_product_id is not null and br.oem_no is distinct from br.existing_oem_no then 'oem_no' end,
        case when br.existing_product_id is not null and br.hs_code is distinct from br.existing_hs_code then 'hs_code' end,
        case when br.existing_product_id is not null and br.origin is distinct from br.existing_origin then 'origin' end,
        case when br.existing_product_id is not null and br.weight_kg is distinct from br.existing_weight_kg then 'weight_kg' end,
        case when br.existing_product_id is not null and br.image_url is distinct from br.existing_image_url then 'image_url' end,
        case when br.existing_product_id is not null and br.lifecycle_status is distinct from br.existing_lifecycle_status then 'lifecycle_status' end,
        case when br.existing_product_id is not null and br.lifecycle_note is distinct from br.existing_lifecycle_note then 'lifecycle_note' end,
        case when br.existing_product_id is not null and br.ean is distinct from br.existing_ean then 'ean' end,
        case when br.existing_product_id is not null and br.vehicle is distinct from br.existing_vehicle then 'vehicle' end,
        case when br.existing_product_id is not null and br.vehicle_model is distinct from br.existing_vehicle_model then 'vehicle_model' end,
        case when br.existing_product_id is not null and br.market_segment is distinct from public.normalize_catalog_market_segment(br.market_segment) then 'market_segment' end,
        case when br.existing_product_id is not null and br.description_tr is distinct from br.existing_description_tr then 'description_tr' end
      ], null)::text[] as changed_fields
    from batch_rows br
  ), classified as (
    select sc.*,
      case
        when nullif(trim(coalesce(sc.brand, '')), '') is null then 'error'
        when sc.brand_id is null then 'error'
        when nullif(trim(coalesce(sc.product_code, '')), '') is null then 'error'
        when nullif(trim(coalesce(sc.normalized_code, '')), '') is null then 'error'
        when sc.weight_kg is not null and sc.weight_kg <= 0 then 'error'
        when sc.duplicate_in_run then 'error'
        when nullif(trim(coalesce(sc.source_url, '')), '') is not null and sc.source_url !~* '^https://' then 'error'
        when nullif(trim(coalesce(sc.source_fingerprint, '')), '') is not null and sc.source_fingerprint !~ '^[0-9a-fA-F]{64}$' then 'error'
        when sc.existing_product_id is null then 'insert'
        when v_run.mode = 'insert_only' then 'skip'
        when coalesce(cardinality(sc.changed_fields), 0) = 0 then 'skip'
        else 'update'
      end as proposed_action,
      case
        when nullif(trim(coalesce(sc.brand, '')), '') is null then 'Brand is required'
        when sc.brand_id is null then 'Brand was not found in the catalog'
        when nullif(trim(coalesce(sc.product_code, '')), '') is null then 'Product code is required'
        when nullif(trim(coalesce(sc.normalized_code, '')), '') is null then 'Normalized code is required'
        when sc.weight_kg is not null and sc.weight_kg <= 0 then 'Weight must be greater than zero'
        when sc.duplicate_in_run then 'Duplicate brand and product code in this import run'
        when nullif(trim(coalesce(sc.source_url, '')), '') is not null and sc.source_url !~* '^https://' then 'Source URL must use HTTPS'
        when nullif(trim(coalesce(sc.source_fingerprint, '')), '') is not null and sc.source_fingerprint !~ '^[0-9a-fA-F]{64}$' then 'Source fingerprint must be a SHA-256 hex digest'
        when sc.existing_product_id is null then null
        when v_run.mode = 'insert_only' then 'Existing catalog product will be skipped in insert-only mode'
        when coalesce(cardinality(sc.changed_fields), 0) = 0 then 'Existing catalog product already matches staged values'
        else null
      end as validation_message,
      jsonb_build_object(
        'brand_exists', sc.brand_id is not null,
        'existing_product_exists', sc.existing_product_id is not null,
        'existing_product_id', sc.existing_product_id,
        'existing_product_code', sc.existing_product_code,
        'duplicate_in_run', sc.duplicate_in_run,
        'changed_fields', to_jsonb(coalesce(sc.changed_fields, ARRAY[]::text[]))
      ) as conflict_summary
    from scored sc
  ), updated as (
    update public.catalog_import_stage s
    set validation_status = case when c.proposed_action = 'error' then 'error' else 'valid' end,
        validation_message = c.validation_message,
        proposed_action = c.proposed_action,
        conflict_summary = c.conflict_summary
    from classified c
    where s.id = c.id
    returning c.proposed_action, c.duplicate_in_run
  )
  select count(*)::integer,
         coalesce(max((select max(row_index) from batch_rows)), v_cursor),
         count(*) filter (where updated.proposed_action = 'insert')::integer,
         count(*) filter (where updated.proposed_action = 'update')::integer,
         count(*) filter (where updated.proposed_action = 'skip')::integer,
         count(*) filter (where updated.proposed_action = 'error')::integer,
         count(*) filter (where updated.duplicate_in_run)::integer
  into v_batch_count, v_next_cursor, v_insert, v_update, v_skip, v_error, v_duplicate
  from updated;

  if v_batch_count = 0 then
    select coalesce(max(row_index), v_cursor) into v_next_cursor
    from public.catalog_import_stage
    where run_id = v_run.id and organization_id = input_organization_id;
  end if;

  update public.catalog_import_runs
  set validation_cursor = v_next_cursor
  where id = v_run.id and organization_id = input_organization_id;

  select exists(
    select 1 from public.catalog_import_stage
    where run_id = v_run.id and organization_id = input_organization_id and row_index > v_next_cursor
  ) into v_has_more;

  if not v_has_more then
    select count(*)::integer,
           count(*) filter (where s.proposed_action = 'insert')::integer,
           count(*) filter (where s.proposed_action = 'update')::integer,
           count(*) filter (where s.proposed_action = 'skip')::integer,
           count(*) filter (where s.validation_status = 'error')::integer,
           count(*) filter (where coalesce((s.conflict_summary->>'duplicate_in_run')::boolean, false))::integer
    into v_total, v_insert, v_update, v_skip, v_error, v_duplicate
    from public.catalog_import_stage s
    where s.run_id = v_run.id and s.organization_id = input_organization_id;

    update public.catalog_import_runs
    set status = case when v_total = 0 or v_error > 0 then 'validation_failed' else 'validated' end,
        finished_at = case when v_total = 0 or v_error > 0 then now() else null end,
        error_message = case when v_total = 0 then 'Catalog import run has no staged rows' when v_error > 0 then 'Catalog import validation failed' else null end,
        staged_rows = v_total,
        valid_rows = greatest(v_total - v_error, 0),
        error_rows = v_error,
        duplicate_rows = v_duplicate,
        insert_rows = v_insert,
        update_rows = v_update,
        skip_rows = v_skip,
        processed_rows = 0
    where id = v_run.id and organization_id = input_organization_id;
  end if;

  return jsonb_build_object(
    'status', case when v_has_more then 'validating' when v_total = 0 or v_error > 0 then 'validation_failed' else 'validated' end,
    'run_id', v_run.id,
    'batch_processed', v_batch_count,
    'validation_cursor', v_next_cursor,
    'total_count', case when v_has_more then null else v_total end,
    'insert_count', case when v_has_more then null else v_insert end,
    'update_count', case when v_has_more then null else v_update end,
    'skip_count', case when v_has_more then null else v_skip end,
    'error_count', case when v_has_more then null else v_error end,
    'has_more', v_has_more
  );
end;
$function$;

-- Structural/payload writes after EOF would invalidate its one-time count.
-- Normal validation may update only its four result fields. NOWAIT avoids a
-- direct row-update caller reversing source -> run -> stage lock ordering.
create function catalog_storage_internal.guard_sealed_stage_row()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_run uuid;v_source uuid;v_sealed boolean;
begin
 if tg_op='UPDATE' and (new.run_id is distinct from old.run_id or new.organization_id is distinct from old.organization_id or new.row_index is distinct from old.row_index)
  and exists(select 1 from public.catalog_import_sources where run_id in(old.run_id,new.run_id))
 then raise exception 'CATALOG_STORAGE_STAGE_IDENTITY_IMMUTABLE';end if;
 v_run:=case when tg_op='DELETE' then old.run_id else new.run_id end;
 begin
  select id into v_source from public.catalog_import_sources where run_id=v_run for update nowait;
 exception when lock_not_available then raise exception 'CATALOG_STORAGE_SOURCE_NOT_READY';end;
 if v_source is not null then
  select exists(select 1 from catalog_storage_internal.read_completion_receipts where source_id=v_source) into v_sealed;
  if v_sealed and (tg_op<>'UPDATE' or
   (to_jsonb(new)-array['validation_status','validation_message','conflict_summary','proposed_action']) is distinct from
   (to_jsonb(old)-array['validation_status','validation_message','conflict_summary','proposed_action']))
  then raise exception 'CATALOG_STORAGE_STAGE_SEALED';end if;
 end if;
 if tg_op='DELETE' then return old;end if;return new;
end $$;
revoke all on function catalog_storage_internal.guard_sealed_stage_row() from public,anon,authenticated,service_role;
create trigger catalog_storage_stage_sealed before insert or update or delete on public.catalog_import_stage
 for each row execute function catalog_storage_internal.guard_sealed_stage_row();


-- A completed SQL read may outlive its worker checkpoint. Recovery reads the
-- immutable proof without renewing a lease, restaging or altering finalization.
create function public.get_catalog_import_storage_read_completion_system(
 input_run_id uuid,input_organization_id uuid,input_actor_id uuid,input_source_id uuid,input_source_sha256 text,input_source_bytes bigint
) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare s public.catalog_import_sources%rowtype;r public.catalog_import_runs%rowtype;c catalog_storage_internal.read_completion_receipts%rowtype;
begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception 'CATALOG_STORAGE_SERVICE_REQUIRED';end if;
 if input_run_id is null or input_organization_id is null or input_actor_id is null or input_source_id is null
  or (input_source_sha256 is not null and input_source_sha256!~'^[0-9a-f]{64}$') or input_source_bytes is null or input_source_bytes<=0
 then raise exception 'CATALOG_STORAGE_READ_INPUT_INVALID';end if;
 perform public.catalog_storage_assert_system_actor(input_organization_id,input_actor_id);
 select * into s from public.catalog_import_sources where id=input_source_id and run_id=input_run_id and organization_id=input_organization_id and created_by=input_actor_id;
 select * into r from public.catalog_import_runs where id=input_run_id and organization_id=input_organization_id and created_by=input_actor_id;
 if s.id is null or r.id is null then raise exception 'CATALOG_STORAGE_SOURCE_SCOPE';end if;
 if s.total_bytes is distinct from input_source_bytes then raise exception 'CATALOG_STORAGE_READ_RECEIPT_CONFLICT';end if;
 select * into c from catalog_storage_internal.read_completion_receipts where source_id=s.id;
 if c.source_id is null then return jsonb_build_object('read_complete',false);end if;
 if input_source_sha256 is not null and s.checksum_sha256 is distinct from input_source_sha256
 then raise exception 'CATALOG_STORAGE_READ_RECEIPT_CONFLICT';end if;
 if s.status not in('staged','completed') or c.run_id is distinct from r.id or c.organization_id is distinct from s.organization_id
  or c.actor_id is distinct from input_actor_id or c.source_sha256 is distinct from s.checksum_sha256 or c.source_bytes is distinct from input_source_bytes
  or c.source_path is distinct from s.storage_object_path
  or (c.storage_object_id is distinct from s.storage_object_id and not(s.storage_object_id is null and s.status='completed' and r.status in('finalized','succeeded')))
  or c.sealed_object_version is distinct from s.sealed_object_version
  or s.read_completed_at is distinct from c.completed_at or s.read_complete_rows is distinct from c.total_rows
  or s.cursor_row is distinct from c.cursor_row or s.rows_parsed is distinct from c.total_rows or s.rows_staged is distinct from c.total_rows
 then raise exception 'CATALOG_STORAGE_READ_RECEIPT_CONFLICT';end if;
 return jsonb_build_object('read_complete',true,'run_id',r.id,'source_id',s.id,'source_sha256',c.source_sha256,'source_bytes',c.source_bytes,'source_path',c.source_path,
  'total_rows',c.total_rows,'cursor_row',c.cursor_row,'read_completed_at',c.completed_at,'run_status',r.status,'source_status',s.status);
end $$;
revoke all on function public.get_catalog_import_storage_read_completion_system(uuid,uuid,uuid,uuid,text,bigint) from public,anon,authenticated,service_role;
grant execute on function public.get_catalog_import_storage_read_completion_system(uuid,uuid,uuid,uuid,text,bigint) to service_role;
