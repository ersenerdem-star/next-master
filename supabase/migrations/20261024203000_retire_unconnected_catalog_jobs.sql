set local lock_timeout='2s';
set local statement_timeout='10s';

-- Retire work that cannot run with its source connection. Terminal catalog
-- receipts stay immutable; only non-terminal queues are stopped with a reason.
update public.catalog_brand_jobs
set status='failed',
    error_message='SOURCE_INACTIVE_NO_ENGINE',
    retry_after=null,
    lease_expires_at=null,
    updated_at=clock_timestamp()
where manifest->>'source_key'='spareto_schaeffler_correction_v1'
  and status in('queued','running','paused');

-- The legacy Elring tables have no failed/cancelled state. Paused plus a
-- durable reason prevents stale rows from being presented as live workers.
update public.catalog_elring_completion_jobs
set status='paused',
    totals=coalesce(totals,'{}'::jsonb)||jsonb_build_object(
      'stopped_reason','STALE_NO_ACTIVE_WORKER',
      'stopped_at',clock_timestamp()),
    updated_at=clock_timestamp()
where status='running'
  and updated_at<now()-interval '30 minutes';

update public.catalog_elring_spareto_jobs
set status='paused',
    updated_at=clock_timestamp()
where status='running'
  and updated_at<now()-interval '30 minutes';

select pg_notify('pgrst','reload schema');
