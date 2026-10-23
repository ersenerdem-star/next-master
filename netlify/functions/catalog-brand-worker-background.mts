import type {Config} from '@netlify/functions';import {createClient} from '@supabase/supabase-js';
import {json,readJson} from './_shared/http.mts';import {supplierCatalogTarget} from './_shared/catalog/supplier-enrichment-worker.mts';
import {requireBrandDispatch} from './_shared/catalog/brand-dispatch.mts';import {runBrandJob} from './_shared/catalog/brand-job-worker.mts';
export default async(req:Request)=>{if(req.method!=='POST')return json({error:'Method not allowed'},405);const target=supplierCatalogTarget(n=>Netlify.env.get(n)??process.env[n]);if(!target){console.warn('BRAND_ENGINE_DISABLED');return json({error:'BRAND_ENGINE_DISABLED'},503);}
 const body=await readJson<{jobId:string;organizationId:string}>(req);try{requireBrandDispatch(req,target.key,body.jobId,body.organizationId);}catch{return json({error:'Forbidden'},403);}
 const db=createClient(target.url,target.key,{auth:{persistSession:false},global:{fetch:(url,init)=>fetch(url,{...init,signal:AbortSignal.timeout(30000)})}});
 try{const result=await runBrandJob({db,organizationId:body.organizationId,jobId:body.jobId});console.info('BRAND_ENGINE_RESULT',{jobId:body.jobId,...result});return json(result);}catch{console.error('BRAND_ENGINE_WORKER_FAILED',{jobId:body.jobId});return json({error:'BRAND_ENGINE_WORKER_FAILED'},500);}};
export const config:Config={path:'/api/catalog-brand-worker-background',method:'POST'};
