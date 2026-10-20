#!/usr/bin/env node
import fs from 'node:fs/promises';import path from 'node:path';import {setTimeout as sleep} from 'node:timers/promises';
import {withElringWriteLease} from './lib/elring-write-lease.mjs';import {maintainIndexes} from './lib/elring-completion-maintenance.mjs';import {readSafeFetch} from './lib/elring-read-fetch.mjs';import {finalizeElringCompletion} from './lib/elring-final-reread.mjs';
const args=Object.fromEntries(process.argv.slice(2).map(a=>{const[k,...v]=a.replace(/^--/,'').split('=');return[k,v.join('=')||true];}));
if(!args['confirm-production'])throw Error('Production confirmation required');
const root='/Users/ersen/Developer/next-master/artifacts/elring',dir=path.join(root,'spareto-completion-2026-10-20'),run='cc0695cd-eb9f-43ef-9a3e-1371834fdb7f';
const lock=path.join(dir,'apply.lock');await fs.writeFile(lock,JSON.stringify({pid:process.pid}),{flag:'wx',mode:0o600});
let status={pid:process.pid,status:'starting',started_at:new Date().toISOString(),scalar_processed:0,vehicle_processed:0,applied_fields:{},conflicts:{}};
const save=async()=>{status.updated_at=new Date().toISOString();await fs.writeFile(path.join(dir,'apply-status.json.tmp'),JSON.stringify(status,null,2));await fs.rename(path.join(dir,'apply-status.json.tmp'),path.join(dir,'apply-status.json'));};
const config=JSON.parse(await fs.readFile(args['runtime-file']||'/tmp/elring-recovery-runtime.json','utf8'));
if(!config.SUPABASE_SERVICE_ROLE_KEY||config.SUPABASE_SERVICE_ROLE_KEY.startsWith('***'))throw Error('Runtime unavailable');
const headers={apikey:config.SUPABASE_SERVICE_ROLE_KEY,authorization:'Bearer '+config.SUPABASE_SERVICE_ROLE_KEY,'content-type':'application/json'};
const api=async(url,body,timeoutMs=6000)=>{const started=Date.now();const r=await readSafeFetch('https://zjgueqijumzlfioihnkt.supabase.co'+url,{method:body?'POST':'GET',headers,body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(timeoutMs),redirect:'error'});const t=await r.text();if(!r.ok)throw Error('DATABASE_HTTP_'+r.status+': '+t.slice(0,300));return{data:JSON.parse(t),ms:Date.now()-started};};
const read=async(table,params)=>(await api('/rest/v1/'+table+'?'+new URLSearchParams(params))).data;
const health=async()=>{for(const p of ['/auth/v1/health','/rest/v1/catalog_products?select=id&limit=1']){const r=await api(p);if(r.ms>2000)throw Error('PORTAL_LATENCY_GUARD '+r.ms);}};
const lease=fn=>withElringWriteLease(path.join(root,'canonical-write.lock'),fn);
let stop=false;process.on('SIGTERM',()=>{stop=true;});process.on('SIGINT',()=>{stop=true;});
try{
 await health();const manifest=JSON.parse(await fs.readFile(path.join(dir,'manifest.json'),'utf8'));
 const job=(await read('catalog_elring_spareto_jobs',{run_id:'eq.'+run,select:'*'}))[0];if(!job||job.expected_products!==manifest.products.length||job.approval_reference!==manifest.authorization_reference)throw Error('SECONDARY_JOB_SCOPE');
 const done={scalars:new Set(),vehicle:new Set()},rejected=new Set();
 for(const phase of Object.keys(done))for(let offset=0;;offset+=1000){const rows=await read('catalog_elring_spareto_events',{run_id:'eq.'+run,phase:'eq.'+phase,select:'row_index,applied_fields,conflicts',order:'row_index',offset,limit:1000});for(const r of rows){done[phase].add(r.row_index);for(const f of r.applied_fields)status.applied_fields[f]=(status.applied_fields[f]||0)+1;for(const f of Object.keys(r.conflicts))status.conflicts[f]=(status.conflicts[f]||0)+1;}if(rows.length<1000)break;}
 let writes=0,lastMaintenance=0,scanned=0;
 while(!stop){
  const official=(await read('catalog_elring_completion_jobs',{run_id:'eq.'+run,phase:'eq.fitment',select:'cursor,status'}))[0];let work=0;
  for(const row of manifest.products){if(stop)break;let evidence;
   for(const phase of ['scalars','vehicle']){
    if(rejected.has(row.row_index)||done[phase].has(row.row_index)||(phase==='vehicle'&&row.row_index>official.cursor))continue;
    try{evidence||=JSON.parse(await fs.readFile(path.join(dir,'evidence',row.row_index+'.json'),'utf8'));}catch(e){if(e.code==='ENOENT')continue;throw e;}
    if(evidence.status==='source_rejected'){rejected.add(row.row_index);status.source_rejected=rejected.size;await save();continue;}
    if(evidence.status==='source_404')evidence.stage_fingerprint=row.source_fingerprint;
    if(writes%5===0)await health();
    if(writes-lastMaintenance>=100){await lease(()=>maintainIndexes({request:api,health,run}));lastMaintenance=writes;}
    const body={input_run_id:run,input_row_index:row.row_index,input_phase:phase,input_evidence:evidence};
    let applied;try{applied=await lease(()=>api('/rest/v1/rpc/apply_elring_spareto_completion',body));}
    catch(e){
     // Ambiguous POSTs are never replayed here: an immutable matching receipt
     // is required before acknowledging the row; otherwise stop for review.
     await health();const receipt=(await read('catalog_elring_spareto_events',{run_id:'eq.'+run,row_index:'eq.'+row.row_index,phase:'eq.'+phase,select:'evidence,applied_fields,conflicts'}))[0];
     if(!receipt||JSON.stringify(receipt.evidence)!==JSON.stringify(evidence)){
      // JSONB key order differs from the local payload; compare recursively.
      const stable=v=>v&&typeof v==='object'?Array.isArray(v)?v.map(stable):Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v;
      if(!receipt||JSON.stringify(stable(receipt.evidence))!==JSON.stringify(stable(evidence)))throw e;
     }
     applied={data:{status:'receipt_verified',applied_fields:receipt.applied_fields,conflicts:receipt.conflicts},ms:0};
    }
    if(applied.data.status==='waiting_for_official_vehicle')continue;
    done[phase].add(row.row_index);writes++;work++;status.current_product=row.product_code;status.current_phase=phase;
    for(const f of applied.data.applied_fields||[])status.applied_fields[f]=(status.applied_fields[f]||0)+1;
    for(const f of Object.keys(applied.data.conflicts||{}))status.conflicts[f]=(status.conflicts[f]||0)+1;
    status.scalar_processed=done.scalars.size;status.vehicle_processed=done.vehicle.size;status.total=manifest.products.length;status.status='running';await save();
    if(applied.ms>2000)throw Error('SLOW_ACKNOWLEDGED_SECONDARY_WRITE '+applied.ms);
    if(args['max-writes']&&writes>=Number(args['max-writes'])){stop=true;break;}
    await sleep(250);
   }
   if(++scanned%1000===0)await health();
  }
  if(done.scalars.size===manifest.products.length&&done.vehicle.size===manifest.products.length){
   const collection=JSON.parse(await fs.readFile(path.join(dir,'collection-status.json'),'utf8'));if(collection.status!=='completed')throw Error('SOURCE_COLLECTION_NOT_COMPLETED');
   const stage=JSON.parse(await fs.readFile(path.join(root,'complete-fitment-2026-10-20/stage-index.json'),'utf8'));
   await lease(async()=>{await api('/rest/v1/rpc/finish_elring_spareto_completion',{input_run_id:run});status.final_reread=await finalizeElringCompletion({api,health,root,run,stage});});status.status='completed';await save();break;
  }
  if(rejected.size&&done.scalars.size+rejected.size===manifest.products.length&&done.vehicle.size+rejected.size===manifest.products.length){status.status='review_required';status.source_rejected=rejected.size;await save();break;}
  if(!stop){status.status=work?'running':'waiting_for_source_or_official_vehicle';await save();await sleep(work?1000:15000);}
 }
 if(stop){status.status='stopped_at_checkpoint';await save();}
}catch(e){status.status='stopped';status.error=e.message;await save();console.error(e.stack);process.exitCode=1;}finally{await fs.unlink(lock);}
