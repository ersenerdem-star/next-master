insert into public.organizations values('00000000-0000-0000-0000-000000000001');
insert into public.app_export_jobs(organization_id,export_type,cache_key)
select '00000000-0000-0000-0000-000000000001',kind,kind
from unnest(array['admin_price_list','portal_price_list','catalog_master','catalog_export','supplier_report','supplier_price_list']) kind;
do $test$
begin
  assert (select count(*) from public.app_export_jobs)=6,'all existing and supplier types admitted';
  assert not has_table_privilege('anon','public.app_export_jobs','truncate'),'no anonymous truncate';
  assert not has_table_privilege('authenticated','public.app_export_jobs','select'),'no direct browser read';
  assert has_table_privilege('service_role','public.app_export_jobs','insert'),'worker may create jobs';
  assert has_table_privilege('service_role','public.app_export_jobs','update'),'worker may finish jobs';
  assert (select relrowsecurity from pg_class where oid='public.app_export_jobs'::regclass),'jobs RLS remains enabled';
  begin
    insert into public.app_export_jobs(organization_id,export_type,cache_key)
    values('00000000-0000-0000-0000-000000000001','unsupported','invalid');
    raise exception 'unsupported export type admitted';
  exception when check_violation then null;
  end;
end;
$test$;
