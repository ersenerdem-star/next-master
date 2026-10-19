import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomBytes} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import pg from 'pg';
import {createFullReplayDb} from './fixtures/price-engine-full-replay-db.mjs';
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
 await db.exec(await readFile('supabase/migrations/20261019180755_supplier_source_validation_details.sql','utf8'));
 await db.query("insert into organizations(id,name)values($1,'Org')",[org]);
 await db.query("insert into suppliers(id,organization_id,name)values($1,$2,'Supplier')",[supplier,org]);
 await db.query("insert into brands(id,organization_id,name)values($1,$2,'Sachs')",[brand,org]);
 await db.query('insert into auth.users(id)values($1)',[actor]);
 await db.query("insert into profiles(id,organization_id,email,role,is_active)values($1,$2,'test@example.invalid','admin',true)",[actor,org]);
});
after(async()=>{try{await db?.close();}finally{if(container)await exec('docker',['rm','--force',container]).catch(()=>{});}});
async function transaction(fn:()=>Promise<any>){await admin('begin');try{await fn();}finally{await db.exec('rollback;reset role');}}

async function seed(){
 await admin("insert into supplier_price_releases(id,organization_id,supplier_id,brand_id,status,total_rows,source_date,source_file_sha256,source_file_path,created_by,source_verification_required)values($1,$2,$3,$4,'uploaded',1,'2026-10-19',$5,'fixture/source.csv',$6,true)",[id(10),org,supplier,brand,'a'.repeat(64),actor]);
 await db.query("insert into supplier_price_upload_sessions(id,organization_id,release_id,idempotency_key,storage_object_path,file_name,content_type,total_bytes,expires_at,created_by)values($1,$2,$3,'fixture','fixture/source.csv','source.csv','text/csv',100,now()+interval '1 day',$4)",[id(11),org,id(10),actor]);
 await db.query("insert into supplier_price_ingestion_internal.handoffs(id,session_id,release_id,organization_id,storage_bucket,source_path,source_sha256,source_bytes,total_rows,object_id,object_version,object_updated_at,workflow_id)values($1,$2,$3,$4,'supplier-price-imports','fixture/source.csv',$5,100,1,$6,'fixture',now(),$7)",[id(12),id(11),id(10),org,'a'.repeat(64),id(13),'supplier-price-verified:v1:'+id(10)]);
}
const report={version:1,validatorVersion:'measurement-v1',totalRows:1,issueCount:1,counts:{INVALID_WEIGHT:1},samples:[{row:2,productCode:'A',column:'Weight_kg',code:'INVALID_WEIGHT',value:'abc',severity:'warning'}],truncated:false};
const args=(patch:any={})=>({input_release_id:id(10),input_handoff_id:id(12),input_source_sha256:'a'.repeat(64),input_report:report,...patch});
async function readAs(user:string){
 await db.exec('reset role;set role authenticated');
 await db.query("select set_config('request.jwt.claim.sub',$1,false),set_config('request.jwt.claim.role','authenticated',false),set_config('request.jwt.claims',$2,false)",[user,JSON.stringify({sub:user,role:'authenticated'})]);
 return (await db.query('select get_supplier_price_source_validation_report($1) report',[id(10)])).rows[0].report;
}
test('source diagnostics are immutable, source-bound, bounded and do not write prices or publication state',()=>transaction(async()=>{
 await seed();
 await admin('savepoint wrong');await assert.rejects(rpc('record_supplier_price_source_validation_report',args({input_source_sha256:'b'.repeat(64)})),/BINDING_INVALID/);await admin('rollback to savepoint wrong');
 assert.equal((await rpc('record_supplier_price_source_validation_report',args())).status,'recorded');
 assert.equal((await rpc('record_supplier_price_source_validation_report',args())).status,'recorded');
 const read=await readAs(actor);assert.equal(read.samples[0].value,'abc');assert.equal(read.issueCount,1);
 const r=(await admin('select status,processed_rows from supplier_price_releases where id=$1',[id(10)])).rows[0];assert.equal(r.status,'uploaded');assert.equal(Number(r.processed_rows),0);
 assert.equal(Number((await db.query('select count(*) c from supplier_price_publications')).rows[0].c),0);
 await admin('savepoint changed');await assert.rejects(rpc('record_supplier_price_source_validation_report',args({input_report:{...report,samples:[{...report.samples[0],value:'different'}]}})),/CONFLICT/);await admin('rollback to savepoint changed');
}));
test('anonymous, non-admin, other-organization and direct-table access cannot read or write diagnostics',()=>transaction(async()=>{
 await seed();await rpc('record_supplier_price_source_validation_report',args());
 const acl=(await admin("select has_function_privilege('anon','get_supplier_price_source_validation_report(uuid)','execute') anon,has_function_privilege('authenticated','record_supplier_price_source_validation_report(uuid,uuid,text,jsonb)','execute') client_write,has_table_privilege('service_role','supplier_price_ingestion_internal.source_validation_reports','select') direct")).rows[0];assert.deepEqual(acl,{anon:false,client_write:false,direct:false});
 await db.query("insert into organizations(id,name) values($1,'Other')",[id(20)]);
 await db.query('insert into auth.users(id) values($1),($2)',[id(21),id(22)]);
 await db.query("insert into profiles(id,organization_id,email,role,is_active)values($1,$2,'other@example.invalid','admin',true),($3,$4,'customer@example.invalid','sales',true)",[id(21),id(20),id(22),org]);
 await admin('savepoint other');await assert.rejects(readAs(id(21)),/NOT_FOUND/);await admin('rollback to savepoint other');
 await admin('savepoint customer');await assert.rejects(readAs(id(22)),/ADMIN_REQUIRED/);await admin('rollback to savepoint customer');
}));
