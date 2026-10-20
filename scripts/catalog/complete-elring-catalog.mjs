#!/usr/bin/env node
import fs from 'node:fs/promises';
import {setTimeout as sleep} from 'node:timers/promises';
import {maintainIndexes} from './lib/elring-completion-maintenance.mjs';
import {readSafeFetch} from './lib/elring-read-fetch.mjs';
const args=Object.fromEntries(process.argv.slice(2).map(a=>{const [k,...v]=a.replace(/^--/,'').split('=');return[k,v.join('=')||true];}));
if(!args['confirm-production'])throw Error('Explicit production confirmation required');
const run='cc0695cd-eb9f-43ef-9a3e-1371834fdb7f',base='https://zjgueqijumzlfioihnkt.supabase.co';
const config=JSON.parse(await fs.readFile(String(args['runtime-file']||'/tmp/elring-recovery-runtime.json'),'utf8'));
const key=config.SUPABASE_SERVICE_ROLE_KEY;
if(!key||key.startsWith('****'))throw Error('Runtime credential unavailable');
const phases=String(args.phases||'images,enrichment,lifecycle').split(',');
if(phases.some(p=>!['images','enrichment','lifecycle'].includes(p)))throw Error('Invalid phase');
const batch=Number(args.batch||25),max=Number(args['max-batches']||5000);
if(!Number.isInteger(batch)||batch<1||batch>25||!Number.isInteger(max)||max<1||max>5000)throw Error('Invalid batch budget');
const output=String(args.output||'/Users/ersen/Developer/next-master/artifacts/elring/completion-progress-2026-10-20.json');
const report={started_at:new Date().toISOString(),run_id:run,status:'preflight',jobs:{},batches:0,health:[]};
const save=async()=>{report.updated_at=new Date().toISOString();await fs.writeFile(output+'.tmp',JSON.stringify(report,null,2));await fs.rename(output+'.tmp',output);};
const request=async(path,body,timeoutMs=6000)=>{
 const started=Date.now();const r=await readSafeFetch(base+path,{method:body?'POST':'GET',headers:{apikey:key,authorization:`Bearer ${key}`,'content-type':'application/json'},
  body:body?JSON.stringify(body):undefined,redirect:'error',signal:AbortSignal.timeout(timeoutMs)});
 const text=await r.text();if(!r.ok)throw Error(`HTTP_${r.status}: ${text.slice(0,350)}`);
 return{data:text?JSON.parse(text):null,ms:Date.now()-started};
};
async function health(){
 for(const path of ['/auth/v1/health','/rest/v1/catalog_products?select=id&organization_id=eq.1e4c5e99-e387-41aa-a6d3-cbe74558f766&limit=1']){
  const r=await request(path);report.health.push({path,ms:r.ms,at:new Date().toISOString()});
  if(r.ms>2000)throw Error(`PORTAL_LATENCY_GUARD ${r.ms}ms`);
 }report.health=report.health.slice(-12);
}
try{
 await health();await save();
 const maintenance=()=>maintainIndexes({request,health,run,onResult:async r=>{report.last_maintenance=r.data;await save();}});
 if(args['maintain-before'])await maintenance();
 for(const phase of phases){
  report.phase=phase;
  while(report.batches<max){
   if(report.batches>0&&report.batches%20===0)await maintenance();
   if(report.batches%5===0)await health();
   const r=await request('/rest/v1/rpc/run_elring_completion_batch',{input_run_id:run,input_phase:phase,input_batch_size:batch});
   report.jobs[phase]=r.data;report.batches++;report.last_batch_ms=r.ms;report.status=r.data.status;await save();
   if(report.batches%25===0||r.data.status==='completed')console.log(JSON.stringify({phase,status:r.data.status,processed:r.data.processed,changed:r.data.changed,totals:r.data.totals,ms:r.ms}));
   if(r.ms>2000)throw Error(`COMPLETION_LATENCY_GUARD ${r.ms}ms`);
   if(r.data.status==='completed')break;
   await sleep(150);
  }
  if(report.jobs[phase]?.status!=='completed')throw Error('Cohort budget exhausted; inspect durable job before continuation');
 }
 await health();report.status='completed';await save();
}catch(e){report.status='stopped';report.error=e.message;await save();console.error(e.message);process.exitCode=1;}
