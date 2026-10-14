-- The scheduled Netlify worker also clears terminal markers on the legacy
-- supplier queue. Grant only the read/update operations required for that
-- maintenance path; the supplier worker itself remains unchanged.
grant select, update on table public.supplier_price_import_runs to service_role;
