-- The first page must count the exact published source once. Immutable
-- eligibility belongs in a partial index so the count need not run a regexp
-- and SKU normalization over the entire million-row release on every export.
create index if not exists idx_release_rows_export_exact_eligible_count
  on public.supplier_price_release_rows(release_id,normalized_code collate "C")
  include(valid_from)
  where row_status='accepted' and buy_price>0 and currency='EUR'
    and normalized_code=public.normalize_catalog_product_code(product_code)
    and normalized_code ~ '[A-Z0-9]';

-- PostgREST hoists these protected RPC settings before executing the request.
-- Keep the budget below the worker's 45s HTTP deadline; all pages remain capped
-- at 5,000 rows. Global, authenticator, anon and authenticated budgets stay as-is.
alter function public.cloud_catalog_export_chunk_v3(uuid,uuid,text,uuid,integer)
  set statement_timeout to '35s';
alter function public.cloud_catalog_master_export_chunk_v3(uuid,uuid,text,text,text,uuid,integer,numeric,numeric)
  set statement_timeout to '35s';
alter function public.cloud_supplier_price_export_chunk_v3(uuid,uuid,uuid,text,text,text,uuid,integer)
  set statement_timeout to '35s';
notify pgrst, 'reload schema';
