-- These SECURITY DEFINER helpers accept an organization ID and are internal to
-- guarded document/payment RPCs. Do not expose them as direct tenant RPCs.
revoke execute on function public.recalculate_invoice_paid_status_for_org(uuid, text) from public, anon, authenticated;
revoke execute on function public.recalculate_bill_paid_status_for_org(uuid, text) from public, anon, authenticated;
-- Keep explicit service access even where its former access came via PUBLIC.
grant execute on function public.recalculate_invoice_paid_status_for_org(uuid, text) to service_role;
grant execute on function public.recalculate_bill_paid_status_for_org(uuid, text) to service_role;
notify pgrst, 'reload schema';
