\set ON_ERROR_STOP on

-- Run after 20260726145032_catalog_operations_status.sql inside a transaction.
-- The caller must roll the transaction back after validation.

insert into public.organizations (id, name)
values
  ('71000000-0000-4000-8000-000000000001', 'Catalog Operations Validation'),
  ('72000000-0000-4000-8000-000000000001', 'Catalog Operations Other Tenant');

insert into public.profiles (id, organization_id, email, role)
values (
  '71000000-0000-4000-8000-000000000002',
  '71000000-0000-4000-8000-000000000001',
  'catalog-operations-validation@example.invalid',
  'superadmin'
);

insert into public.brands (id, organization_id, name)
values
  (
    '71000000-0000-4000-8000-000000000003',
    '71000000-0000-4000-8000-000000000001',
    'TRW'
  ),
  (
    '71000000-0000-4000-8000-000000000004',
    '71000000-0000-4000-8000-000000000001',
    'TRW Engine Components'
  ),
  (
    '72000000-0000-4000-8000-000000000003',
    '72000000-0000-4000-8000-000000000001',
    'TRW'
  );

insert into public.catalog_products (
  id,
  organization_id,
  brand_id,
  product_code,
  description,
  origin,
  hs_code,
  weight_kg,
  ean,
  oem_no,
  vehicle,
  image_url,
  market_segment
)
values
  (
    '71000000-0000-4000-8000-000000000005',
    '71000000-0000-4000-8000-000000000001',
    '71000000-0000-4000-8000-000000000003',
    'ZF-TRW-001',
    'Complete ZF TRW fixture',
    'DE',
    '8708.80',
    1.2500,
    '4000000000001',
    'OE-TRW-001',
    'Commercial vehicle',
    'https://example.invalid/trw-001.jpg',
    'cv'
  ),
  (
    '71000000-0000-4000-8000-000000000006',
    '71000000-0000-4000-8000-000000000001',
    '71000000-0000-4000-8000-000000000004',
    'MS-TRW-001',
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    'engines'
  ),
  (
    '72000000-0000-4000-8000-000000000005',
    '72000000-0000-4000-8000-000000000001',
    '72000000-0000-4000-8000-000000000003',
    'OTHER-TENANT-TRW',
    'Must never appear in the first tenant summary',
    'DE',
    '8708.80',
    1.0000,
    '4000000000003',
    'OE-OTHER-TRW',
    'Other tenant vehicle',
    'https://example.invalid/other-trw.jpg',
    'cv'
  );

select set_config(
  'request.jwt.claim.sub',
  '71000000-0000-4000-8000-000000000002',
  true
);
set local role authenticated;

do $$
declare
  v_summary jsonb;
  v_brand_count integer;
begin
  select public.get_catalog_integrity_summary() into v_summary;

  if (v_summary ->> 'total_products')::integer <> 2
     or (v_summary ->> 'clear_count')::integer <> 1
     or (v_summary ->> 'incomplete_count')::integer <> 1
     or (v_summary ->> 'missing_ean_count')::integer <> 1
     or (v_summary ->> 'missing_oem_count')::integer <> 1
     or (v_summary ->> 'missing_vehicle_count')::integer <> 1
     or (v_summary ->> 'missing_image_count')::integer <> 1 then
    raise exception 'Unexpected Catalog Operations Status insert snapshot: %', v_summary;
  end if;

  select count(*) into v_brand_count
  from public.get_catalog_operations_brand_status(12)
  where brand in ('TRW', 'TRW Engine Components');

  if v_brand_count <> 2 then
    raise exception 'TRW and TRW Engine Components must remain separate brand identities';
  end if;

  if exists (
    select 1
    from public.get_catalog_operations_brand_status(12)
    where brand_id = '72000000-0000-4000-8000-000000000003'
  ) then
    raise exception 'Cross-tenant brand status leaked through Catalog Operations Status';
  end if;
end;
$$;

reset role;

update public.catalog_products
set description = 'Completed Motorservice TRW fixture',
    origin = 'DE',
    hs_code = '8409.99',
    weight_kg = 2.5000,
    ean = '4000000000002',
    oem_no = 'OE-MS-TRW-001',
    vehicle = 'Engine application',
    image_url = 'https://example.invalid/ms-trw-001.jpg'
where id = '71000000-0000-4000-8000-000000000006';

set local role authenticated;

do $$
declare
  v_summary jsonb;
begin
  select public.get_catalog_integrity_summary() into v_summary;
  if (v_summary ->> 'total_products')::integer <> 2
     or (v_summary ->> 'clear_count')::integer <> 2
     or (v_summary ->> 'incomplete_count')::integer <> 0 then
    raise exception 'Unexpected Catalog Operations Status update snapshot: %', v_summary;
  end if;
end;
$$;

reset role;

delete from public.catalog_products
where id = '71000000-0000-4000-8000-000000000005';

set local role authenticated;

do $$
declare
  v_summary jsonb;
begin
  select public.get_catalog_integrity_summary() into v_summary;
  if (v_summary ->> 'total_products')::integer <> 1
     or (v_summary ->> 'clear_count')::integer <> 1
     or (v_summary ->> 'incomplete_count')::integer <> 0 then
    raise exception 'Unexpected Catalog Operations Status delete snapshot: %', v_summary;
  end if;
end;
$$;

reset role;
