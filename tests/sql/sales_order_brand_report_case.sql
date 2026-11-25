-- Canonical case comes from the organization catalogue; order snapshots remain unchanged.
reset role;
insert into public.brands values ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','Bosch');
insert into public.brands values ('cccccccc-cccc-cccc-cccc-cccccccccccc','BOSCH');
set role authenticated;
select set_config('test.role','admin',false);
do $$
declare n integer; s record;
begin
 select * into s from public.reporting_sales_orders_brand_summary('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',null,null,null,null,' BOSCH ');
 if s.brand <> 'Bosch' or s.line_count <> 3 or s.amount <> 24 then
   raise exception 'case and whitespace grouping mismatch: %', row_to_json(s);
 end if;
 select count(*) into n from public.reporting_sales_orders_brand_summary('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') where lower(brand)='bosch';
 if n <> 1 then raise exception 'same brand emitted more than one group: %',n; end if;
 select count(*) into n from public.reporting_sales_orders_brand_details('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',null,null,null,null,'bosch',0,500) where brand = 'Bosch';
 if n <> 3 then raise exception 'detail and summary brand labels differ: %',n; end if;
 select count(*) into n from public.reporting_sales_orders_brand_details('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',null,null,null,null,'Bosch',0,500);
 if n <> 3 then raise exception 'canonical filter mismatch: %',n; end if;
 select count(*) into n from public.sales_orders so, lateral jsonb_array_elements(so.lines) l where l->>'brand' = ' Bosch ';
 if n <> 1 then raise exception 'historical snapshot was changed'; end if;
end $$;
