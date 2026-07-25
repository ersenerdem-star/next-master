-- Reusable source-backed catalog relation example.
-- Copy this block into a separately reviewed brand onboarding migration and
-- replace every EXAMPLE value with evidence from that brand's official source.
--
-- Direction:
--   replacement = current catalog product replaces the related old code
--   replaced_by = current catalog product is superseded by the related new code
--   alternative = source states interchangeability; no lifecycle inference
--
-- Normalization removes whitespace only:
--   OLD 12/34.A -> OLD12/34.A
-- Hyphens, slashes and dots are preserved.

do $example$
declare
  v_product_id uuid;
  v_source_record_id uuid;
begin
  select p.id
    into v_product_id
  from public.catalog_products p
  join public.brands b on b.id = p.brand_id
  where lower(b.name) = lower('EXAMPLE CURRENT BRAND')
    and public.normalize_catalog_relation_code(p.product_code)
      = public.normalize_catalog_relation_code('NEW 12/34.A')
  limit 1;

  if v_product_id is null then
    raise exception 'Example target product not found; replace the EXAMPLE values before use';
  end if;

  select s.id
    into v_source_record_id
  from public.catalog_product_source_records s
  where s.catalog_product_id = v_product_id
    and s.source_key = 'official-brand-catalog'
  order by s.retrieved_at desc
  limit 1;

  if v_source_record_id is null then
    raise exception 'Official source record is required before recording a relation';
  end if;

  perform public.record_catalog_product_relation(
    input_catalog_product_id => v_product_id,
    input_source_record_id => v_source_record_id,
    input_relation_type => 'replacement',
    input_related_brand => 'EXAMPLE CURRENT BRAND',
    input_related_product_code => 'OLD 12/34.A',
    input_related_oem_no => null,
    input_related_description => 'Official source states that the current code replaces the related code'
  );
end
$example$;
