do $test$
declare
  org uuid := '00000000-0000-0000-0000-000000000001';
  brand_id uuid := '00000000-0000-0000-0000-000000000002';
  supplier_id uuid := '00000000-0000-0000-0000-000000000003';
  page_row record;
  fingerprint text;
  changed text;
  n integer;
begin
  select * into page_row from public.cloud_catalog_master_export_page_v3(org,brand_id,'priced','',null,null,1,.1,.2);
  assert page_row.total_count=2 and page_row.product_code='61/1', 'first page and exact SKU';
  assert page_row.description='CAT SLASH', 'punctuation preserving catalog match';
  assert page_row.cheapest_price=90 and page_row.second_price=100 and page_row.supplier_count=2, 'two supplier comparison';
  assert page_row.sales_a=99 and page_row.sales_b=108 and page_row.sales_c is null, 'A B margins and removed C';
  assert page_row.price_gap=10 and page_row.price_gap_percent=11.11, 'comparison gap';
  select * into page_row from public.cloud_catalog_master_export_page_v3(org,brand_id,'priced','','61/1',null,1,.1,.2);
  assert page_row.total_count is null and page_row.product_code='611' and page_row.description='CAT COMPACT', 'following keyset page';
  select count(*) into n from public.cloud_catalog_master_export_page_v3(org,brand_id,'priced','','611',null,1,.1,.2);
  assert n=0, 'final page exhausted';
  select count(*) into n from public.cloud_catalog_master_export_page_v3('00000000-0000-0000-0000-000000000999',brand_id);
  assert n=0, 'tenant isolation';
  select * into page_row from public.cloud_catalog_master_export_page_fast(org,brand_id,'priced','',2,1,.1,.2);
  assert page_row.product_code='611' and page_row.total_count=2, 'legacy paging compatibility';
  select count(*) into n from public.cloud_catalog_master_export_page_v3(org,brand_id,'catalog','',null,null,100,.1,.2) m
    join public.cloud_admin_price_list_page_fast(org,brand_id,'A',.1,null,null,100) a on a.product_code=m.product_code
    where a.sales_price=m.sales_a;
  assert n=2, 'A price parity with existing admin source';
  select * into page_row from public.cloud_supplier_price_export_page(org,supplier_id,brand_id,'','all',null,null,1);
  assert page_row.product_code='61/1' and page_row.buy_price=100 and page_row.total_count=2, 'supplier current published scope';
  select * into page_row from public.cloud_supplier_price_export_page(org,supplier_id,brand_id,'','all',page_row.product_code,page_row.price_id,1);
  assert page_row.product_code='611' and page_row.total_count is null, 'supplier published cursor';
  select public.get_catalog_export_version(org,brand_id) into fingerprint;
  update public.brands set name='Renamed Clevite' where id=brand_id;
  select public.get_catalog_export_version(org,brand_id) into changed;
  assert fingerprint<>changed, 'brand labels invalidate catalog cache';
  update public.brands set name='Clevite' where id=brand_id;
  select public.get_catalog_master_export_version(org,'00000000-0000-0000-0000-000000000203') into fingerprint;
  insert into public.supplier_current_price_pointers values
    (org,'00000000-0000-0000-0000-000000000203',supplier_id,'00000000-0000-0000-0000-000000000998','00000000-0000-0000-0000-000000000999');
  select public.get_catalog_master_export_version(org,'00000000-0000-0000-0000-000000000203') into changed;
  assert fingerprint<>changed, 'invalid pointer presence invalidates legacy master cache';
  delete from public.supplier_current_price_pointers where supplier_current_price_pointers.brand_id='00000000-0000-0000-0000-000000000203';
  select public.get_supplier_price_export_version(org,supplier_id,brand_id) into fingerprint;
  update public.supplier_price_publications set status='withdrawn';
  select public.get_supplier_price_export_version(org,supplier_id,brand_id) into changed;
  assert fingerprint<>changed, 'publication changes invalidate supplier cache';
  select count(*) into n from public.cloud_supplier_price_export_page(org,supplier_id,brand_id);
  assert n=0, 'invalid supplier pointer fails closed';
  select count(*) into n from public.cloud_catalog_master_export_page_v3(org,brand_id);
  assert n=0, 'invalid master pointer fails closed';
  update public.supplier_price_publications set status='published';
  assert not has_function_privilege('authenticated','public.cloud_catalog_master_export_page_v3(uuid,uuid,text,text,text,uuid,integer,numeric,numeric)','execute'), 'master RPC private';
  assert not has_function_privilege('anon','public.cloud_catalog_export_fast(uuid,uuid,text)','execute'), 'legacy catalog RPC private';
  assert has_function_privilege('service_role','public.cloud_catalog_export_page_v3(uuid,uuid,text,uuid,integer)','execute'), 'worker catalog access';
end;
$test$;

-- Above the former 150,000-row catalog ceiling: page every row and verify the
-- compatibility source no longer returns a truncated JSON document.
insert into public.brands values('00000000-0000-0000-0000-000000000202','00000000-0000-0000-0000-000000000001','Large Fixture');
insert into public.catalog_products(id,organization_id,brand_id,product_code,normalized_code,description,market_segment)
select md5('catalog-'||n)::uuid,'00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000202',
  'SKU-'||n,'SKU'||n,'Fixture','PC' from generate_series(1,150001) n;
do $large$
declare
  v_after uuid := null;
  v_count bigint;
  v_seen bigint := 0;
  v_total bigint;
  v_next uuid;
begin
  loop
    select count(*),(array_agg(p.product_id order by p.product_id desc))[1],max(p.total_count)
      into v_count,v_next,v_total
    from public.cloud_catalog_export_page_v3('00000000-0000-0000-0000-000000000001',
      '00000000-0000-0000-0000-000000000202','PC',v_after,1000) p;
    if v_count=0 then exit; end if;
    if v_after is null then assert v_total=150001,'full first-page catalog count';
    else assert v_next>v_after and v_total is null,'catalog cursor advances without recount'; end if;
    v_after:=v_next; v_seen:=v_seen+v_count;
  end loop;
  assert v_seen=150001,'catalog keyset reads beyond former cap';
  assert jsonb_array_length(public.cloud_catalog_export_fast('00000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-000000000202','PC'))=150001,'legacy compatibility no truncation';
end;
$large$;
