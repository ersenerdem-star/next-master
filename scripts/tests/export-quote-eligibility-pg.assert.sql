do $$
declare
  org_id uuid := '00000000-0000-0000-0000-000000000001';
  brand_id uuid := '00000000-0000-0000-0000-000000000002';
  first_portal record;
  second_portal record;
  first_admin record;
  second_admin record;
  before_version text;
  after_version text;
  visible_count bigint;
begin
  select version into before_version from public.export_version_before;
  select * into first_portal
    from public.cloud_portal_customer_price_list_page_fast(org_id, brand_id, 'A', 10, null, null, 1);
  if not found or first_portal.normalized_code <> 'A-VALID'
     or first_portal.sales_price <> 110 or first_portal.total_count <> 2 then
    raise exception 'Portal first page or eligible total incorrect: %', row_to_json(first_portal);
  end if;
  select * into second_portal
    from public.cloud_portal_customer_price_list_page_fast(org_id, brand_id, 'A', 10, null, 'A-VALID', 1);
  if not found or second_portal.normalized_code <> 'G-VALID'
     or second_portal.sales_price <> 77 or coalesce(second_portal.total_count, 0) <> 0 then
    raise exception 'Portal continuation incorrect: %', row_to_json(second_portal);
  end if;

  select * into first_admin
    from public.cloud_admin_price_list_page_fast(org_id, brand_id, 'B', 0.10, null, null, 1);
  if not found or first_admin.normalized_code <> 'A-VALID'
     or first_admin.sales_price <> 110 or first_admin.total_count <> 2 then
    raise exception 'Admin first page or eligible total incorrect: %', row_to_json(first_admin);
  end if;
  select * into second_admin
    from public.cloud_admin_price_list_page_fast(org_id, brand_id, 'B', 0.10, null, 'A-VALID', 1);
  if not found or second_admin.normalized_code <> 'G-VALID'
     or second_admin.sales_price <> 77 or coalesce(second_admin.total_count, 0) <> 0 then
    raise exception 'Admin continuation incorrect: %', row_to_json(second_admin);
  end if;

  select count(*) into visible_count
    from public.cloud_portal_customer_price_list_page_fast(org_id, brand_id, 'A', 10, null, null, 100);
  if visible_count <> 2 then
    raise exception 'Portal returned an ineligible or cross-tenant row: %', visible_count;
  end if;
  select count(*) into visible_count
    from public.cloud_admin_price_list_page_fast(org_id, brand_id, 'A', 0.10, null, null, 100);
  if visible_count <> 2 then
    raise exception 'Admin returned an ineligible or cross-tenant row: %', visible_count;
  end if;
  if has_function_privilege('anon', 'public.cloud_portal_customer_price_list_page_fast(uuid,uuid,text,numeric,text,text,integer)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.cloud_admin_price_list_page_fast(uuid,uuid,text,numeric,text,text,integer)', 'EXECUTE')
     or not has_function_privilege('service_role', 'public.cloud_portal_customer_price_list_page_fast(uuid,uuid,text,numeric,text,text,integer)', 'EXECUTE') then
    raise exception 'Service-only RPC privilege boundary changed';
  end if;

  select public.get_admin_price_list_export_version(org_id, brand_id) into after_version;
  if after_version = before_version then
    raise exception 'Future effective row did not invalidate export cache';
  end if;
  update public.supplier_price_release_rows
    set valid_from = current_date
    where id in ('00000000-0000-0000-0000-000000000102',
                 '00000000-0000-0000-0000-000000000103');
  select public.get_admin_price_list_export_version(org_id, brand_id) into after_version;
  if after_version <> before_version then
    raise exception 'No-future publication changed the existing cache key';
  end if;
  select * into first_portal
    from public.cloud_portal_customer_price_list_page_fast(org_id, brand_id, 'A', 10, null, null, 1);
  if first_portal.total_count <> 3 or first_portal.sales_price <> 1.10 then
    raise exception 'Effective-date rollover did not update page and total: %', row_to_json(first_portal);
  end if;
end;
$$;
