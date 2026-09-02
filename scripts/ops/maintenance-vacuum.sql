-- Run in a direct Postgres session (not the Supabase transactional SQL API).
-- The API wraps statements in a transaction, where VACUUM is prohibited.
vacuum (analyze, verbose) public.catalog_products;
vacuum (analyze, verbose) public.supplier_prices;
vacuum (analyze, verbose) public.catalog_import_stage;
vacuum (analyze, verbose) public.supplier_price_import_stage;
vacuum (analyze, verbose) public.supplier_price_rollups;
vacuum (analyze, verbose) public.catalog_product_attributes;
