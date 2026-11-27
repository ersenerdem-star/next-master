alter table public.catalog_elring_jobs add column source_retry_after timestamptz;
create index catalog_elring_budget_resume on public.catalog_elring_jobs(source_retry_after,id)
  where status='paused' and source_retry_after is not null;

create function public.defer_catalog_elring_source_request(input_org uuid,input_job uuid,input_token uuid,input_retry_at timestamptz)
returns void language plpgsql security invoker set search_path=''
set lock_timeout='2s' set statement_timeout='3s' as $$
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Service role required'; end if;
  if input_retry_at is null or input_retry_at>now()+interval '8 days' then raise exception 'Invalid source retry time'; end if;
  update public.catalog_elring_jobs set status='paused',source_retry_after=greatest(now()+interval '1 second',input_retry_at),
    lease_expires_at=now(),updated_at=now(),error_message='CATALOG_SOURCE_BUDGET_WAIT'
    where id=input_job and organization_id=input_org and status='running' and lease_token=input_token and lease_expires_at>now();
  if not found then raise exception 'Elring worker lease lost'; end if;
end $$;

-- Find due budget waits and recover only jobs that already passed this path.
create function public.next_catalog_elring_budget_dispatch()
returns jsonb language plpgsql security invoker set search_path=''
set statement_timeout='3s' as $$
declare j record;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Service role required'; end if;
  select q.id,q.organization_id,q.status into j from public.catalog_elring_jobs q
  join public.catalog_external_sources s on s.organization_id=q.organization_id and s.source_key='tecalliance_elring'
  where q.source_retry_after<=now()
    and (q.status in ('paused','queued') or (q.status='running' and q.lease_expires_at<=now()))
    and s.is_active and s.license_posture='allowed' and s.credential_boundary='none'
    and s.rate_limit_posture='bounded' and s.metadata->>'internal_observation_allowed'='true'
    and s.metadata->>'automated_read_only_approved'='true' and s.metadata->'allowed_brands' ? 'Elring'
    and (q.mode='stage' or (s.metadata->>'internal_catalog_persistence_allowed'='true'
      and nullif(s.metadata->>'approval_actor','') is not null and nullif(s.metadata->>'publication_approval_reference','') is not null))
    and not exists(select 1 from public.catalog_elring_jobs busy where busy.organization_id=q.organization_id
      and busy.status='running' and busy.lease_expires_at>now())
  order by q.source_retry_after,q.id limit 1;
  if not found then return null; end if;
  return to_jsonb(j);
end $$;

-- Supplier catalog projection already uses its lease timestamp to defer retries.
create function public.defer_supplier_catalog_source_request(input_job_id uuid,input_token uuid,input_retry_at timestamptz)
returns jsonb language plpgsql security definer set search_path=''
set lock_timeout='2s' set statement_timeout='3s' as $$
declare j supplier_price_ingestion_internal.catalog_enrichment_jobs%rowtype;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'Service role required'; end if;
  if input_retry_at is null or input_retry_at>now()+interval '8 days' then raise exception 'Invalid source retry time'; end if;
  j:=supplier_price_ingestion_internal.catalog_job(input_job_id,input_token);
  if j.status='superseded' then return jsonb_build_object('status','superseded'); end if;
  if j.phase is distinct from 'official' then raise exception 'CATALOG_ENRICHMENT_PHASE_INVALID'; end if;
  update supplier_price_ingestion_internal.catalog_enrichment_jobs set status='queued',lease_token=null,
    lease_until=greatest(now()+interval '1 second',input_retry_at),updated_at=now()
    where id=j.id;
  return jsonb_build_object('status','continuation');
end $$;

revoke all on function public.defer_catalog_elring_source_request(uuid,uuid,uuid,timestamptz),
 public.next_catalog_elring_budget_dispatch(), public.defer_supplier_catalog_source_request(uuid,uuid,timestamptz)
 from public,anon,authenticated;
grant execute on function public.defer_catalog_elring_source_request(uuid,uuid,uuid,timestamptz),
 public.next_catalog_elring_budget_dispatch(), public.defer_supplier_catalog_source_request(uuid,uuid,timestamptz)
 to service_role;
notify pgrst,'reload schema';
