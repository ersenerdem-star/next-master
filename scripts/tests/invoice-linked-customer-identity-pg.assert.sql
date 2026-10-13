set role authenticated;
set app.test_org = '11111111-1111-4111-8111-111111111111';
set app.test_role = 'admin';

do $$
declare
  v_result jsonb;
  v_count integer;
  v_failed boolean;
begin
  v_result := public.save_invoice_atomic('{"id":"invoice-single","sales_order_id":"a-1","customer_name":"Customer A","currency":"EUR"}'::jsonb);
  if v_result #>> '{invoice,customer_id}' <> 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' then
    raise exception 'RPC did not bind the single linked sales order customer';
  end if;
  select count(*) into v_count from public.invoices
  where customer_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    and id = 'invoice-single';
  if v_count <> 1 then raise exception 'customer-ID portal history filter cannot see new invoice'; end if;

  perform public.save_invoice_atomic('{"id":"draft-shift-invoice","sales_order_id":"draft-shift","customer_name":"Customer A","currency":"EUR"}'::jsonb);
  v_failed := false;
  begin
    -- The preceding pricing guard resolves Customer B by name and changes
    -- customer_id inside its BEFORE UPDATE trigger. This guard must run next.
    update public.sales_orders set customer_name = 'Customer B' where id = 'draft-shift';
  exception when others then
    v_failed := position('Invoiced sales order customer account cannot change or be deleted' in sqlerrm) > 0;
  end;
  if not v_failed
    or (select customer_id from public.sales_orders where id = 'draft-shift')
       is distinct from 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid
    or (select customer_id from public.invoices where id = 'draft-shift-invoice')
       is distinct from 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid then
    raise exception 'draft sales order rebind left invoice with a stale customer';
  end if;

  v_failed := false;
  begin
    delete from public.sales_orders where id = 'draft-shift';
  exception when others then
    v_failed := position('Invoiced sales order customer account cannot change or be deleted' in sqlerrm) > 0;
  end;
  if not v_failed then raise exception 'direct deletion orphaned an invoice'; end if;

  perform public.delete_invoice_guarded('draft-shift-invoice');
  update public.sales_orders set customer_name = 'Customer B' where id = 'draft-shift';
  if (select customer_id from public.sales_orders where id = 'draft-shift')
       is distinct from 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'::uuid then
    raise exception 'uninvoiced draft sales order could not switch customer';
  end if;

  v_result := public.save_invoice_atomic('{"id":"invoice-multi","sales_order_id":"a-1","sales_order_ids":["a-1","a-2"],"customer_name":"Customer A","currency":"EUR"}'::jsonb);
  if v_result #>> '{invoice,customer_id}' <> 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' then
    raise exception 'RPC did not bind a same-customer multi-order invoice';
  end if;

  v_failed := false;
  begin
    perform public.save_invoice_atomic('{"id":"forged-name","sales_order_id":"b-1","customer_name":"Customer A","currency":"EUR"}'::jsonb);
  exception when others then
    v_failed := position('Invoice customer name must match the linked customer account' in sqlerrm) > 0;
  end;
  if not v_failed or exists(select 1 from public.invoices where id = 'forged-name') then
    raise exception 'B-bound invoice with visible A customer name was accepted';
  end if;

  v_result := public.save_invoice_atomic('{"id":"renamed-name","sales_order_id":"a-1","customer_name":"  RENAMED A  ","currency":"EUR"}'::jsonb);
  if v_result #>> '{invoice,customer_id}' <> 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' then
    raise exception 'renamed same-ID customer display name was rejected';
  end if;
  v_result := public.save_invoice_atomic('{"id":"legal-name","sales_order_id":"a-1","customer_name":"Legal A Ltd","currency":"EUR"}'::jsonb);
  if v_result #>> '{invoice,customer_id}' <> 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' then
    raise exception 'same-ID customer legal company name was rejected';
  end if;

  v_failed := false;
  begin
    perform public.save_invoice_atomic('{"id":"invoice-mixed","sales_order_id":"a-1","sales_order_ids":["a-1","b-1"],"customer_name":"Customer A","currency":"EUR"}'::jsonb);
  exception when others then
    v_failed := position('All linked sales orders must belong to one customer account' in sqlerrm) > 0;
  end;
  if not v_failed or exists(select 1 from public.invoices where id = 'invoice-mixed') then
    raise exception 'mixed-customer invoice was not rejected atomically';
  end if;

  perform public.save_invoice_atomic('{"id":"rename-source","sales_order_id":"a-1","customer_name":"Customer A","currency":"EUR"}'::jsonb);
  v_failed := false;
  begin
    perform public.save_invoice_atomic(
      '{"id":"rename-target","sales_order_id":"a-1","sales_order_ids":["a-1","b-1"],"customer_name":"Customer A","currency":"EUR"}'::jsonb,
      'rename-source'
    );
  exception when others then
    v_failed := position('All linked sales orders must belong to one customer account' in sqlerrm) > 0;
  end;
  if not v_failed
    or not exists(select 1 from public.invoices where id = 'rename-source')
    or exists(select 1 from public.invoices where id = 'rename-target') then
    raise exception 'failed invoice ID replacement did not roll back the original';
  end if;

  v_failed := false;
  begin
    perform public.save_invoice_atomic('{"id":"invoice-unbound","sales_order_id":"unbound","currency":"EUR"}'::jsonb);
  exception when others then
    v_failed := position('Linked sales order has no customer account' in sqlerrm) > 0;
  end;
  if not v_failed then raise exception 'unbound sales-order customer was accepted'; end if;

  v_failed := false;
  begin
    perform public.save_invoice_atomic('{"id":"invoice-missing","sales_order_id":"missing","currency":"EUR"}'::jsonb);
  exception when others then
    v_failed := position('Linked sales order was not found' in sqlerrm) > 0;
  end;
  if not v_failed then raise exception 'missing sales order was accepted'; end if;

  v_failed := false;
  begin
    perform public.save_invoice_atomic('{"id":"invoice-other-org","sales_order_id":"other-org","currency":"EUR"}'::jsonb);
  exception when others then
    v_failed := position('Linked sales order was not found' in sqlerrm) > 0;
  end;
  if not v_failed then raise exception 'other-organization sales order was accepted'; end if;

  v_failed := false;
  begin
    perform public.save_invoice_atomic('{"id":"invoice-wrong-customer-org","sales_order_id":"wrong-org-customer","currency":"EUR"}'::jsonb);
  exception when others then
    v_failed := position('Linked customer account is outside this organization' in sqlerrm) > 0;
  end;
  if not v_failed then raise exception 'cross-organization customer reference was accepted'; end if;

  v_failed := false;
  begin
    insert into public.invoices (id, organization_id, sales_order_id, customer_name, customer_id)
    values ('forged-insert', '11111111-1111-4111-8111-111111111111', 'a-1', 'Customer A',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  exception when others then
    v_failed := position('Invoice customer account must match linked sales orders' in sqlerrm) > 0;
  end;
  if not v_failed then raise exception 'forged direct invoice insert was accepted'; end if;

  -- Legacy local bootstrap inserts invoices directly, sometimes without a
  -- surviving sales order. They remain unbound and cannot appear in the wrong
  -- customer's portal history.
  insert into public.invoices (id, organization_id, sales_order_id, customer_name)
  values ('standalone-bootstrap', '11111111-1111-4111-8111-111111111111', 'old-local-order', 'Historical customer');
  if (select customer_id from public.invoices where id = 'standalone-bootstrap') is not null then
    raise exception 'standalone bootstrap invoice guessed a customer';
  end if;
  v_failed := false;
  begin
    insert into public.invoices (id, organization_id, sales_order_id, customer_id)
    values ('forged-standalone', '11111111-1111-4111-8111-111111111111', 'missing',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  exception when others then
    v_failed := position('Standalone invoice cannot claim a linked customer account' in sqlerrm) > 0;
  end;
  if not v_failed then raise exception 'unlinked invoice claimed a portal customer'; end if;

  insert into public.invoices (id, organization_id, sales_order_id, customer_name)
  values ('direct-insert', '11111111-1111-4111-8111-111111111111', 'a-1', 'Customer A');
  if (select customer_id from public.invoices where id = 'direct-insert')
       is distinct from 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid then
    raise exception 'direct invoice insert did not bind customer';
  end if;

  v_failed := false;
  begin
    update public.invoices set customer_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    where id = 'direct-insert';
  exception when others then
    v_failed := position('Invoice customer account must match linked sales orders' in sqlerrm) > 0;
  end;
  if not v_failed then raise exception 'forged direct invoice update was accepted'; end if;

  v_failed := false;
  begin
    update public.invoices set sales_order_ids = array['a-1', 'b-1']
    where id = 'direct-insert';
  exception when others then
    v_failed := position('All linked sales orders must belong to one customer account' in sqlerrm) > 0;
  end;
  if not v_failed then raise exception 'mixed direct invoice update was accepted'; end if;

  -- Existing RPC omits customer_id in its ON CONFLICT update. Rebinding must
  -- still follow the new linked order rather than retaining the old UUID.
  v_result := public.save_invoice_atomic('{"id":"invoice-single","sales_order_id":"b-1","customer_name":"Customer B","currency":"EUR"}'::jsonb);
  if v_result #>> '{invoice,customer_id}' <> 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' then
    raise exception 'RPC invoice update retained stale customer identity';
  end if;

  if (select customer_id from public.invoices where id = 'legacy') is not null then
    raise exception 'migration silently backfilled ambiguous historical invoice';
  end if;
  update public.invoices set status = 'paid', updated_at = now() where id = 'legacy';
  if (select status from public.invoices where id = 'legacy') <> 'paid' then
    raise exception 'historical invoice payment status update was blocked';
  end if;
  update public.invoices set notes = 'historical edit' where id = 'legacy';
  if (select customer_id from public.invoices where id = 'legacy') is not null then
    raise exception 'historical unrelated invoice was assigned a portal customer';
  end if;
end $$;

set app.test_role = 'sales';
do $$
declare v_failed boolean := false;
begin
  begin
    perform public.save_invoice_atomic('{"id":"sales-invoice","sales_order_id":"a-1","customer_name":"Customer A","currency":"EUR"}'::jsonb);
  exception when others then
    v_failed := position('Only active admin users can save invoices' in sqlerrm) > 0;
  end;
  if not v_failed then raise exception 'sales role bypassed invoice RPC admin boundary'; end if;
end $$;

reset role;
do $$
begin
  if has_function_privilege('authenticated', 'invoice_identity_private.bind_invoice_linked_customer()', 'EXECUTE')
    or has_function_privilege('service_role', 'invoice_identity_private.bind_invoice_linked_customer()', 'EXECUTE')
  then
    raise exception 'private trigger function can be invoked directly';
  end if;
end $$;

select 'invoice linked customer identity fixture passed' as result;
