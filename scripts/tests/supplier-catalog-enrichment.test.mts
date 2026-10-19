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
 await db.exec(await readFile('supabase/migrations/20261019162519_supplier_publication_catalog_enrichment.sql','utf8'));
 await db.exec(await readFile('supabase/migrations/20261019170812_supplier_catalog_enrichment_short_transactions.sql','utf8'));
 await db.query("insert into organizations(id,name)values($1,'Org')",[org]);
 await db.query("insert into suppliers(id,organization_id,name)values($1,$2,'Supplier')",[supplier,org]);
 await db.query("insert into brands(id,organization_id,name)values($1,$2,'Sachs')",[brand,org]);
 await db.query('insert into auth.users(id)values($1)',[actor]);
 await db.query("insert into profiles(id,organization_id,email,role,is_active)values($1,$2,'test@example.invalid','admin',true)",[actor,org]);
});
after(async()=>{try{await db?.close();}finally{if(container)await exec('docker',['rm','--force',container]).catch(()=>{});}});
async function transaction(fn:()=>Promise<any>){await admin('begin');try{await fn();}finally{await db.exec('rollback;reset role');}}
async function publish(n:number,origin='TR',tariff='0087.08.80'){
 await admin('update supplier_price_ingestion_internal.catalog_enrichment_control set enabled=true');
 await db.query("insert into supplier_price_releases(id,organization_id,supplier_id,brand_id,status,total_rows,source_date,source_file_sha256,source_file_path,created_by)values($1,$2,$3,$4,'validated',1,'2026-10-19',$5,'fixture/source.csv',$6)",[id(n),org,supplier,brand,n.toString(16).padStart(64,'0'),actor]);
 await db.query("insert into supplier_price_release_rows(release_id,source_row_number,normalized_code,product_code,buy_price,currency,valid_from,row_status,row_hash,origin,tariff,market_segment)values($1,1,'00123','00123',10,'EUR','2026-10-19','accepted',$2,$3,$4,'PC')",[id(n),'b'.repeat(64),origin,tariff]);
 await db.query("insert into supplier_price_publications(id,release_id,organization_id,supplier_id,brand_id,status,publication_version,published_at)values($1,$2,$3,$4,$5,'published',$6,now())",[id(n+1000),id(n),org,supplier,brand,n]);
 await db.query('insert into supplier_current_price_pointers(organization_id,supplier_id,brand_id,publication_id,release_id)values($1,$2,$3,$4,$5) on conflict(organization_id,supplier_id,brand_id)do update set publication_id=excluded.publication_id,release_id=excluded.release_id',[org,supplier,brand,id(n+1000),id(n)]);
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
  await assert.rejects(fetchZfSupplierCatalogFields('Sachs','317851'),/OFFICIAL_EXACT_MATCH_NOT_FOUND/);assert.equal(calls,1);
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
 await admin('savepoint stale');await assert.rejects(rpc('apply_supplier_catalog_enrichment_batch',{...scope,input_phase:'file',input_cursor:0,input_rows:[{rowNumber:1,existing:r.existing,patch:{origin:'TR'},issues:[],evidence:{}}]}),/PRODUCT_CHANGED/);await admin('rollback to savepoint stale');
 assert.equal((await db.query("select origin from catalog_products where product_code='00123'")).rows[0].origin,'JP');
 assert.equal(Number((await db.query('select cursor from supplier_price_ingestion_internal.catalog_enrichment_jobs')).rows[0].cursor),0);
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


test('database timeouts retain a safe actionable reason without exposing database details',async()=>{
 const original=globalThis.fetch;
 try{
  globalThis.fetch=async()=>new Response(JSON.stringify({code:'57014',message:'private database details'}),{status:500});
  await assert.rejects(catalogEnrichmentRpc({url:'https://example.invalid',key:'test',portal:'https://example.invalid'})('apply_supplier_catalog_enrichment_batch'),/CATALOG_ENRICHMENT_DATABASE_TIMEOUT/);
  globalThis.fetch=async()=>new Response(JSON.stringify({code:'XX000',message:'private database details'}),{status:500});
  await assert.rejects(catalogEnrichmentRpc({url:'https://example.invalid',key:'test',portal:'https://example.invalid'})('apply_supplier_catalog_enrichment_batch'),/CATALOG_ENRICHMENT_RPC_UNCONFIRMED/);
 }finally{globalThis.fetch=original;}
});
