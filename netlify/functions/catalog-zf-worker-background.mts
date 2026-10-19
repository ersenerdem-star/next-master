import type {Config} from '@netlify/functions';
import {createClient} from '@supabase/supabase-js';
import {requireCallerProfile} from './_shared/auth.mts';
import {json,readJson} from './_shared/http.mts';
import {runZfJob} from './_shared/catalog/zf-job-worker.mjs';
export default async(req:Request)=>{
 if(req.method!=='POST')return json({error:'Method not allowed'},405);
 const caller=await requireCallerProfile(req,['superadmin']);
 if('error' in caller)return json({error:caller.error},caller.status);
 const body=await readJson<{jobId?:string}>(req);
 if(!/^[0-9a-f-]{36}$/i.test(body.jobId||''))return json({error:'Job ID required'},400);
 const db=createClient(caller.supabaseUrl,caller.serviceRoleKey,{auth:{persistSession:false,autoRefreshToken:false},
  global:{fetch:(url,init)=>fetch(url,{...init,signal:AbortSignal.timeout(60000)})}});
 const result=await runZfJob({db,organizationId:caller.profile.organization_id,jobId:body.jobId});
 return json(result);
};
export const config:Config={path:'/api/catalog-zf-worker-background',method:'POST'};
