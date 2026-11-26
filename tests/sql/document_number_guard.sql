select set_config('test.org','00000000-0000-0000-0000-000000000001',false);
select set_config('test.role','admin',false);
do $$
declare r jsonb;
begin
 -- Existing duplicated sales numbers remain editable through both update and upsert.
 update public.sales_orders set status='confirmed',notes='retained' where id='old-a';
 insert into public.sales_orders(id,organization_id,sales_order_no,status) values
  ('old-b','00000000-0000-0000-0000-000000000001',' so-old ','confirmed')
 on conflict(id) do update set status=excluded.status,sales_order_no=excluded.sales_order_no;
 if (select status from public.sales_orders where id='old-b') <> 'confirmed' then raise exception 'existing duplicate cannot be edited'; end if;
 begin
  insert into public.sales_orders(id,organization_id,sales_order_no) values('new-a','00000000-0000-0000-0000-000000000001',' S O - O L D ');
  raise exception 'duplicate sales number was accepted';
 exception when unique_violation then if sqlerrm <> 'SALES_ORDER_NUMBER_ALREADY_USED' then raise; end if; end;
 insert into public.sales_orders(id,organization_id,sales_order_no) values('other-org','00000000-0000-0000-0000-000000000002','SO-OLD');
 insert into public.sales_orders(id,organization_id,sales_order_no) values('new-b','00000000-0000-0000-0000-000000000001','SO-NEW');
 begin
  update public.sales_orders set sales_order_no='so-old' where id='new-b';
  raise exception 'duplicate rename was accepted';
 exception when unique_violation then if sqlerrm <> 'SALES_ORDER_NUMBER_ALREADY_USED' then raise; end if; end;
 -- Invoice number lives in id. Old case-variant duplicates retain explicit edits.
 r := public.save_invoice_atomic('{"id":"INV-OLD","notes":"safe edit"}'::jsonb,'INV-OLD');
 if r->>'notes' <> 'safe edit' then raise exception 'existing invoice edit failed'; end if;
 begin
  perform public.save_invoice_atomic('{"id":"INV-OLD","notes":"must not overwrite"}'::jsonb,null);
  raise exception 'new invoice overwrote existing';
 exception when unique_violation then if sqlerrm <> 'INVOICE_NUMBER_ALREADY_USED' then raise; end if; end;
 if (select notes from public.invoices where id='INV-OLD') <> 'safe edit' then raise exception 'invoice changed after blocked creation'; end if;
 begin
  perform public.save_invoice_atomic('{"id":" Inv - Old "}'::jsonb,null);
  raise exception 'normalized duplicate invoice accepted';
 exception when unique_violation then if sqlerrm <> 'INVOICE_NUMBER_ALREADY_USED' then raise; end if; end;
 perform public.save_invoice_atomic('{"id":"INV-NEW"}'::jsonb,null);
 begin
  perform public.save_invoice_atomic('{"id":"inv-old"}'::jsonb,'INV-NEW');
  raise exception 'rename collision accepted';
 exception when unique_violation then if sqlerrm <> 'INVOICE_NUMBER_ALREADY_USED' then raise; end if; end;
 if not exists(select 1 from public.invoices where id='INV-NEW') then raise exception 'failed rename deleted original'; end if;
 begin
  perform public.save_invoice_atomic('{"id":"FOREIGN-INV","notes":"foreign overwrite"}'::jsonb,null);
  raise exception 'foreign invoice overwrite accepted';
 exception when unique_violation then if sqlerrm <> 'INVOICE_NUMBER_ALREADY_USED' then raise; end if; end;
 begin
  perform public.save_invoice_atomic('{"id":"FOREIGN-INV","notes":"foreign edit"}'::jsonb,'FOREIGN-INV');
  raise exception 'foreign previous id accepted';
 exception when others then if sqlerrm <> 'Previous invoice was not found' then raise; end if; end;
 if (select notes from public.invoices where id='FOREIGN-INV') <> '' then raise exception 'foreign invoice changed'; end if;
 begin
  insert into public.invoices(id,organization_id) values('INV-OLD','00000000-0000-0000-0000-000000000001') on conflict(id) do update set notes='unexpected overwrite';
  raise exception 'direct insert overwrote existing invoice';
 exception when unique_violation then if sqlerrm <> 'INVOICE_NUMBER_ALREADY_USED' then raise; end if; end;
 -- Sales/invoice namespaces are separate.
 perform public.save_invoice_atomic('{"id":"SO-NEW"}'::jsonb,null);
 -- Scope and permissions stay fenced.
 if has_function_privilege('authenticated','document_number_guard_private.save_invoice_atomic(jsonb,text)','EXECUTE') then raise exception 'private bypass executable'; end if;
 if has_schema_privilege('authenticated','document_number_guard_private','USAGE') then raise exception 'private schema exposed'; end if;
end;
$$;
set role authenticated;
select public.save_invoice_atomic('{"id":"INV-AUTHENTICATED","notes":"allowed"}'::jsonb,null);
do $$
begin
 begin
  perform public.save_invoice_atomic('{"id":"inv-authenticated"}'::jsonb,null);
  raise exception 'authenticated duplicate accepted';
 exception when unique_violation then if sqlerrm <> 'INVOICE_NUMBER_ALREADY_USED' then raise; end if; end;
end;
$$;
reset role;
