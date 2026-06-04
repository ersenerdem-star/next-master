create index if not exists idx_catalog_products_org_brand_product_code
  on public.catalog_products (organization_id, brand_id, product_code);
