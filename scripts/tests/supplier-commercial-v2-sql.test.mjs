import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash,randomBytes} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import pg from 'pg';
import {createFullReplayDb} from './fixtures/price-engine-full-replay-db.mjs';
const dir='supabase/migrations/';
const names=['20261014162139_supplier_admin_release_action_queue','20261014165817_price_list_legacy_scope_compatibility','20261014171235_master_price_mixed_supplier_scopes','20261014175649_supplier_source_commercial_compatibility_guard','20261014183349_supplier_upload_safe_commercial_error_status'];
const ingestion='20261014193018_supplier_commercial_fields_v2_ingestion',readers='20261014193456_supplier_commercial_fields_v2_readers';
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const org=id(1),supplier=id(3),brand=id(5),actor=id(7),policy='supplier-price-commercial-fields-v2';
let db,oldStageHash,oldReceiptHash,container;
const exec=promisify(execFile);
const admin=async(sql,args=[])=>{if(/^rollback/i.test(sql)){await db.query(sql,args);return db.exec('reset role');}await db.exec('reset role');return db.query(sql,args);};
const rpc=async(name,args)=>{await db.exec("reset role;set role service_role;select set_config('request.jwt.claim.role','service_role',false)");return db.query(`select * from public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')})`,args);};
async function record(n,kind=policy){return (await rpc(kind===policy?'record_supplier_price_source_compatibility_v2':'record_supplier_price_source_compatibility',[id(n),id(n+3000),createHash('sha256').update(`fixture/${id(n)}.csv`).digest('hex'),2,kind])).rows[0];}
async function seed(n,{started=false}={}){
 const release=id(n),path=`fixture/${release}.csv`,hash=createHash('sha256').update(path).digest('hex');
 await admin(`insert into supplier_price_releases(id,organization_id,supplier_id,brand_id,created_by,status,source_date,total_rows,processed_rows,current_cursor,source_verification_required,uploaded_at,source_file_path,source_file_sha256)
 values($1,$2,$3,$4,$5,'uploaded',current_date,2,$6,$6,true,now(),$7,$8)`,[release,org,supplier,brand,actor,started?1:0,path,hash]);
 await db.query(`insert into supplier_price_upload_sessions(id,organization_id,release_id,idempotency_key,storage_object_path,file_name,content_type,total_bytes,uploaded_bytes,status,created_by,expires_at,checksum_sha256)
 values($1,$2,$3,$4,$5,'source.csv','text/csv',100,100,'uploaded',$6,now()+interval '1 day',$7)`,[id(n+1000),org,release,'fixture-'+n,path,actor,hash]);
 await db.query(`insert into storage.objects(id,bucket_id,name,version,updated_at,metadata)values($1,'supplier-price-imports',$2,'object-v1',now(),'{"size":100}')`,[id(n+2000),path]);
 await db.query(`insert into supplier_price_ingestion_internal.handoffs(id,session_id,release_id,organization_id,storage_bucket,source_path,source_sha256,source_bytes,total_rows,object_id,object_version,object_updated_at,workflow_id,status,enqueued_at)
 select $1,$2,$3,$4,o.bucket_id,o.name,$5,100,2,o.id,o.version,o.updated_at,$6,'enqueued',now() from storage.objects o where id=$7`,[id(n+3000),id(n+1000),release,org,hash,`supplier-price-verified:v1:${release}`,id(n+2000)]);
 return release;
}
async function batch(n){await admin(`insert into supplier_price_release_batches(id,release_id,batch_number,cursor_start,cursor_end,row_count,status,lease_owner,lease_expires_at)values($1,$2,1,1,2,2,'running','owner',now()+interval '1 minute')`,[id(n+4000),id(n)]);}
const date=(offset=0)=>new Date(Date.now()+offset*86400000).toISOString().slice(0,10);
const rows=(patch={})=>[1,2].map(i=>({source_row_number:i,normalized_code:'CODE'+i,product_code:'CODE'+i,buy_price:10+i,currency:'EUR',valid_from:date(),row_status:'staged',row_hash:String(i).repeat(64),moq:3,stock_qty:i===1?0:null,order_multiple:i===1?6:null,valid_to:i===1?date():null,...patch}));
const stage=(n,payload=rows(),owner='owner',v2=true)=>rpc(v2?'stage_supplier_price_release_batch_v2':'stage_supplier_price_release_batch',[id(n+4000),owner,JSON.stringify(payload)]);
async function rollbackCase(fn){await admin('begin');try{await fn();}finally{await admin('rollback');}}
before(async()=>{
 if(process.env.RUN_SUPPLIER_COMMERCIAL_PG_RUNTIME==='1'){
  container=`nm-commercial-v2-pg-${process.pid}-${randomBytes(4).toString('hex')}`;const password=randomBytes(24).toString('hex');
  await exec('docker',['run','--detach','--rm','--name',container,'--cpus','0.5','--memory','1g','--publish','127.0.0.1::5432','--env','POSTGRES_PASSWORD','--env','POSTGRES_DB=commercial_v2_test','postgres:17'],{env:{...process.env,POSTGRES_PASSWORD:password},timeout:30000});
  const port=Number((await exec('docker',['port',container,'5432/tcp'])).stdout.trim().match(/^127\.0\.0\.1:(\d+)$/)[1]);
  pg.types.setTypeParser(20,Number);pg.types.setTypeParser(1082,x=>x);let client;
  for(let i=0;i<60;i++){const c=new pg.Client({host:'127.0.0.1',port,user:'postgres',password,database:'commercial_v2_test',connectionTimeoutMillis:1000});try{await c.connect();client=c;break;}catch{await c.end().catch(()=>{});await delay(250);}}
  assert.ok(client);client.exec=q=>client.query(q);client.close=()=>client.end();db=await createFullReplayDb({db:client});
 }else db=await createFullReplayDb();
 try{
 const m=JSON.parse(await readFile('scripts/ops/price-engine-production-manifest.json','utf8'));
 for(const i of m.migration_order)await db.exec(await readFile(i.file,'utf8'));
 for(const n of names)await db.exec(await readFile(dir+n+'.sql','utf8'));
 oldStageHash=(await db.query("select md5(pg_get_functiondef('stage_supplier_price_release_batch(uuid,text,jsonb)'::regprocedure)) hash")).rows[0].hash;
 oldReceiptHash=(await db.query("select md5(pg_get_functiondef('record_supplier_price_source_compatibility(uuid,uuid,text,bigint,text)'::regprocedure)) hash")).rows[0].hash;
 await db.exec(await readFile(dir+ingestion+'.sql','utf8'));await db.exec(await readFile(dir+readers+'.sql','utf8'));
 await db.exec(await readFile(dir+'20261023185017_continental_automotive_brand_identity.sql','utf8'));
 await db.query("insert into organizations(id,name)values($1,'Org')",[org]);
 await db.query("insert into suppliers(id,organization_id,name)values($1,$2,'Supplier')",[supplier,org]);
 await db.query("insert into brands(id,organization_id,name)values($1,$2,'Brand')",[brand,org]);
 await db.query('insert into auth.users(id)values($1)',[actor]);
 await db.query("insert into profiles(id,organization_id,email,role,is_active,permissions)values($1,$2,'test@example.invalid','superadmin',true,'{\"supplier_prices.manage\":true}')",[actor,org]);
 await db.query("insert into auth.sessions(id,user_id,not_after)values($1,$2,now()+interval '1 day')",[id(8),actor]);
 await db.query("select set_config('request.jwt.claim.sub',$1,false)",[actor]);
 }catch(e){throw new Error(`fixture ${e.code}: ${e.message} @${e.position}`);}
});
after(async()=>{try{await db?.close();}finally{if(container)await exec('docker',['rm','--force',container]).catch(()=>{});}});

test('full62 and forwards compile; v1 RPC bodies and private receipt ACL remain unchanged',async()=>{
 assert.equal((await admin("select md5(pg_get_functiondef('stage_supplier_price_release_batch(uuid,text,jsonb)'::regprocedure)) hash")).rows[0].hash,oldStageHash);
 assert.equal((await admin("select md5(pg_get_functiondef('record_supplier_price_source_compatibility(uuid,uuid,text,bigint,text)'::regprocedure)) hash")).rows[0].hash,oldReceiptHash);
 for(const name of ['record_supplier_price_source_compatibility_v2(uuid,uuid,text,bigint,text)','stage_supplier_price_release_batch_v2(uuid,text,jsonb)','cloud_current_supplier_commercial_options_service(uuid,text,text)','cloud_supplier_price_export_commercial_chunk_v3(uuid,uuid,uuid,text,text,text,uuid,integer)']){
 const r=(await admin("select has_function_privilege('anon',$1,'execute') anon,has_function_privilege('authenticated',$1,'execute') browser,has_function_privilege('service_role',$1,'execute') service",[name])).rows[0];assert.deepEqual(r,{anon:false,browser:false,service:true});}
 const r=(await admin("select relrowsecurity rls,has_table_privilege('service_role',oid,'insert') service_insert from pg_class where oid='supplier_price_ingestion_internal.source_compatibility_receipts'::regclass")).rows[0];assert.deepEqual(r,{rls:true,service_insert:false});
});

test('v2 receipt requires pristine source, rejects v1 relabeling, and replays after started work',()=>rollbackCase(async()=>{
 await seed(10,{started:true});await admin('savepoint invalid');await assert.rejects(record(10),/V2_ALREADY_STARTED/);await admin('rollback to savepoint invalid');
 await seed(11);await record(11,'supplier-price-commercial-fields-v1');await admin('savepoint invalid');await assert.rejects(record(11),/SOURCE_COMPATIBILITY_CONFLICT/);await admin('rollback to savepoint invalid');
 await seed(12);assert.equal((await record(12)).record_supplier_price_source_compatibility_v2.status,'recorded');await batch(12);await stage(12);
 assert.equal((await record(12)).record_supplier_price_source_compatibility_v2.status,'replayed');
}));

test('v2 stages exact null/zero/int/date fields; commit-before-checkpoint replay is immutable; stale owners fenced',()=>rollbackCase(async()=>{
 await seed(20);await record(20);await batch(20);
 assert.equal((await stage(20,rows(),'other')).rows[0].status,'stale');
 const first=(await stage(20)).rows;assert.equal(first[0].staged_rows,2);assert.deepEqual((await stage(20)).rows,first);
 const stored=(await admin('select stock_qty,order_multiple,valid_to::text,commercial_policy from supplier_price_release_rows order by source_row_number')).rows;
 assert.deepEqual(stored,[{stock_qty:0,order_multiple:6,valid_to:date(),commercial_policy:policy},{stock_qty:null,order_multiple:null,valid_to:null,commercial_policy:policy}]);
 // A SQL statement error aborts a transaction; independent savepoints model RPC transactions.
 await db.exec('savepoint invalid');await assert.rejects(stage(20,rows({stock_qty:9})),/retry payload differs/);await db.exec('rollback to savepoint invalid');
}));

test('v2 SQL rejects missing keys, fractions, negatives, overflow and bad dates, without persisting rows',()=>rollbackCase(async()=>{
 await seed(30);await record(30);await batch(30);
 for(const patch of [{stock_qty:-1},{stock_qty:1.2},{stock_qty:2147483648},{stock_qty:'1'},{order_multiple:0},{order_multiple:-1},{order_multiple:2147483648},{valid_to:'2026-02-30'},{valid_to:'2000-01-01'},{valid_to:'infinity'}]){
  await admin('savepoint invalid');await assert.rejects(stage(30,rows(patch)));await admin('rollback to savepoint invalid');
 }
 const absent=rows();delete absent[0].stock_qty;await admin('savepoint invalid');await assert.rejects(stage(30,absent),/ROW_SHAPE/);await admin('rollback to savepoint invalid');
 assert.equal((await admin('select count(*) n from supplier_price_release_rows')).rows[0].n,0);
 assert.equal((await stage(30,rows({stock_qty:2147483647,order_multiple:2147483647,valid_to:'9999-12-31'}))).rows[0].staged_rows,2);
}));

test('old staging cannot bypass v2 policy; v1 old payload replay retains null commercial fields',()=>rollbackCase(async()=>{
 await seed(40);await record(40);await batch(40);await admin('savepoint invalid');await assert.rejects(stage(40,rows(),'owner',false),/V2_STAGE_REQUIRED/);await admin('rollback to savepoint invalid');
 await seed(41);await record(41,'supplier-price-commercial-fields-v1');await batch(41);const oldRows=rows().map(({stock_qty,order_multiple,valid_to,...r})=>r);
 assert.equal((await stage(41,oldRows,'owner',false)).rows[0].staged_rows,2);assert.equal((await stage(41,oldRows,'owner',false)).rows[0].staged_rows,2);
}));

async function commercialPublished(n){
 await seed(n);await admin('update supplier_price_releases set source_date=current_date-10 where id=$1',[id(n)]);await record(n);await batch(n);
 const payload=rows({valid_from:date(-10)});payload[1].valid_to=date(-1);
 await stage(n,payload);
 await admin("update supplier_price_release_rows set row_status='accepted' where release_id=$1",[id(n)]);
 await admin("update supplier_price_releases set status='validated',validated_at=now(),processed_rows=2,current_cursor=2,accepted_rows=2,rejected_rows=0,warning_rows=0,conflict_rows=0 where id=$1",[id(n)]);
 assert.equal((await admin('select supplier_price_ingestion_internal.source_publication_blocker($1) blocker',[id(n)])).rows[0].blocker,null);
 await admin("insert into supplier_price_publications(id,release_id,organization_id,supplier_id,brand_id,status,publication_version,published_at)values($1,$2,$3,$4,$5,'published',1,now())",[id(n+5000),id(n),org,supplier,brand]);
 await admin("update supplier_price_releases set status='published' where id=$1",[id(n)]);
 await admin('insert into supplier_current_price_pointers(organization_id,supplier_id,brand_id,release_id,publication_id)values($1,$2,$3,$4,$5)',[org,supplier,brand,id(n),id(n+5000)]);
}
async function legacy(n,code,{supplierId=supplier,price=1,stock=7,multiple=4,until=null}={}){
 await admin(`insert into supplier_prices(id,organization_id,supplier_id,brand_id,product_code,buy_price,currency,valid_from,is_active,moq,stock_qty,order_multiple,valid_to)
 values($1,$2,$3,$4,$5,$6,'EUR',current_date-10,true,2,$7,$8,$9)`,[id(n),org,supplierId,brand,code,price,stock,multiple,until]);
}
const opts=(code)=>rpc('cloud_current_supplier_commercial_options_service',[org,code,'Brand']);
async function authenticate(){await db.exec("reset role;set role authenticated;select set_config('request.jwt.claim.role','authenticated',false)");}

test('inclusive expiry chooses the remaining current supplier with atomic terms; owned legacy never resurfaces',()=>rollbackCase(async()=>{
 await admin("insert into suppliers(id,organization_id,name)values($1,$2,'Alternative')",[id(9),org]);
 await legacy(500,'CODE1');await legacy(501,'CODE2');await legacy(502,'CODE2',{supplierId:id(9),price:20,stock:8,multiple:5});
 await commercialPublished(50);
 let a=(await opts('CODE1')).rows;assert.equal(a.length,1);assert.equal(a[0].buy_price,'11');assert.equal(a[0].stock_qty,0);assert.equal(a[0].order_multiple,6);assert.equal(a[0].moq,3);assert.equal(new Date(a[0].valid_to).toISOString().slice(0,10),date());
 a=(await opts('CODE2')).rows;assert.equal(a.length,1);assert.equal(a[0].supplier_id,id(9));assert.equal(a[0].buy_price,'20.00');assert.equal(a[0].stock_qty,8);assert.equal(a[0].order_multiple,5);
 await authenticate();const q=(await db.query("select * from cloud_quote_supplier_commercial_options_v3('CODE1','Brand','B',.1,.15)")).rows[0];assert.equal(q.sell_price,'12.65');assert.equal(q.stock_qty,0);assert.equal(q.order_multiple,6);
 // Existing quote/sales/PO callers keep their signature and inherit expiry.
 const old=(await db.query("select * from cloud_resolve_quote_line_v3('CODE2','Brand','A',.1,.15)")).rows[0];assert.equal(old.supplier_id,id(9));assert.equal(old.sell_price,'22.00');
}));

test('raw supplier export/page retain expired terms while Sales and Master current readers agree on eligible prices',()=>rollbackCase(async()=>{
 await admin("insert into suppliers(id,organization_id,name)values($1,$2,'Alternative')",[id(9),org]);
 await legacy(510,'CODE2',{supplierId:id(9),price:20});await commercialPublished(51);
 const raw=(await rpc('cloud_supplier_price_export_commercial_chunk_v3',[org,supplier,brand,'','all',null,null,1000])).rows[0].cloud_supplier_price_export_commercial_chunk_v3;
 assert.equal(raw.length,2);assert.equal(raw[1].valid_to,date(-1));assert.equal(raw[0].order_multiple,6);assert.equal(raw[0].stock_qty,0);
 const second=(await rpc('cloud_supplier_price_export_commercial_chunk_v3',[org,supplier,brand,'','all',raw[0].product_code,raw[0].price_id,1])).rows[0].cloud_supplier_price_export_commercial_chunk_v3;assert.equal(second[0].product_code,'CODE2');assert.equal(second[0].total_count,null);
 const browse=(await rpc('cloud_portal_published_price_search_page_v3',[org,brand,'',24])).rows;assert.deepEqual(browse,[]); // Catalog-backed brands retain the established catalog browse authority.
 const sale=(await rpc('cloud_admin_price_list_page_fast',[org,brand,'A',.1,null,null,1000])).rows;assert.deepEqual(sale.map(r=>[r.product_code,r.sales_price]),[['CODE1','12.10'],['CODE2','22.00']]);
 const master=(await rpc('cloud_catalog_master_export_page_v3',[org,brand,'priced','',null,null,1000,.1,.15])).rows;assert.deepEqual(master.map(r=>[r.product_code,r.cheapest_price]),[['CODE1','11'],['CODE2','20.00']]);
 await authenticate();const ui=(await db.query('select * from cloud_supplier_price_commercial_page_v3($1)',[supplier])).rows;assert.equal(ui.length,2);assert.equal(ui[0].total_count,null);assert.equal(new Date(ui[1].valid_to).toISOString().slice(0,10),date(-1));
 const preview=(await db.query('select cloud_master_published_price_page_v3($1,$2) result',['',brand])).rows[0].result;assert.deepEqual(preview.rows.map(r=>[r.product_code,r.cheapest_price]),[['CODE1',11],['CODE2',20]]);
}));

test('invalid pointers still fence legacy, precise SKU punctuation remains distinct, and source cache sees raw term edits',()=>rollbackCase(async()=>{
 await legacy(520,'61/1',{stock:0,multiple:3});await admin('update supplier_prices set valid_from=current_date-11 where id=$1',[id(520)]);await legacy(521,'611',{stock:9,multiple:7,price:2});
 assert.equal((await opts('61/1')).rows[0].order_multiple,3);assert.equal((await opts('611')).rows[0].order_multiple,7);
 const before=(await rpc('get_supplier_price_export_version',[org,supplier,brand])).rows[0].get_supplier_price_export_version;
 await admin('update supplier_prices set stock_qty=100 where id=$1',[id(520)]);
 const changed=(await rpc('get_supplier_price_export_version',[org,supplier,brand])).rows[0].get_supplier_price_export_version;assert.notEqual(changed,before);
 await commercialPublished(52);await admin("update supplier_price_publications set status='superseded' where id=$1",[id(5052)]);
 assert.deepEqual((await opts('CODE1')).rows,[]);assert.deepEqual((await opts('61/1')).rows,[]);
 const raw=(await rpc('cloud_supplier_price_export_commercial_chunk_v3',[org,supplier,brand,'','all',null,null,1000])).rows[0].cloud_supplier_price_export_commercial_chunk_v3;assert.deepEqual(raw,[]);
}));

test('authenticated supplier pages are org-bound and service commercial options deny browser callers',()=>rollbackCase(async()=>{
 await authenticate();await db.exec('savepoint denied');await assert.rejects(db.query('select * from cloud_current_supplier_commercial_options_service($1,$2,$3)',[org,'CODE1','Brand']),/permission denied/);await db.exec('rollback to savepoint denied');
 await db.exec('savepoint denied');await assert.rejects(db.query('select * from cloud_supplier_price_commercial_page_v3($1)',[id(999)]),/SCOPE_REQUIRED/);await db.exec('rollback to savepoint denied');
 await db.query("select set_config('request.jwt.claim.sub','',false)");assert.deepEqual((await db.query("select * from cloud_quote_supplier_commercial_options_v3('CODE1','Brand')")).rows,[]);
 await db.exec('savepoint denied');await assert.rejects(db.query('select * from cloud_supplier_price_commercial_page_v3($1)',[supplier]),/AUTH_REQUIRED/);await db.exec('rollback to savepoint denied');
}));

test('unchanged NULL commercial terms preserve exact legacy quote projection; v2 source proof cannot be inserted by API roles',()=>rollbackCase(async()=>{
 await legacy(530,'OLD',{stock:null,multiple:null});
 const source=await readFile(dir+'20261013140016_supplier_price_exact_sku_lookup.sql','utf8');const oldCore=source.slice(source.indexOf('create or replace function'),source.indexOf('$function$;')+'$function$;'.length);
 await admin(oldCore);const before=(await rpc('cloud_current_supplier_price_options_service',[org,'OLD','Brand'])).rows;
 const current=await readFile(dir+readers+'.sql','utf8');const start=current.indexOf('create or replace function public.cloud_current_supplier_price_options_core(');const end=current.indexOf('$function$;',start)+'$function$;'.length;
 await admin(current.slice(start,end));assert.deepEqual((await rpc('cloud_current_supplier_price_options_service',[org,'OLD','Brand'])).rows,before);
 const commercial=(await opts('OLD')).rows[0];assert.equal(commercial.stock_qty,null);assert.equal(commercial.order_multiple,null);assert.equal(commercial.valid_to,null);
 for(const role of ['service_role','authenticated','anon']){
  await admin('savepoint denied');await db.exec(`set role ${role}`);await assert.rejects(db.query("insert into supplier_price_ingestion_internal.source_compatibility_receipts(release_id)values($1)",[id(999)]),/permission denied/);await admin('rollback to savepoint denied');
 }
}));

test('actual 1000-row stage commits before checkpoint and exact replay performs no duplicate insertion',async()=>{
 await seed(60);await admin('update supplier_price_releases set total_rows=1000 where id=$1',[id(60)]);
 await admin('update supplier_price_ingestion_internal.handoffs set total_rows=1000 where release_id=$1',[id(60)]);
 const hash=createHash('sha256').update(`fixture/${id(60)}.csv`).digest('hex');await rpc('record_supplier_price_source_compatibility_v2',[id(60),id(3060),hash,1000,policy]);
 await admin("insert into supplier_price_release_batches(id,release_id,batch_number,cursor_start,cursor_end,row_count,status,lease_owner,lease_expires_at)values($1,$2,1,1,1000,1000,'running','owner',now()+interval '2 minutes')",[id(4060),id(60)]);
 const payload=Array.from({length:1000},(_,i)=>({...rows()[0],source_row_number:i+1,product_code:'P'+String(i).padStart(5,'0'),normalized_code:'P'+String(i).padStart(5,'0'),row_hash:createHash('sha256').update(String(i)).digest('hex')}));
 const started=performance.now();assert.equal((await stage(60,payload)).rows[0].staged_rows,1000);const firstMs=performance.now()-started;
 // Each RPC above is autocommit: a lost HTTP/DBOS acknowledgement retries the same persisted payload.
 assert.equal((await stage(60,payload)).rows[0].staged_rows,1000);
 const exact=(await admin('select count(*) n,count(distinct source_row_number) unique_rows,min(stock_qty) stock,max(order_multiple) multiple from supplier_price_release_rows where release_id=$1',[id(60)])).rows[0];assert.deepEqual(exact,{n:1000,unique_rows:1000,stock:0,multiple:6});
 console.log(JSON.stringify({scope:process.env.RUN_SUPPLIER_COMMERCIAL_PG_RUNTIME==='1'?'isolated-postgresql17-0.5cpu-1gb':'pglite',rows:1000,firstStageMilliseconds:Math.round(firstMs),receiptReplayRows:1000,networkMeasured:false}));
});

test('bounded batch options carry atomic terms for legacy and published inputs, with any-pointer ownership',()=>rollbackCase(async()=>{
 await admin("insert into suppliers(id,organization_id,name)values($1,$2,'Alternative')",[id(9),org]);await legacy(540,'LEGACY',{supplierId:id(9),multiple:9});await commercialPublished(61);
 await authenticate();let batch=(await db.query('select * from cloud_current_supplier_price_options_batch($1)',[JSON.stringify([{code:'CODE1',brand:'Brand'},{code:'LEGACY',brand:'Brand'}])])).rows;
 assert.equal(batch[0].options[0].stock_qty,0);assert.equal(batch[0].options[0].order_multiple,6);assert.equal(batch[1].options[0].order_multiple,9);
 await admin("update supplier_price_publications set status='superseded' where id=$1",[id(5061)]);await authenticate();batch=(await db.query('select * from cloud_current_supplier_price_options_batch($1)',[JSON.stringify([{code:'CODE1',brand:'Brand'}])])).rows;
 assert.equal(batch[0].has_published_scope,true);assert.deepEqual(batch[0].options,[]);
}));

test('new price snapshot versions change at date boundary even with only published rows',()=>rollbackCase(async()=>{
 await commercialPublished(62);
 await admin("set local timezone='Pacific/Kiritimati'");const a=(await rpc('get_admin_price_list_export_version',[org,brand])).rows[0].get_admin_price_list_export_version;
 await admin("set local timezone='Etc/GMT+12'");const b=(await rpc('get_admin_price_list_export_version',[org,brand])).rows[0].get_admin_price_list_export_version;
 assert.notEqual(a,b);
}));

test('published-only portal browse excludes expired rows when no governed catalog exists',()=>rollbackCase(async()=>{
 await commercialPublished(63);const browse=(await rpc('cloud_portal_published_price_search_page_v3',[org,brand,'',24])).rows;
 assert.deepEqual(browse.map(r=>r.product_code),['CODE1']);
}));
