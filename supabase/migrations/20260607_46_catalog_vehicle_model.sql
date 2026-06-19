alter table public.catalog_products
  add column if not exists vehicle_model text;
