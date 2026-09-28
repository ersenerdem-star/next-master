-- Notification functions are trigger-only; they must not be callable through
-- the public Supabase RPC surface.
revoke all on function public.notify_portal_brand_added() from public, anon, authenticated;
revoke all on function public.notify_portal_price_list_finalized() from public, anon, authenticated;
revoke all on function public.close_stale_supplier_price_import_runs(interval) from public, anon;
grant execute on function public.close_stale_supplier_price_import_runs(interval) to authenticated;
