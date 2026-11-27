import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';

const read = path => readFile(new URL('../../'+path,import.meta.url),'utf8');
const baseline=await read('supabase/migrations/20260707_96_sales_purchase_order_guarded_boundary.sql');
const vendorMigration=await read('supabase/migrations/20261109104136_purchase_order_vendor_resolution.sql');
const confirmation=await read('supabase/migrations/20261126135625_safe_sales_confirmation.sql');
const concurrency=await read('supabase/migrations/20261126135620_optimistic_order_versions.sql');
const deletion=await read('supabase/migrations/20261126135630_atomic_order_deletion.sql');
const salesDelete=await read('supabase/migrations/20260827090000_portal_sales_order_delete_notifications.sql');
const org='10000000-0000-4000-8000-000000000001', admin='20000000-0000-4000-8000-000000000001';
const gnk='30000000-0000-4000-8000-000000000001', second='30000000-0000-4000-8000-000000000002';
const decision='40000000-0000-4000-8000-000000000001';
const line=(supplier,code='001/20')=>({supplier_name:supplier,resolvedCode:code,requestedCode:code,brand:'Bosch',description:'Part',qty:2,buy_price:10.125,sell_price:15});
const payload=(id='new',lines=[line('GNK-Diesel'),line('GNK-Mechanik','0002'),line('Other','0003')])=>({id,status:'confirmed',customer_name:'Customer',sales_order_no:id,currency:'EUR',lines});
async function realPostgres(t) {
 const {default:pg}=await import('pg');
 const admin = new pg.Client({connectionString:process.env.TEST_POSTGRES_URL});await admin.connect();
 const name='confirmation_test_'+Math.random().toString(36).slice(2);
 await admin.query(`create database ${name}`);
 const url=new URL(process.env.TEST_POSTGRES_URL);url.pathname='/'+name;
 const client=new pg.Client({connectionString:url.toString()});await client.connect();
 t.after(async()=>{await client.end();await admin.query(`drop database ${name}`);await admin.end();});
 return {query:(sql,params)=>client.query(sql,params),exec:sql=>client.query(sql),open:async()=>{const other=new pg.Client({connectionString:url.toString()});await other.connect();return other;}};
}
async function fixture(t) {
 const db = process.env.TEST_POSTGRES_URL ? await realPostgres(t) : new PGlite();
 if (!process.env.TEST_POSTGRES_URL) t.after(()=>db.close());
 await db.exec(`do $$begin if not exists(select 1 from pg_roles where rolname='anon') then create role anon;end if;if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated;end if;if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role;end if;end$$;create schema auth;
 create function auth.uid()returns uuid language sql as $$select nullif(current_setting('test.uid',true),'')::uuid$$;
 create table organizations(id uuid primary key);create table profiles(id uuid primary key,organization_id uuid,role text,is_active boolean);
 create function public.current_profile_org_id()returns uuid language sql security definer as $$select organization_id from public.profiles where id=auth.uid() and is_active$$;
 create function public.current_profile_role()returns text language sql security definer as $$select role from public.profiles where id=auth.uid() and is_active$$;
 create function public.is_superadmin()returns boolean language sql security definer as $$select false$$;
 create table vendors(id uuid primary key,organization_id uuid not null references organizations(id),display_name text,company_name text,vendor_number text);
 create table customers(organization_id uuid,display_name text,company_name text);create table company_profiles(organization_id uuid,company_name text);
 create table sales_orders(id text primary key,organization_id uuid,sales_order_no text,customer_name text,seller_company text,purchase_company text,quote_date text,currency text,customer_type text,shipping_cost numeric,discount_amount numeric,supplier_mode text,preferred_supplier text,seller_info text,buyer_info text,delivery_term text,payment_terms text,packing_details text,notes text,status text,purchase_total numeric,sales_total numeric,profit_total numeric,margin_percent numeric,source_channel text,portal_invite_id uuid,portal_submitted_at timestamptz,portal_seen_at timestamptz,confirmed_at timestamptz,lines jsonb,created_at timestamptz default now(),updated_at timestamptz default now());
 create table purchase_orders(id text primary key,organization_id uuid,vendor_id uuid references vendors(id),supplier_name text,supplier_key text,purchase_company text,sales_order_id text,sales_order_no text,customer_name text,status text,currency text,total_amount numeric,line_count integer,lines jsonb,created_at timestamptz default now(),updated_at timestamptz default now());
 create table invoices(id text,organization_id uuid,sales_order_id text,sales_order_ids text[]);
 create table portal_audit_logs(organization_id uuid,invite_id uuid,party_type text,event_type text,status text,details jsonb);
 create table bills(id text,organization_id uuid,purchase_order_id text,lines jsonb);create table purchase_receives(id text,organization_id uuid,purchase_order_id text);create table inventory_movements(id text,organization_id uuid,document_id text,document_no text);
 insert into organizations values('${org}');insert into profiles values('${admin}','${org}','admin',true);
 insert into vendors values('${gnk}','${org}','GNK','GNK','1'),('${second}','${org}','Other','Other','2');
 insert into customers values('${org}','Customer','Customer');select set_config('test.uid','${admin}',false);`);
 for(const fn of ['save_sales_order_atomic','save_purchase_order_atomic']) await db.exec(baseline.match(new RegExp(`create or replace function public\\.${fn}\\([\\s\\S]*?\\n\\$\\$;`,'i'))[0]);
 await db.exec('grant execute on function public.save_purchase_order_atomic(jsonb,text) to authenticated,service_role;');
 await db.exec(vendorMigration);await db.exec(concurrency);await db.exec(confirmation);
 await db.exec(salesDelete.match(/create or replace function public\.delete_sales_order_guarded\([\s\S]*?\n\$\$;/i)[0]);
 await db.exec(baseline.match(/create or replace function public\.delete_purchase_order_guarded\([\s\S]*?\n\$\$;/i)[0]);
 await db.exec('grant all on public.sales_orders,public.purchase_orders to authenticated;');await db.exec(deletion);
 for(const name of ['GNK-Diesel','GNK-Mechanik']) await db.query('insert into purchase_vendor_resolution_private.vendor_aliases(organization_id,alias_supplier_name,vendor_id,reason)values($1,$2,$3,$4)',[org,name,gnk,'test']);
 const confirm=async (p=payload(),d=decision)=>(await db.query('select public.confirm_sales_order_with_purchases_safe($1::jsonb,$2::uuid) as result',[JSON.stringify(p),d])).rows[0].result;
 return {db,confirm};
}
test('atomic confirmation groups aliases, preserves leading zeros, prices and replay',async t=>{
 const {db,confirm}=await fixture(t);const value=payload();const result=await confirm(value);
 assert.equal(result.sales_order.status,'confirmed');assert.equal(result.purchase_orders.length,2);
 const first=result.purchase_orders.find(x=>x.vendor_id===gnk);assert.equal(first.lines.length,2);assert.equal(first.lines[0].product_code,'001/20');assert.equal(first.lines[1].product_code,'0002');assert.equal(first.lines[0].buy_price,10.125);assert.equal(first.lines[0].source_supplier_name,'GNK-Diesel');
 assert.equal((await confirm(value)).replayed,true);await assert.rejects(confirm({...value,customer_name:'changed'}),/SALES_CONFIRMATION_DECISION_MISMATCH/);
 assert.equal((await db.query('select count(*)::int n from purchase_orders')).rows[0].n,2);
});
test('explicit alternative supplier controls the purchase order without changing the sale price',async t=>{
 const {db,confirm}=await fixture(t);
 const selected={...line('Other','000012'),buy_price:20,sell_price:15,supplier_override_keep_sell_price:true,customer_price_basis_buy_price:10.125};
 const result=await confirm(payload('chosen-supplier',[selected]));
 assert.equal(result.sales_order.lines[0].sell_price,15);
 assert.equal(result.sales_order.lines[0].buy_price,20);
 assert.equal(result.purchase_orders.length,1);
 assert.equal(result.purchase_orders[0].vendor_id,second);
 assert.equal(result.purchase_orders[0].lines[0].product_code,'000012');
 assert.equal(result.purchase_orders[0].lines[0].buy_price,20);
 assert.equal((await db.query('select count(*)::int n from purchase_orders')).rows[0].n,1);
});
test('failed purchase save rolls back sales, other purchases and receipt',async t=>{
 const {db,confirm}=await fixture(t);await db.exec(`create function public.fail_other() returns trigger language plpgsql as $$begin if new.supplier_name='Other' then raise exception 'simulated purchase failure'; end if; return new; end$$;create trigger fail_other before insert on purchase_orders for each row execute function public.fail_other();`);
 await assert.rejects(confirm(),/simulated purchase failure/);
 for(const name of ['sales_orders','purchase_orders','sales_confirmation_private.receipts','sales_confirmation_private.capabilities']) assert.equal((await db.query(`select count(*)::int n from ${name}`)).rows[0].n,0);
});
test('history remains untouched and direct confirmation is blocked',async t=>{
 const {db,confirm}=await fixture(t);await db.query(`insert into sales_orders(id,organization_id,status,lines)values('existing',$1,'draft','[]')`,[org]);
 await db.query(`insert into purchase_orders(id,organization_id,sales_order_id,status,lines)values('old',$1,'existing','open','[]')`,[org]);
 const before=(await db.query("select to_jsonb(s) s,(select to_jsonb(p) from purchase_orders p where p.id='old') p from sales_orders s where id='existing'")).rows[0];
 await assert.rejects(confirm(payload('existing')),/SALES_CONFIRMATION_HAS_DOCUMENTS/);
 await assert.rejects(db.query('select public.save_sales_order_atomic($1::jsonb,null)',[JSON.stringify({...payload('existing'),expected_updated_at:before.s.updated_at})]),/SALES_CONFIRMATION_ATOMIC_REQUIRED/);
 assert.deepEqual((await db.query("select to_jsonb(s) s,(select to_jsonb(p) from purchase_orders p where p.id='old') p from sales_orders s where id='existing'")).rows[0],before);
});
test('missing supplier and missing or invalid prices fail before writing',async t=>{
 const {db,confirm}=await fixture(t);
 for(const bad of [line('Missing'),{...line('GNK'),buy_price:null},{...line('GNK'),sell_price:null,manual_sell_price:true},{...line('GNK'),qty:0}]) await assert.rejects(confirm(payload('bad',[bad])),/PURCHASE_VENDOR_NOT_FOUND|SALES_CONFIRMATION_PRICE_INVALID/);
 assert.equal((await db.query('select count(*)::int n from sales_orders')).rows[0].n,0);
});

test('concurrent sessions retry safely without creating duplicate purchase orders', {skip:!process.env.TEST_POSTGRES_URL}, async t=>{
 const {db,confirm}=await fixture(t);const other=await db.open();
 await other.query("select set_config('test.uid',$1,false)",[admin]);
 await db.exec(`create function public.slow_po() returns trigger language plpgsql as $$begin perform pg_sleep(0.1);return new;end$$; create trigger slow_po before insert on purchase_orders for each row execute function public.slow_po();`);
 const request=payload();const [a,b]=await Promise.all([confirm(request),other.query('select public.confirm_sales_order_with_purchases_safe($1::jsonb,$2::uuid) result',[JSON.stringify(request),decision]).then(r=>r.rows[0].result)]);
 assert.deepEqual([a.replayed,b.replayed].sort(),[false,true]);
 assert.equal((await db.query('select count(*)::int n from purchase_orders')).rows[0].n,2);
 await assert.rejects(other.query('select public.confirm_sales_order_with_purchases_safe($1::jsonb,$2::uuid)',[JSON.stringify(request),'40000000-0000-4000-8000-000000000002']),/SALES_CONFIRMATION_ALREADY_CONFIRMED/);
 await other.end();
});

test('stale version cannot confirm a changed draft; correct version confirms and replay succeeds',async t=>{
 const {db,confirm}=await fixture(t);
 await db.query(`insert into sales_orders(id,organization_id,status,lines,updated_at)values('draft',$1,'draft','[]','2026-11-26T10:00:00Z')`,[org]);
 const stale={...payload('draft'),expected_updated_at:'2026-11-26T09:00:00Z'};
 await assert.rejects(confirm(stale),/SALES_ORDER_STALE_VERSION/);
 assert.equal((await db.query("select status from sales_orders where id='draft'")).rows[0].status,'draft');
 assert.equal((await db.query('select count(*)::int n from purchase_orders')).rows[0].n,0);
 const current={...stale,expected_updated_at:'2026-11-26T10:00:00Z'};
 assert.equal((await confirm(current)).sales_order.status,'confirmed');assert.equal((await confirm(current)).replayed,true);
});

test('a stale service-role portal write cannot revert an internally confirmed order',async t=>{
 const {db,confirm}=await fixture(t);const data={...payload('portal'),source_channel:'portal'};
 await confirm(data);const before=(await db.query("select to_jsonb(s) row from sales_orders s where id='portal'")).rows[0].row;
 await db.exec("select set_config('test.uid','',false)");
 await assert.rejects(db.query("update sales_orders set status='draft',lines='[]' where id='portal'"),/SALES_CONFIRMATION_PORTAL_STALE/);
 assert.deepEqual((await db.query("select to_jsonb(s) row from sales_orders s where id='portal'")).rows[0].row,before);
});

test('callers cannot forge private capabilities or confirmation receipts',async t=>{
 const {db}=await fixture(t);
 for(const role of ['anon','authenticated','service_role']) {
  assert.equal((await db.query("select has_schema_privilege($1,'sales_confirmation_private','USAGE') allowed",[role])).rows[0].allowed,false);
  assert.equal((await db.query("select has_table_privilege($1,'sales_confirmation_private.capabilities','INSERT') allowed",[role])).rows[0].allowed,false);
  assert.equal((await db.query("select has_table_privilege($1,'sales_confirmation_private.receipts','UPDATE') allowed",[role])).rows[0].allowed,false);
 }
 await db.exec("select set_config('sales_confirmation_private.capability','true',false)");
 await assert.rejects(db.query('select public.save_sales_order_atomic($1::jsonb,null)',[JSON.stringify(payload('forged'))]),/SALES_CONFIRMATION_ATOMIC_REQUIRED/);
});

test('batch deletion is all-or-nothing, checks versions and retains the original delete guard and audit',async t=>{
 const {db}=await fixture(t);const ts='2026-11-26T10:00:00Z';
 await db.exec('begin');
 await db.query("insert into sales_confirmation_private.capabilities values($1,$2,'a',txid_current())",[org,admin]);
 await db.query(`insert into sales_orders(id,organization_id,status,source_channel,portal_invite_id,lines,updated_at) values
 ('a',$1,'confirmed','portal','50000000-0000-4000-8000-000000000001','[]',$2),('b',$1,'draft','internal',null,'[]',$2)`,[org,ts]);
 await db.exec('commit');
 const batch=async items=>db.query('select public.delete_sales_orders_guarded_batch($1::jsonb)',[JSON.stringify(items)]);
 await assert.rejects(batch([{id:'a',expected_updated_at:ts},{id:'b',expected_updated_at:'2020-01-01Z'}]),/ORDER_DELETE_STALE_VERSION/);
 assert.equal((await db.query('select count(*)::int n from sales_orders')).rows[0].n,2);assert.equal((await db.query('select count(*)::int n from portal_audit_logs')).rows[0].n,0);
 await db.query("insert into invoices(id,organization_id,sales_order_id)values('bill',$1,'b')",[org]);
 await assert.rejects(batch([{id:'a',expected_updated_at:ts},{id:'b',expected_updated_at:ts}]),/downstream documents/);
 assert.equal((await db.query('select count(*)::int n from sales_orders')).rows[0].n,2);assert.equal((await db.query('select count(*)::int n from portal_audit_logs')).rows[0].n,0);
 await db.query("delete from invoices where id='bill'");await batch([{id:'a',expected_updated_at:ts},{id:'b',expected_updated_at:ts}]);
 assert.equal((await db.query('select count(*)::int n from sales_orders')).rows[0].n,0);assert.equal((await db.query('select count(*)::int n from portal_audit_logs')).rows[0].n,1);
});
test('browser roles cannot bypass guarded order boundaries with direct DML, TRUNCATE or trigger creation',async t=>{
 const {db}=await fixture(t);for(const table of ['sales_orders','purchase_orders'])for(const privilege of ['UPDATE','DELETE','TRUNCATE','TRIGGER','REFERENCES'])
  assert.equal((await db.query('select has_table_privilege($1,$2,$3) allowed',['authenticated','public.'+table,privilege])).rows[0].allowed,false,table+' '+privilege);
 assert.equal((await db.query("select has_column_privilege('authenticated','public.sales_orders','portal_seen_at','UPDATE') allowed")).rows[0].allowed,true);
 await assert.rejects(db.query("select public.delete_sales_order_guarded('old')"),/ORDER_DELETE_VERSION_REQUIRED/);
});

test('browser bootstrap INSERT cannot upsert existing order, while portal seen flag remains writable',async t=>{
 const {db}=await fixture(t);await db.exec("grant usage on schema auth to authenticated; grant execute on function auth.uid() to authenticated;grant select on sales_orders,purchase_orders to authenticated;");
 await db.query("insert into sales_orders(id,organization_id,status,lines)values('keep',$1,'draft','[]')",[org]);
 await db.exec('set role authenticated');
 await assert.rejects(db.query("insert into sales_orders(id,organization_id,status,lines) values('keep',$1,'draft','[]') on conflict(id) do update set lines='[1]'",[org]),/permission denied/);
 await db.query("update sales_orders set portal_seen_at='2026-11-26T10:00:00Z' where id='keep'");
 await db.exec('reset role');const row=(await db.query("select portal_seen_at,lines from sales_orders where id='keep'")).rows[0];assert.ok(row.portal_seen_at);assert.deepEqual(row.lines,[]);
});

test('purchase-order batch refuses stale and posted members without deleting other selections',async t=>{
 const {db}=await fixture(t);const ts='2026-11-26T10:00:00Z';
 await db.query("insert into purchase_orders(id,organization_id,status,lines,updated_at)values('p1',$1,'draft','[]',$2),('p2',$1,'open','[]',$2)",[org,ts]);
 const batch=items=>db.query('select public.delete_purchase_orders_guarded_batch($1::jsonb)',[JSON.stringify(items)]);
 await assert.rejects(batch([{id:'p1',expected_updated_at:ts},{id:'p2',expected_updated_at:'2020-01-01'}]),/ORDER_DELETE_STALE_VERSION/);
 await assert.rejects(batch([{id:'p1',expected_updated_at:ts},{id:'p2',expected_updated_at:ts}]),/Posted purchase orders cannot be deleted/);
 assert.equal((await db.query('select count(*)::int n from purchase_orders')).rows[0].n,2);
});
