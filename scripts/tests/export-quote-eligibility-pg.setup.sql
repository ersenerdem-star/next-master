create role anon;
create role authenticated;
create role service_role;

create function public.normalize_catalog_product_code(input_code text)
returns text language sql immutable as $$select upper(btrim(input_code))$$;

create table public.brands (id uuid primary key, name text);
create table public.supplier_current_price_pointers (
  organization_id uuid, brand_id uuid, supplier_id uuid,
  release_id uuid, publication_id uuid
);
create table public.supplier_price_publications (
  id uuid primary key, organization_id uuid, brand_id uuid,
  supplier_id uuid, release_id uuid, status text,
  published_at timestamptz default now(), created_at timestamptz default now()
);
create table public.supplier_price_release_rows (
  id uuid primary key, release_id uuid, normalized_code text,
  product_code text, description text, buy_price numeric,
  currency text, valid_from date, row_status text
);
create table public.catalog_products (
  id uuid primary key, organization_id uuid, brand_id uuid,
  product_code text, description text, oem_no text, hs_code text,
  origin text, weight_kg numeric, lifecycle_status text,
  lifecycle_note text, updated_at timestamptz default now()
);
create table public.supplier_price_rollups (
  organization_id uuid, brand_id uuid, refreshed_at timestamptz,
  cheapest_price numeric
);
create table public.item_code_references (
  id uuid, organization_id uuid, brand_id uuid, old_code text,
  new_code text, is_active boolean, updated_at timestamptz
);

insert into public.brands values
  ('00000000-0000-0000-0000-000000000002', 'Clevite'),
  ('00000000-0000-0000-0000-000000000012', 'Other');
insert into public.supplier_price_publications
  (id, organization_id, brand_id, supplier_id, release_id, status)
values
  ('00000000-0000-0000-0000-000000000004', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000005', 'published'),
  ('00000000-0000-0000-0000-000000000014', '00000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-000000000012', '00000000-0000-0000-0000-000000000013', '00000000-0000-0000-0000-000000000015', 'published');
insert into public.supplier_current_price_pointers values
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000005', '00000000-0000-0000-0000-000000000004'),
  ('00000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-000000000012', '00000000-0000-0000-0000-000000000013', '00000000-0000-0000-0000-000000000015', '00000000-0000-0000-0000-000000000014');

insert into public.supplier_price_release_rows
  (id, release_id, normalized_code, product_code, description, buy_price, currency, valid_from, row_status)
values
  ('00000000-0000-0000-0000-000000000101', '00000000-0000-0000-0000-000000000005', 'A-VALID', 'A-VALID', 'Valid', 100, 'EUR', current_date - 1, 'accepted'),
  ('00000000-0000-0000-0000-000000000102', '00000000-0000-0000-0000-000000000005', 'A-VALID', 'A-VALID', 'Future cheaper', 1, 'EUR', current_date + 1, 'accepted'),
  ('00000000-0000-0000-0000-000000000103', '00000000-0000-0000-0000-000000000005', 'B-FUTURE', 'B-FUTURE', 'Future only', 20, 'EUR', current_date + 1, 'accepted'),
  ('00000000-0000-0000-0000-000000000104', '00000000-0000-0000-0000-000000000005', 'C-USD', 'C-USD', 'Wrong currency', 30, 'USD', current_date - 1, 'accepted'),
  ('00000000-0000-0000-0000-000000000105', '00000000-0000-0000-0000-000000000005', 'D-ZERO', 'D-ZERO', 'Zero', 0, 'EUR', current_date - 1, 'accepted'),
  ('00000000-0000-0000-0000-000000000106', '00000000-0000-0000-0000-000000000005', 'E-NEG', 'E-NEG', 'Negative', -1, 'EUR', current_date - 1, 'accepted'),
  ('00000000-0000-0000-0000-000000000107', '00000000-0000-0000-0000-000000000005', 'F-REJECT', 'F-REJECT', 'Rejected', 2, 'EUR', current_date - 1, 'rejected'),
  ('00000000-0000-0000-0000-000000000108', '00000000-0000-0000-0000-000000000005', 'G-VALID', 'G-VALID', 'Valid', 70, 'EUR', current_date - 1, 'accepted'),
  ('00000000-0000-0000-0000-000000000109', '00000000-0000-0000-0000-000000000005', 'G-VALID', 'G-VALID', 'Wrong currency cheaper', 1, 'USD', current_date - 1, 'accepted'),
  ('00000000-0000-0000-0000-000000000110', '00000000-0000-0000-0000-000000000005', '-', '-', 'Placeholder', 10, 'EUR', current_date - 1, 'accepted'),
  ('00000000-0000-0000-0000-000000000111', '00000000-0000-0000-0000-000000000015', 'Z-OTHER', 'Z-OTHER', 'Other tenant', 1, 'EUR', current_date - 1, 'accepted');
