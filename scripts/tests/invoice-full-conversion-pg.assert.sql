insert into public.sales_orders (id, organization_id, customer_id, customer_name, currency, status, lines, updated_at)
select n, '11111111-1111-4111-8111-111111111111', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Customer A', 'EUR', 'confirmed', '[{"buy_price":10,"sell_price":11}]'::jsonb, '2026-01-01T00:00:00Z'::timestamptz
from unnest(array['full1','full2','full3','missing','zero']) n;
update public.sales_orders set lines = '[{"buy_price":10,"sell_price":null}]' where id='missing';
update public.sales_orders set lines = '[{"buy_price":0,"sell_price":0}]' where id='zero';
set role authenticated;
set app.test_org = '11111111-1111-4111-8111-111111111111';
set app.test_role = 'admin';
do $$
declare v_result jsonb; v_failed boolean;
begin
  v_result := public.create_full_sales_invoices_atomic('[{"id":"full-inv1","sales_order_id":"full1","customer_name":"Customer A","currency":"EUR","lines":[{"buy_price":10,"sell_price":11}]},{"id":"full-inv2","sales_order_id":"full2","customer_name":"Customer A","currency":"EUR","lines":[{"buy_price":10,"sell_price":11}]}]', '{"full1":"2026-01-01T00:00:00Z","full2":"2026-01-01T00:00:00Z","full3":"2026-01-01T00:00:00Z","missing":"2026-01-01T00:00:00Z","zero":"2026-01-01T00:00:00Z"}');
  if jsonb_array_length(v_result->'invoices') <> 2 then raise exception 'batch conversion missing results'; end if;
  v_failed := false;
  begin
    perform public.create_full_sales_invoices_atomic('[{"id":"rolled-back","sales_order_id":"full3","customer_name":"Customer A","currency":"EUR","lines":[{"buy_price":10,"sell_price":11}]},{"id":"duplicate","sales_order_id":"full1","customer_name":"Customer A","currency":"EUR","lines":[{"buy_price":10,"sell_price":11}]}]', '{"full1":"2026-01-01T00:00:00Z","full2":"2026-01-01T00:00:00Z","full3":"2026-01-01T00:00:00Z","missing":"2026-01-01T00:00:00Z","zero":"2026-01-01T00:00:00Z"}');
  exception when others then v_failed := position('SALES_ORDER_ALREADY_INVOICED' in sqlerrm)>0; end;
  if not v_failed or exists(select 1 from public.invoices where id in ('rolled-back','duplicate')) then raise exception 'duplicate batch did not roll back'; end if;
  v_failed := false;
  begin
    perform public.create_full_sales_invoices_atomic('[{"id":"missing-inv","sales_order_id":"missing","customer_name":"Customer A","currency":"EUR","lines":[{"buy_price":10,"sell_price":0}]}]', '{"full1":"2026-01-01T00:00:00Z","full2":"2026-01-01T00:00:00Z","full3":"2026-01-01T00:00:00Z","missing":"2026-01-01T00:00:00Z","zero":"2026-01-01T00:00:00Z"}');
  exception when others then v_failed := position('INVOICE_SOURCE_PRICE_MISSING' in sqlerrm)>0; end;
  if not v_failed or exists(select 1 from public.invoices where id='missing-inv') then raise exception 'missing source price not rejected'; end if;
  perform public.create_full_sales_invoices_atomic('[{"id":"zero-inv","sales_order_id":"zero","customer_name":"Customer A","currency":"EUR","lines":[{"buy_price":0,"sell_price":0}]}]', '{"full1":"2026-01-01T00:00:00Z","full2":"2026-01-01T00:00:00Z","full3":"2026-01-01T00:00:00Z","missing":"2026-01-01T00:00:00Z","zero":"2026-01-01T00:00:00Z"}');
  v_failed := false;
  begin
    perform public.create_full_sales_invoices_atomic('[{"id":"stale-inv","sales_order_id":"full3","customer_name":"Customer A","currency":"EUR","lines":[{"buy_price":10,"sell_price":11}]}]', '{"full3":"2025-01-01T00:00:00Z"}');
  exception when others then v_failed := position('INVOICE_SOURCE_ORDER_STALE' in sqlerrm)>0; end;
  if not v_failed or exists(select 1 from public.invoices where id='stale-inv') then raise exception 'stale order version not rejected'; end if;
  perform public.save_invoice_atomic('{"id":"manual-partial","sales_order_id":"full1","customer_name":"Customer A","currency":"EUR"}');
  if not exists(select 1 from public.invoices where id='manual-partial') then raise exception 'manual partial invoice blocked'; end if;
end $$;
