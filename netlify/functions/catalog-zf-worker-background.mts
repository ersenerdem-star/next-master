import type {Config} from '@netlify/functions';
import {createClient} from '@supabase/supabase-js';
import {requireCallerProfile} from './_shared/auth.mts';
import {json,readJson} from './_shared/http.mts';
import {runZfJob} from './_shared/catalog/zf-job-worker.mjs';
import {requireZfDispatch} from './_shared/catalog/zf-dispatch.mts';
import {supplierCatalogTarget} from './_shared/catalog/supplier-enrichment-worker.mts';
export default async(req:Request)=>{
 if(req.method!=='POST')return json({error:'Method not allowed'},405);
 const body=await readJson<{jobId?:string;organizationId?:string}>(req);
 if(!/^[0-9a-f-]{36}$/i.test(body.jobId||''))return json({error:'Job ID required'},400);
 let organizationId:string,supabaseUrl:string,serviceRoleKey:string;
 if(req.headers.has('x-catalog-signature')){
  const target=supplierCatalogTarget(name=>Netlify.env.get(name)??process.env[name]);
  if(!target)return json({error:'ZF worker disabled'},503);
  try{requireZfDispatch(req,target.key,body.jobId!,body.organizationId||'');}
  catch{return json({error:'Forbidden'},403);}
  organizationId=body.organizationId!;supabaseUrl=target.url;serviceRoleKey=target.key;
 }else{
  const caller=await requireCallerProfile(req,['superadmin']);
  if('error' in caller)return json({error:caller.error},caller.status);
  organizationId=caller.profile.organization_id;supabaseUrl=caller.supabaseUrl;serviceRoleKey=caller.serviceRoleKey;
 }
 const db=createClient(supabaseUrl,serviceRoleKey,{auth:{persistSession:false,autoRefreshToken:false},
  global:{fetch:(url,init)=>fetch(url,{...init,signal:AbortSignal.timeout(60000)})}});
 const result=await runZfJob({db,organizationId,jobId:body.jobId});
 return json(result);
};
export const config:Config={path:'/api/catalog-zf-worker-background',method:'POST'};
