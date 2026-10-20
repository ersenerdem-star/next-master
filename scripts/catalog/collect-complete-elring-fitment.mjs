#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {hash,collectCompleteVehicles} from './lib/elring-fitment-completion.mjs';
import {maintainIndexes} from './lib/elring-completion-maintenance.mjs';
import {readSafeFetch} from './lib/elring-read-fetch.mjs';
import {readOfficialRequest} from './lib/elring-source-request.mjs';
import {applyConfirmedFitment,verifySlowFitmentAcknowledgement} from './lib/elring-fitment-apply.mjs';
import {finalizeElringCompletion} from './lib/elring-final-reread.mjs';
import {withElringWriteLease} from './lib/elring-write-lease.mjs';
const args=Object.fromEntries(process.argv.slice(2).map(a=>{const [k,...v]=a.replace(/^--/,'').split('=');return[k,v.join('=')||true];}));
if(!args['confirm-production'])throw Error('Explicit production confirmation required');
const root='/Users/ersen/Developer/next-master/artifacts/elring',run='cc0695cd-eb9f-43ef-9a3e-1371834fdb7f';
const writeLease=fn=>withElringWriteLease(path.join(root,'canonical-write.lock'),fn);
let stopRequested=false;process.on('SIGTERM',()=>{stopRequested=true;});process.on('SIGINT',()=>{stopRequested=true;});
const dir=path.join(root,'complete-fitment-2026-10-20');await fs.mkdir(path.join(dir,'requests'),{recursive:true});await fs.mkdir(path.join(dir,'products'),{recursive:true});
const lockFile=path.join(dir,'collector.lock');
try{const previous=JSON.parse(await fs.readFile(lockFile,'utf8'));let alive=false;try{process.kill(previous.pid,0);alive=true;}catch(e){if(e.code!=='ESRCH')throw e;}if(alive)throw Error('Fitment collector already running');await fs.unlink(lockFile);}catch(e){if(e.code!=='ENOENT')throw e;}
const lock=await fs.open(lockFile,'wx',0o600);await lock.writeFile(JSON.stringify({pid:process.pid,started_at:new Date().toISOString()}));await lock.close();
const config=JSON.parse(await fs.readFile(String(args['runtime-file']||'/tmp/elring-recovery-runtime.json'),'utf8'));
const headers={apikey:config.SUPABASE_SERVICE_ROLE_KEY,authorization:`Bearer ${config.SUPABASE_SERVICE_ROLE_KEY}`,'content-type':'application/json'};
if(!config.SUPABASE_SERVICE_ROLE_KEY||config.SUPABASE_SERVICE_ROLE_KEY.startsWith('****'))throw Error('Runtime credential unavailable');
const base='https://zjgueqijumzlfioihnkt.supabase.co';
let report;try{report=JSON.parse(await fs.readFile(path.join(dir,'status.json'),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;report={run_id:run,started_at:new Date().toISOString(),source_requests:0,processed:0};}
const save=async()=>{report.updated_at=new Date().toISOString();await fs.writeFile(path.join(dir,'status.json.tmp'),JSON.stringify(report,null,2));await fs.rename(path.join(dir,'status.json.tmp'),path.join(dir,'status.json'));};
report.pid=process.pid;report.article_country='GB';report.language='en';report.scope='official_passenger_commercial_motorcycle_makes_and_models';
const api=async(url,body,timeoutMs=6000)=>{const started=Date.now();const r=await readSafeFetch(base+url,{method:body?'POST':'GET',headers,redirect:'error',body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(timeoutMs)});const text=await r.text();if(!r.ok)throw Error(`DATABASE_HTTP_${r.status}: ${text.slice(0,350)}`);return{data:JSON.parse(text),ms:Date.now()-started};};
const health=async()=>{for(const p of ['/auth/v1/health','/rest/v1/catalog_products?select=id&limit=1']){const r=await api(p);if(r.ms>2000)throw Error(`PORTAL_LATENCY_GUARD ${r.ms}ms`);}};
const articles=new Map();
for(const name of await fs.readdir(path.join(root,'full-catalog-2026-10-19'))){if(!/^prefix-.*\.json$/.test(name))continue;const page=JSON.parse(await fs.readFile(path.join(root,'full-catalog-2026-10-19',name),'utf8'));for(const a of page.response.articles){if(articles.has(a.articleNumber))throw Error('DUPLICATE_SOURCE_ARTICLE');articles.set(a.articleNumber,a);}}
if(articles.size!==21543)throw Error('SOURCE_MANIFEST_CARDINALITY');
const vehiclesCache=new Map();try{for(const line of (await fs.readFile(path.join(dir,'vehicle-cache.jsonl'),'utf8')).split('\n').filter(Boolean)){const entry=JSON.parse(line);vehiclesCache.set(`${entry.target_type}:${entry.target_id}`,entry);}}catch(e){if(e.code!=='ENOENT')throw e;}
const saveVehicle=async(key,entry)=>fs.appendFile(path.join(dir,'vehicle-cache.jsonl'),JSON.stringify(entry)+'\n');
let lastSourceRequest=Date.now();
const call=async(method,extra)=>{
 const request={[method]:{provider:2122,articleCountry:'GB',lang:'en',...extra}},id=hash(request),file=path.join(dir,'requests',id+'.json');
 try{const cached=JSON.parse(await fs.readFile(file,'utf8'));if(hash(cached.response)!==cached.response_fingerprint)throw Error('SOURCE_CACHE_FINGERPRINT');return{...cached,evidence_ref:id};}catch(e){if(e.code!=='ENOENT')throw e;}
 const response=await readOfficialRequest(request,{beforeAttempt:async attempt=>{
  if(report.source_requests>=500000)throw Error('SOURCE_REQUEST_BUDGET');
  await sleep(Math.max(0,1100-(Date.now()-lastSourceRequest)));lastSourceRequest=Date.now();report.source_requests++;
  if(attempt)report.source_read_retries=(report.source_read_retries||0)+1;await save();
 }});
 const evidence={request,response,response_fingerprint:hash(response),retrieved_at:new Date().toISOString()};await fs.writeFile(file+'.tmp',JSON.stringify(evidence));await fs.rename(file+'.tmp',file);return{...evidence,evidence_ref:id};
};
try{
 await health();const job=(await api(`/rest/v1/catalog_elring_completion_jobs?run_id=eq.${run}&phase=eq.fitment&select=*`)).data[0];
 if(!job||job.status==='paused'||(job.status!=='completed'&&new Date(job.approved_until)<new Date()))throw Error('Fitment approval unavailable');
 let stage;try{stage=JSON.parse(await fs.readFile(path.join(dir,'stage-index.json'),'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;stage=[];for(let offset=0;offset<21543;offset+=1000){const rows=(await api(`/rest/v1/catalog_import_stage?run_id=eq.${run}&select=row_index,product_code,source_fingerprint&order=row_index&offset=${offset}&limit=1000`)).data;stage.push(...rows);}if(stage.length!==21543||stage.some((s,i)=>s.row_index!==i||!articles.has(s.product_code)))throw Error('STAGE_IDENTITY_CARDINALITY');await fs.writeFile(path.join(dir,'stage-index.json'),JSON.stringify(stage));}
 if(job.status==='completed'){
  report.final_reread=await writeLease(()=>finalizeElringCompletion({api,health,root,run,stage}));report.status='completed';await save();await fs.unlink(lockFile);process.exit(0);
 }
 report.status='running';report.processed=job.processed;delete report.error;await save();
 for(let i=job.cursor+1;i<stage.length;i++){
  if(stopRequested){report.status='stopped_at_checkpoint';await save();break;}
  const row=stage[i];report.current_product=row.product_code;report.current_row=i;await save();
  let evidence;const file=path.join(dir,'products',String(i)+'.json');try{evidence=JSON.parse(await fs.readFile(file,'utf8'));}catch(e){if(e.code!=='ENOENT')throw e;evidence=await collectCompleteVehicles(articles.get(row.product_code),{call,vehiclesCache,saveVehicle});evidence.stage_fingerprint=row.source_fingerprint;await fs.writeFile(file+'.tmp',JSON.stringify(evidence));await fs.rename(file+'.tmp',file);}
  // Source collection is independent; canonical writes wait until the other
  // approved completion phases release the shared Product/summary workload.
  while(true){const jobs=(await api(`/rest/v1/catalog_elring_completion_jobs?run_id=eq.${run}&phase=in.(images,enrichment,lifecycle)&select=phase,status`)).data;
   if(jobs.length===3&&jobs.every(j=>j.status==='completed'))break;report.status='waiting_for_other_phases';await save();await sleep(30000);}
  if(i%50===0)await writeLease(()=>maintainIndexes({request:api,health,run,onResult:async r=>{report.last_maintenance=r.data;await save();}}));
  await health();const applied=await writeLease(()=>applyConfirmedFitment({request:api,health,run,row:i,evidence,
   onRecovery:async recovery=>{report.last_verified_recovery=recovery;await save();}}));
  report.status='running';report.processed=applied.data.processed;report.changed=applied.data.changed;report.totals=applied.data.totals;report.cached_vehicle_targets=vehiclesCache.size;report.last_apply_ms=applied.ms;await save();
  if(applied.ms>2000){
   report.status='holding_writes_after_slow_acknowledgement';await save();
   report.last_verified_recovery=await writeLease(()=>verifySlowFitmentAcknowledgement({request:api,health,run,row:i,evidence}));
   report.status='running';await save();
  }
  if(i%25===0||applied.data.status==='completed')console.log(JSON.stringify({row:i,product_code:row.product_code,processed:report.processed,requests:report.source_requests,cached_vehicles:vehiclesCache.size,vehicle_count:evidence.vehicles.length}));
 }
 if(!stopRequested){report.status='verifying_all_fields';await save();report.final_reread=await writeLease(()=>finalizeElringCompletion({api,health,root,run,stage}));
 report.status='completed';report.finished_at=new Date().toISOString();await save();}
}catch(e){report.status='stopped';report.error=e.message;await save();console.error(e.message);process.exitCode=1;}
finally{await fs.unlink(lockFile).catch(e=>{if(e.code!=='ENOENT')throw e;});}
