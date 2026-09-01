-- Ensure a supplier import run has exactly one finalize worker at a time.
--
-- The browser queue endpoint only records the hand-off. The scheduled worker
-- calls this system RPC. A per-run advisory lock makes overlapping cron ticks
-- and a reclaimed Netlify invocation return immediately as lock_waiting rather
-- than waiting for the 55s function timeout.

create or replace function public.finalize_supplier_price_import_batch_system(
  input_run_id uuid,
  input_organization_id uuid,
  input_actor_id uuid,
  input_batch_size integer default 500
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_actor_org uuid;
  v_actor_role text;
  v_run public.supplier_price_import_runs%rowtype;
  v_lock_key bigint;
begin
  select organization_id, lower(role::text)
    into v_actor_org, v_actor_role
  from public.profiles
  where id = input_actor_id
    and is_active = true;

  if v_actor_org is null
     or v_actor_org <> input_organization_id
     or v_actor_role not in ('admin', 'superadmin') then
    raise exception 'System supplier finalization actor is not an active organization admin';
  end if;

  if input_run_id is null then
    raise exception 'Import run is required';
  end if;

  select *
    into v_run
  from public.supplier_price_import_runs
  where id = input_run_id
    and organization_id = input_organization_id;

  if not found then
    raise exception 'Import run was not found';
  end if;

  if v_run.status in ('finalized', 'succeeded') then
    return jsonb_build_object(
      'status', v_run.status,
      'run_id', v_run.id,
      'finalize_phase', coalesce(v_run.finalize_phase, 'done'),
      'processed', coalesce(v_run.processed_rows, 0),
      'staged_rows', v_run.staged_rows,
      'has_more', false,
      'catalog_sync_status', coalesce(v_run.catalog_sync_status, 'pending')
    );
  end if;

  v_lock_key := hashtextextended('supplier-import-run:' || input_run_id::text, 0);
  if not pg_try_advisory_xact_lock(v_lock_key) then
    return jsonb_build_object(
      'status', 'finalizing',
      'run_id', input_run_id,
      'finalize_phase', coalesce(v_run.finalize_phase, 'merge'),
      'processed', coalesce(v_run.processed_rows, 0),
      'staged_rows', v_run.staged_rows,
      'has_more', true,
      'worker_state', 'lock_waiting',
      'deferred', true
    );
  end if;

  -- The underlying function keeps its existing authorization and batching
  -- logic. The transaction-local claim above prevents duplicate callers.
  perform set_config('request.jwt.claim.sub', input_actor_id::text, true);
  return public.finalize_supplier_price_import_batch(input_run_id, input_batch_size);
end;
$function$;

revoke all on function public.finalize_supplier_price_import_batch_system(uuid, uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.finalize_supplier_price_import_batch_system(uuid, uuid, uuid, integer) to service_role;
