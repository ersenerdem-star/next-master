import fs from 'node:fs/promises';
import {setTimeout as sleep} from 'node:timers/promises';
// Operator runner only; no scheduler, automatic retries, source activation or
// base-publication resume. Server-side job owns the durable cursor and audit.
const args=Object.fromEntries(process.argv.slice(2).map(a=>{const [k,...v]=a.replace(/^--/,'').split('=');return[k,v.join('=')||true];}));
if(!args['confirm-production']||!args['run-id'])throw Error('Explicit production confirmation and run-id required');
const run=String(args['run-id']);
if(!/^[a-f0-9-]{36}$/.test(run))throw Error('Invalid run-id');
const base='https://zjgueqijumzlfioihnkt.supabase.co';
const key=String(process.env.SUPABASE_SERVICE_ROLE_KEY||await fs.readFile(String(args['key-file']||'/tmp/elring-image-service-key'),'utf8')).trim();
if(!key||key.includes('\n'))throw Error('Invalid service credential');
const headers={apikey:key,authorization:`Bearer ${key}`,'content-type':'application/json'};
const output=String(args.output||'/Users/ersen/Developer/next-master/artifacts/elring/image-fill-status-2026-10-20.json');
const report={run_id:run,started_at:new Date().toISOString(),status:'preflight',batches:0,health:[],last_job:null};
const save=async()=>{report.updated_at=new Date().toISOString();await fs.writeFile(output+'.tmp',JSON.stringify(report,null,2));await fs.rename(output+'.tmp',output);};
async function request(path,options={}){
 const started=Date.now();
 const response=await fetch(base+path,{...options,headers,redirect:'error',signal:AbortSignal.timeout(6000)});
 const body=await response.text();
 if(!response.ok)throw Error(`HTTP_${response.status}: ${body.slice(0,300)}`);
 return {data:body?JSON.parse(body):null,ms:Date.now()-started};
}
async function health(){
 for(const path of ['/auth/v1/health','/rest/v1/catalog_products?select=id&organization_id=eq.1e4c5e99-e387-41aa-a6d3-cbe74558f766&limit=1']){
  const result=await request(path);report.health.push({path,ms:result.ms,at:new Date().toISOString()});
  if(result.ms>2000)throw Error(`PORTAL_LATENCY_GUARD: ${path} ${result.ms}ms`);
 }
 report.health=report.health.slice(-12);
}
try{
 await health();await save();
 const max=Number(args['max-batches']||1000),batch=Number(args.batch||25);
 if(!Number.isInteger(max)||max<1||max>1000||!Number.isInteger(batch)||batch<1||batch>25)throw Error('Invalid batch budget');
 for(let i=0;i<max;i++){
  if(i&&i%5===0)await health();
  const result=await request('/rest/v1/rpc/fill_approved_elring_images',{method:'POST',body:JSON.stringify({input_run_id:run,input_batch_size:batch})});
  report.last_job=result.data;report.batches++;report.last_batch_ms=result.ms;report.status=result.data.status;await save();
  if(i%25===0||result.data.status==='completed')console.log(JSON.stringify({status:result.data.status,scanned:result.data.scanned,applied:result.data.applied,batch_ms:result.ms}));
  if(result.ms>2000)throw Error(`PUBLICATION_LATENCY_GUARD: ${result.ms}ms`);
  if(result.data.status==='completed')break;
  await sleep(150);
 }
 await health();await save();
}catch(error){report.status='stopped';report.error=error.message;await save();console.error(error.message);process.exitCode=1;}
