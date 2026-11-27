import type {Config} from '@netlify/functions';
import {createClient} from '@supabase/supabase-js';
import {requireCallerProfile} from './_shared/auth.mts';
import {json,readJson} from './_shared/http.mts';
import {requireBrandDispatch} from './_shared/catalog/brand-dispatch.mts';
import {supplierCatalogTarget} from './_shared/catalog/supplier-enrichment-worker.mts';
import {runElringJob} from './_shared/catalog/elring-job-worker.mjs';
export default async(req:Request)=>{
 if(req.method!=='POST')return json({error:'Method not allowed'},405);
 const signed=req.headers.has('x-catalog-signature');
 const body=await readJson<{jobId?:string;organizationId?:string}>(req);
 if(!/^[0-9a-f-]{36}$/i.test(body.jobId||''))return json({error:'Job ID required'},400);
 let url:string,key:string,organizationId:string;
 if(signed){
  const target=supplierCatalogTarget(n=>Netlify.env.get(n)??process.env[n]);
  if(!target)return json({error:'Forbidden'},403);
  organizationId=body.organizationId||'';
  try{requireBrandDispatch(req,target.key,body.jobId!,organizationId,'catalog-elring-engine-v1');}
  catch{return json({error:'Forbidden'},403);}
  ({url,key}=target);
 }else{
  const caller=await requireCallerProfile(req,['superadmin']);
  if('error' in caller)return json({error:caller.error},caller.status);
  url=caller.supabaseUrl;key=caller.serviceRoleKey;organizationId=caller.profile.organization_id;
 }
 const db=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false},
  global:{fetch:(url,init)=>fetch(url,{...init,signal:AbortSignal.timeout(60000)})}});
 const result=await runElringJob({db,organizationId,jobId:body.jobId});
 return json(result);
};
export const config:Config={path:'/api/catalog-elring-worker-background',method:'POST'};
