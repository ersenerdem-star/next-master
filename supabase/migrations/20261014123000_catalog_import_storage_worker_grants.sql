-- The scheduled Netlify worker uses the service-role REST API for its bounded
-- queue scan, marker cleanup and completed-source cleanup.
grant select, update on table public.catalog_import_runs to service_role;
grant select, update on table public.catalog_import_sources to service_role;
