set role authenticated;
set app.test_org = '11111111-1111-4111-8111-111111111111';
set app.test_role = 'admin';
do $$
declare v_failed boolean; v_payload jsonb; v_version text;
begin
  if has_table_privilege('authenticated', 'public.invoices', 'UPDATE')
     or has_table_privilege('authenticated', 'public.invoices', 'DELETE')
     or has_table_privilege('authenticated', 'public.invoices', 'TRUNCATE')
     or has_table_privilege('authenticated', 'public.invoices', 'TRIGGER') then
    raise exception 'authenticated retained risky invoice privilege';
  end if;
  if not has_table_privilege('authenticated', 'public.invoices', 'INSERT')
     or not has_table_privilege('authenticated', 'public.invoices', 'SELECT') then
    raise exception 'legacy bootstrap or reads were disabled';
  end if;
  v_failed := false;
  begin update public.invoices set notes = 'bad direct update' where id = 'partial-one';
  exception when insufficient_privilege then v_failed := true; end;
  if not v_failed then raise exception 'direct update allowed'; end if;
  v_failed := false;
  begin delete from public.invoices where id = 'partial-one';
  exception when insufficient_privilege then v_failed := true; end;
  if not v_failed then raise exception 'direct delete allowed'; end if;
  v_failed := false;
  begin insert into public.invoices(id, organization_id, sales_order_id, customer_name, lines)
    values ('partial-one', '11111111-1111-4111-8111-111111111111', 'partial', 'Customer A', '[]');
  exception when others then v_failed := true; end;
  if not v_failed then raise exception 'same-id insert overwrote existing invoice'; end if;
  v_failed := false;
  begin insert into public.invoices(id, organization_id, sales_order_id, customer_name, lines)
    values ('direct-full', '11111111-1111-4111-8111-111111111111', 'partial', 'Customer A', '[{"product_code":"A","brand":"B","qty":10}]');
  exception when others then v_failed := position('SALES_ORDER_ALREADY_INVOICED' in sqlerrm)>0; end;
  if not v_failed then raise exception 'direct duplicate full invoice allowed'; end if;
  insert into public.invoices(id, organization_id, sales_order_id, customer_name, lines)
    values ('direct-partial', '11111111-1111-4111-8111-111111111111', 'partial', 'Customer A', '[{"product_code":"A","brand":"B","qty":2}]');
  select updated_at::text into v_version from public.invoices where id = 'partial-one';
  v_payload := jsonb_build_object('id','partial-one','sales_order_id','partial','customer_name','Customer A','currency','EUR','expected_updated_at',v_version,'notes','guarded-rpc');
  perform public.save_invoice_atomic(v_payload, 'partial-one');
  if (select notes from public.invoices where id='partial-one') <> 'guarded-rpc' then raise exception 'guarded save stopped working'; end if;
end $$;
