-- The registered SKF exact-item catalogue now serves its public product pages
-- on the SKF Vertevo origin. Preserve the source key and all admission flags.
update public.catalog_external_sources
set base_url='https://www.skfvertevo.com/eur/en/product-catalogue'
where source_key='skf_official_product_v1'
  and base_url='https://automotive.skf.com/eur/en/product-catalogue';
