-- Fixture only: timestamp before the first test edit simulates two browser tabs.
update public.invoices set updated_at = '2026-01-01 00:00:00+00' where id = 'partial-one';
set role authenticated;
set app.test_org = '11111111-1111-4111-8111-111111111111';
set app.test_role = 'admin';
do $$
declare v_failed boolean; v_payload jsonb := '{"id":"partial-one","sales_order_id":"partial","customer_name":"Customer A","currency":"EUR","notes":"first-edit","lines":[{"product_code":"A","brand":"B","qty":3,"buy_price":10,"sell_price":11}],"expected_updated_at":"2026-01-01T00:00:00Z"}';
begin
  perform public.save_invoice_atomic(v_payload, 'partial-one');
  v_failed := false;
  begin perform public.save_invoice_atomic(v_payload || '{"notes":"stale-edit"}', 'partial-one');
  exception when others then v_failed := position('INVOICE_VERSION_CONFLICT' in sqlerrm)>0; end;
  if not v_failed or (select notes from public.invoices where id='partial-one') <> 'first-edit' then raise exception 'stale update did not preserve first edit'; end if;
  v_failed := false;
  begin perform public.save_invoice_atomic(v_payload - 'expected_updated_at', 'partial-one');
  exception when others then v_failed := position('INVOICE_VERSION_REQUIRED' in sqlerrm)>0; end;
  if not v_failed then raise exception 'old client update was not rejected'; end if;
  v_failed := false;
  begin perform public.delete_invoice_guarded('partial-one', '2026-01-01T00:00:00Z');
  exception when others then v_failed := position('INVOICE_VERSION_CONFLICT' in sqlerrm)>0; end;
  if not v_failed or not exists(select 1 from public.invoices where id='partial-one') then raise exception 'stale delete not rejected'; end if;
  v_failed := false;
  begin perform public.delete_invoice_guarded('partial-one');
  exception when others then v_failed := position('INVOICE_VERSION_REQUIRED' in sqlerrm)>0; end;
  if not v_failed then raise exception 'old client delete was not rejected'; end if;
  v_failed := false;
  begin perform public.save_invoice_atomic(v_payload || jsonb_build_object('expected_updated_at', (select updated_at from public.invoices where id='partial-one')), 'partial-one');
  exception when others then v_failed := true; end;
  if v_failed then raise exception 'fresh version update failed'; end if;
  perform public.delete_invoice_guarded('partial-two', (select updated_at::text from public.invoices where id='partial-two'));
  if exists(select 1 from public.invoices where id='partial-two') then raise exception 'fresh version delete failed'; end if;
end $$;
