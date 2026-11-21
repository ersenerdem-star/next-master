-- Run against a disposable database containing the matching TITANX test fixture.
-- All changes are rolled back; the production catalog must not be used.
begin;
do $$ begin
  if has_function_privilege('anon', 'public.catalog_titanx_oem_reference_correction(uuid)', 'execute') then
    raise exception 'Anonymous role may execute the tenant-scoped function';
  end if;
  if not has_function_privilege('service_role', 'public.catalog_titanx_oem_reference_correction(uuid)', 'execute') then
    raise exception 'Service role cannot execute the helper';
  end if;
end $$;
set local role authenticated;
select set_config('test.org', '10000000-0000-0000-0000-000000000001', true);
do $$
declare total_missing bigint; titanx_missing bigint; other_missing bigint;
begin
  select (public.get_catalog_integrity_summary()->>'missing_oem_count')::bigint into total_missing;
  select missing_oem_count into titanx_missing from public.get_catalog_operations_brand_status(100) where brand='Titanx';
  select missing_oem_count into other_missing from public.get_catalog_operations_brand_status(100) where brand='Other';
  if (total_missing,titanx_missing,other_missing) is distinct from (2::bigint,1::bigint,1::bigint) then
    raise exception 'Incorrect first snapshot %, %, %',total_missing,titanx_missing,other_missing;
  end if;
  if public.catalog_titanx_oem_reference_correction('00000000-0000-0000-0000-000000000013') <> 0 then
    raise exception 'Cross-tenant identifier leaked';
  end if;
end $$;
reset role;
delete from catalog_product_identifiers where id in (1,2);
set local role authenticated;
do $$ begin
  if (public.get_catalog_integrity_summary()->>'missing_oem_count')::integer <> 3 then
    raise exception 'Missing count did not respond to identifier removal';
  end if;
end $$;
select set_config('test.org', '10000000-0000-0000-0000-000000000002', true);
do $$ begin
  if (public.get_catalog_integrity_summary()->>'missing_oem_count')::integer <> 0 then
    raise exception 'Tenant 2 count incorrect';
  end if;
  if (select count(*) from public.get_catalog_operations_brand_status(100)) <> 1 then
    raise exception 'Brand information leaked across tenants';
  end if;
end $$;
rollback;
