create role anon;
create role authenticated;
create schema auth;
create function auth.uid() returns uuid language sql stable as $$ select 'ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid $$;
create function public.current_profile_org_id() returns uuid language sql stable as $$ select 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid $$;
create function public.current_profile_role() returns text language sql stable as $$ select current_setting('test.role',true) $$;
create function public.profile_has_permission(text) returns boolean language sql stable as $$ select current_setting('test.permission',true)='true' $$;
create function public.current_profile_customer_scope_mode() returns text language sql stable as $$ select coalesce(nullif(current_setting('test.scope',true),''),'all') $$;
create function public.can_access_customer(uuid) returns boolean language sql stable as $$ select $1 = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'::uuid $$;
create table public.customers(id uuid, organization_id uuid,display_name text);
create table public.sales_orders(id text, organization_id uuid,sales_order_no text,quote_date text,customer_id uuid,customer_name text,status text,lines jsonb,currency text);
grant usage on schema auth,public to authenticated;
grant select, update on public.sales_orders to authenticated;
grant select on public.customers to authenticated;
insert into public.customers values ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','Test Customer');
insert into public.customers values ('dddddddd-dddd-dddd-dddd-dddddddddddd','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','Other'), ('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','Other');
insert into public.sales_orders values
 ('a','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','SO-A','2026-01-10',null,'Test Customer','draft','[{"brand":"BOSCH","requestedCode":"OLD","resolvedCode":"NEW","description":"Part","qty":2,"sell_price":12},{"brand":"BOSCH","qty":1}]','EUR'),
 ('b','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','SO-B','2026-01-15','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','Test Customer','confirmed','[{"brand":"BOSCH","qty":3,"sell_price":0}]','EUR'),
 ('c','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','SO-C','2026-02-01',null,'Unmatched historic customer','draft','[]','EUR'),
 ('d','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','SO-D','2026-02-01',null,'Other','draft',(select jsonb_agg(jsonb_build_object('brand','SKF','qty',1,'sell_price',2)) from generate_series(1,501)),'USD');
