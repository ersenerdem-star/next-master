
create role anon; create role authenticated; create role service_role;
create schema auth; create function auth.role() returns text language sql stable as $$select 'service_role'::text$$;
create function public.normalize_part_code(x text) returns text language sql immutable as $$select regexp_replace(upper(coalesce(x,'')),'[^A-Z0-9]','','g')$$;
create function public.normalize_catalog_product_code(x text) returns text language sql immutable as $$select regexp_replace(upper(btrim(coalesce(x,''))),'[[:space:]]+','','g')$$;
create table brands(id uuid primary key,organization_id uuid,name text);
create table suppliers(id uuid primary key,organization_id uuid,name text,updated_at timestamptz);
create table catalog_products(id uuid primary key,organization_id uuid,brand_id uuid,product_code text,normalized_code text,normalized_oem text,description text,description_tr text,oem_no text,ean text,vehicle text,vehicle_model text,hs_code text,origin text,market_segment text,weight_kg numeric,image_url text,lifecycle_status text,lifecycle_note text,updated_at timestamptz default now());
create table supplier_current_price_pointers(organization_id uuid,brand_id uuid,supplier_id uuid,release_id uuid,publication_id uuid);
create table supplier_price_publications(id uuid primary key,organization_id uuid,brand_id uuid,supplier_id uuid,release_id uuid,status text,published_at timestamptz default now(),created_at timestamptz default now());
create table supplier_price_release_rows(id bigint primary key,release_id uuid,normalized_code text,product_code text,description text,oem_no text,buy_price numeric,currency text,valid_from date,row_status text,moq integer,lead_time_days integer,notes text);
create table supplier_price_rollups(organization_id uuid,brand_id uuid,normalized_code text,product_code text,description text,oem_no text,normalized_oem text,cheapest_supplier_id uuid,cheapest_price numeric,second_supplier_id uuid,second_supplier_name text,second_price numeric,price_gap numeric,price_gap_percent numeric,price_date date,supplier_count integer,notes text,has_notes boolean,refreshed_at timestamptz);
create table supplier_prices(id uuid primary key,organization_id uuid,supplier_id uuid,brand_id uuid,product_code text,normalized_code text,normalized_oem text,description text,oem_no text,buy_price numeric,currency text,valid_from date,moq integer,order_multiple integer,lead_time_days integer,notes text,updated_at timestamptz default now(),is_active boolean);
create table item_code_references(id uuid,organization_id uuid,brand_id uuid,old_code text,new_code text,is_active boolean,updated_at timestamptz);
