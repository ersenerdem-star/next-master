set role authenticated;
set request.jwt.claim.sub = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
do $$
declare
  v_count integer;
  v_customer_id uuid;
  v_ambiguous boolean := false;
begin
  select count(*) into v_count from public.customers
  where lower(btrim(display_name)) = 'acme' or lower(btrim(company_name)) = 'acme';
  if v_count <> 1 then raise exception 'fixture failed: assigned sales should see one Acme'; end if;

  begin
    perform * from public.find_invoice_price_customer_name_matches(
      '11111111-1111-4111-8111-111111111111', ' acMe '
    );
  exception when sqlstate 'P0001' then
    v_ambiguous := sqlerrm = 'AMBIGUOUS_CUSTOMER_ACCOUNT';
  end;
  if not v_ambiguous then raise exception 'visible plus hidden duplicate was not rejected'; end if;

  select count(*) into v_count from public.customers
  where lower(btrim(display_name)) = 'three-way' or lower(btrim(company_name)) = 'three-way';
  if v_count <> 1 then raise exception 'fixture failed: assigned sales should see only the third Three-Way match'; end if;

  v_ambiguous := false;
  begin
    perform * from public.find_invoice_price_customer_name_matches(
      '11111111-1111-4111-8111-111111111111', 'Three-Way'
    );
  exception when sqlstate 'P0001' then
    v_ambiguous := sqlerrm = 'AMBIGUOUS_CUSTOMER_ACCOUNT';
  end;
  if not v_ambiguous then raise exception 'third visible match after two hidden duplicates was not rejected'; end if;

  select customer_id into v_customer_id
  from public.find_invoice_price_customer_name_matches(
    '11111111-1111-4111-8111-111111111111', 'Unique Visible'
  );
  if v_customer_id is distinct from '11111111-cccc-4ccc-8ccc-cccccccccccc'::uuid then
    raise exception 'unique assigned customer lookup failed';
  end if;

  select count(*) into v_count
  from public.find_invoice_price_customer_name_matches(
    '11111111-1111-4111-8111-111111111111', 'Unique Hidden'
  );
  if v_count <> 0 then raise exception 'hidden unique customer leaked'; end if;

  select count(*) into v_count
  from public.find_invoice_price_customer_name_matches(
    '11111111-1111-4111-8111-111111111111', 'Hidden Pair'
  );
  if v_count <> 0 then raise exception 'hidden duplicate existence leaked'; end if;

  select count(*) into v_count
  from public.find_invoice_price_customer_name_matches(
    '22222222-2222-4222-8222-222222222222', 'Unique Visible'
  );
  if v_count <> 0 then raise exception 'cross-organization lookup leaked'; end if;
end $$;

set request.jwt.claim.sub = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
do $$
declare v_ambiguous boolean := false;
begin
  begin
    perform * from public.find_invoice_price_customer_name_matches(
      '11111111-1111-4111-8111-111111111111', 'Acme'
    );
  exception when sqlstate 'P0001' then
    v_ambiguous := sqlerrm = 'AMBIGUOUS_CUSTOMER_ACCOUNT';
  end;
  if not v_ambiguous then raise exception 'admin duplicate was not rejected'; end if;
end $$;

set request.jwt.claim.sub = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
do $$
begin
  if exists (select 1 from public.find_invoice_price_customer_name_matches(
    '11111111-1111-4111-8111-111111111111', 'Unique Visible'
  )) then raise exception 'viewer role gained customer lookup'; end if;
end $$;

set request.jwt.claim.sub = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
do $$
begin
  if exists (select 1 from public.find_invoice_price_customer_name_matches(
    '11111111-1111-4111-8111-111111111111', 'Unique Visible'
  )) then raise exception 'inactive profile gained customer lookup'; end if;
end $$;

set request.jwt.claim.sub = '';
do $$
begin
  if exists (select 1 from public.find_invoice_price_customer_name_matches(
    '11111111-1111-4111-8111-111111111111', 'Unique Visible'
  )) then raise exception 'missing JWT gained customer lookup'; end if;
end $$;
reset role;

do $$
begin
  if has_function_privilege('anon', 'public.find_invoice_price_customer_name_matches(uuid,text)', 'EXECUTE')
    or has_function_privilege('service_role', 'public.find_invoice_price_customer_name_matches(uuid,text)', 'EXECUTE')
    or not has_function_privilege('authenticated', 'public.find_invoice_price_customer_name_matches(uuid,text)', 'EXECUTE')
  then
    raise exception 'lookup RPC grants are too broad or missing';
  end if;
end $$;

select 'invoice price customer lookup fixture passed' as result;
