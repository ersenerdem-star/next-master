import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash,randomBytes} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {setTimeout as delay} from 'node:timers/promises';
import {performance} from 'node:perf_hooks';
import pg from 'pg';
const path='supabase/migrations/20261014171235_master_price_mixed_supplier_scopes.sql';
const exec=promisify(execFile),id=n=>'40000000-0000-4000-8000-'+String(n).padStart(12,'0');
const org=id(1),brand=id(2),supplier=id(3),legacySupplier=id(4),release=id(5),publication=id(6),actor=id(7);
function nodes(p,a=[]){a.push(p);for(const c of p.Plans||[])nodes(c,a);return a;}
const summarize=r=>({executionMs:r['Execution Time'],planningMs:r['Planning Time'],tempReadBlocks:r.Plan['Temp Read Blocks'],tempWrittenBlocks:r.Plan['Temp Written Blocks'],cteWork:nodes(r.Plan).filter(n=>n['CTE Name']||n['Rows Removed by Join Filter']).map(n=>({node:n['Node Type'],cte:n['CTE Name']||null,rows:n['Actual Rows'],loops:n['Actual Loops'],removedByJoinFilter:n['Rows Removed by Join Filter']||0})),scans:nodes(r.Plan).filter(n=>n['Relation Name']).map(n=>({relation:n['Relation Name'],node:n['Node Type'],index:n['Index Name']||null,rows:n['Actual Rows'],loops:n['Actual Loops'],removed:n['Rows Removed by Filter']||0}))});
const bounded=(plan)=>{const reads=plan.scans.filter(n=>n.relation==='supplier_price_release_rows');assert.ok(reads.some(n=>n.loops>0&&n.index),'published lookups use indexes');assert.ok(reads.reduce((n,r)=>n+r.rows*r.loops,0)<20000,'continuation/preview cannot materialize or recount the 1M publication');assert.ok(plan.cteWork.every(n=>(n.rows+n.removedByJoinFilter)*n.loops<100000),'bounded page CTEs cannot perform quadratic page-by-page comparisons');};
test('isolated PG17 mixed supplier Master export and catalog preview stay bounded under generic plans',
 {skip:process.env.RUN_MASTER_MIXED_PG_PERF!=='1',timeout:600000},async t=>{
 const container=`nm-master-perf-${process.pid}-${randomBytes(4).toString('hex')}`,password=randomBytes(24).toString('hex');let db;
 const sql=await readFile(path,'utf8');
 const evidence={schemaVersion:1,scope:'local synthetic PostgreSQL17 read performance',migrationSha256:createHash('sha256').update(sql).digest('hex'),capturedAt:new Date().toISOString(),resources:{setupCpu:2,measurementCpu:0.5,memoryBytes:1073741824},fixture:{publishedRows:1000000,catalogRows:1000000,rawLegacyRows:60656,legacySuppliers:2,unownedEligibleLegacyRows:30328,legacyCodesOverlapPublication:true},limits:['Synthetic projection fixture; no provider connections or production rows.','Warm-cache local timings and forced generic plans are not production SLA. Autovacuum is disabled only on the three local fixture data tables; explicit VACUUM ANALYZE runs before measurement.','Source/ACL/full62 compatibility is separately verified by functional tests.','Fixture installs the seven relevant existing read indexes listed in indexNames, not unrelated production indexes.']};
 try{
  await exec('docker',['run','--detach','--rm','--name',container,'--cpus','2','--memory','1g','--publish','127.0.0.1::5432','--env','POSTGRES_PASSWORD','--env','POSTGRES_DB=master_price_performance','postgres:17'],{env:{...process.env,POSTGRES_PASSWORD:password},timeout:30000});
  const port=(await exec('docker',['port',container,'5432/tcp'])).stdout.trim().match(/^127\.0\.0\.1:(\d+)$/);assert.ok(port);
  for(let n=0;n<60;n++){const c=new pg.Client({host:'127.0.0.1',port:Number(port[1]),user:'postgres',password,database:'master_price_performance',connectionTimeoutMillis:1000});try{await c.connect();db=c;break;}catch{await c.end().catch(()=>{});await delay(250);}}
  assert.ok(db);
  await db.query(await readFile('scripts/tests/catalog-export-source-pg.setup.sql','utf8'));
  await db.query(`alter table supplier_prices add column valid_to date;
   alter table supplier_prices set(autovacuum_enabled=false);alter table catalog_products set(autovacuum_enabled=false);alter table supplier_price_release_rows set(autovacuum_enabled=false);create table supplier_price_releases(id uuid,organization_id uuid,supplier_id uuid,brand_id uuid,accepted_rows bigint);
   create function auth.uid()returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
   create function public.current_profile_org_id()returns uuid language sql stable as $$select nullif(current_setting('test.org',true),'')::uuid$$;
   grant usage on schema public,auth to authenticated,anon,service_role;
   set timezone='UTC';set statement_timeout='120s';set lock_timeout='1s';set plan_cache_mode='force_generic_plan';`);
  await db.query(await readFile('supabase/migrations/20261014165817_price_list_legacy_scope_compatibility.sql','utf8'));await db.query(sql);
  await db.query("select set_config('request.jwt.claim.sub',$1,false),set_config('test.org',$2,false)",[actor,org]);
  await db.query("insert into brands values($1,$2,'Synthetic brand')",[brand,org]);
  await db.query("insert into suppliers values($1,$2,'Published',now()),($3,$2,'Legacy',now())",[supplier,org,legacySupplier]);
  await db.query("insert into supplier_price_publications(id,organization_id,brand_id,supplier_id,release_id,status)values($1,$2,$3,$4,$5,'published')",[publication,org,brand,supplier,release]);
  await db.query('insert into supplier_current_price_pointers values($1,$2,$3,$4,$5)',[org,brand,supplier,release,publication]);
  await db.query('insert into supplier_price_releases values($1,$2,$3,$4,1000000)',[release,org,supplier,brand]);
  await db.query(`insert into supplier_price_release_rows(id,release_id,normalized_code,product_code,description,oem_no,notes,buy_price,currency,valid_from,row_status)
   select i,$1,'P'||lpad(i::text,8,'0'),'P'||lpad(i::text,8,'0'),repeat('Published part ',4),'OEM'||i,'note',100+(i%10000)/100::numeric,'EUR',current_date-1,'accepted'from generate_series(1,1000000)i`,[release]);
  await db.query(`insert into catalog_products(id,organization_id,brand_id,product_code,normalized_code,description)select md5('catalog-'||i)::uuid,$1,$2,'P'||lpad(i::text,8,'0'),'P'||lpad(i::text,8,'0'),repeat('Catalog part ',4)from generate_series(1,1000000)i`,[org,brand]);
  await db.query(`insert into supplier_prices(id,organization_id,supplier_id,brand_id,product_code,normalized_code,description,oem_no,notes,buy_price,currency,valid_from,is_active)
   select md5('legacy-'||s||'-'||i)::uuid,$1,case s when 1 then $3::uuid else $4::uuid end,$2,'P'||lpad((500000+i)::text,8,'0'),'P'||lpad((500000+i)::text,8,'0'),'Legacy part','OEM'||i,'raw note',case s when 1 then 1 else 10+i/100::numeric end,'EUR',current_date-1,true from generate_series(1,30328)i cross join generate_series(1,2)s`,[org,brand,supplier,legacySupplier]);
  const plan=JSON.parse(await readFile('scripts/ops/price-engine-production-index-prebuild-plan.json','utf8'));
  evidence.indexNames=[];for(const item of plan.operations.filter(x=>['idx_catalog_products_export_exact_identity','idx_catalog_products_export_code_c_id','idx_catalog_products_export_code_id','idx_supplier_prices_export_code_c'].includes(x.name))){await db.query(item.source_sql);evidence.indexNames.push(item.name);}
  const foundation=await readFile('supabase/migrations/20261014110452_price_engine_production_foundation_bootstrap.sql','utf8');
  for(const m of foundation.matchAll(/^CREATE INDEX IF NOT EXISTS (idx_release_rows_export_exact_eligible_count|idx_supplier_price_release_rows_portal_prefix|idx_supplier_price_release_rows_release_code) [^\n]+;/gm)){await db.query(m[0]);evidence.indexNames.push(m[1]);}
  await db.query('vacuum analyze');
  await exec('docker',['update','--cpus','0.5',container],{timeout:10000});
  await db.query("set statement_timeout='30s'");
  const timed=async(q,args=[])=>{const s=performance.now(),r=await db.query(q,args);return{ms:Math.round((performance.now()-s)*100)/100,rows:r.rows};};
  const code='P00500000',cursorId=(await db.query('select id from catalog_products where organization_id=$1 and brand_id=$2 and product_code=$3',[org,brand,code])).rows[0].id;
  for(const scope of['priced','catalog']){
   t.diagnostic('measuring '+scope);
   const r=await timed('select * from cloud_catalog_master_export_page_v3($1,$2,$3,\'\',$4,$5,5000,.1,.15)',[org,brand,scope,code,scope==='catalog'?cursorId:null]);
   assert.equal(r.rows.length,5000);assert.equal(r.rows[0].product_code,'P00500001');assert.equal(Number(r.rows[0].cheapest_price),10.01);assert.equal(Number(r.rows[0].second_price),100.01);assert.equal(Number(r.rows[0].supplier_count),2);assert.equal(r.rows[0].total_count,null);evidence[scope]={rows:r.rows.length,ms:r.ms};
  }
  const body=sql.match(/as \$function\$([\s\S]*?)\$function\$/i)[1];
  const parameters=['input_organization_id','input_brand_id','input_scope','input_search','input_after_code','input_after_id','input_page_size','input_margin_a','input_margin_b'];
  let prepared=body;for(const[n,name]of parameters.entries())prepared=prepared.replaceAll(name,'$'+(n+1));
  await db.query('prepare master_export(uuid,uuid,text,text,text,uuid,integer,numeric,numeric)as '+prepared);
  for(const scope of['priced','catalog']){const p=(await db.query(`explain(analyze,buffers,format json)execute master_export('${org}','${brand}','${scope}','','${code}',${scope==='catalog'?`'${cursorId}'`:'null'},5000,.1,.15)`)).rows[0]['QUERY PLAN'][0];evidence[scope].plan=summarize(p);bounded(evidence[scope].plan);if(scope==='catalog')assert.ok(evidence[scope].plan.scans.filter(n=>n.relation==='catalog_products').reduce((sum,n)=>sum+(n.rows+n.removed)*n.loops,0)<20000,'catalog continuation must seek past the500k prefix instead of filtering it');}
  await db.query('set role authenticated');const preview=await timed('select * from cloud_master_page_fast(\'\',$1,1,50,.1,.15)',[brand]);await db.query('reset role');
  assert.ok(preview.rows.length>0&&preview.rows.length<=50);assert.ok(preview.rows.every(r=>r.total_count===null));evidence.catalogPreview={rows:preview.rows.length,ms:preview.ms};
  const previewBody=sql.split('create or replace function public.cloud_master_page_fast')[1].split('return query')[1].split('end;')[0].trim().replace(/;$/,'');
  const pnames=['v_org','input_brand_id','input_search','v_size','v_offset','input_margin_a','input_margin_b'];let pb=previewBody;for(const[n,name]of pnames.entries())pb=pb.replaceAll(name,'$'+(n+1));
  await db.query('prepare catalog_preview(uuid,uuid,text,integer,bigint,numeric,numeric)as '+pb);
  const previewPlan=(await db.query(`explain(analyze,buffers,format json)execute catalog_preview('${org}','${brand}','',50,0,.1,.15)`)).rows[0]['QUERY PLAN'][0];evidence.catalogPreview.plan=summarize(previewPlan);bounded(evidence.catalogPreview.plan);assert.ok(evidence.catalogPreview.plan.scans.filter(n=>n.relation==='catalog_products').reduce((sum,n)=>sum+(n.rows+n.removed)*n.loops,0)<=100,'default preview reads only its bounded catalog page');
  const sales=await timed("select * from cloud_admin_price_list_page_fast($1,$2,'A',.1,null,$3,1000)",[org,brand,code]);assert.equal(sales.rows.length,1000);assert.equal(sales.rows[0].normalized_code,'P00500001');assert.equal(Number(sales.rows[0].sales_price),11.01);evidence.salesCompatibility={rows:sales.rows.length,ms:sales.ms,catalogRows:1000000};
  evidence.server=(await db.query("select version(),current_setting('work_mem')work_mem,current_setting('plan_cache_mode')plan_cache_mode")).rows[0];evidence.completedAt=new Date().toISOString();
  await writeFile('/private/tmp/next-master-mixed-master-performance-20261014.json',JSON.stringify(evidence,null,2)+'\n');t.diagnostic(JSON.stringify(evidence));
 }finally{await db?.end().catch(()=>{});await exec('docker',['rm','--force',container],{timeout:15000}).catch(()=>{});}
});
