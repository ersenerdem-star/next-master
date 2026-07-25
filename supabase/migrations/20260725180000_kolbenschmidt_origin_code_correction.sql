-- NM-CATALOG-KOLBENSCHMIDT-ORIGIN-CODE-CORRECTION
-- Canonical origin values use ISO 3166-1 alpha-2 codes.

update public.catalog_products p
set
  origin = 'PL',
  updated_at = now()
from public.brands b
where b.id = p.brand_id
  and lower(b.name) = 'kolbenschmidt'
  and public.normalize_part_code(p.product_code) = public.normalize_part_code('40 448 601')
  and upper(trim(coalesce(p.origin, ''))) in ('POLAND', 'PL');

update public.catalog_product_attributes a
set value_text = 'PL'
from public.catalog_products p
join public.brands b on b.id = p.brand_id
where a.catalog_product_id = p.id
  and a.organization_id = p.organization_id
  and a.attribute_key = 'secondary_origin'
  and lower(b.name) = 'kolbenschmidt'
  and public.normalize_part_code(p.product_code) = public.normalize_part_code('40 448 601');
