-- Labels and fail-closed pointer presence also change exported content. Include
-- these in version fingerprints even when a pointer has no valid publication.
create or replace function public.get_catalog_export_version(
  input_organization_id uuid, input_brand_id uuid, input_market_segment text default ''
) returns text language sql stable security definer set search_path to '' as $function$
  with params as (
    select input_organization_id organization_id,input_brand_id brand_id,
      nullif(btrim(coalesce(input_market_segment,'')),'') market_segment
  )
  select md5(coalesce(p.organization_id::text,'') || ':' || coalesce(p.brand_id::text,'') || ':' ||
    coalesce(p.market_segment,'') || ':' ||
    coalesce((select b.name from public.brands b where b.organization_id=p.organization_id and b.id=p.brand_id),'') || ':' ||
    coalesce((select count(*)::text || ':' || coalesce(max(cp.updated_at)::text,'') || ':' || coalesce(max(cp.id::text),'')
      from public.catalog_products cp where cp.organization_id=p.organization_id and cp.brand_id=p.brand_id
        and (p.market_segment is null or cp.market_segment=p.market_segment)),'0:'))
  from params p;
$function$;

create or replace function public.get_catalog_master_export_version(
  input_organization_id uuid, input_brand_id uuid, input_scope text default 'priced'
) returns text language sql stable security definer set search_path to '' as $function$
  select md5(coalesce(input_scope,'priced') || ':' ||
    public.get_admin_price_list_export_version(input_organization_id,input_brand_id) || ':' ||
    coalesce((select string_agg(s.id::text || ':' || s.name,',' order by s.id)
      from public.suppliers s where s.organization_id=input_organization_id),'') || ':' ||
    coalesce((select b.name from public.brands b where b.organization_id=input_organization_id and b.id=input_brand_id),'') || ':' ||
    coalesce((select jsonb_agg(jsonb_build_array(ptr.supplier_id,ptr.release_id,ptr.publication_id,pub.status)
      order by ptr.supplier_id,ptr.release_id,ptr.publication_id)::text
      from public.supplier_current_price_pointers ptr
      left join public.supplier_price_publications pub on pub.id=ptr.publication_id
        and pub.organization_id=ptr.organization_id and pub.supplier_id=ptr.supplier_id
        and pub.brand_id=ptr.brand_id and pub.release_id=ptr.release_id
      where ptr.organization_id=input_organization_id and ptr.brand_id=input_brand_id),'[]'));
$function$;

revoke all on function public.get_catalog_export_version(uuid,uuid,text) from public,anon,authenticated;
revoke all on function public.get_catalog_master_export_version(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.get_catalog_export_version(uuid,uuid,text) to service_role;
grant execute on function public.get_catalog_master_export_version(uuid,uuid,text) to service_role;
