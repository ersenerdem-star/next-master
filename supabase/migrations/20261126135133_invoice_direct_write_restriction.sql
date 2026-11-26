-- Existing invoice changes and removals must pass the guarded RPCs. Keep
-- INSERT for the legacy local-storage bootstrap and SELECT for normal reads.
-- TRUNCATE bypasses RLS; authenticated browser sessions do not need it or
-- authority to add triggers. Privileged service roles retain their grants.
revoke update, delete, truncate, trigger on public.invoices from authenticated, anon;
