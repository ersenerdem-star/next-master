-- Remove exact duplicate btree indexes. Keep the tenant-prefixed canonical names.
drop index if exists public.idx_catalog_observation_runs_job_started;
drop index if exists public.idx_catalog_products_brand_code;
drop index if exists public.idx_quote_lines_quote;
