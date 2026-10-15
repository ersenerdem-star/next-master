-- Narrow existing default-PUBLIC access to the documented RPC audience.
-- No new data access: existing authenticated/admin checks remain in the bodies.
revoke execute on function public.save_invoice_atomic(jsonb,text) from public, anon;
revoke execute on function public.save_bill_atomic(jsonb,text) from public, anon;
grant execute on function public.save_invoice_atomic(jsonb,text) to authenticated, service_role;
grant execute on function public.save_bill_atomic(jsonb,text) to authenticated, service_role;
