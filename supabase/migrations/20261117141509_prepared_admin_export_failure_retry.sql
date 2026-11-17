-- The scheduled starter returns before a background workbook finishes. If the
-- worker later fails, wake only the matching current profile with bounded retry.
create function public.retry_failed_prepared_admin_export()
returns trigger language plpgsql security definer set search_path='' as $fn$
begin
 if new.audience='admin' and new.export_type in ('catalog_master','supplier_price_list')
  and new.status='failed' and old.status is distinct from 'failed' then
  update public.prepared_admin_export_profiles p set
   revision=p.revision+1,
   next_check_at=least(p.next_check_at,pg_catalog.clock_timestamp()+interval '15 minutes'),
   last_error_code='PREPARED_ADMIN_EXPORT_FAILED'
  where p.organization_id=new.organization_id and p.seed_job_id=new.id;
 end if;
 return null;
end;
$fn$;
revoke all on function public.retry_failed_prepared_admin_export() from public,anon,authenticated,service_role;
create trigger retry_failed_prepared_admin_export after update of status on public.app_export_jobs
for each row execute function public.retry_failed_prepared_admin_export();
