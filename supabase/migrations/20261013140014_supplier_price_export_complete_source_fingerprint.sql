-- An export also contains catalog labels and item-code replacements. Include
-- deletion-sensitive counts for the older rollup/catalog sources and a complete
-- scoped replacement fingerprint, including active/inactive transitions.
-- Preserve every current publication pointer from 20261013140008.
create or replace function public.get_admin_price_list_export_version(
  input_organization_id uuid,
  input_brand_id uuid
)
returns text
language sql
stable
security definer
set search_path to ''
as $function$
  select pg_catalog.md5(
    coalesce(input_organization_id::text, '') || ':' ||
    coalesce(input_brand_id::text, '') || ':' ||
    coalesce((
      select count(*)::text || ':' ||
        coalesce(extract(epoch from max(spr.refreshed_at))::text, '')
      from public.supplier_price_rollups spr
      where spr.organization_id=input_organization_id
        and spr.brand_id=input_brand_id
        and spr.cheapest_price is not null
    ), '') || ':' ||
    coalesce((
      select count(*)::text || ':' ||
        coalesce(extract(epoch from max(cp.updated_at))::text, '')
      from public.catalog_products cp
      where cp.organization_id=input_organization_id
        and cp.brand_id=input_brand_id
    ), '') || ':' ||
    coalesce((
      select pg_catalog.string_agg(
        ptr.supplier_id::text || ':' || ptr.release_id::text || ':' ||
        ptr.publication_id::text || ':' ||
        coalesce(extract(epoch from pub.published_at)::text, '') || ':' ||
        coalesce(extract(epoch from pub.created_at)::text, ''),
        ',' order by ptr.supplier_id, ptr.release_id, ptr.publication_id
      )
      from public.supplier_current_price_pointers ptr
      join public.supplier_price_publications pub
        on pub.id=ptr.publication_id
       and pub.organization_id=ptr.organization_id
       and pub.brand_id=ptr.brand_id
       and pub.supplier_id=ptr.supplier_id
       and pub.release_id=ptr.release_id
       and pub.status='published'
      where ptr.organization_id=input_organization_id
        and ptr.brand_id=input_brand_id
    ), '') || ':' ||
    coalesce((
      select pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_array(
          ref.id, ref.old_code, ref.new_code, ref.is_active,
          ref.updated_at
        ) order by ref.id
      )::text
      from public.item_code_references ref
      where ref.organization_id=input_organization_id
        and ref.brand_id=input_brand_id
    ), '[]')
  );
$function$;

revoke all on function public.get_admin_price_list_export_version(uuid,uuid)
  from public,anon,authenticated;
grant execute on function public.get_admin_price_list_export_version(uuid,uuid)
  to service_role;
