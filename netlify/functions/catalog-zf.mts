import type {Config} from '@netlify/functions';
import {createClient} from '@supabase/supabase-js';
import {requireCallerProfile} from './_shared/auth.mts';
import {json,readJson} from './_shared/http.mts';
import {assertZfSource,ZF_SOURCE} from './_shared/catalog/zf-job-worker.mjs';
import {requireZfBrand} from './_shared/catalog/zf-product-identity.mjs';

export default async(req:Request)=>{
 if(!['GET','POST'].includes(req.method))return json({error:'Method not allowed'},405);
 try{
  const caller=await requireCallerProfile(req,['superadmin']);
  if('error' in caller)return json({error:caller.error},caller.status);
  const org=caller.profile.organization_id;
  const db=createClient(caller.supabaseUrl,caller.serviceRoleKey,{auth:{persistSession:false,autoRefreshToken:false},
    global:{fetch:(url,init)=>fetch(url,{...init,signal:AbortSignal.timeout(30000)})}});
  const source=await db.from('catalog_external_sources').select('*').eq('organization_id',org).eq('source_key',ZF_SOURCE).maybeSingle();
  const params=new URL(req.url).searchParams;
  let brandName=params.get('brand')||'Sachs';
  const body=req.method==='POST'?await readJson<{action?:string;codes?:string[];brand?:string;requestId?:string;jobId?:string}>(req):null;
  if(body?.brand)brandName=body.brand;
  brandName=requireZfBrand(brandName);
  let readAllowed=false,publishAllowed=false;
  try{if(source.error)throw source.error;assertZfSource(source.data,brandName);readAllowed=true;
    assertZfSource(source.data,brandName,{apply:true});publishAllowed=true;}catch{}
  if(req.method==='GET'){
    const jobs=await db.from('catalog_zf_jobs').select('id,mode,status,total_items,next_index,error_message,created_at,updated_at,lease_expires_at,manifest')
      .eq('organization_id',org).eq('manifest->>brand',brandName).order('created_at',{ascending:false}).limit(10);
    if(jobs.error)throw jobs.error;
    const jobId=params.get('jobId')||jobs.data[0]?.id;
    const items=jobId?await db.from('catalog_zf_review_items').select('product_code,state,error_message,observation,checkpoint')
      .eq('organization_id',org).eq('job_id',jobId).order('item_index'): {data:[],error:null};
    if(items.error)throw items.error;
    return json({sourceUrl:'https://aftermarket.zf.com/en/aftermarket-portal/',readAllowed,publishAllowed,jobs:jobs.data,items:items.data.map(item=>({
      productCode:item.product_code,state:item.state,error:item.error_message,observation:item.observation,result:item.checkpoint
    }))});
  }

  const action=body!.action;
  if(!['start','resume','publish'].includes(action||''))return json({error:'Invalid ZF action'},400);
  if(!readAllowed)return json({error:'ZF official source is not enabled for observation.'},409);
  if(action==='publish'&&!publishAllowed)return json({error:'ZF publication authorization is not registered.'},409);
  const args=action==='start'?{input_org:org,input_actor:caller.profile.id,input_codes:body!.codes,input_brand:brandName,input_key:body!.requestId}
    :{input_org:org,input_job:body!.jobId,input_publish:action==='publish'};
  const result=await db.rpc(action==='start'?'start_catalog_zf_job':'schedule_catalog_zf_job',args);
  if(result.error)return json({error:result.error.message},400);
  const job=result.data;
  if(job.status==='queued'){
    // Dispatch only to the configured production/deploy origin, never a
    // caller-controlled Host header. The background handler reauthenticates.
    const origin=Netlify.env.get('DEPLOY_PRIME_URL')||Netlify.env.get('URL');
    if(!origin)return json({job,dispatchPending:true},202);
    try{
      const dispatched=await fetch(new URL('/api/catalog-zf-worker-background',origin),{method:'POST',
        headers:{'content-type':'application/json',authorization:req.headers.get('authorization')||''},
        body:JSON.stringify({jobId:job.id}),signal:AbortSignal.timeout(8000),redirect:'error'});
      if(!dispatched.ok)return json({job,dispatchPending:true},202);
    }catch{return json({job,dispatchPending:true},202);}
  }
  return json({job,dispatchPending:false},202);
 }catch(error){console.error('catalog-zf request failed',error instanceof Error?error.name:'error');return json({error:'ZF catalog request failed. Please retry.'},500);}
};
export const config:Config={path:'/api/catalog-zf'};
