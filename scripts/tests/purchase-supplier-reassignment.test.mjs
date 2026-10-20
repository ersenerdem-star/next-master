import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
const org='00000000-0000-0000-0000-000000000001', actor='00000000-0000-0000-0000-000000000002', supplier='00000000-0000-0000-0000-000000000003', vendor='00000000-0000-0000-0000-000000000004';
const other='00000000-0000-0000-0000-000000000005';
const table = (file,name) => readFileSync(`supabase/migrations/${file}`,'utf8').match(new RegExp(`create table if not exists ${name} \\([\\s\\S]*?\\n\\);`,'i'))[0];
const line = (code='000366', qty=2) => ({sales_order_id:'SO-1',sales_order_no:'SO-1',product_code:code,old_code:'',brand:'SACHS',description:'Shock absorber',qty,buy_price:10,line_total:qty*10,supplier_name:'Romany',origin:'DE',hs_code:'870880',notes:''});
async function setup() {
 const db=new PGlite();
 await db.exec(`create role anon; create role authenticated; create role service_role; create schema auth;
 create function auth.uid() returns uuid language sql as $$select nullif(current_setting('test.actor',true),'')::uuid$$;
 create function current_profile_org_id() returns uuid language sql as $$select nullif(current_setting('test.org',true),'')::uuid$$;
 create function current_profile_role() returns text language sql as $$select current_setting('test.role',true)$$;
 create function is_superadmin() returns boolean language sql as $$select nullif(current_setting('test.super',true),'')::boolean$$;
 create function normalize_part_code(text) returns text language sql immutable as $$select upper(regexp_replace($1,'[^a-zA-Z0-9]','','g'))$$;
 create table organizations(id uuid primary key); create table warehouses(id uuid primary key);
 create table suppliers(id uuid primary key, organization_id uuid, name text);
 ${table('20260513_11_orders_phase2.sql','sales_orders')}
 ${table('20260513_11_orders_phase2.sql','purchase_orders')}
 ${table('20260513_14_vendors_phase4.sql','vendors')}
 ${table('20260513_12_documents_phase3.sql','bills')}
 ${table('20260513_19_inventory_phase2.sql','purchase_receives')}
 ${table('20260513_19_inventory_phase2.sql','inventory_movements')}
 ${table('20260513_13_email_templates.sql','outbound_emails')}
 alter table purchase_orders add vendor_id uuid references vendors;
 create table test_offers(organization_id uuid,supplier_id uuid,supplier_name text,product_code text,brand text,buy_price numeric,price_date date,moq integer,order_multiple integer,stock_qty integer,valid_to date);
 create function cloud_current_supplier_commercial_options_core(uuid,text,text) returns setof public.test_offers language sql as $$ select * from public.test_offers where organization_id=$1 and upper(regexp_replace(product_code,'[[:space:]]','','g'))=upper(regexp_replace($2,'[[:space:]]','','g')) and brand=$3 $$;
 set test.actor='${actor}';set test.org='${org}';set test.role='sales';
 insert into organizations values('${org}'),('${other}');
 insert into suppliers values('${supplier}','${org}','TPM');
 insert into vendors(id,organization_id,display_name,company_name,vendor_number) values('${vendor}','${org}','TPM','TPM','V1');
 insert into sales_orders(id,organization_id,sales_order_no,status,sales_total,lines) values('SO-1','${org}','SO-1','confirmed',12345,'[{"sell_price":12345,"product_code":"000366"}]');
 insert into test_offers values('${org}','${supplier}','TPM','000366','SACHS',12,'2026-10-19',1,1,1000,null),('${org}','${supplier}','TPM','000369','SACHS',15,'2026-10-19',1,1,1000,null);
 `);
 await db.exec(readFileSync('supabase/migrations/20261020183558_purchase_order_supplier_reassignment.sql','utf8'));
 await db.exec(readFileSync('supabase/migrations/20261020185703_purchase_order_sourcing_plan.sql','utf8'));
 await db.query(`insert into purchase_orders(id,organization_id,supplier_name,supplier_key,purchase_company,sales_order_id,sales_order_no,status,currency,total_amount,line_count,lines) values('PO-R',$1,'Romany','romany','Next','SO-1','SO-1','draft','EUR',40,2,$2)`,[org,JSON.stringify([line(),line('000369')])]);
 return db;
}
async function request(db, overrides={}) {
 const source=(await db.query("select * from purchase_orders where id='PO-R'")).rows[0];
 return {decision_id:crypto.randomUUID(),source_order_id:'PO-R',supplier_id:supplier,expected_source_updated_at:source.updated_at.toISOString(),target_order_id:null,expected_target_updated_at:null,line_indices:[0,1],expected_prices:[{line_index:0,buy_price:12},{line_index:1,buy_price:15}],reason:'Consolidate logistics',...overrides};
}
async function rpc(db,payload){return (await db.query('select reassign_purchase_order_supplier_atomic($1::jsonb) result',[JSON.stringify(payload)])).rows[0].result;}
async function target(db){await db.query(`insert into purchase_orders(id,organization_id,vendor_id,supplier_name,supplier_key,purchase_company,sales_order_id,status,total_amount,line_count,lines) values('PO-T',$1,$2,'TPM','tpm','Next','SO-1','draft',120,1,$3)`,[org,vendor,JSON.stringify([{...line('000366',10),supplier_name:'TPM',buy_price:12,line_total:120}])]);return (await db.query("select updated_at from purchase_orders where id='PO-T'")).rows[0].updated_at.toISOString();}
async function withDb(fn){const db=await setup();try{await fn(db);}finally{await db.close();}}

test('whole draft changes supplier/cost atomically, preserves literal SKU and accepted sale, replay is stable',()=>withDb(async db=>{
 const before=(await db.query('select to_jsonb(s) data from sales_orders s')).rows[0].data;
 const p=await request(db); const r=await rpc(db,p);
 assert.equal(r.target_order.id,'PO-R');assert.equal(r.target_order.vendor_id,vendor);assert.equal(r.target_order.total_amount,54);assert.equal(r.target_order.lines[0].product_code,'000366');assert.equal(r.target_order.lines[0].buy_price,12);
 assert.deepEqual((await db.query('select to_jsonb(s) data from sales_orders s')).rows[0].data,before);
 assert.equal((await rpc(db,p)).replayed,true);await assert.rejects(rpc(db,{...p,reason:'Changed reason'}),/REPLAY_CONFLICT/);
 assert.equal((await db.query('select count(*) n from purchase_order_supplier_changes')).rows[0].n,1);
}));
test('all lines merge into existing TPM draft and empty Romany draft closes without deletion',()=>withDb(async db=>{
 const stamp=await target(db);const r=await rpc(db,await request(db,{target_order_id:'PO-T',expected_target_updated_at:stamp}));
 assert.equal(r.target_order.total_amount,174);assert.equal(r.target_order.lines.length,3);assert.equal(r.source_order.status,'closed');assert.equal(r.source_order.total_amount,0);assert.equal(r.source_order.lines.length,0);
 assert.equal((await db.query("select before_snapshot->'source'->>'supplier_name' s from purchase_order_supplier_changes")).rows[0].s,'Romany');
}));
test('partial move creates separate draft and keeps remaining source demand',()=>withDb(async db=>{
 const r=await rpc(db,await request(db,{line_indices:[1],expected_prices:[{line_index:1,buy_price:15}]}));
 assert.notEqual(r.target_order.id,'PO-R');assert.equal(r.target_order.total_amount,30);assert.equal(r.source_order.total_amount,20);assert.equal(r.source_order.status,'draft');assert.equal(r.source_order.lines[0].product_code,'000366');
}));
test('concurrent source/target and changed prices abort without partial writes',()=>withDb(async db=>{
 const p=await request(db); await db.exec("update purchase_orders set updated_at=updated_at+interval '1 second'");
 await assert.rejects(rpc(db,p),/ORDER_CHANGED/);
 const stamp=await target(db); const t=await request(db,{target_order_id:'PO-T',expected_target_updated_at:stamp});await db.exec("update purchase_orders set updated_at=updated_at+interval '1 second' where id='PO-T'");await assert.rejects(rpc(db,t),/TARGET_CHANGED/);
 const q=await request(db);await db.exec("update test_offers set buy_price=13 where product_code='000366'");await assert.rejects(rpc(db,q),/PRICE_CHANGED/);
 assert.equal((await db.query("select supplier_name from purchase_orders where id='PO-R'")).rows[0].supplier_name,'Romany');
 assert.equal((await db.query('select count(*) n from purchase_order_supplier_changes')).rows[0].n,0);
}));
test('billed, received, emailed and issued orders are guarded, including merged bill line references',()=>withDb(async db=>{
 await db.exec(`insert into bills(id,organization_id,purchase_order_id,lines) values('B','${org}','OTHER','[{"purchase_order_id":"PO-R"}]')`);await assert.rejects(rpc(db,await request(db)),/ALREADY_ISSUED/);await db.exec('delete from bills');
 await db.exec(`insert into warehouses values('${vendor}');insert into purchase_receives(organization_id,purchase_order_id,warehouse_id) values('${org}','PO-R','${vendor}')`);await assert.rejects(rpc(db,await request(db)),/ALREADY_ISSUED/);await db.exec('delete from purchase_receives');
 await db.exec(`insert into outbound_emails(organization_id,template_key,recipient_type,related_type,related_id,status) values('${org}','po','vendor','purchase_order','PO-R','sent')`);await assert.rejects(rpc(db,await request(db)),/ALREADY_ISSUED/);await db.exec('delete from outbound_emails');
 await db.exec("update purchase_orders set status='open'");await assert.rejects(rpc(db,await request(db)),/EUR_DRAFT_REQUIRED/);
}));
test('tenant, role (including NULL superadmin), vendor ambiguity and exact SKU are enforced',()=>withDb(async db=>{
 const p=await request(db);await db.exec("set test.role='customer'");await assert.rejects(rpc(db,p),/ACCESS_DENIED/);await db.exec(`set test.role='sales';set test.org='${other}'`);await assert.rejects(rpc(db,p),/ORDER_NOT_FOUND/);await db.exec(`set test.org='${org}'`);
 await db.exec("update test_offers set product_code='366' where product_code='000366'");await assert.rejects(rpc(db,p),/PRICE_UNAVAILABLE/);await db.exec("update test_offers set product_code='000366' where product_code='366'");
 await db.exec(`insert into vendors(id,organization_id,display_name,vendor_number) values('${other}','${org}','TPM','V2')`);await assert.rejects(rpc(db,p),/VENDOR_MAPPING_REQUIRED/);
 assert.equal((await db.query("select has_function_privilege('anon','reassign_purchase_order_supplier_atomic(jsonb)','execute') allowed")).rows[0].allowed,false);
 assert.equal((await db.query("select has_table_privilege('authenticated','purchase_order_supplier_changes','insert') allowed")).rows[0].allowed,false);
}));
test('MOQ, multiples, stock, expiry, duplicate indices and unconfirmed sales cannot be bypassed',()=>withDb(async db=>{
 const p=await request(db);
 for(const change of ["moq=3","order_multiple=3","stock_qty=1","valid_to=current_date-1"]){await db.exec(`update test_offers set ${change}`);await assert.rejects(rpc(db,p),/QUANTITY_UNAVAILABLE/);await db.exec('update test_offers set moq=1,order_multiple=1,stock_qty=1000,valid_to=null');}
 await assert.rejects(rpc(db,{...p,line_indices:[0,0]}),/LINES_INVALID/);
 await db.exec("update sales_orders set status='draft'");await assert.rejects(rpc(db,p),/CONFIRMED_SALE_REQUIRED/);
}));

test('destination stock includes existing and duplicated demand',()=>withDb(async db=>{
 const stamp=await target(db);await db.exec("update test_offers set stock_qty=11 where product_code='000366'");
 await assert.rejects(rpc(db,await request(db,{target_order_id:'PO-T',expected_target_updated_at:stamp})),/QUANTITY_UNAVAILABLE/);
 assert.equal((await db.query("select total_amount from purchase_orders where id='PO-T'")).rows[0].total_amount,'120.00');
}));

test('audit receipts are tenant-scoped and authenticated clients cannot rewrite or erase them',()=>withDb(async db=>{
 await rpc(db,await request(db));
 await db.exec('set role authenticated');
 assert.equal((await db.query('select count(*) n from purchase_order_supplier_changes')).rows[0].n,1);
 await assert.rejects(db.exec("update purchase_order_supplier_changes set reason='rewritten'"),/permission denied/);
 await assert.rejects(db.exec('delete from purchase_order_supplier_changes'),/permission denied/);
 await db.exec(`set test.org='${other}'`);
 assert.equal((await db.query('select count(*) n from purchase_order_supplier_changes')).rows[0].n,0);
}));

const ga='00000000-0000-0000-0000-000000000006', gaVendor='00000000-0000-0000-0000-000000000007';
async function groupAuto(db) {
 await db.exec(`insert into suppliers values('${ga}','${org}','GroupAuto');insert into vendors(id,organization_id,display_name,company_name,vendor_number) values('${gaVendor}','${org}','GroupAuto','GroupAuto','GA');
 insert into test_offers values('${org}','${ga}','GroupAuto','000366','SACHS',13,'2026-10-19',1,1,1000,null),('${org}','${ga}','GroupAuto','000369','SACHS',17,'2026-10-19',1,1,1000,null)`);
}
async function plan(db,groups) {
 const base=await request(db);
 return {decision_id:base.decision_id,source_order_id:base.source_order_id,expected_source_updated_at:base.expected_source_updated_at,reason:base.reason,groups};
}
const group=(supplier_id,indices,prices,extra={})=>({supplier_id,target_order_id:null,expected_target_updated_at:null,line_indices:indices,expected_prices:indices.map((i,n)=>({line_index:i,buy_price:prices[n]})),...extra});
async function planRpc(db,p){return (await db.query('select apply_purchase_order_sourcing_plan_atomic($1::jsonb) result',[JSON.stringify(p)])).rows[0].result;}

test('one plan routes original line identities to different supplier POs atomically and replays safely',()=>withDb(async db=>{
 await groupAuto(db);const stamp=await target(db);
 const before=(await db.query('select to_jsonb(s) data from sales_orders s')).rows[0].data;
 const p=await plan(db,[group(supplier,[0],[12],{target_order_id:'PO-T',expected_target_updated_at:stamp}),group(ga,[1],[17])]);
 const r=await planRpc(db,p);assert.equal(r.target_orders.length,2);
 assert.equal(r.target_orders[0].total_amount,144);assert.equal(r.target_orders[1].total_amount,34);
 assert.equal(r.target_orders[1].lines[0].product_code,'000369');assert.equal(r.target_orders[1].lines[0].supplier_name,'GroupAuto');
 assert.equal((await planRpc(db,p)).replayed,true);
 assert.equal((await db.query('select count(*) n from purchase_order_sourcing_plans')).rows[0].n,1);
 assert.equal((await db.query('select count(*) n from purchase_order_supplier_changes')).rows[0].n,2);
 await assert.rejects(planRpc(db,{...p,reason:'Other reason'}),/REPLAY_CONFLICT/);
 assert.deepEqual((await db.query('select to_jsonb(s) data from sales_orders s')).rows[0].data,before);
}));
test('a late second-supplier price failure rolls back the first PO and all receipts',()=>withDb(async db=>{
 await groupAuto(db);
 const p=await plan(db,[group(supplier,[0],[12]),group(ga,[1],[999])]);
 await assert.rejects(planRpc(db,p),/PRICE_CHANGED/);
 const rows=(await db.query('select * from purchase_orders')).rows;
 assert.equal(rows.length,1);assert.equal(rows[0].supplier_name,'Romany');assert.equal(rows[0].lines.length,2);
 assert.equal((await db.query('select count(*) n from purchase_order_supplier_changes')).rows[0].n,0);
 assert.equal((await db.query('select count(*) n from purchase_order_sourcing_plans')).rows[0].n,0);
}));
test('duplicate original line allocation and stale source are rejected before routing any demand',()=>withDb(async db=>{
 await groupAuto(db);
 await assert.rejects(planRpc(db,await plan(db,[group(supplier,[0],[12]),group(ga,[0],[13])])),/PLAN_INVALID/);
 const p=await plan(db,[group(supplier,[0],[12])]);await db.exec("update purchase_orders set updated_at=updated_at+interval '1 second'");
 await assert.rejects(planRpc(db,p),/ORDER_CHANGED/);
 assert.equal((await db.query('select count(*) n from purchase_order_supplier_changes')).rows[0].n,0);
}));
test('200-line two-supplier plan preserves repeated SKU demand identity across index remapping',()=>withDb(async db=>{
 await groupAuto(db);
 const lines=Array.from({length:200},(_,i)=>({...line(i%2?'000369':'000366',1),notes:`original-${i}`}));
 await db.query("update purchase_orders set lines=$1,line_count=200,total_amount=2000 where id='PO-R'",[JSON.stringify(lines)]);
 const even=Array.from({length:100},(_,i)=>i*2),odd=even.map(i=>i+1);
 const r=await planRpc(db,await plan(db,[group(supplier,even,even.map(()=>12)),group(ga,odd,odd.map(()=>17))]));
 assert.deepEqual(r.target_orders[0].lines.map(l=>l.notes),even.map(i=>`original-${i}`));
 assert.deepEqual(r.target_orders[1].lines.map(l=>l.notes),odd.map(i=>`original-${i}`));
 assert.equal(r.target_orders[0].total_amount,1200);assert.equal(r.target_orders[1].total_amount,1700);
}));
test('plan receipts enforce tenant and immutable-client boundaries',()=>withDb(async db=>{
 const p=await plan(db,[group(supplier,[0],[12])]);
 await db.exec("set test.role='customer'");await assert.rejects(planRpc(db,p),/ACCESS_DENIED/);await db.exec(`set test.role='sales';set test.org='${other}'`);await assert.rejects(planRpc(db,p),/ORDER_NOT_FOUND/);
 await db.exec(`set test.org='${org}'`);await planRpc(db,p);
 assert.equal((await db.query("select has_function_privilege('anon','apply_purchase_order_sourcing_plan_atomic(jsonb)','execute') allowed")).rows[0].allowed,false);
 await db.exec('set role authenticated');await assert.rejects(db.exec('delete from purchase_order_sourcing_plans'),/permission denied/);
 await db.exec(`set test.org='${other}'`);assert.equal((await db.query('select count(*) n from purchase_order_sourcing_plans')).rows[0].n,0);
}));

test('stale second destination rolls back earlier groups and the source snapshot',()=>withDb(async db=>{
 await groupAuto(db);const stamp=await target(db);
 const p=await plan(db,[group(ga,[0],[13]),group(supplier,[1],[15],{target_order_id:'PO-T',expected_target_updated_at:stamp})]);
 await db.exec("update purchase_orders set updated_at=updated_at+interval '1 second' where id='PO-T'");
 await assert.rejects(planRpc(db,p),/TARGET_CHANGED/);
 assert.equal((await db.query("select line_count from purchase_orders where id='PO-R'")).rows[0].line_count,2);
 assert.equal((await db.query('select count(*) n from purchase_orders')).rows[0].n,2);
 assert.equal((await db.query('select count(*) n from purchase_order_supplier_changes')).rows[0].n,0);
}));
