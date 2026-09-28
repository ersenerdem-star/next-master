-- Keep stale-import cleanup tenant-scoped when called by an authenticated admin.
create or replace function public.close_stale_supplier_price_import_runs(
  input_age interval default interval '2 hours'
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_closed integer;
  v_org_id uuid := public.current_profile_org_id();
begin
  if v_org_id is null then
    return 0;
  end if;

  update public.supplier_price_import_runs
  set status = 'failed',
      finished_at = coalesce(finished_at, now()),
      error_message = coalesce(error_message, 'Automatically closed as stale: no progress for more than 2 hours.'),
      catalog_sync_status = case
        when catalog_sync_status in ('pending', 'running') then 'failed'
        else catalog_sync_status
      end,
      catalog_sync_finished_at = coalesce(catalog_sync_finished_at, now()),
      catalog_sync_error_message = coalesce(catalog_sync_error_message, 'Automatically closed as stale: no progress for more than 2 hours.'),
      catalog_sync_worker_state = 'failed',
      processing_queued_at = null,
      processing_queued_by = null
  where organization_id = v_org_id
    and status in ('running', 'finalizing')
    and started_at < now() - coalesce(input_age, interval '2 hours');

  get diagnostics v_closed = row_count;
  return v_closed;
end;
$$;

revoke all on function public.close_stale_supplier_price_import_runs(interval) from public;
grant execute on function public.close_stale_supplier_price_import_runs(interval) to authenticated;
