-- PostgREST caps SETOF responses at db_max_rows even when an internal page is
-- larger. One JSON value preserves the bounded 5,000-row source page intact.
create or replace function public.cloud_catalog_export_chunk_v3(
  input_organization_id uuid,input_brand_id uuid,input_market_segment text default '',
  input_after_id uuid default null,input_page_size integer default 1000
) returns jsonb language sql stable security definer set search_path to '' as $function$
  select coalesce(jsonb_agg(to_jsonb(p) order by p.product_id),'[]'::jsonb)
  from public.cloud_catalog_export_page_v3(input_organization_id,input_brand_id,
    input_market_segment,input_after_id,input_page_size) p;
$function$;

create or replace function public.cloud_catalog_master_export_chunk_v3(
  input_organization_id uuid,input_brand_id uuid,input_scope text default 'priced',
  input_search text default '',input_after_code text default null,input_after_id uuid default null,
  input_page_size integer default 1000,input_margin_a numeric default .10,input_margin_b numeric default .15
) returns jsonb language sql stable security definer set search_path to '' as $function$
  select coalesce(jsonb_agg(to_jsonb(p) order by p.cursor_code collate "C",p.cursor_id),'[]'::jsonb)
  from public.cloud_catalog_master_export_page_v3(input_organization_id,input_brand_id,
    input_scope,input_search,input_after_code,input_after_id,input_page_size,input_margin_a,input_margin_b) p;
$function$;

create or replace function public.cloud_supplier_price_export_chunk_v3(
  input_organization_id uuid,input_supplier_id uuid,input_brand_id uuid,input_search text default '',
  input_freshness text default 'all',input_after_product_code text default null,input_after_id uuid default null,
  input_page_size integer default 1000
) returns jsonb language sql stable security definer set search_path to '' as $function$
  select coalesce(jsonb_agg(to_jsonb(p) order by coalesce(p.product_code,'') collate "C",p.price_id),'[]'::jsonb)
  from public.cloud_supplier_price_export_page(input_organization_id,input_supplier_id,input_brand_id,
    input_search,input_freshness,input_after_product_code,input_after_id,input_page_size) p;
$function$;

revoke all on function public.cloud_catalog_export_chunk_v3(uuid,uuid,text,uuid,integer) from public,anon,authenticated;
revoke all on function public.cloud_catalog_master_export_chunk_v3(uuid,uuid,text,text,text,uuid,integer,numeric,numeric) from public,anon,authenticated;
revoke all on function public.cloud_supplier_price_export_chunk_v3(uuid,uuid,uuid,text,text,text,uuid,integer) from public,anon,authenticated;
grant execute on function public.cloud_catalog_export_chunk_v3(uuid,uuid,text,uuid,integer) to service_role;
grant execute on function public.cloud_catalog_master_export_chunk_v3(uuid,uuid,text,text,text,uuid,integer,numeric,numeric) to service_role;
grant execute on function public.cloud_supplier_price_export_chunk_v3(uuid,uuid,uuid,text,text,text,uuid,integer) to service_role;
