-- This is an existence lookup, not an export scan. PostgreSQL can decorrelate
-- EXISTS under OR into a hashed SubPlan that reads every published release row
-- before returning the small brand list. Keep each lookup correlated to its
-- brand and stop at the first eligible row. OFFSET 0 is a planner fence here;
-- all publication, legacy fallback, identity, currency and validity rules stay
-- identical. No prices, publication pointers or export artifacts are changed.
create or replace function public.cloud_admin_price_list_brands(input_organization_id uuid)
returns table(id uuid,name text)
language sql stable security definer set search_path to '' as $function$
  select b.id,b.name from public.brands b
  where b.organization_id=input_organization_id and (
    exists(select 1 from public.supplier_current_price_pointers ptr
      join public.supplier_price_publications pub on pub.id=ptr.publication_id
        and pub.release_id=ptr.release_id and pub.organization_id=ptr.organization_id
        and pub.supplier_id=ptr.supplier_id and pub.brand_id=ptr.brand_id and pub.status='published'
      join public.supplier_price_release_rows r on r.release_id=ptr.release_id
      where ptr.organization_id=b.organization_id and ptr.brand_id=b.id
        and r.row_status='accepted' and r.buy_price>0 and r.currency='EUR' and r.valid_from<=current_date and (r.valid_to is null or r.valid_to>=current_date)
        and r.normalized_code=public.normalize_catalog_product_code(r.product_code)
        and r.normalized_code ~ '[A-Z0-9]'
      offset 0)
    or exists(select 1 from public.supplier_prices sp
      where sp.organization_id=b.organization_id and sp.brand_id=b.id and sp.is_active
        and sp.buy_price>0 and sp.currency='EUR' and sp.valid_from<=current_date
        and (sp.valid_to is null or sp.valid_to>=current_date)
        and public.normalize_catalog_product_code(sp.product_code) ~ '[A-Z0-9]'
        and not exists(select 1 from public.supplier_current_price_pointers ptr
          where ptr.organization_id=sp.organization_id and ptr.supplier_id=sp.supplier_id and ptr.brand_id=sp.brand_id)
      offset 0)
  ) order by b.name,b.id;
$function$;

revoke all on function public.cloud_admin_price_list_brands(uuid) from public, anon, authenticated;
grant execute on function public.cloud_admin_price_list_brands(uuid) to service_role;
