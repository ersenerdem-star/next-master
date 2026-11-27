import type {Config} from '@netlify/functions';import {createClient} from '@supabase/supabase-js';
import {supplierCatalogTarget} from './_shared/catalog/supplier-enrichment-worker.mts';
import {dispatchCatalogBrand} from './_shared/catalog/brand-dispatch-worker.mts';
import {brandDispatchSignature} from './_shared/catalog/brand-dispatch.mts';
export default async()=>{const read=(n:string)=>Netlify.env.get(n)??process.env[n];const target=supplierCatalogTarget(read);if(!target){console.warn('BRAND_DISPATCH_DISABLED',{enabled:read('SUPPLIER_CATALOG_ENRICHMENT_ENABLED')==='1',keyPresent:Boolean(read('SUPABASE_SERVICE_ROLE_KEY'))});return new Response(null,{status:204});}
 const db=createClient(target.url,target.key,{auth:{persistSession:false},global:{fetch:(url,init)=>fetch(url,{...init,signal:AbortSignal.timeout(12000)})}});
 try {
  const admitted = await db.rpc('admit_catalog_monroe_discovery', {});
  if (admitted.error) console.error('MONROE_DISCOVERY_ADMISSION_FAILED', admitted.error.code);
 } catch { console.error('MONROE_DISCOVERY_ADMISSION_FAILED'); }
 try{console.info(JSON.stringify({event:'BRAND_DISPATCH_RESULT',...await dispatchCatalogBrand({db,target})}));}catch(error){console.error(error instanceof Error?error.message:'BRAND_DISPATCH_FAILED');}
 try {
  const selected=await db.rpc('next_catalog_elring_budget_dispatch', {});
  if(selected.error)throw selected.error;
  const job=selected.data;
  if(job){
   if(job.status==='paused'){
    const ready=await db.rpc('schedule_catalog_elring_job',{input_org:job.organization_id,input_job:job.id,input_publish:false});
    if(ready.error)throw ready.error;
   }
   const time=String(Date.now());
   const sent=await fetch(target.portal+'/api/catalog-elring-worker-background',{
    method:'POST',redirect:'error',signal:AbortSignal.timeout(8000),
    headers:{'content-type':'application/json','x-catalog-time':time,
     'x-catalog-signature':brandDispatchSignature(target.key,job.id,job.organization_id,time,'catalog-elring-engine-v1')},
    body:JSON.stringify({jobId:job.id,organizationId:job.organization_id}),
   });
   if(!sent.ok)throw Error('ELRING_BUDGET_DISPATCH_HTTP_'+sent.status);
  }
 } catch(error) { console.error('ELRING_BUDGET_DISPATCH_FAILED', error instanceof Error ? error.message : undefined); }
 return new Response(null,{status:204});};
export const config:Config={schedule:'* * * * *'};
