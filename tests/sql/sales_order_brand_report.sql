-- Run against a disposable PostgreSQL database after the migration.
set role authenticated;
select set_config('test.role','admin',false);
do $$
declare s record; n integer; v text; prior_hash text;
begin
 select * into s from public.reporting_sales_orders_brand_summary('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', null,null,null,null,'BOSCH');
 if s.order_count <> 2 or s.line_count <> 3 or s.detail_count <> 3
   or s.missing_price_count <> 1 or s.quantity <> 6 or s.amount <> 24
 then raise exception 'summary mismatch: %', row_to_json(s); end if;

 select count(*) into n from public.reporting_sales_orders_brand_summary('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') where brand='SKF' and currency='USD' and amount=1002;
 if n <> 1 then raise exception 'currency groups or USD total wrong'; end if;
 select count(*) into n from public.reporting_sales_orders_brand_summary('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') where brand='BOSCH' and currency='USD';
 if n <> 0 then raise exception 'currency groups combined'; end if;
 select count(*) into n from public.reporting_sales_orders_brand_details('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',null,null,null,null,null,0,500);
 if n <> 500 then raise exception 'first page expected 500, got %', n; end if;
select count(*) into n from public.reporting_sales_orders_brand_details('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',null,null,null,null,null,500,500);
 if n <> 5 then raise exception 'second page mismatch %', n; end if;
 select count(*) into n from public.reporting_sales_orders_brand_details('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',null,null,'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',null,null,0,500);
 if n <> 3 then raise exception 'historic customer lookup mismatch %', n; end if;
 select count(*) into n from public.reporting_sales_orders_brand_details('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','2026-01-01','2026-01-31',null,'confirmed',null,0,500);
 if n <> 1 then raise exception 'date/status filter mismatch %', n; end if;
 select count(*) into n from public.reporting_sales_orders_brand_details('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',null,null,null,null,null,0,500,'Unmatched historic customer');
 if n <> 1 then raise exception 'historic name filter mismatch %', n; end if;
 select count(*) into n from public.reporting_sales_orders_brand_customers('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') where customer_id is null and customer_name='Unmatched historic customer';
 if n <> 1 then raise exception 'historic name option missing %', n; end if;
 select count(*) into n from public.reporting_sales_orders_brand_details('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',null,null,'dddddddd-dddd-dddd-dddd-dddddddddddd',null,null,0,500);
 if n <> 0 then raise exception 'ambiguous historical name attached to customer'; end if;
 select content_hash into prior_hash from public.reporting_sales_orders_brand_summary('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',null,null,null,null,'BOSCH');
 update public.sales_orders set lines=jsonb_set(lines,'{0,description}','"Changed"'::jsonb) where id='a';
 select content_hash into v from public.reporting_sales_orders_brand_summary('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',null,null,null,null,'BOSCH');
 if prior_hash=v then raise exception 'digest did not detect text change'; end if;
 select requested_code into v from public.reporting_sales_orders_brand_details('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',null,null,null,null,'BOSCH',0,500) where product_code='NEW';
 if v <> 'OLD' then raise exception 'replacement missing'; end if;
 select count(*) into n from public.reporting_sales_orders_brand_details('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',null,null,null,null,null,0,500) where line_index=0 and brand='(Marka belirtilmemiş)';
 if n <> 1 then raise exception 'empty order omitted'; end if;
 begin
  perform * from public.reporting_sales_orders_brand_summary('cccccccc-cccc-cccc-cccc-cccccccccccc');
  raise exception 'cross organization access permitted';
 exception when raise_exception then
  if sqlerrm <> 'SALES_ORDER_REPORT_ACCESS_DENIED' then raise; end if;
 end;
end $$;
select set_config('test.role','sales',false);
select set_config('test.permission','false',false);
do $$ begin
 begin
  perform * from public.reporting_sales_orders_brand_summary('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
  raise exception 'unauthorized access permitted';
 exception when raise_exception then
  if sqlerrm <> 'SALES_ORDER_REPORT_ACCESS_DENIED' then raise; end if;
 end;
end $$;


select set_config('test.permission','true',false);
select set_config('test.scope','assigned',false);
do $$
declare n integer;
begin
 select count(*) into n from public.reporting_sales_orders_brand_details('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',null,null,null,null,null,0,500);
 if n <> 1 then raise exception 'restricted customer scope leaked or hid records: %',n; end if;
 select count(*) into n from public.reporting_sales_orders_brand_customers('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') where customer_id is null;
 if n <> 0 then raise exception 'unmapped historical names leaked'; end if;
end $$;
