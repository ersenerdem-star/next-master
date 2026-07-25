-- Read-only preflight for NM-CATALOG-PRODUCT-RELATION-CONTRACT.
-- Apply is blocked unless invalid_target_rows and source_boundary_mismatches are zero.

select
  count(*) as total_relation_rows,
  count(*) filter (
    where nullif(btrim(coalesce(r.related_product_code, '')), '') is null
      and nullif(btrim(coalesce(r.related_oem_no, '')), '') is null
  ) as invalid_target_rows,
  count(*) filter (where r.source_record_id is null) as rows_without_source_record
from public.catalog_product_relations r;

select count(*) as source_boundary_mismatches
from public.catalog_product_relations r
join public.catalog_product_source_records s on s.id = r.source_record_id
where s.organization_id <> r.organization_id
   or s.catalog_product_id <> r.catalog_product_id;

select
  r.relation_type,
  count(*) as relation_count
from public.catalog_product_relations r
group by r.relation_type
order by r.relation_type;

select
  has_table_privilege('authenticated', 'public.catalog_product_relations', 'SELECT') as authenticated_can_select_before,
  has_table_privilege('authenticated', 'public.catalog_product_relations', 'INSERT') as authenticated_can_insert_before,
  has_table_privilege('service_role', 'public.catalog_product_relations', 'INSERT') as service_role_can_insert_before;
