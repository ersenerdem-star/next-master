-- NM-CATALOG-PART-CODE-NORMALIZATION-COMPATIBILITY-FIX
-- Local fixture validation. The caller must run this against a disposable or
-- local database. All fixture writes are rolled back.

begin;

do $$
declare
  v_organization_id uuid := gen_random_uuid();
  v_pierburg_brand_id uuid := gen_random_uuid();
  v_trw_brand_id uuid := gen_random_uuid();
  v_pierburg_product_id uuid := gen_random_uuid();
  v_trw_product_id uuid := gen_random_uuid();
  v_product_code text;
  v_legacy_lookup text;
begin
  insert into public.organizations (id, name)
  values (v_organization_id, 'NM normalization compatibility fixture');

  insert into public.brands (id, organization_id, name)
  values
    (v_pierburg_brand_id, v_organization_id, 'Pierburg'),
    (v_trw_brand_id, v_organization_id, 'TRW Engine Components');

  insert into public.catalog_products (
    id,
    organization_id,
    brand_id,
    product_code,
    description
  )
  values
    (
      v_pierburg_product_id,
      v_organization_id,
      v_pierburg_brand_id,
      ' 7. 00468.42. 0 ',
      'Normalization fixture'
    ),
    (
      v_trw_product_id,
      v_organization_id,
      v_trw_brand_id,
      ' 81 - 1116 ',
      'Normalization fixture'
    );

  select p.product_code, p.normalized_code
    into v_product_code, v_legacy_lookup
  from public.catalog_products p
  where p.id = v_pierburg_product_id;

  if v_product_code <> '7.00468.42.0' then
    raise exception 'Pierburg canonical product code mismatch: %', v_product_code;
  end if;

  if v_legacy_lookup <> '700468420' then
    raise exception 'Pierburg legacy lookup mismatch: %', v_legacy_lookup;
  end if;

  select p.product_code, p.normalized_code
    into v_product_code, v_legacy_lookup
  from public.catalog_products p
  where p.id = v_trw_product_id;

  if v_product_code <> '81-1116' then
    raise exception 'TRW canonical product code mismatch: %', v_product_code;
  end if;

  if v_legacy_lookup <> '811116' then
    raise exception 'TRW legacy lookup mismatch: %', v_legacy_lookup;
  end if;

  update public.catalog_products
  set product_code = ' 105 - 35609 '
  where id = v_trw_product_id;

  select p.product_code, p.normalized_code
    into v_product_code, v_legacy_lookup
  from public.catalog_products p
  where p.id = v_trw_product_id;

  if v_product_code <> '105-35609' then
    raise exception 'TRW update canonicalization mismatch: %', v_product_code;
  end if;

  if v_legacy_lookup <> '10535609' then
    raise exception 'TRW update legacy lookup mismatch: %', v_legacy_lookup;
  end if;
end
$$;

rollback;
