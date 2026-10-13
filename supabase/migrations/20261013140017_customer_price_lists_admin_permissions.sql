-- Price-list settings are read directly by authenticated application screens.
-- Existing RLS policies scope reads to the caller's organization and writes
-- to administrators of that organization. Restore only the table/columns
-- needed by the A/B margin UI; PostgreSQL checks both grants and RLS.
--
-- In particular, do not retain TRUNCATE/REFERENCES/TRIGGER privileges on
-- browser roles: TRUNCATE does not honor row-level security.
revoke all privileges on table public.customer_price_lists from anon, authenticated;

grant select on table public.customer_price_lists to authenticated;
grant insert (organization_id, name, list_type, margin_percent, is_manual, is_active)
  on table public.customer_price_lists to authenticated;
grant update (margin_percent, updated_at)
  on table public.customer_price_lists to authenticated;
