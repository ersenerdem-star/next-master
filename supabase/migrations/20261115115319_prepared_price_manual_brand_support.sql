-- Keep published and legacy eligibility unchanged, while admitting a brand
-- with an active manual-only price from an enabled supplier.
create or replace function public.cloud_admin_price_list_brands(input_organization_id uuid)
returns table(id uuid,name text) language sql stable security definer set search_path='' as $fn$
  select b.id,b.name from public.brands b
  where b.organization_id=input_organization_id and (
    exists(select 1 from public.supplier_current_price_pointers ptr
      join public.supplier_price_publications pub on pub.id=ptr.publication_id
        and pub.release_id=ptr.release_id and pub.organization_id=ptr.organization_id
        and pub.supplier_id=ptr.supplier_id and pub.brand_id=ptr.brand_id and pub.status='published'
        and public.supplier_price_usage_enabled(pub.organization_id,pub.supplier_id)
      join public.supplier_price_release_rows r on r.release_id=ptr.release_id
      where ptr.organization_id=b.organization_id and ptr.brand_id=b.id
        and r.row_status='accepted' and r.buy_price>0 and r.currency='EUR'
        and r.valid_from<=current_date and (r.valid_to is null or r.valid_to>=current_date)
        and r.normalized_code=public.normalize_catalog_product_code(r.product_code)
        and r.normalized_code ~ '[A-Z0-9]' offset 0)
    or exists(select 1 from public.supplier_prices sp
      where sp.organization_id=b.organization_id and sp.brand_id=b.id and sp.is_active
        and exists(select 1 from public.suppliers s where s.organization_id=sp.organization_id and s.id=sp.supplier_id and s.price_usage_enabled)
        and sp.buy_price>0 and sp.currency='EUR' and sp.valid_from<=current_date
        and (sp.valid_to is null or sp.valid_to>=current_date)
        and public.normalize_catalog_product_code(sp.product_code) ~ '[A-Z0-9]'
        and not exists(select 1 from public.supplier_current_price_pointers ptr
          where ptr.organization_id=sp.organization_id and ptr.supplier_id=sp.supplier_id and ptr.brand_id=sp.brand_id) offset 0)
    or exists(select 1 from supplier_manual_price_internal.entries m
      join public.suppliers s on s.organization_id=m.organization_id and s.id=m.supplier_id
      where m.organization_id=b.organization_id and m.brand_id=b.id and m.active
        and m.valid_from<=current_date and m.buy_price>0 and m.currency='EUR'
        and s.price_usage_enabled and m.exact_code=public.normalize_catalog_product_code(m.product_code)
        and m.exact_code ~ '[A-Z0-9]' offset 0)
  ) order by b.name,b.id;
$fn$;
