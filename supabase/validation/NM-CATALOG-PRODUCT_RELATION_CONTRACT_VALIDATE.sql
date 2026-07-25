-- Read-only validation for NM-CATALOG-PRODUCT-RELATION-CONTRACT.

select
  public.normalize_catalog_relation_code(' OLD 12/34.A ') as normalized_example,
  public.normalize_catalog_relation_code('OLD-12 / 34.A') as punctuation_example;

select
  c.conname,
  pg_get_constraintdef(c.oid) as definition,
  c.convalidated
from pg_constraint c
where c.conrelid = 'public.catalog_product_relations'::regclass
  and c.conname = 'catalog_product_relations_target_check';

select
  a.attname,
  pg_get_expr(d.adbin, d.adrelid) as generation_expression
from pg_attribute a
join pg_attrdef d
  on d.adrelid = a.attrelid
 and d.adnum = a.attnum
where a.attrelid = 'public.catalog_product_relations'::regclass
  and a.attname in ('normalized_related_product_code', 'normalized_related_oem_no')
order by a.attname;

select
  p.proname,
  p.prosecdef as security_definer,
  p.proacl
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname = 'record_catalog_product_relation';

select
  indexname,
  indexdef
from pg_indexes
where schemaname = 'public'
  and tablename = 'catalog_product_relations'
order by indexname;
