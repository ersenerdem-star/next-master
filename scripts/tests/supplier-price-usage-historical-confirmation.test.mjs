import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';

const migration=await readFile(new URL('../../supabase/migrations/20261106111617_supplier_price_usage_historical_confirmation.sql',import.meta.url),'utf8');
const org='10000000-0000-4000-8000-000000000001',supplier='20000000-0000-4000-8000-000000000001';
const customer='30000000-0000-4000-8000-000000000001';
const line={requestedCode:'001/20',resolvedCode:'001/20',brand:'Bosch',qty:2,supplier_name:'GNK-Diesel',buy_price:10,sell_price:11,manual_sell_price:false,selectedSupplierKey:'GNK-Diesel-0',price_date:'2026-11-01'};
async function fixture(t){
 const db=new PGlite();t.after(()=>db.close());
 await db.exec(`create role anon;create role authenticated;create role service_role;
 create schema auth;create function auth.uid() returns uuid language sql as $$select nullif(current_setting('test.uid',true),'')::uuid$$;
 create function public.current_profile_org_id() returns uuid language sql as $$select '${org}'::uuid$$;
 create function public.current_profile_role() returns text language sql as $$select current_setting('test.role',true)$$;
 create function public.is_superadmin() returns boolean language sql as $$select current_setting('test.role',true)='superadmin'$$;
 create function public.profile_has_permission(v text) returns boolean language sql as $$select current_setting('test.role',true) in ('admin','staff')$$;
 create function public.can_access_customer(v uuid) returns boolean language sql as $$select v='${customer}'::uuid$$;
 create function public.normalize_part_code(v text) returns text language sql immutable as $$select upper(regexp_replace(coalesce(v,''),'[^a-zA-Z0-9]','','g'))$$;
 create table suppliers(id uuid,organization_id uuid,name text,normalized_name text,price_usage_enabled boolean,price_usage_disabled_at timestamptz);
 create table sales_orders(id text primary key,organization_id uuid,created_at timestamptz,updated_at timestamptz,
 customer_id uuid,customer_name text,customer_type text,currency text,lines jsonb,notes text);
 select set_config('test.uid','40000000-0000-4000-8000-000000000001',false);select set_config('test.role','admin',false);
 insert into suppliers values('${supplier}','${org}','GNK-Diesel','GNKDIESEL',false,'2026-11-06T12:00:00Z');`);
 await db.query(`insert into sales_orders values('old',$1,'2026-11-01','2026-11-01',$2,'Customer','A','EUR',$3,'original')`,[org,customer,JSON.stringify([line])]);
 await db.exec(migration);
 await db.query('select supplier_price_usage_internal.capture_order_lines($1,$2)',[org,supplier]);
 const policy=async(lines=[line],order='old',extra={})=>(await db.query('select public.cloud_sales_order_preserved_supplier_lines($1,$2,$3,$4,$5,$6) result',[
 order,JSON.stringify(lines),extra.currency??'EUR',extra.type??'A',Object.hasOwn(extra,'customer')?extra.customer:customer,extra.name??'Customer'])).rows[0].result;
 return {db,policy};
}
test('disabling captures evidence without changing saved financial lines; notes saves keep confirmation eligibility',async t=>{
 const {db,policy}=await fixture(t);
 const before=(await db.query('select lines from sales_orders')).rows[0].lines;
 assert.deepEqual(await policy(),{preserved_indices:[0],disabled_indices:[]});
 await db.exec("update sales_orders set notes='updated note',updated_at=now()");
 assert.deepEqual(await policy(),{preserved_indices:[0],disabled_indices:[]});
 assert.deepEqual((await db.query('select lines from sales_orders')).rows[0].lines,before);
});
test('new orders and new or edited lines cannot reuse historical supplier evidence',async t=>{
 const {policy}=await fixture(t);
 assert.deepEqual(await policy([line],null),{preserved_indices:[],disabled_indices:[0]});
 assert.deepEqual(await policy([line],'unknown'),{preserved_indices:[],disabled_indices:[0]});
 assert.deepEqual(await policy([line,{...line}]),{preserved_indices:[0],disabled_indices:[1]});
 for(const patch of [{qty:3},{buy_price:9},{sell_price:12},{resolvedCode:'00120'},{moq:5},{manual_sell_price:true}]){
  assert.deepEqual(await policy([{...line,...patch}]),{preserved_indices:[],disabled_indices:[0]});
 }
});
test('saving altered lines after closure does not manufacture pre-disable evidence',async t=>{
 const {db,policy}=await fixture(t),changed={...line,buy_price:1,sell_price:1.1};
 await db.query('update sales_orders set lines=$1,updated_at=now()',[JSON.stringify([changed])]);
 assert.deepEqual(await policy([changed]),{preserved_indices:[],disabled_indices:[0]});
});
test('customer identity, pricing header, tenant, and disable event remain bound to captured evidence',async t=>{
 const {db,policy}=await fixture(t);
 for(const extra of [{currency:'USD'},{type:'B'},{customer:null},{name:'Other'}]){
  assert.deepEqual(await policy([line],'old',extra),{preserved_indices:[],disabled_indices:[0]});
 }
 await db.exec("update sales_orders set organization_id='10000000-0000-4000-8000-000000000002'");
 assert.deepEqual(await policy(),{preserved_indices:[],disabled_indices:[0]});
 await db.query('update sales_orders set organization_id=$1',[org]);
 await db.exec("update suppliers set price_usage_disabled_at='2026-11-07'");
 assert.deepEqual(await policy(),{preserved_indices:[],disabled_indices:[0]});
});
test('selected disabled supplier ID cannot be hidden by changing the display name',async t=>{
 const {policy}=await fixture(t);
 const forged={...line,supplier_name:'Other',supplierOptions:[{supplier_id:supplier,supplier_name:'GNK-Diesel'}]};
 assert.deepEqual(await policy([forged],null),{preserved_indices:[],disabled_indices:[0]});
});
test('saved options-only supplier identity is captured with the same selected-option rule as confirmation',async t=>{
 const {db,policy}=await fixture(t);
 const stored={...line,supplier_name:'',selectedSupplierKey:'GNK-Diesel-1',supplierOptions:[
  {supplier_id:'20000000-0000-4000-8000-000000000099',supplier_name:'Other'},
  {supplier_id:supplier,supplier_name:'GNK-Diesel'},
 ]};
 await db.query('update sales_orders set lines=$1',[JSON.stringify([stored])]);
 await db.query('select supplier_price_usage_internal.capture_order_lines($1,$2)',[org,supplier]);
 assert.deepEqual(await policy([stored]),{preserved_indices:[0],disabled_indices:[]});
 assert.deepEqual(await policy([stored],null),{preserved_indices:[],disabled_indices:[0]});
 assert.deepEqual(await policy([{...stored,qty:3}]),{preserved_indices:[],disabled_indices:[0]});
 // The unselected first option must not capture a different supplier's line.
 const otherSelected={...stored,selectedSupplierKey:'Other-0'};
 await db.query('update sales_orders set lines=$1',[JSON.stringify([otherSelected])]);
 await db.query('select supplier_price_usage_internal.capture_order_lines($1,$2)',[org,supplier]);
 assert.equal((await db.query('select count(*)::integer n from supplier_price_usage_internal.preserved_order_lines')).rows[0].n,0);
});
test('policy denies unauthenticated callers, malformed lines and private evidence access',async t=>{
 const {db,policy}=await fixture(t);
 await db.exec("select set_config('test.uid','',false)");await assert.rejects(policy(),/ADMIN_REQUIRED/);
 await db.exec("select set_config('test.uid','40000000-0000-4000-8000-000000000001',false);select set_config('test.role','',false)");
 await assert.rejects(policy(),/ADMIN_REQUIRED/);
 await db.exec("select set_config('test.role','admin',false)");await assert.rejects(policy([null]),/LINES_INVALID/);
 for(const role of ['anon','authenticated','service_role']){
  const result=(await db.query("select has_schema_privilege($1,'supplier_price_usage_internal','USAGE') allowed",[role])).rows[0];assert.equal(result.allowed,false);
 }
});
