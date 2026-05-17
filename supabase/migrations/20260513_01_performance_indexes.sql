-- Performance indexes for large shared datasets.
-- Run this in Supabase SQL Editor after schema setup.

create extension if not exists pg_trgm;

create index if not exists idx_catalog_products_org_brand_normcode
  on catalog_products (organization_id, brand_id, normalized_code);

create index if not exists idx_catalog_products_org_product_code
  on catalog_products (organization_id, product_code);

create index if not exists idx_catalog_products_desc_trgm
  on catalog_products using gin (description gin_trgm_ops);

create index if not exists idx_catalog_products_oem_trgm
  on catalog_products using gin (oem_no gin_trgm_ops);

create index if not exists idx_supplier_prices_org_supplier_brand_normcode_active
  on supplier_prices (organization_id, supplier_id, brand_id, normalized_code, valid_from desc)
  where is_active;

create index if not exists idx_supplier_prices_org_supplier_brand_active
  on supplier_prices (organization_id, supplier_id, brand_id, valid_from desc, id)
  where is_active;

create index if not exists idx_supplier_prices_org_supplier_active
  on supplier_prices (organization_id, supplier_id, valid_from desc, id)
  where is_active;

create index if not exists idx_supplier_prices_org_supplier_normcode_active
  on supplier_prices (organization_id, supplier_id, normalized_code, valid_from desc, updated_at desc)
  where is_active;

create index if not exists idx_supplier_prices_org_brand_normcode_buy_active
  on supplier_prices (organization_id, brand_id, normalized_code, buy_price, valid_from desc, updated_at desc)
  where is_active and buy_price is not null;

create index if not exists idx_supplier_prices_product_code_trgm
  on supplier_prices using gin (product_code gin_trgm_ops);

create index if not exists idx_supplier_prices_description_trgm
  on supplier_prices using gin (description gin_trgm_ops);

create index if not exists idx_supplier_prices_oem_trgm
  on supplier_prices using gin (oem_no gin_trgm_ops);

create index if not exists idx_quotes_org_updated
  on quotes (organization_id, updated_at desc, created_at desc);

create index if not exists idx_quotes_org_status_updated
  on quotes (organization_id, status, updated_at desc, created_at desc);

create index if not exists idx_quotes_customer_trgm
  on quotes using gin (customer_name gin_trgm_ops);

create index if not exists idx_quotes_quote_no_trgm
  on quotes using gin (quote_no gin_trgm_ops);

create index if not exists idx_quote_lines_quote_product
  on quote_lines (quote_id, normalized_code);

create index if not exists idx_quote_lines_quote_line_no
  on quote_lines (quote_id, line_no);

create index if not exists idx_quote_lines_product_code_trgm
  on quote_lines using gin (product_code gin_trgm_ops);

create index if not exists idx_quote_lines_description_trgm
  on quote_lines using gin (description gin_trgm_ops);
