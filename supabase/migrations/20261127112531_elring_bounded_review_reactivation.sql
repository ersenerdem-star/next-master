-- Reopening the source for bounded review must not reopen the old bulk path.
do $migration$
declare def text; anchor text;
begin
  def:=pg_get_functiondef('public.publish_catalog_provider_stage_batch(uuid,uuid,integer,text,text,integer)'::regprocedure);
  anchor:='  v_total_pages := nullif';
  if strpos(def,anchor)=0 then raise exception 'Provider publisher guard anchor missing'; end if;
  execute replace(def,anchor,$guard$
  if v_source_key='tecalliance_elring' and exists(
    select 1 from public.catalog_external_sources s
    where s.organization_id=v_run.organization_id and s.source_key=v_source_key
      and (s.metadata->>'bounded_review_only'='true' or s.metadata->>'internal_catalog_persistence_allowed' is distinct from 'true')
  ) then raise exception 'ELRING_REVIEW_ONLY'; end if;
  v_total_pages := nullif$guard$);

  def:=pg_get_functiondef('public.begin_or_resume_catalog_provider_stage(uuid,text,text,text,jsonb)'::regprocedure);
  anchor:='  select b.name';
  if strpos(def,anchor)=0 then raise exception 'Provider collection guard anchor missing'; end if;
  execute replace(def,anchor,$guard$
  if v_source_key='tecalliance_elring' and exists(
    select 1 from public.catalog_external_sources s
    where s.organization_id=input_organization_id and s.source_key=v_source_key
      and s.metadata->>'bounded_review_only'='true'
  ) then raise exception 'ELRING_BOUNDED_QUEUE_REQUIRED'; end if;
  select b.name$guard$);

  def:=pg_get_functiondef('public.start_catalog_elring_job(uuid,uuid,jsonb,text,uuid)'::regprocedure);
  anchor:=' insert into public.catalog_elring_jobs';
  if strpos(def,anchor)=0 then raise exception 'Elring admission guard anchor missing'; end if;
  execute replace(def,anchor,$guard$
 if exists(select 1 from public.catalog_external_sources where organization_id=input_org
   and source_key='tecalliance_elring' and metadata->>'bounded_review_only'='true') then
   if jsonb_array_length(input_codes)>3 or exists(select 1 from public.catalog_external_sources where organization_id=input_org
     and source_key='tecalliance_elring' and metadata ? 'review_canary_key'
     and metadata->>'review_canary_key' is distinct from input_key::text) then
     raise exception 'ELRING_BOUNDED_REVIEW_SCOPE';
   end if;
   config:=config||'{"adapter":"elring-bounded-review.v1","fitment_max_requests":6}'::jsonb;
 end if;
 insert into public.catalog_elring_jobs$guard$);

  def:=pg_get_functiondef('public.claim_catalog_elring_job(uuid,uuid)'::regprocedure);
  anchor:=' perform pg_advisory_xact_lock(hashtextextended(''catalog-elring:''||input_org::text,0));';
  if strpos(def,anchor)=0 then raise exception 'Elring claim guard anchor missing'; end if;
  execute replace(def,anchor,$guard$
 if not pg_try_advisory_xact_lock(hashtextextended('catalog-elring:'||input_org::text,0)) then return null; end if;
 if not exists(
   select 1 from public.catalog_elring_jobs q join public.catalog_external_sources s
     on s.organization_id=q.organization_id and s.source_key='tecalliance_elring'
   where q.id=input_job and q.organization_id=input_org and s.is_active
     and (q.source_retry_after is null or q.source_retry_after<=now())
     and (s.metadata->>'bounded_review_only' is distinct from 'true'
       or (q.mode='stage' and q.total_items<=3 and q.manifest->>'adapter'='elring-bounded-review.v1'
         and (not (s.metadata ? 'review_canary_key') or s.metadata->>'review_canary_key'=q.idempotency_key::text)))
 ) then return null; end if;$guard$);
end $migration$;

alter function public.claim_catalog_elring_job(uuid,uuid) set lock_timeout='250ms';
alter function public.claim_catalog_elring_job(uuid,uuid) set statement_timeout='3s';
alter function public.checkpoint_catalog_elring_job(uuid,uuid,uuid,integer,jsonb,jsonb,text,text,boolean,text) set lock_timeout='250ms';
alter function public.checkpoint_catalog_elring_job(uuid,uuid,uuid,integer,jsonb,jsonb,text,text,boolean,text) set statement_timeout='3s';

alter table public.catalog_elring_jobs add column lock_retry_count smallint not null default 0 check(lock_retry_count between 0 and 4);

create function public.defer_catalog_elring_lock_wait(input_org uuid,input_job uuid,input_token uuid)
returns text language plpgsql security invoker set search_path=''
set lock_timeout='250ms' set statement_timeout='3s' as $$
declare next_status text;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Service role required'; end if;
  update public.catalog_elring_jobs
    set lock_retry_count=least(lock_retry_count+1,4),
      status=case when lock_retry_count>=3 then 'failed' else 'paused' end,
      source_retry_after=case when lock_retry_count>=3 then null else now()+interval '30 seconds' end,
      lease_expires_at=now(),updated_at=now(),error_message='ELRING_REVIEW_DATABASE_BUSY'
    where id=input_job and organization_id=input_org and status='running'
      and lease_token=input_token and lease_expires_at>now()
    returning status into next_status;
  if not found then raise exception 'Elring worker lease lost'; end if;
  return next_status;
end $$;

create or replace function public.next_catalog_elring_budget_dispatch()
returns jsonb language plpgsql security invoker set search_path=''
set statement_timeout='3s' as $$
declare j record;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Service role required'; end if;
  select q.id,q.organization_id,q.status into j from public.catalog_elring_jobs q
  join public.catalog_external_sources s on s.organization_id=q.organization_id and s.source_key='tecalliance_elring'
  where (
     (q.source_retry_after<=now() and (q.status in ('paused','queued') or (q.status='running' and q.lease_expires_at<=now())))
     or (s.metadata->>'bounded_review_only'='true' and q.status in ('queued','running')
       and (q.status='queued' or q.lease_expires_at<=now()) and q.source_retry_after is null)
    )
    and s.is_active and s.license_posture='allowed' and s.credential_boundary='none'
    and s.rate_limit_posture='bounded' and s.metadata->>'internal_observation_allowed'='true'
    and s.metadata->>'automated_read_only_approved'='true' and s.metadata->'allowed_brands' ? 'Elring'
    and (s.metadata->>'bounded_review_only' is distinct from 'true'
      or (q.mode='stage' and q.total_items<=3 and q.manifest->>'adapter'='elring-bounded-review.v1'
       and (not (s.metadata ? 'review_canary_key') or s.metadata->>'review_canary_key'=q.idempotency_key::text)))
    and (q.mode='stage' or (s.metadata->>'internal_catalog_persistence_allowed'='true'
      and nullif(s.metadata->>'approval_actor','') is not null and nullif(s.metadata->>'publication_approval_reference','') is not null))
    and not exists(select 1 from public.catalog_elring_jobs busy where busy.organization_id=q.organization_id
      and busy.status='running' and busy.lease_expires_at>now())
  order by coalesce(q.source_retry_after,q.created_at),q.id limit 1;
  if not found then return null; end if;
  return to_jsonb(j);
end $$;

revoke all on function public.defer_catalog_elring_lock_wait(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.defer_catalog_elring_lock_wait(uuid,uuid,uuid) to service_role;
notify pgrst,'reload schema';
