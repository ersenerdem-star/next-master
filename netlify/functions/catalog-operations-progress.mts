import type {Config} from '@netlify/functions';
import {createClient} from '@supabase/supabase-js';
import {requireCallerProfile} from './_shared/auth.mts';
import {json,HttpRequestError} from './_shared/http.mts';
import {readCatalogProgress} from './_shared/catalog/operations-progress.mjs';
// One cold-start receipt lets operators verify managed runtime security patches.
// No request, credential or customer data is included.
console.info(JSON.stringify({event:'catalog_progress_runtime',node:process.versions.node,openssl:process.versions.openssl}));
export default async(req:Request)=>{
 if(req.method!=='GET')return json({error:'Method not allowed'},405);
 try{
  const caller=await requireCallerProfile(req,['superadmin','admin']);
  if('error' in caller)return json({error:caller.error},caller.status);
  const brandSearch=new URL(req.url).searchParams.get('brand')?.trim()||'';
  if(brandSearch.length>160)return json({error:'INVALID_BRAND_FILTER'},400);
  const db=createClient(caller.supabaseUrl,caller.serviceRoleKey,{auth:{persistSession:false},global:{fetch:(url,init)=>fetch(url,{...init,signal:AbortSignal.timeout(20000)})}});
  return json(await readCatalogProgress(db,caller.profile.organization_id,brandSearch),200,{'Cache-Control':'no-store'});
 }catch(error){
  if(error instanceof HttpRequestError&&[401,403].includes(error.status))return json({error:'AUTH_REQUIRED'},401);
  return json({error:'CATALOG_PROGRESS_UNAVAILABLE'},503,{'Cache-Control':'no-store'});
 }
};
export const config:Config={path:'/api/catalog-operations-progress'};
