import type {Config} from '@netlify/functions';
import {createClient} from '@supabase/supabase-js';
import {requireCallerProfile} from './_shared/auth.mts';
import {json,readJson} from './_shared/http.mts';
import {assertSource,ELRING} from './_shared/catalog/elring-official-provider.mjs';

export default async(req:Request)=>{
 if(!['GET','POST'].includes(req.method))return json({error:'Method not allowed'},405);
 try{
  const caller=await requireCallerProfile(req,['superadmin']);
  if('error' in caller)return json({error:caller.error},caller.status);
  const org=caller.profile.organization_id;
  const db=createClient(caller.supabaseUrl,caller.serviceRoleKey,{auth:{persistSession:false,autoRefreshToken:false},
    global:{fetch:(url,init)=>fetch(url,{...init,signal:AbortSignal.timeout(30000)})}});
  const source=await db.from('catalog_external_sources').select('*').eq('organization_id',org).eq('source_key',ELRING.sourceKey).maybeSingle();
  let readAllowed=false,publishAllowed=false;
  try{if(source.error)throw source.error;assertSource(source.data);readAllowed=true;
    assertSource(source.data,{publish:true,approvalActor:source.data?.metadata?.approval_actor,approvalReference:source.data?.metadata?.publication_approval_reference});publishAllowed=true;}catch{}
  if(req.method==='GET'){
    const jobs=await db.from('catalog_elring_jobs').select('id,mode,status,total_items,next_index,error_message,created_at,updated_at,lease_expires_at')
      .eq('organization_id',org).order('created_at',{ascending:false}).limit(10);
    if(jobs.error)throw jobs.error;
    const params=new URL(req.url).searchParams;
    const jobId=params.get('jobId')||jobs.data[0]?.id;
    const withValues=params.get('details')==='1';
    const items=jobId?await db.from('catalog_elring_job_items').select('product_code,state,error_message,run_id:checkpoint->>run_id,lifecycle:checkpoint->lifecycle,source_checks:observation->lifecycle->checks,field_status:observation->field_status,limitations:observation->limitations'+(withValues?',source_values:observation->fields':''))
      .eq('organization_id',org).eq('job_id',jobId).order('item_index'): {data:[],error:null};
    if(items.error)throw items.error;
    return json({sourceUrl:ELRING.url,readAllowed,publishAllowed,jobs:jobs.data,items:items.data.map(item=>({
      productCode:item.product_code,state:item.state,error:item.error_message,runId:item.run_id,
      fields:item.field_status||{},sourceChecks:item.source_checks||{},lifecycle:item.lifecycle||null,limitations:item.limitations||[],
      ...(withValues?{values:item.source_values||{}}:{})}))});
  }
  const body=await readJson<{action?:string;codes?:string[];segment?:string;requestId?:string;jobId?:string}>(req);
  const action=body.action;
  if(!['start','resume','publish'].includes(action||''))return json({error:'Invalid Elring action'},400);
  if(!readAllowed)return json({error:'Elring official source is not enabled for observation.'},409);
  if(action==='publish'&&!publishAllowed)return json({error:'Elring publication authorization is not registered.'},409);
  const args=action==='start'?{input_org:org,input_actor:caller.profile.id,input_codes:body.codes,input_segment:body.segment,input_key:body.requestId}
    :{input_org:org,input_job:body.jobId,input_publish:action==='publish'};
  const result=await db.rpc(action==='start'?'start_catalog_elring_job':'schedule_catalog_elring_job',args);
  if(result.error)return json({error:result.error.message},400);
  const job=result.data;
  if(job.status==='queued'){
    // Dispatch only to the configured production/deploy origin, never a
    // caller-controlled Host header. The background handler reauthenticates.
    const origin=Netlify.env.get('DEPLOY_PRIME_URL')||Netlify.env.get('URL');
    if(!origin)return json({job,dispatchPending:true},202);
    try{
      const dispatched=await fetch(new URL('/api/catalog-elring-worker-background',origin),{method:'POST',
        headers:{'content-type':'application/json',authorization:req.headers.get('authorization')||''},
        body:JSON.stringify({jobId:job.id}),signal:AbortSignal.timeout(8000),redirect:'error'});
      if(!dispatched.ok)return json({job,dispatchPending:true},202);
    }catch{return json({job,dispatchPending:true},202);}
  }
  return json({job,dispatchPending:false},202);
 }catch(error){console.error('catalog-elring request failed',error instanceof Error?error.name:'error');return json({error:'Elring catalog request failed. Please retry.'},500);}
};
export const config:Config={path:'/api/catalog-elring'};
