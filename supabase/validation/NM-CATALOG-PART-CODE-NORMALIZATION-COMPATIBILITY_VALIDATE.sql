-- NM-CATALOG-PART-CODE-NORMALIZATION-COMPATIBILITY-FIX
-- Post-migration, read-only validation.

do $$
declare
  invalid_policy_count integer;
  invalid_product_count integer;
begin
  if public.normalize_catalog_product_code(' 7. 00468.42. 0 ') <> '7.00468.42.0' then
    raise exception 'Pierburg punctuation-preserving normalization failed';
  end if;

  if public.normalize_catalog_product_code(' 81 - 1116 ') <> '81-1116' then
    raise exception 'TRW punctuation-preserving normalization failed';
  end if;

  if public.normalize_catalog_product_code(' 20 0602/08-260 ') <> '200602/08-260' then
    raise exception 'BF punctuation-preserving normalization failed';
  end if;

  if public.normalize_catalog_product_code(' 40 448 601 ') <> '40448601' then
    raise exception 'Kolbenschmidt whitespace normalization failed';
  end if;

  if public.normalize_part_code('7.00468.42.0') <> '700468420' then
    raise exception 'Legacy compact lookup compatibility changed unexpectedly';
  end if;

  select count(*)::integer
    into invalid_policy_count
  from (
    values
      ('BF'),
      ('KOLBENSCHMIDT'),
      ('PIERBURG'),
      ('TRWENGINECOMPONENT'),
      ('TRWENGINECOMPONENTS')
  ) expected(brand_key)
  left join public.product_code_normalization_policies p
    on p.brand_key = expected.brand_key
   and p.policy = 'compact_space'
   and p.active
  where p.brand_key is null;

  if invalid_policy_count > 0 then
    raise exception 'Missing or invalid Motorservice normalization policies: %', invalid_policy_count;
  end if;

  select count(*)::integer
    into invalid_product_count
  from public.catalog_products p
  join public.brands b on b.id = p.brand_id
  where public.normalize_catalog_brand_key(b.name) in (
    'BF',
    'KOLBENSCHMIDT',
    'PIERBURG',
    'TRWENGINECOMPONENT',
    'TRWENGINECOMPONENTS'
  )
    and p.product_code is distinct from public.normalize_catalog_product_code(p.product_code);

  if invalid_product_count > 0 then
    raise exception 'Target catalog products remain outside whitespace-only policy: %', invalid_product_count;
  end if;

  if not exists (
    select 1
    from pg_trigger t
    where t.tgrelid = 'public.catalog_products'::regclass
      and t.tgname = 'trg_catalog_products_canonical_code'
      and not t.tgisinternal
  ) then
    raise exception 'Catalog product canonical-code trigger is missing';
  end if;
end
$$;

select
  public.normalize_catalog_product_code(' 7. 00468.42. 0 ') as pierburg_canonical,
  public.normalize_catalog_product_code(' 81 - 1116 ') as trw_canonical,
  public.normalize_catalog_product_code(' 20 0602/08-260 ') as bf_canonical,
  public.normalize_catalog_product_code(' 40 448 601 ') as kolbenschmidt_canonical,
  public.normalize_part_code('7.00468.42.0') as legacy_compact_lookup;
