import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash,randomBytes} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import {performance} from 'node:perf_hooks';
import pg from 'pg';

// Synthetic local sizing proof, never connects to a provider. These timings are
// not production latency: projection fixture, warm cache, no concurrent load.
const path='supabase/migrations/20261014165817_price_list_legacy_scope_compatibility.sql';
const id=n=>'20000000-0000-4000-8000-'+String(n).padStart(12,'0');
const org=id(1),brand=id(2),supplier=id(3),supplier2=id(4),release=id(5),publication=id(6);
const exec=promisify(execFile);
const round=x=>Math.round(x*100)/100;
function nodes(plan,out=[]) {out.push(plan);for(const child of plan.Plans||[])nodes(child,out);return out;}

test('isolated PG17 Corteco-sized complete legacy paging and 1M publication continuation',
 {skip:process.env.RUN_PRICE_LIST_LEGACY_PG_PERF!=='1',timeout:300000},async t=>{
 const container=`nm-price-list-perf-${process.pid}-${randomBytes(4).toString('hex')}`;
 const password=randomBytes(24).toString('hex');let db;
 const sql=await readFile(path,'utf8');
 const evidence={schemaVersion:1,scope:'local-synthetic-postgresql17',capturedAt:new Date().toISOString(),migrationSha256:createHash('sha256').update(sql).digest('hex'),resources:{cpu:0.5,memoryBytes:1073741824},limits:['Synthetic commercial projection, not copied production rows','Warm local cache, no network/provider or concurrent workload','Only read-path indexes and columns are modeled; RLS/auth correctness is covered by the separate functional replay test','Timings are observations, not a production SLA'],legacy:{inputRows:60656,expectedExactCodes:30328,suppliers:2},published:{inputRows:1000000,suppliers:1}};
 try{
  await exec('docker',['run','--detach','--rm','--name',container,'--cpus','0.5','--memory','1g','--publish','127.0.0.1::5432','--env','POSTGRES_PASSWORD','--env','POSTGRES_DB=price_list_performance','postgres:17'],{env:{...process.env,POSTGRES_PASSWORD:password},timeout:30000});
  const port=(await exec('docker',['port',container,'5432/tcp'])).stdout.trim().match(/^127\.0\.0\.1:(\d+)$/);assert.ok(port);
  for(let n=0;n<60;n++){const c=new pg.Client({host:'127.0.0.1',port:Number(port[1]),user:'postgres',password,database:'price_list_performance',connectionTimeoutMillis:1000});try{await c.connect();db=c;break;}catch{await c.end().catch(()=>{});await delay(250);}}
  assert.ok(db);
  await db.query(await readFile('scripts/tests/export-quote-eligibility-pg.setup.sql','utf8'));
  await db.query(`truncate supplier_price_release_rows,supplier_current_price_pointers,supplier_price_publications,catalog_products,brands;
   alter table brands add column organization_id uuid;
   alter table supplier_price_release_rows alter column id type bigint using 0::bigint;
   create or replace function public.normalize_catalog_product_code(input_code text) returns text language sql immutable as $$select regexp_replace(upper(coalesce(input_code,'')), '[[:space:]]+', '', 'g')$$;
   create table supplier_prices(id uuid primary key,organization_id uuid,supplier_id uuid,brand_id uuid,product_code text,normalized_code text,description text,buy_price numeric,currency text,valid_from date,valid_to date,is_active boolean,updated_at timestamptz default now());
   set statement_timeout='30s';set lock_timeout='1s';set timezone='UTC';set plan_cache_mode='force_generic_plan';`);
  await db.query(sql);
  const plan=JSON.parse(await readFile('scripts/ops/price-engine-production-index-prebuild-plan.json','utf8'));
  const indexNames=[];
  for(const item of plan.operations.filter(x=>['supplier_prices','catalog_products'].includes(x.table))){await db.query(item.source_sql);indexNames.push(item.name);}
  const baseline=JSON.parse(await readFile('scripts/tests/fixtures/price-engine-full-replay-production-source.json','utf8'));
  const wanted=new Set(['idx_supplier_prices_brand_code','idx_supplier_prices_master_rollup_active','idx_supplier_prices_master_rollup_supplier_active','idx_supplier_prices_order_rules','idx_supplier_prices_org_brand_normcode_buy_active','idx_supplier_prices_org_supplier_brand_normcode_active','idx_supplier_prices_org_supplier_brand_active']);
  for(const index of baseline.tables.find(x=>x.name==='supplier_prices').indexes.filter(x=>wanted.has(x.name))){await db.query(index.definition);indexNames.push(index.name);}
  const foundation=await readFile('supabase/migrations/20261014110452_price_engine_production_foundation_bootstrap.sql','utf8');
  for(const match of foundation.matchAll(/^CREATE INDEX IF NOT EXISTS (idx_release_rows_export_exact_eligible_count|idx_release_rows_export_future_eligibility|idx_release_rows_master_export_code_c|idx_supplier_price_release_rows_portal_prefix|idx_supplier_price_release_rows_release_code|idx_supplier_price_release_rows_release_status) [^\n]+;/gm)){await db.query(match[0]);indexNames.push(match[1]);}
  evidence.indexNames=indexNames.sort();
  await db.query('insert into brands(id,name,organization_id)values($1,\'Synthetic Corteco\',$2)',[brand,org]);
  await db.query(`insert into supplier_prices(id,organization_id,supplier_id,brand_id,product_code,normalized_code,description,buy_price,currency,valid_from,is_active,updated_at)
   select md5('legacy-'||s||'-'||i)::uuid,$1,case s when 1 then $3::uuid else $4::uuid end,$2,'C'||lpad(i::text,8,'0'),'C'||lpad(i::text,8,'0'),repeat('Part description ',5),10+(i%10000)/100::numeric+s,'EUR',current_date-1,true,'2026-01-01T00:00:00Z' from generate_series(1,30328)i cross join generate_series(1,2)s`,[org,brand,supplier,supplier2]);
  await db.query(`insert into catalog_products(id,organization_id,brand_id,product_code,description,updated_at)select md5('catalog-'||i)::uuid,$1,$2,'C'||lpad(i::text,8,'0'),'Catalog part','2026-01-01T00:00:00Z'from generate_series(1,30328)i`,[org,brand]);
  await db.query('analyze');
  const timed=async(query,args=[])=>{const started=performance.now();const result=await db.query(query,args);return{ms:round(performance.now()-started),rows:result.rows};};
  const version=()=>timed('select public.get_admin_price_list_export_version($1,$2) version',[org,brand]);
  const page=after=>timed('select normalized_code,sales_price::text,total_count::text from public.cloud_admin_price_list_page_fast($1,$2,\'A\',.1,null,$3,1000)',[org,brand,after]);
  evidence.legacy.versionSamplesMs=[];
  for(let n=0;n<3;n++)evidence.legacy.versionSamplesMs.push((await version()).ms);
  const helperBody=sql.match(/as \$function\$([\s\S]*?)\$function\$/)[1];
  await db.query('prepare perf_source(uuid,uuid,text,integer) as '+helperBody.replaceAll('input_organization_id','$1').replaceAll('input_brand_id','$2').replaceAll('input_after_normalized_code','$3').replaceAll('input_page_size','$4'));
  const explain=async(after)=>{
   const raw=(await db.query(`explain(analyze,buffers,format json) execute perf_source('${org}','${brand}',${after?`'${after}'`:'null'},1000)`)).rows[0]['QUERY PLAN'][0];
   return{executionMs:raw['Execution Time'],planningMs:raw['Planning Time'],sharedHitBlocks:raw.Plan['Shared Hit Blocks'],sharedReadBlocks:raw.Plan['Shared Read Blocks'],tempReadBlocks:raw.Plan['Temp Read Blocks'],tempWrittenBlocks:raw.Plan['Temp Written Blocks'],scans:nodes(raw.Plan).filter(n=>n['Relation Name']).map(n=>({relation:n['Relation Name'],node:n['Node Type'],index:n['Index Name']||null,rows:n['Actual Rows'],loops:n['Actual Loops'],removedByFilter:n['Rows Removed by Filter']||0}))};
  };
  evidence.legacy.firstPlan=await explain(null);evidence.legacy.middlePlan=await explain('C00015000');
  const started=performance.now();let after=null,count=0,versionMs=0,pageMs=0,maxPageMs=0,maxVersionMs=0,pages=0;
  while(count<30328){const v=await version();const p=await page(after);assert.ok(p.rows.length);assert.equal(p.rows[0].total_count,after===null?'30328':null);for(const row of p.rows){assert.ok(after===null||Buffer.compare(Buffer.from(row.normalized_code),Buffer.from(after))>0);after=row.normalized_code;count++;}versionMs+=v.ms;pageMs+=p.ms;maxPageMs=Math.max(maxPageMs,p.ms);maxVersionMs=Math.max(maxVersionMs,v.ms);pages++;}
  assert.equal(count,30328);assert.equal(pages,31);assert.equal((await page(after)).rows.length,0);
  evidence.legacy.fullExport={rows:count,pages,wallMs:round(performance.now()-started),versionMs:round(versionMs),pageMs:round(pageMs),maxPageMs,maxVersionMs};
  t.diagnostic('Corteco-sized local result '+JSON.stringify(evidence.legacy));
  await db.query('truncate supplier_prices,catalog_products');
  await db.query('insert into supplier_price_publications(id,organization_id,brand_id,supplier_id,release_id,status)values($1,$2,$3,$4,$5,\'published\')',[publication,org,brand,supplier,release]);
  await db.query('insert into supplier_current_price_pointers values($1,$2,$3,$4,$5)',[org,brand,supplier,release,publication]);
  await db.query("set statement_timeout='120s'");
  await db.query(`insert into supplier_price_release_rows(id,release_id,normalized_code,product_code,description,buy_price,currency,valid_from,row_status)select i::bigint,$1,'P'||lpad(i::text,8,'0'),'P'||lpad(i::text,8,'0'),repeat('Part description ',5),10+(i%10000)/100::numeric,'EUR',current_date-1,'accepted'from generate_series(1,1000000)i`,[release]);
  await db.query("vacuum analyze supplier_price_release_rows");await db.query("set statement_timeout='30s'");
  evidence.published.versionMs=(await version()).ms;
  const first=await page(null);assert.equal(first.rows[0].total_count,'1000000');evidence.published.firstPageMs=first.ms;
  const middle=await page('P00500000');assert.equal(middle.rows.length,1000);assert.equal(middle.rows[0].normalized_code,'P00500001');assert.equal(middle.rows[0].total_count,null);evidence.published.middlePageMs=middle.ms;
  evidence.published.middlePlan=await explain('P00500000');
  const releaseScans=evidence.published.middlePlan.scans.filter(n=>n.relation==='supplier_price_release_rows');
  assert.ok(releaseScans.some(n=>n.loops>0&&n.index&&n.rows<=5000),'published keyset must read a bounded indexed range under a generic plan');
  assert.ok(releaseScans.every(n=>n.loops===0||n.rows<=5000),'continuation must not recount or fully materialize the 1M release');
  assert.ok(releaseScans.reduce((sum,n)=>sum+n.rows*n.loops,0)<10000,'aggregate release reads must remain bounded across every plan loop');
  evidence.server=(await db.query("select version(),current_setting('work_mem') work_mem,current_setting('TimeZone') timezone,current_setting('statement_timeout') statement_timeout,current_setting('plan_cache_mode') plan_cache_mode")).rows[0];
  evidence.completedAt=new Date().toISOString();
  await writeFile('/private/tmp/next-master-price-list-legacy-performance-20261014.json',JSON.stringify(evidence,null,2)+'\n');
  t.diagnostic('1M published local result '+JSON.stringify(evidence.published));
 }finally{await db?.end().catch(()=>{});await exec('docker',['rm','--force',container],{timeout:15000}).catch(()=>{});}
});
