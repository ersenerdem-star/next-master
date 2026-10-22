import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomBytes} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import pg from 'pg';
import {createFullReplayDb} from './fixtures/price-engine-full-replay-db.mjs';
import {planSupplierCatalogEnrichment,sourceCatalogFields} from '../../netlify/functions/_shared/catalog/supplier-enrichment-plan.mjs';
import {runSupplierCatalogEnrichment,catalogEnrichmentRpc,supplierCatalogTarget,enrichmentDispatchHeaders,requireEnrichmentDispatch} from '../../netlify/functions/_shared/catalog/supplier-enrichment-worker.mts';
import {safeSupplierOfficialObservation} from '../../netlify/functions/_shared/catalog/supplier-official-completion.mts';
import {fetchZfSupplierCatalogFields} from '../../netlify/functions/_shared/catalog/zf-aftermarket-sync.mts';
const exec=promisify(execFile),id=(n:number)=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const org=id(1),supplier=id(2),brand=id(3),actor=id(4);let db:any,container:string;
const admin=async(q:string,a:any[]=[])=>{if(/^rollback/i.test(q)){await db.query(q,a);return db.exec('reset role');}await db.exec('reset role');return db.query(q,a);};
const rpc=async(name:string,args:Record<string,any>={})=>{
 await db.exec("reset role;set role service_role;select set_config('request.jwt.claim.role','service_role',false)");
 const entries=Object.entries(args);return (await db.query(`select public.${name}(${entries.map(([k],i)=>`${k}=>$${i+1}`).join(',')}) value`,entries.map(([,v])=>typeof v==='object'&&v!==null?JSON.stringify(v):v))).rows[0].value;
};
before(async()=>{
 container=`nm-catalog-enrichment-${process.pid}-${randomBytes(3).toString('hex')}`;const password=randomBytes(24).toString('hex');
 await exec('docker',['run','--detach','--rm','--name',container,'--cpus','1','--memory','1g','--publish','127.0.0.1::5432','--env','POSTGRES_PASSWORD','postgres:17'],{env:{...process.env,POSTGRES_PASSWORD:password}});
 const port=Number((await exec('docker',['port',container,'5432/tcp'])).stdout.trim().match(/:(\d+)$/)![1]);let client:any;
 for(let i=0;i<60;i++){const c=new pg.Client({host:'127.0.0.1',port,user:'postgres',password,connectionTimeoutMillis:1000});try{await c.connect();client=c;break;}catch{await c.end().catch(()=>{});await delay(250);}}
 assert(client);client.exec=(q:string)=>client.query(q);client.close=()=>client.end();db=await createFullReplayDb({db:client});
 const manifest=JSON.parse(await readFile('scripts/ops/price-engine-production-manifest.json','utf8'));
 for(const item of manifest.migration_order)await db.exec(await readFile(item.file,'utf8'));
 await db.exec('set check_function_bodies=true');
 await db.exec('create table if not exists public.catalog_external_sources(organization_id uuid,source_key text,is_active boolean)');
 await db.exec(await readFile('supabase/migrations/20261019162519_supplier_publication_catalog_enrichment.sql','utf8'));
 await db.exec(await readFile('supabase/migrations/20261019170812_supplier_catalog_enrichment_short_transactions.sql','utf8'));
 await db.exec(await readFile('supabase/migrations/20261019171104_supplier_catalog_enrichment_scoped_timeout.sql','utf8'));
 await db.exec(await readFile('supabase/migrations/20261019225659_catalog_enrichment_fair_dispatch.sql','utf8'));
 await db.exec(await readFile('supabase/migrations/20261021095222_supplier_catalog_bounded_source_lanes.sql','utf8'));
 await db.exec(await readFile('supabase/migrations/20261021162624_supplier_catalog_ean_identity_guard.sql','utf8'));
 await db.exec(await readFile('supabase/migrations/20261021162739_supplier_catalog_mandatory_lifecycle_receipts.sql','utf8'));
 await db.exec(await readFile('supabase/migrations/20261021162842_supplier_catalog_bounded_fair_turns.sql','utf8'));
 await db.exec(await readFile('supabase/migrations/20261022092956_catalog_row_review_isolation.sql','utf8'));
 await db.query("insert into organizations(id,name)values($1,'Org')",[org]);
 await db.query("insert into suppliers(id,organization_id,name)values($1,$2,'Supplier')",[supplier,org]);
 await db.query("insert into brands(id,organization_id,name)values($1,$2,'Sachs')",[brand,org]);
 await db.query('insert into auth.users(id)values($1)',[actor]);
 await db.query("insert into profiles(id,organization_id,email,role,is_active)values($1,$2,'test@example.invalid','admin',true)",[actor,org]);
});
after(async()=>{try{await db?.close();}finally{if(container)await exec('docker',['rm','--force',container]).catch(()=>{});}});
async function transaction(fn:()=>Promise<any>){await admin('begin');try{await fn();}finally{await db.exec('rollback;reset role');}}
async function publish(n:number,origin='TR',tariff='0087.08.80',publishBrand=brand,publishSupplier=supplier){
 await admin('update supplier_price_ingestion_internal.catalog_enrichment_control set enabled=true');
 await db.query("insert into supplier_price_releases(id,organization_id,supplier_id,brand_id,status,total_rows,source_date,source_file_sha256,source_file_path,created_by)values($1,$2,$3,$4,'validated',1,'2026-10-19',$5,'fixture/source.csv',$6)",[id(n),org,publishSupplier,publishBrand,n.toString(16).padStart(64,'0'),actor]);
 await db.query("insert into supplier_price_release_rows(release_id,source_row_number,normalized_code,product_code,buy_price,currency,valid_from,row_status,row_hash,origin,tariff,market_segment)values($1,1,'00123','00123',10,'EUR','2026-10-19','accepted',$2,$3,$4,'PC')",[id(n),'b'.repeat(64),origin,tariff]);
 await db.query("insert into supplier_price_publications(id,release_id,organization_id,supplier_id,brand_id,status,publication_version,published_at)values($1,$2,$3,$4,$5,'published',$6,now())",[id(n+1000),id(n),org,publishSupplier,publishBrand,n]);
 await db.query('insert into supplier_current_price_pointers(organization_id,supplier_id,brand_id,publication_id,release_id)values($1,$2,$3,$4,$5) on conflict(organization_id,supplier_id,brand_id)do update set publication_id=excluded.publication_id,release_id=excluded.release_id',[org,publishSupplier,publishBrand,id(n+1000),id(n)]);
}
test('field policy refreshes supplied variable fields and adds identifiers without losing punctuation or old values',()=>{
 const p=planSupplierCatalogEnrichment({existing:{origin:'DE',hs_code:'001234',oem_no:'AA/1; BB2',vehicle_model:'Focus'},incoming:{origin:'TR',hs_code:'0087.08.80',oem_no:'aa/1; CC3',vehicle_model:'Focus; Fiesta',notes:'private',buy_price:2},sourceDate:'2026-10-19'});
 assert.deepEqual(p.patch,{oem_no:'AA/1; BB2; CC3',vehicle_model:'Focus; Fiesta',origin:'TR',hs_code:'0087.08.80'});
 const blank=planSupplierCatalogEnrichment({existing:{origin:'TR',hs_code:'001234'},incoming:{origin:'',hs_code:null}});assert.deepEqual(blank.patch,{});
 const older=planSupplierCatalogEnrichment({existing:{origin:'DE'},incoming:{origin:'TR'},fieldState:{origin:{source_date:'2026-10-19',applied_value:'DE'}},sourceDate:'2026-10-18'});assert.equal(older.issues[0].code,'OLDER_SOURCE');
 const conflict=planSupplierCatalogEnrichment({existing:{},incoming:{origin:'TR'},conflicts:['origin']});assert.deepEqual(conflict.patch,{});
 const official=planSupplierCatalogEnrichment({existing:{origin:'TR',oem_no:'A'},incoming:{origin:'DE',oem_no:'B'},phase:'official'});assert.deepEqual(official.patch,{oem_no:'A; B'});
});
test('official projection rejects fuzzy identities and nonofficial sources and strips images and commercial fields',()=>{
 const v=safeSupplierOfficialObservation({code:'00123',sourceUrl:'https://aftermarket.zf.com/tr/catalog/products/00123',fields:{origin:'TR',image_url:'private',notes:'supplier only',buy_price:10}},'00123',brand);
 assert.deepEqual(v.fields,{origin:'TR'});assert.equal(v.evidence.fingerprint.length,64);
 assert.throws(()=>safeSupplierOfficialObservation({code:'00124',sourceUrl:'https://aftermarket.zf.com',fields:{}},'00123',brand));
 assert.throws(()=>safeSupplierOfficialObservation({code:'00123',sourceUrl:'https://spareto.com',fields:{}},'00123',brand));
});
test('background dispatch is signed, environment-bound and rejects replay with another job or lease',()=>{
 assert.equal(supplierCatalogTarget(()=>undefined),null);
 const env:Record<string,string>={SUPPLIER_CATALOG_ENRICHMENT_ENABLED:'1',SUPABASE_URL:'https://kaxsqafdevabkxofwdod.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'test-service-key'};
 const target=supplierCatalogTarget(k=>env[k])!;const headers=enrichmentDispatchHeaders(target,id(10),id(11));
 const req=new Request(target.portal,{headers});requireEnrichmentDispatch(req,target,id(10),id(11));
 assert.throws(()=>requireEnrichmentDispatch(req,target,id(12),id(11)),/DISPATCH_DENIED/);
 env.NM_PRODUCTION_TARGET='zjgueqijumzlfioihnkt';assert.throws(()=>supplierCatalogTarget(k=>env[k]),/TARGET_DENIED/);
});
test('ZF completion rejects a same-number result carrying another brand',async()=>{
 const original=globalThis.fetch;let calls=0;
 try{
  globalThis.fetch=async()=>{calls++;return new Response(JSON.stringify({products:{items:[{productNumber:'317 851',brandName:'TRW'}]}}),{status:200});};
  await assert.rejects(fetchZfSupplierCatalogFields('Sachs','317851'),/OFFICIAL_EXACT_MATCH_NOT_FOUND/);assert.equal(calls,2);
 }finally{globalThis.fetch=original;}
});
test('publication atomically queues one job; six-column source updates real catalog and unknown official source stays explicit',()=>transaction(async()=>{
 await admin("insert into catalog_products(organization_id,brand_id,product_code,origin,hs_code,oem_no)values($1,$2,'00123','DE','111111','KEEP')",[org,brand]);
 await publish(10);const claim=await rpc('claim_supplier_catalog_enrichment');assert.equal(claim.status,'claimed');
 assert.equal((await rpc('claim_supplier_catalog_enrichment')).status,'empty');
 const result=await runSupplierCatalogEnrichment({rpc,jobId:claim.jobId,token:claim.token,officialProvider:()=>null});
 assert.equal(result.status,'review_required');
 const c=(await admin("select origin,hs_code,oem_no from catalog_products where product_code='00123'")).rows[0];assert.deepEqual(c,{origin:'TR',hs_code:'0087.08.80',oem_no:'KEEP'});
 const j=(await admin('select processed_rows,phase,status,error_code from supplier_price_ingestion_internal.catalog_enrichment_jobs')).rows[0];assert.equal(Number(j.processed_rows),1);assert.equal(j.error_code,'OFFICIAL_SOURCE_NOT_CONFIGURED');
 const audit=(await db.query('select before_values,patch,evidence from supplier_price_ingestion_internal.catalog_enrichment_changes')).rows[0];assert.equal(audit.before_values.origin,'DE');assert.equal(audit.patch.origin,'TR');assert.equal(audit.evidence.sourceSha256,10 .toString(16).padStart(64,'0'));
}));
test('official completion runs after file projection and cannot overwrite file origin or tariff',()=>transaction(async()=>{
 await publish(20);const claim=await rpc('claim_supplier_catalog_enrichment');let calls=0;
 await runSupplierCatalogEnrichment({rpc,jobId:claim.jobId,token:claim.token,officialProvider:()=>({key:'zf',fetch:async(code:string)=>{calls++;return {code,sourceUrl:'https://aftermarket.zf.com/tr/catalog/products/00123',fields:{origin:'DE',hs_code:'999999',description:'Shock absorber',oem_no:'OEM-1',vehicle:'Ford',vehicle_model:'Focus',ean:'0123456789012',weight_kg:1,dimensions:{length_mm:20}}};}})});
 const c=(await admin("select origin,hs_code,oem_no,description,ean from catalog_products where product_code='00123'")).rows[0];assert.equal(c.origin,'TR');assert.equal(c.hs_code,'0087.08.80');assert.equal(c.oem_no,'OEM-1');assert.equal(c.ean,'0123456789012');assert.equal(calls,1);
 assert.equal((await db.query('select status from supplier_price_ingestion_internal.catalog_enrichment_jobs')).rows[0].status,'completed'); // Optional Description_TR is not fabricated or required.
}));
test('superseded publications and expired leases cannot mutate catalog; response-loss retries cannot double apply',()=>transaction(async()=>{
 await publish(30);const claim=await rpc('claim_supplier_catalog_enrichment');const scope={input_job_id:claim.jobId,input_token:claim.token};
 const batch=await rpc('read_supplier_catalog_enrichment_batch',scope),row=batch.rows[0];const plan=planSupplierCatalogEnrichment({incoming:sourceCatalogFields(row.source)});
 const args={...scope,input_phase:'file',input_cursor:0,input_rows:[{rowNumber:1,existing:{},patch:plan.patch,issues:[],evidence:{},missing:false}]};
 assert.equal((await rpc('apply_supplier_catalog_enrichment_batch',args)).status,'applied');
 await admin('savepoint duplicate');await assert.rejects(rpc('apply_supplier_catalog_enrichment_batch',args),/CURSOR_CHANGED/);await admin('rollback to savepoint duplicate');
 await publish(31,'DE');assert.equal((await rpc('read_supplier_catalog_enrichment_batch',scope)).status,'superseded');
 const second=await rpc('claim_supplier_catalog_enrichment');await admin("update supplier_price_ingestion_internal.catalog_enrichment_jobs set lease_until=now()-interval '1 second' where id=$1",[second.jobId]);
 await admin('savepoint expired');await assert.rejects(rpc('read_supplier_catalog_enrichment_batch',{input_job_id:second.jobId,input_token:second.token}),/LEASE_LOST/);await admin('rollback to savepoint expired');
}));
test('catalog mutation endpoints are service-only and field ledger is private',()=>transaction(async()=>{
 const acl=(await admin("select has_function_privilege('anon','claim_supplier_catalog_enrichment()','execute') anon,has_function_privilege('authenticated','apply_supplier_catalog_enrichment_batch(uuid,uuid,text,bigint,jsonb)','execute') mutate,has_table_privilege('service_role','supplier_price_ingestion_internal.catalog_enrichment_fields','insert') direct_insert")).rows[0];assert.deepEqual(acl,{anon:false,mutate:false,direct_insert:false});
}));
test('a catalog edit between read and commit is retained and cannot be overwritten by a stale snapshot',()=>transaction(async()=>{
 await admin("insert into catalog_products(organization_id,brand_id,product_code,origin)values($1,$2,'00123','DE')",[org,brand]);
 await publish(35);const claim=await rpc('claim_supplier_catalog_enrichment'),scope={input_job_id:claim.jobId,input_token:claim.token};
 const b=await rpc('read_supplier_catalog_enrichment_batch',scope),r=b.rows[0];
 await admin("update catalog_products set origin='JP' where product_code='00123'");
 const held=await rpc('apply_supplier_catalog_enrichment_batch',{...scope,input_phase:'file',input_cursor:0,input_rows:[{rowNumber:1,existing:r.existing,patch:{origin:'TR'},issues:[],evidence:{}}]});assert.equal(held.held,1);
 assert.equal((await db.query("select origin from catalog_products where product_code='00123'")).rows[0].origin,'JP');
 assert.equal(Number((await admin('select cursor from supplier_price_ingestion_internal.catalog_enrichment_jobs')).rows[0].cursor),1);
 assert.equal((await admin('select issues from supplier_price_ingestion_internal.catalog_enrichment_changes')).rows[0].issues[0].code,'CATALOG_ENRICHMENT_PRODUCT_CHANGED');
}));

test('a transient official failure preserves file progress and records its exact source row and reason',()=>transaction(async()=>{
 await publish(40);const claim=await rpc('claim_supplier_catalog_enrichment');
 await assert.rejects(runSupplierCatalogEnrichment({rpc,jobId:claim.jobId,token:claim.token,officialProvider:()=>({key:'zf',fetch:async()=>{throw Error('HTTP 429');}})}),/UNCONFIRMED/);
 const j=(await admin('select phase,status,processed_rows,error_code,error_source_row,error_provider from supplier_price_ingestion_internal.catalog_enrichment_jobs')).rows[0];
 assert.equal(j.phase,'official');assert.equal(j.status,'queued');assert.equal(Number(j.processed_rows),1);assert.equal(j.error_code,'OFFICIAL_SOURCE_RATE_LIMIT');assert.equal(Number(j.error_source_row),1);assert.equal(j.error_provider,'zf');
 assert.equal((await db.query("select origin from catalog_products where product_code='00123'")).rows[0].origin,'TR');
}));

test('1000 source rows complete in bounded commits with exact tariffs and persisted field evidence',()=>transaction(async()=>{
 await publish(50);await admin('update supplier_price_releases set total_rows=1000 where id=$1',[id(50)]);
 await db.query("insert into supplier_price_release_rows(release_id,source_row_number,normalized_code,product_code,buy_price,currency,valid_from,row_status,row_hash,origin,tariff,market_segment)select $1,n,lpad(n::text,8,'0'),lpad(n::text,8,'0'),10,'EUR','2026-10-19','accepted',repeat('c',64),'TR','00870880','PC' from generate_series(2,1000)n",[id(50)]);
 await db.query('update supplier_price_ingestion_internal.catalog_enrichment_jobs set total_rows=1000');
 const claim=await rpc('claim_supplier_catalog_enrichment'),start=Date.now();
 const commits:number[]=[];
 await runSupplierCatalogEnrichment({rpc:async(name,args)=>{if(name==='apply_supplier_catalog_enrichment_batch'&&args?.input_phase==='file')commits.push(args.input_rows.length);return rpc(name,args);},jobId:claim.jobId,token:claim.token,officialProvider:()=>null});
 assert.equal(commits.length,10);assert.ok(commits.every(n=>n<=100));
 const counts=(await admin("select count(*) count,count(*)filter(where origin='TR') tr,count(*)filter(where hs_code in ('00870880','0087.08.80')) tariffs from catalog_products")).rows[0];assert.equal(Number(counts.count),1000);assert.equal(Number(counts.tr),1000);assert.equal(Number(counts.tariffs),1000);
 assert.equal(Number((await db.query('select processed_rows from supplier_price_ingestion_internal.catalog_enrichment_jobs')).rows[0].processed_rows),1000);
 console.log(JSON.stringify({localPostgresRows:1000,elapsedMs:Date.now()-start,productionPerformanceProven:false}));
}));


test('catalog write timeout is bounded and scoped to the service-only RPC',async()=>{
 const r=(await admin("select proconfig,has_function_privilege('anon',oid,'execute') anon,has_function_privilege('authenticated',oid,'execute') client,has_function_privilege('service_role',oid,'execute') worker from pg_proc where oid='public.apply_supplier_catalog_enrichment_batch(uuid,uuid,text,bigint,jsonb)'::regprocedure")).rows[0];
 assert.ok(r.proconfig.includes('statement_timeout=20s'));assert.equal(r.anon,false);assert.equal(r.client,false);assert.equal(r.worker,true);
});

test('database timeouts retain a safe actionable reason without exposing database details',async()=>{
 const original=globalThis.fetch;
 try{
  globalThis.fetch=async()=>new Response(JSON.stringify({code:'57014',message:'private database details'}),{status:500});
  await assert.rejects(catalogEnrichmentRpc({url:'https://example.invalid',key:'test',portal:'https://example.invalid'})('apply_supplier_catalog_enrichment_batch'),/CATALOG_ENRICHMENT_DATABASE_TIMEOUT/);
  globalThis.fetch=async()=>new Response(JSON.stringify({code:'XX000',message:'private database details'}),{status:500});
  await assert.rejects(catalogEnrichmentRpc({url:'https://example.invalid',key:'test',portal:'https://example.invalid'})('apply_supplier_catalog_enrichment_batch'),/CATALOG_ENRICHMENT_RPC_UNCONFIRMED/);
 }finally{globalThis.fetch=original;}
});

test('official row success is durably committed before a later source failure',()=>transaction(async()=>{
 await publish(60);await admin('update supplier_price_releases set total_rows=2 where id=$1',[id(60)]);
 await db.query("insert into supplier_price_release_rows(release_id,source_row_number,normalized_code,product_code,buy_price,currency,valid_from,row_status,row_hash)values($1,2,'00234','00234',10,'EUR','2026-10-19','accepted',repeat('d',64))",[id(60)]);
 await admin('update supplier_price_ingestion_internal.catalog_enrichment_jobs set total_rows=2');
 const claim=await rpc('claim_supplier_catalog_enrichment');let calls=0;
 await assert.rejects(runSupplierCatalogEnrichment({rpc,jobId:claim.jobId,token:claim.token,officialDelayMs:0,officialProvider:()=>({key:'zf',fetch:async(code:string)=>{
 if(++calls===2)throw Error('HTTP 503');return {code,sourceUrl:'https://aftermarket.zf.com/api/articles/'+code,fields:{description:'Verified first row'}};
 }})}),/UNCONFIRMED/);
 const j=(await admin('select phase,cursor,error_source_row from supplier_price_ingestion_internal.catalog_enrichment_jobs')).rows[0];assert.equal(j.phase,'official');assert.equal(Number(j.cursor),1);assert.equal(Number(j.error_source_row),2);
 assert.equal((await db.query("select description from catalog_products where product_code='00123'")).rows[0].description,'Verified first row');
 assert.equal(Number((await db.query("select count(*) n from supplier_price_ingestion_internal.catalog_enrichment_changes where phase='official'")).rows[0].n),1);
}));

test('connector implementation failures are distinguished from official source outages',()=>transaction(async()=>{
 await publish(70);const claim=await rpc('claim_supplier_catalog_enrichment');
 await assert.rejects(runSupplierCatalogEnrichment({rpc,jobId:claim.jobId,token:claim.token,officialDelayMs:0,officialProvider:()=>({key:'zf',fetch:async()=>{throw new ReferenceError('dependency is not defined');}})}));
 const j=(await admin('select error_code,cursor,phase from supplier_price_ingestion_internal.catalog_enrichment_jobs')).rows[0];assert.equal(j.error_code,'OFFICIAL_PROVIDER_IMPLEMENTATION_ERROR');assert.equal(j.phase,'official');assert.equal(Number(j.cursor),0);
}));

test('Denso runs beside the shared ZF queue with two global slots, one job per source and fenced expired workers',()=>transaction(async()=>{
 const denso=id(800),trw=id(801),secondSupplier=id(802);
 await admin("insert into brands(id,organization_id,name)values($1,$3,'Denso'),($2,$3,'TRW')",[denso,trw,org]);
 await db.query("insert into suppliers(id,organization_id,name)values($1,$2,'Second supplier')",[secondSupplier,org]);
 await publish(80);await publish(81,'TR','0087.08.80',trw);await publish(82,'TR','0087.08.80',denso);await publish(83,'TR','0087.08.80',denso,secondSupplier);
 await admin("update supplier_price_ingestion_internal.catalog_enrichment_jobs j set phase='official',processed_rows=1,updated_at='2026-01-01'::timestamptz+(select publication_version from supplier_price_publications p where p.id=j.publication_id)*interval '1 second'");
 const before=(await db.query('select * from supplier_current_price_pointers order by brand_id,supplier_id')).rows;
 const shared=await rpc('claim_supplier_catalog_enrichment'),independent=await rpc('claim_supplier_catalog_enrichment');
 assert.equal(shared.releaseId,id(80));assert.equal(independent.releaseId,id(82));assert.equal((await rpc('claim_supplier_catalog_enrichment')).status,'empty');
 await rpc('release_supplier_catalog_enrichment',{input_job_id:independent.jobId,input_token:independent.token});
 assert.equal((await rpc('claim_supplier_catalog_enrichment')).releaseId,id(83));
 await admin("update supplier_price_ingestion_internal.catalog_enrichment_jobs set lease_until=clock_timestamp()-interval '1 second' where id=$1",[shared.jobId]);
 const nextZf=await rpc('claim_supplier_catalog_enrichment');assert.equal(nextZf.releaseId,id(81));
 await admin('savepoint expired_claim');
 await assert.rejects(rpc('read_supplier_catalog_enrichment_batch',{input_job_id:shared.jobId,input_token:shared.token}),/LEASE_LOST/);
 await db.exec('rollback to savepoint expired_claim;reset role');
 assert.equal((await rpc('claim_supplier_catalog_enrichment')).status,'empty');
 assert.deepEqual((await admin('select * from supplier_current_price_pointers order by brand_id,supplier_id')).rows,before);
}));

test('new file projection drains running official work and stays globally exclusive',()=>transaction(async()=>{
 const denso=id(810);await admin("insert into brands(id,organization_id,name)values($1,$2,'Denso')",[denso,org]);
 await publish(90);await admin("update supplier_price_ingestion_internal.catalog_enrichment_jobs set phase='official',processed_rows=1");
 const shared=await rpc('claim_supplier_catalog_enrichment');await publish(91,'TR','0087.08.80',denso);
 assert.equal((await rpc('claim_supplier_catalog_enrichment')).status,'empty');
 await rpc('release_supplier_catalog_enrichment',{input_job_id:shared.jobId,input_token:shared.token});
 const file=await rpc('claim_supplier_catalog_enrichment');assert.equal(file.releaseId,id(91));assert.equal(file.phase,'file');
 assert.equal((await rpc('claim_supplier_catalog_enrichment')).status,'empty');
}));

test('bounded source dispatch retains the existing service-only admission grant',async()=>{
 const row=(await admin("select has_function_privilege('anon',oid,'execute') anon,has_function_privilege('authenticated',oid,'execute') client,has_function_privilege('service_role',oid,'execute') worker from pg_proc where oid='public.claim_supplier_catalog_enrichment()'::regprocedure")).rows[0];
 assert.deepEqual(row,{anon:false,client:false,worker:true});
});

test('an unsupported product domain is explicit review evidence and does not stop later source rows',()=>transaction(async()=>{
 const skf=id(820);await admin("insert into brands(id,organization_id,name)values($1,$2,'SKF')",[skf,org]);
 await publish(95,'TR','0087.08.80',skf);await admin('update supplier_price_releases set total_rows=2 where id=$1',[id(95)]);
 await db.query("insert into supplier_price_release_rows(release_id,source_row_number,normalized_code,product_code,buy_price,currency,valid_from,row_status,row_hash)values($1,2,'00234','00234',10,'EUR','2026-10-19','accepted',repeat('e',64))",[id(95)]);
 await admin('update supplier_price_ingestion_internal.catalog_enrichment_jobs set total_rows=2');
 const claim=await rpc('claim_supplier_catalog_enrichment');
 await runSupplierCatalogEnrichment({rpc,jobId:claim.jobId,token:claim.token,officialDelayMs:0,officialProvider:()=>({key:'skf_automotive_official',fetch:async(code:string)=>{
  if(code==='00123')throw Error('OFFICIAL_PRODUCT_DOMAIN_UNSUPPORTED');return {code,sourceUrl:'https://automotive.skf.com/eur/en/product-catalogue/'+code,fields:{description:'Wheel Bearing Kit'}};
 }})});
 const j=(await admin('select cursor,official_checked,review_rows,status,error_code from supplier_price_ingestion_internal.catalog_enrichment_jobs')).rows[0];
 assert.equal(Number(j.cursor),2);assert.equal(Number(j.official_checked),2);assert.equal(Number(j.review_rows),1);assert.equal(j.status,'review_required');assert.equal(j.error_code,null);
 const issues=(await db.query("select issues from supplier_price_ingestion_internal.catalog_enrichment_changes where phase='official' and source_row_number=1")).rows[0].issues;
 assert.deepEqual(issues,[{field:'source',code:'OFFICIAL_PRODUCT_DOMAIN_UNSUPPORTED'}]);
 assert.equal((await db.query("select description from catalog_products where product_code='00234'")).rows[0].description,'Wheel Bearing Kit');
}));


test('official EAN conflict holds all metadata in the planner',()=>{
 const p=planSupplierCatalogEnrichment({phase:'official',existing:{ean:'1234567890123'},incoming:{ean:'9999999999999',description:'Wrong identity',weight_kg:2,oem_no:'WRONG'}});
 assert.deepEqual(p.patch,{});assert.deepEqual(p.issues,[{field:'ean',code:'EAN_IDENTITY_CONFLICT'}]);
 const equal=planSupplierCatalogEnrichment({phase:'official',existing:{ean:'1234567890123'},incoming:{ean:' 1234567890123 ',weight_kg:2}});assert.equal(equal.patch.weight_kg,2);
});

test('the database holds conflicting source EAN even if the worker incorrectly proposes a patch',()=>transaction(async()=>{
 await publish(110);const claim=await rpc('claim_supplier_catalog_enrichment');
 await admin("insert into catalog_products(organization_id,brand_id,product_code,ean)values($1,$2,'00123','1234567890123')",[org,brand]);
 await admin("update supplier_price_ingestion_internal.catalog_enrichment_jobs set phase='official',cursor=0 where id=$1",[claim.jobId]);
 const scope={input_job_id:claim.jobId,input_token:claim.token};const row=(await rpc('read_supplier_catalog_enrichment_batch',scope)).rows[0];
 const evidence=safeSupplierOfficialObservation({code:'00123',sourceUrl:'https://aftermarket.zf.com/api/articles/00123',fields:{ean:'9999999999999',description:'Wrong identity'}},'00123',brand).evidence;
 const pointers=(await admin('select * from supplier_current_price_pointers')).rows;
 await rpc('apply_supplier_catalog_enrichment_batch',{...scope,input_phase:'official',input_cursor:0,input_rows:[{rowNumber:1,existing:row.existing,patch:{description:'Wrong identity',weight_kg:2,oem_no:'WRONG'},issues:[],evidence}]});
 const product=(await admin("select ean,description,weight_kg,oem_no from catalog_products where product_code='00123'")).rows[0];assert.equal(product.ean,'1234567890123');assert.equal(product.description,null);assert.equal(product.weight_kg,null);assert.equal(product.oem_no,null);
 const change=(await db.query("select patch,issues,evidence from supplier_price_ingestion_internal.catalog_enrichment_changes where phase='official'")).rows[0];assert.deepEqual(change.patch,{});assert.deepEqual(change.issues,[{field:'ean',code:'EAN_IDENTITY_CONFLICT'}]);assert.equal(change.evidence.sourceEan,'9999999999999');
 assert.deepEqual((await admin('select * from supplier_current_price_pointers')).rows,pointers);
}));


test('metadata-complete products still obtain a source request and mandatory lifecycle receipt',()=>transaction(async()=>{
 await publish(120);await admin("insert into catalog_products(organization_id,brand_id,product_code,description,oem_no,vehicle,vehicle_model,ean,weight_kg,origin,hs_code,market_segment)values($1,$2,'00123','Existing','OE1','VW','Model1','1234567890123',1,'TR','0087.08.80','pc')",[org,brand]);
 const before=(await admin("select to_jsonb(c) v from catalog_products c where product_code='00123'")).rows[0].v;
 const claim=await rpc('claim_supplier_catalog_enrichment');let calls=0;
 await runSupplierCatalogEnrichment({rpc,jobId:claim.jobId,token:claim.token,officialDelayMs:0,officialProvider:()=>({key:'zf',fetch:async(code:string)=>{calls++;return {code,sourceUrl:'https://aftermarket.zf.com/api/articles/'+code,fields:{ean:'1234567890123'},sourceStatus:'Production discontinued',replacementCandidates:{replacedBy:['00234']}};}})});
 assert.equal(calls,1);const proof=(await admin("select evidence from supplier_price_ingestion_internal.catalog_enrichment_changes where phase='official'")).rows[0].evidence;assert.equal(proof.lifecycle.checks.discontinued,'found');assert.equal(proof.lifecycle.checks.replacement,'review_required');
 const counts=(await db.query('select official_requested,lifecycle_recorded,coverage_start_row from supplier_price_ingestion_internal.catalog_enrichment_jobs')).rows[0];assert.equal(Number(counts.official_requested),1);assert.equal(Number(counts.lifecycle_recorded),1);assert.equal(Number(counts.coverage_start_row),1);
 const after=(await db.query("select to_jsonb(c) v from catalog_products c where product_code='00123'")).rows[0].v;delete before.updated_at;delete after.updated_at;assert.deepEqual(after,before);
}));


test('a large file yields a bounded official turn without concurrent file writes or cursor resets',()=>transaction(async()=>{
 const denso=id(850);await admin("insert into brands(id,organization_id,name)values($1,$2,'Denso')",[denso,org]);
 await publish(130);await publish(131,'TR','0087.08.80',denso);
 await admin("update supplier_price_ingestion_internal.catalog_enrichment_jobs set phase='official',processed_rows=1,cursor=0 where release_id=$1",[id(131)]);
 const file=await rpc('claim_supplier_catalog_enrichment');assert.equal(file.releaseId,id(130));assert.equal(file.phase,'file');assert.equal((await rpc('claim_supplier_catalog_enrichment')).status,'empty');
 await rpc('release_supplier_catalog_enrichment',{input_job_id:file.jobId,input_token:file.token});
 const official=await rpc('claim_supplier_catalog_enrichment');assert.equal(official.releaseId,id(131));assert.equal(official.phase,'official');assert.equal((await rpc('claim_supplier_catalog_enrichment')).status,'empty');
 assert.equal((await rpc('read_supplier_catalog_enrichment_batch',{input_job_id:official.jobId,input_token:official.token})).turnBudgetMs,60000);
 await rpc('release_supplier_catalog_enrichment',{input_job_id:official.jobId,input_token:official.token});
 const nextFile=await rpc('claim_supplier_catalog_enrichment');assert.equal(nextFile.jobId,file.jobId);assert.equal(nextFile.phase,'file');assert.notEqual(nextFile.token,file.token);
 assert.equal(Number((await admin('select cursor from supplier_price_ingestion_internal.catalog_enrichment_jobs where id=$1',[file.jobId])).rows[0].cursor),0);
}));

test('an oversized existing article is held while the preceding and following source rows commit once',()=>transaction(async()=>{
 await publish(150);await admin('update supplier_price_releases set total_rows=3 where id=$1',[id(150)]);
 await admin("insert into supplier_price_release_rows(release_id,source_row_number,normalized_code,product_code,buy_price,currency,valid_from,row_status,row_hash,origin)select $1,n,case n when 2 then '00234' else '00345' end,case n when 2 then '00234' else '00345' end,10,'EUR','2026-10-19','accepted',repeat('a',64),'TR' from generate_series(2,3)n",[id(150)]);
 await admin('update supplier_price_ingestion_internal.catalog_enrichment_jobs set total_rows=3');
 await admin("insert into catalog_products(organization_id,brand_id,product_code,origin,oem_no)values($1,$2,'00234','DE',repeat('LONG-OEM; ',9000))",[org,brand]);
 const before=(await admin("select to_jsonb(p) p from catalog_products p where product_code='00234'")).rows[0].p;
 const pointers=(await admin('select * from supplier_current_price_pointers')).rows;
 const prices=(await admin('select product_code,buy_price from supplier_price_release_rows order by source_row_number')).rows;
 const claim=await rpc('claim_supplier_catalog_enrichment');await runSupplierCatalogEnrichment({rpc,jobId:claim.jobId,token:claim.token,officialProvider:()=>null});
 assert.deepEqual((await admin("select to_jsonb(p) p from catalog_products p where product_code='00234'")).rows[0].p,before);
 assert.equal((await db.query("select count(*)::int n from catalog_products where product_code in('00123','00345') and origin='TR'")).rows[0].n,2);
 const audit=(await db.query("select source_row_number,patch,issues,evidence from supplier_price_ingestion_internal.catalog_enrichment_changes where phase='file' order by source_row_number")).rows;
 assert.equal(audit.length,3);assert.equal(audit[1].issues[0].code,'CATALOG_ENRICHMENT_RECORD_TOO_LARGE');assert.deepEqual(audit[1].patch,{});
 assert(audit[1].evidence.entryBytes>64000);assert.equal(audit[1].evidence.entryFingerprint.length,64);assert(JSON.stringify(audit[1]).length<3000);
 const j=(await db.query('select processed_rows,review_rows,changed_products,status from supplier_price_ingestion_internal.catalog_enrichment_jobs')).rows[0];
 assert.equal(Number(j.processed_rows),3);assert.equal(Number(j.review_rows),1);assert.equal(Number(j.changed_products),2);assert.equal(j.status,'review_required');
 assert.deepEqual((await admin('select * from supplier_current_price_pointers')).rows,pointers);
 assert.deepEqual((await admin('select product_code,buy_price from supplier_price_release_rows order by source_row_number')).rows,prices);
}));

test('a malformed product patch enters review without creating a blank product or bypassing prefix and lease gates',()=>transaction(async()=>{
 await publish(160);await admin('update supplier_price_releases set total_rows=2 where id=$1',[id(160)]);
 await admin("insert into supplier_price_release_rows(release_id,source_row_number,normalized_code,product_code,buy_price,currency,valid_from,row_status,row_hash)values($1,2,'00234','00234',10,'EUR','2026-10-19','accepted',repeat('a',64))",[id(160)]);
 await admin('update supplier_price_ingestion_internal.catalog_enrichment_jobs set total_rows=2');
 const claim=await rpc('claim_supplier_catalog_enrichment'),scope={input_job_id:claim.jobId,input_token:claim.token};
 const rows=[{rowNumber:1,existing:{},patch:{origin:null},issues:[],evidence:{}},{rowNumber:2,existing:{},patch:{origin:'TR'},issues:[],evidence:{}}];
 const result=await rpc('apply_supplier_catalog_enrichment_batch',{...scope,input_phase:'file',input_cursor:0,input_rows:rows});assert.equal(result.held,1);assert.equal(Number(result.cursor),2);
 assert.equal((await admin("select count(*)::int n from catalog_products where product_code='00123'")).rows[0].n,0);
 assert.equal((await db.query("select origin from catalog_products where product_code='00234'")).rows[0].origin,'TR');
 assert.equal((await db.query("select issues from supplier_price_ingestion_internal.catalog_enrichment_changes where source_row_number=1")).rows[0].issues[0].code,'CATALOG_ENRICHMENT_ROW_INVALID');
 await admin('savepoint repeated');await assert.rejects(rpc('apply_supplier_catalog_enrichment_batch',{...scope,input_phase:'file',input_cursor:0,input_rows:rows}),/CURSOR_CHANGED/);await admin('rollback to savepoint repeated');
 await admin('savepoint bad_reason');await assert.rejects(rpc('hold_supplier_catalog_enrichment_product',{...scope,input_phase:'file',input_cursor:2,input_row:{rowNumber:3},input_reason:'OFFICIAL_SOURCE_ACCESS_DENIED'}),/HOLD_REASON_INVALID/);await admin('rollback to savepoint bad_reason');
 await admin('savepoint missing_reason');await assert.rejects(rpc('hold_supplier_catalog_enrichment_product',{...scope,input_phase:'file',input_cursor:2,input_row:{rowNumber:3},input_reason:null}),/HOLD_REASON_INVALID/);await admin('rollback to savepoint missing_reason');
 await admin('savepoint wrong_prefix');await assert.rejects(rpc('hold_supplier_catalog_enrichment_product',{...scope,input_phase:'file',input_cursor:2,input_row:{rowNumber:999},input_reason:'CATALOG_ENRICHMENT_PATCH_INVALID'}),/PREFIX_INVALID/);await admin('rollback to savepoint wrong_prefix');
 await admin('savepoint wrong_lease');await assert.rejects(rpc('hold_supplier_catalog_enrichment_product',{...scope,input_token:id(99999),input_phase:'file',input_cursor:2,input_row:{rowNumber:3},input_reason:'CATALOG_ENRICHMENT_PATCH_INVALID'}),/LEASE_LOST/);await admin('rollback to savepoint wrong_lease');
 const grants=(await admin("select has_function_privilege('anon','hold_supplier_catalog_enrichment_product(uuid,uuid,text,bigint,jsonb,text)','execute') anon,has_function_privilege('authenticated','hold_supplier_catalog_enrichment_product(uuid,uuid,text,bigint,jsonb,text)','execute') client,has_function_privilege('service_role','supplier_price_ingestion_internal.apply_supplier_catalog_enrichment_batch_strict(uuid,uuid,text,bigint,jsonb)','execute') bypass")).rows[0];assert.deepEqual(grants,{anon:false,client:false,bypass:false});
}));

test('one ambiguous official article is held with lifecycle coverage while the next exact article completes',()=>transaction(async()=>{
 await publish(170);await admin('update supplier_price_releases set total_rows=2 where id=$1',[id(170)]);
 await admin("insert into supplier_price_release_rows(release_id,source_row_number,normalized_code,product_code,buy_price,currency,valid_from,row_status,row_hash)values($1,2,'00234','00234',10,'EUR','2026-10-19','accepted',repeat('a',64))",[id(170)]);
 await admin('update supplier_price_ingestion_internal.catalog_enrichment_jobs set total_rows=2');
 const claim=await rpc('claim_supplier_catalog_enrichment');
 await runSupplierCatalogEnrichment({rpc,jobId:claim.jobId,token:claim.token,officialDelayMs:0,officialProvider:()=>({key:'zf',fetch:async(code:string)=>{
  if(code==='00123')throw Error('OFFICIAL_EXACT_MATCH_AMBIGUOUS');return {code,sourceUrl:'https://aftermarket.zf.com/api/articles/'+code,fields:{description:'Shock absorber'}};
 }})});
 const j=(await admin('select cursor,review_rows,official_checked,official_requested,lifecycle_recorded,status from supplier_price_ingestion_internal.catalog_enrichment_jobs')).rows[0];
 assert.equal(Number(j.cursor),2);assert.equal(Number(j.review_rows),1);assert.equal(Number(j.official_checked),2);assert.equal(Number(j.official_requested),2);assert.equal(Number(j.lifecycle_recorded),2);assert.equal(j.status,'review_required');
 const audit=(await db.query("select issues,evidence from supplier_price_ingestion_internal.catalog_enrichment_changes where phase='official' and source_row_number=1")).rows[0];
 assert.equal(audit.issues[0].code,'OFFICIAL_EXACT_MATCH_AMBIGUOUS');assert.equal(audit.evidence.lifecycle.checks.replacement,'blocked');assert.equal(audit.evidence.lifecycle.checks.discontinued,'blocked');
 assert.equal((await db.query("select description from catalog_products where product_code='00234'")).rows[0].description,'Shock absorber');
}));
