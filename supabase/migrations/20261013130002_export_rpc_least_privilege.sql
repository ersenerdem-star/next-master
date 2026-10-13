-- Export page and version RPCs accept a tenant id and pricing inputs and run
-- as their owner. They are called only by the server-side export bridge after
-- the job and portal/admin authority checks, so browser roles must not invoke
-- them directly with arbitrary scope or margin.

revoke all on function public.get_admin_price_list_export_version(uuid, uuid)
  from public, anon, authenticated;
revoke all on function public.cloud_portal_customer_price_list_page_fast(uuid, uuid, text, numeric, text, text, integer)
  from public, anon, authenticated;
revoke all on function public.cloud_admin_price_list_page_fast(uuid, uuid, text, numeric, text, text, integer)
  from public, anon, authenticated;

grant execute on function public.get_admin_price_list_export_version(uuid, uuid)
  to service_role;
grant execute on function public.cloud_portal_customer_price_list_page_fast(uuid, uuid, text, numeric, text, text, integer)
  to service_role;
grant execute on function public.cloud_admin_price_list_page_fast(uuid, uuid, text, numeric, text, text, integer)
  to service_role;
