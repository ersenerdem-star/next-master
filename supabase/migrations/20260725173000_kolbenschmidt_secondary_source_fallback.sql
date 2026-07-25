-- NM-CATALOG-KOLBENSCHMIDT-SECONDARY-SOURCE-FALLBACK
-- Spareto is a secondary source only. Primary Motorservice values remain authoritative.
-- Blank canonical fields are filled only when the primary field is absent.

do $body$
declare
  v_org uuid;
  v_product uuid;
  v_source uuid;
begin
  select p.organization_id, p.id
    into v_org, v_product
  from public.catalog_products p
  join public.brands b on b.id = p.brand_id
  where lower(b.name) = 'kolbenschmidt'
    and public.normalize_part_code(p.product_code) = public.normalize_part_code('40 448 601')
  limit 1;

  if v_product is null then
    raise exception 'Kolbenschmidt target product not found';
  end if;

  insert into public.catalog_product_source_records (
    organization_id,
    catalog_product_id,
    source_key,
    source_url,
    source_product_id,
    source_version,
    source_product_type,
    source_as_of,
    payload_fingerprint
  )
  values (
    v_org,
    v_product,
    'spareto-secondary',
    'https://spareto.co.uk/products/nural-piston/87-136000-00',
    '87-136000-00',
    'NÜRAL Piston cross-referenced to Kolbenschmidt 40 448 601',
    'Piston',
    '2026-07-25',
    '1fc0a510e561316a5b668fcbfed4e98e5875a2aedc87de2c5f34b0212b31f9d3'
  )
  on conflict (organization_id, catalog_product_id, source_key, payload_fingerprint)
  do update set retrieved_at = now()
  returning id into v_source;

  insert into public.catalog_product_attributes (
    organization_id,
    catalog_product_id,
    attribute_key,
    label,
    value_text,
    value_numeric,
    unit,
    source_record_id
  )
  values
    (v_org, v_product, 'secondary_weight_kg', 'Secondary source weight', null, 4.02, 'kg', v_source),
    (v_org, v_product, 'secondary_hs_code', 'Secondary source customs code', '840999', null, null, v_source),
    (v_org, v_product, 'secondary_origin', 'Secondary source country of origin', 'Poland', null, null, v_source),
    (v_org, v_product, 'secondary_oem', 'Secondary source OE number', 'A 541 030 14 17', null, null, v_source)
  on conflict (organization_id, catalog_product_id, attribute_key, ordinal)
  do update set
    value_text = excluded.value_text,
    value_numeric = excluded.value_numeric,
    unit = excluded.unit,
    source_record_id = excluded.source_record_id;

  update public.catalog_products
  set
    weight_kg = coalesce(weight_kg, 4.02),
    hs_code = coalesce(nullif(trim(hs_code), ''), '840999'),
    origin = coalesce(nullif(trim(origin), ''), 'Poland'),
    oem_no = coalesce(nullif(trim(oem_no), ''), 'A 541 030 14 17'),
    updated_at = now()
  where id = v_product
    and organization_id = v_org;
end
$body$;
