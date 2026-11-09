import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';

const migration=await readFile(new URL('../../supabase/migrations/20261109104136_purchase_order_vendor_resolution.sql',import.meta.url),'utf8');
const source=await readFile(new URL('../../supabase/migrations/20260707_96_sales_purchase_order_guarded_boundary.sql',import.meta.url),'utf8');
const baseline=source.match(/create or replace function public\.save_purchase_order_atomic\([\s\S]*?\n\$\$;/i)[0];
const org='10000000-0000-4000-8000-000000000001',otherOrg='10000000-0000-4000-8000-000000000002';
const admin='20000000-0000-4000-8000-000000000001',sales='20000000-0000-4000-8000-000000000002',superadmin='20000000-0000-4000-8000-000000000003',viewer='20000000-0000-4000-8000-000000000004',inactive='20000000-0000-4000-8000-000000000005',otherAdmin='20000000-0000-4000-8000-000000000006';
const gnk='30000000-0000-4000-8000-000000000001',diesel='30000000-0000-4000-8000-000000000002',mechanik='30000000-0000-4000-8000-000000000003',pump='30000000-0000-4000-8000-000000000004',otherVendor='30000000-0000-4000-8000-000000000005';
const lines=[{product_code:'001/20',qty:2,buy_price:10.1234,line_total:20.25,supplier_name:'GNK'}];
const payload=(changes={})=>({id:'new-po',sales_order_id:'so',supplier_name:'GNK',supplier_key:'gnk',status:'draft',currency:'EUR',lines,...changes});

async function fixture(t,{apply=true}={}){
 const db=new PGlite();t.after(()=>db.close());
 await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;
 create function auth.uid()returns uuid language sql as $$select nullif(current_setting('test.uid',true),'')::uuid$$;
 create table organizations(id uuid primary key);create table profiles(id uuid primary key,organization_id uuid,role text,is_active boolean);
 create function public.current_profile_org_id()returns uuid language sql security definer as $$select organization_id from public.profiles where id=auth.uid() and is_active$$;
 create function public.current_profile_role()returns text language sql security definer as $$select case when role='superadmin' then 'admin' else role end from public.profiles where id=auth.uid() and is_active$$;
 create function public.is_superadmin()returns boolean language sql security definer as $$select exists(select 1 from public.profiles where id=auth.uid() and is_active and role='superadmin')$$;
 create table vendors(id uuid primary key,organization_id uuid not null references organizations(id),display_name text,company_name text,vendor_number text);
 create table suppliers(id uuid primary key,organization_id uuid,name text,price_usage_enabled boolean);
 create table supplier_prices(id uuid primary key,supplier_id uuid,buy_price numeric,is_active boolean);
 create table sales_orders(id text primary key,organization_id uuid,currency text,sales_order_no text,customer_name text,lines jsonb,status text,updated_at timestamptz);
 create table purchase_orders(id text primary key,organization_id uuid,vendor_id uuid references vendors(id),supplier_name text,supplier_key text,purchase_company text,sales_order_id text,sales_order_no text,customer_name text,status text,currency text,total_amount numeric,line_count integer,lines jsonb,created_at timestamptz default now(),updated_at timestamptz default now());
 create table company_profiles(organization_id uuid,company_name text);
 create table bills(id text,organization_id uuid,purchase_order_id text,lines jsonb);
 create table purchase_receives(id text,organization_id uuid,purchase_order_id text);
 create table inventory_movements(id text,organization_id uuid,document_id text,document_no text);
 insert into organizations values('${org}'),('${otherOrg}');
 insert into profiles values('${admin}','${org}','admin',true),('${sales}','${org}','sales',true),('${superadmin}','${org}','superadmin',true),('${viewer}','${org}','viewer',true),('${inactive}','${org}','admin',false),('${otherAdmin}','${otherOrg}','admin',true);
 insert into vendors values('${gnk}','${org}','GNK','GNK','VEN-00009'),('${diesel}','${org}','GNK-Diesel','GNK-Diesel','VEN-00001'),('${mechanik}','${org}','GNK-Mechanik','GNK-Mechanik','VEN-00002'),('${pump}','${org}','GNK-Pump','GNK-Pump','VEN-00003'),('${otherVendor}','${otherOrg}','GNK','GNK','VEN-OTHER');
 insert into suppliers values('${gnk}','${org}','GNK',true),('${diesel}','${org}','GNK-Diesel',false),('${mechanik}','${org}','GNK-Mechanik',false),('${pump}','${org}','GNK-Pump',false);
 insert into supplier_prices values('40000000-0000-4000-8000-000000000001','${diesel}',99.99,true);
 select set_config('test.uid','${admin}',false);`);
 await db.query(`insert into sales_orders values('so',$1,'EUR','FU26-F71497666','Customer',$2,'confirmed','2026-11-09T10:34:48Z')`,[org,JSON.stringify(lines)]);
 await db.query(`insert into purchase_orders(id,organization_id,vendor_id,supplier_name,supplier_key,sales_order_id,sales_order_no,customer_name,status,currency,total_amount,line_count,lines,created_at,updated_at)
 values('history',$1,$2,'GNK-Diesel','gnk-diesel','so','FU26-OLD','Customer','open','EUR',20.25,1,$3,'2026-10-01','2026-10-01'),('unbound-history',$1,null,'GNK-Diesel','gnk-diesel','so','FU26-OLD','Customer','open','EUR',20.25,1,$3,'2026-10-01','2026-10-01')`,[org,diesel,JSON.stringify(lines)]);
 await db.exec(baseline);await db.exec('grant execute on function public.save_purchase_order_atomic(jsonb,text) to authenticated,service_role;');
 if(apply)await db.exec(migration);
 const login=async id=>db.query("select set_config('test.uid',$1,false)",[id||'']);
 const resolve=async names=>(await db.query('select public.resolve_purchase_order_vendors($1::text[]) result',[names])).rows[0].result;
 const save=async value=>(await db.query('select public.save_purchase_order_atomic($1::jsonb,null) result',[JSON.stringify(value)])).rows[0].result.purchase_order;
 const aliases=async()=>{for(const name of ['GNK-Diesel','GNK-Mechanik','GNK-Pump'])await db.query('insert into purchase_vendor_resolution_private.vendor_aliases(organization_id,alias_supplier_name,vendor_id,reason)values($1,$2,$3,$4)',[org,name,gnk,'Owner-approved consolidation for new purchase orders']);};
 return {db,login,resolve,save,aliases};
}

test('migration patches exact deployed legacy function only and does not rewrite documents or price flags',async t=>{
 const {db}=await fixture(t,{apply:false});
 assert.equal((await db.query("select md5(pg_get_functiondef('public.save_purchase_order_atomic(jsonb,text)'::regprocedure)) hash")).rows[0].hash,'438afcf7da36ba5f8b7103d14e7b3615');
 const snapshot=async()=>(await db.query("select (select jsonb_agg(to_jsonb(s) order by id) from sales_orders s) sales,(select jsonb_agg(to_jsonb(p) order by id) from purchase_orders p) purchases,(select jsonb_agg(to_jsonb(s) order by id) from suppliers s) suppliers,(select jsonb_agg(to_jsonb(p) order by id) from supplier_prices p) prices")).rows[0];
 const before=await snapshot();await db.exec(migration);assert.deepEqual(await snapshot(),before);
 const permissions=(await db.query("select has_function_privilege('authenticated','public.save_purchase_order_atomic(jsonb,text)','execute') staff,has_function_privilege('authenticated','public.resolve_purchase_order_vendors(text[])','execute') resolver")).rows[0];assert.deepEqual(permissions,{staff:true,resolver:true});
});

test('explicit aliases project the three retained legacy cards to one canonical vendor without touching SO lines',async t=>{
 const {db,resolve,aliases}=await fixture(t);await aliases();
 const before=(await db.query('select to_jsonb(s) row from sales_orders s')).rows[0].row;
 const result=await resolve(['GNK-Diesel','GNK-Mechanik','GNK-Pump','GNK']);
 assert.deepEqual(result,['GNK-Diesel','GNK-Mechanik','GNK-Pump','GNK'].map(name=>({requested_supplier_name:name,supplier_name:'GNK',vendor_id:gnk})));
 assert.deepEqual((await db.query('select to_jsonb(s) row from sales_orders s')).rows[0].row,before);
 assert.equal((await db.query('select count(*)::integer n from vendors where organization_id=$1',[org])).rows[0].n,4);
 assert.equal((await db.query('select count(*)::integer n from suppliers where not price_usage_enabled')).rows[0].n,3);
 await db.exec("update purchase_vendor_resolution_private.vendor_aliases set is_active=false where alias_supplier_name='GNK-Diesel'");assert.equal((await resolve(['GNK-Diesel']))[0].vendor_id,diesel);
});

test('resolver admits only active own-org admin/sales/superadmin, never anonymous, other roles or cross-org aliases',async t=>{
 const {db,login,resolve,aliases}=await fixture(t);await aliases();
 for(const user of [admin,sales,superadmin]){await login(user);assert.equal((await resolve(['GNK']))[0].vendor_id,gnk);}
 for(const user of [null,viewer,inactive]){await login(user);await assert.rejects(resolve(['GNK']),/PURCHASE_VENDOR_STAFF_REQUIRED/);}
 await login(otherAdmin);assert.equal((await resolve(['GNK']))[0].vendor_id,otherVendor);await assert.rejects(resolve(['GNK-Diesel']),/PURCHASE_VENDOR_NOT_FOUND/);
 await assert.rejects(db.query('insert into purchase_vendor_resolution_private.vendor_aliases(organization_id,alias_supplier_name,vendor_id,reason)values($1,$2,$3,$4)',[otherOrg,'Forged',gnk,'Invalid cross-org target']),/foreign key/);
 for(const role of ['anon','authenticated','service_role']){
  assert.equal((await db.query("select has_schema_privilege($1,'purchase_vendor_resolution_private','USAGE') allowed",[role])).rows[0].allowed,false);
  await db.exec(`set role ${role}`);await assert.rejects(db.query('select * from purchase_vendor_resolution_private.vendor_aliases'),/permission denied/);await db.exec('reset role');
 }
 for(const role of ['anon','service_role'])assert.equal((await db.query("select has_function_privilege($1,'public.resolve_purchase_order_vendors(text[])','execute') allowed",[role])).rows[0].allowed,false);
});

test('bounded and unambiguous inputs fail closed rather than choose arbitrary vendors',async t=>{
 const {db,resolve}=await fixture(t);
 for(const names of [null,[],[''],[' '],[null],['x'.repeat(181)],['a\nb'],Array.from({length:101},(_,i)=>'x'+i)])await assert.rejects(resolve(names),/PURCHASE_VENDOR_INPUT_INVALID/);
 for(const names of [['GNK','gnk'],[' GNK ','GNK']])await assert.rejects(resolve(names),/PURCHASE_VENDOR_DUPLICATE_INPUT/);
 await assert.rejects(resolve(['Unknown']),/PURCHASE_VENDOR_NOT_FOUND/);
 await db.query('insert into vendors values($1,$2,$3,$4,$5)',['30000000-0000-4000-8000-000000000099',org,'GNK','Different','DUP']);await assert.rejects(resolve(['GNK']),/PURCHASE_VENDOR_AMBIGUOUS/);
});

test('new PO saves persist a verified vendor binding and preserve every quantity and historical unit price',async t=>{
 const {db,save,aliases}=await fixture(t);await aliases();
 const source=(await db.query('select to_jsonb(s) row from sales_orders s')).rows[0].row;
 const saved=await save(payload({supplier_name:'GNK-Diesel',vendor_id:gnk}));assert.equal(saved.vendor_id,gnk);assert.equal(saved.supplier_name,'GNK');assert.deepEqual(saved.lines,lines);assert.equal(saved.total_amount,20.25);assert.equal(saved.line_count,1);
 assert.deepEqual((await db.query('select to_jsonb(s) row from sales_orders s')).rows[0].row,source);
 await assert.rejects(save(payload({id:'forged',vendor_id:otherVendor})),/PURCHASE_VENDOR_IDENTITY_MISMATCH/);
 assert.equal((await db.query("select count(*)::integer n from purchase_orders where id='forged'")).rows[0].n,0);
 assert.equal((await save(payload({id:'direct-idless'}))).vendor_id,gnk);
});

test('existing posted bound or unbound PO identity remains a snapshot despite later alias registration',async t=>{
 const {db,save,aliases}=await fixture(t);await aliases();
 const history=await save(payload({id:'history',supplier_name:'GNK-Diesel',supplier_key:'gnk-diesel',vendor_id:diesel,status:'open'}));assert.equal(history.vendor_id,diesel);assert.equal(history.supplier_name,'GNK-Diesel');assert.deepEqual(history.lines,lines);
 const unbound=await save(payload({id:'unbound-history',supplier_name:'GNK-Diesel',supplier_key:'gnk-diesel',status:'open'}));assert.equal(unbound.vendor_id,null);assert.equal(unbound.supplier_name,'GNK-Diesel');
 await assert.rejects(save(payload({id:'history',supplier_name:'GNK',vendor_id:gnk,status:'open'})),/POSTED_ID_IMMUTABLE/);
 await assert.rejects(save(payload({id:'history',supplier_name:'GNK',vendor_id:diesel,status:'open'})),/POSTED_NAME_IMMUTABLE/);
 await db.query("insert into bills values('bill',$1,'history',$2)",[org,JSON.stringify(lines)]);await assert.rejects(save(payload({id:'history',supplier_name:'GNK-Diesel',vendor_id:diesel,status:'open'})),/downstream documents cannot be edited/);
 assert.equal((await db.query("select vendor_id from purchase_orders where id='history'")).rows[0].vendor_id,diesel);
});

test('legacy financial and source guards remain in force and a changed save baseline blocks patching',async t=>{
 const {db,save}=await fixture(t);
 await assert.rejects(save(payload({currency:'USD'})),/currency must match/);await assert.rejects(save(payload({lines:[{qty:-1,buy_price:10}]})),/quantities cannot be negative/);
 await assert.rejects(save(payload({sales_order_id:'missing'})),/Linked sales order was not found/);
 assert.equal((await db.query("select count(*)::integer n from purchase_orders where id='new-po'")).rows[0].n,0);
 const changed=(await db.query("select pg_get_functiondef('public.save_purchase_order_atomic(jsonb,text)'::regprocedure) source")).rows[0].source;
 assert.match(changed,/PURCHASE_VENDOR_POSTED_ID_IMMUTABLE/);assert.match(changed,/Purchase order with downstream documents cannot be replaced/);
 const gate=migration.slice(migration.indexOf('do $migration$'));
 await assert.rejects(db.exec(gate),/PURCHASE_VENDOR_SAVE_BASELINE_CHANGED/);
});
