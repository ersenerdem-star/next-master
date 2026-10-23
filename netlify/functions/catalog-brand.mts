import type {Config} from '@netlify/functions';
import {createClient} from '@supabase/supabase-js';
import {requireCallerProfile} from './_shared/auth.mts';
import {json,readJson,HttpRequestError} from './_shared/http.mts';
import {brandEngineDefinition,brandEngineForSource,assertBrandEngineSource,brandEngineCapability,matchesBrandEngineJob} from './_shared/catalog/brand-engine-registry.mts';
export default async(req:Request)=>{
 if(!['GET','POST'].includes(req.method))return json({error:'Method not allowed'},405);
 try{
 const caller=await requireCallerProfile(req,['superadmin']);if('error'in caller)return json({error:caller.error},caller.status);
 const org=caller.profile.organization_id,db=createClient(caller.supabaseUrl,caller.serviceRoleKey,{auth:{persistSession:false},global:{fetch:(url,init)=>fetch(url,{...init,signal:AbortSignal.timeout(30000)})}});
 const body=req.method==='POST'?await readJson<any>(req):null,params=new URL(req.url).searchParams,brandName=body?.brand||params.get('brand');
 const brands=await db.from('brands').select('id,name').eq('organization_id',org).order('name');if(brands.error)throw brands.error;
 if(!brandName){const sources=await db.from('catalog_external_sources').select('source_key,is_active,license_posture,credential_boundary,rate_limit_posture,metadata').eq('organization_id',org);if(sources.error)throw sources.error;return json({brands:brands.data.map(b=>{const d=brandEngineDefinition(b.name),s=sources.data.find(s=>s.source_key===d.sourceKey);return {...d,status:brandEngineCapability(d,s)};})});}
 const brand=brands.data.find(b=>b.name===brandName);if(!brand)return json({error:'Brand not registered'},400);
 let def;try{def=brandEngineForSource(brand.name,body?.sourceKey||params.get('sourceKey')||undefined);}catch{return json({error:'BRAND_SOURCE_CONFIGURATION_CHANGED'},400);}
 const wilmink=def.family.startsWith('wilmink_'),support=def.family==='wilmink_support';
 const source=def.sourceKey?await db.from('catalog_external_sources').select('*').eq('organization_id',org).eq('source_key',def.sourceKey).maybeSingle():{data:null,error:null};
 let readAllowed=false,publishAllowed=false;try{if(source.error)throw source.error;assertBrandEngineSource(source.data,brand.name,{sourceKey:def.sourceKey||undefined});readAllowed=true;assertBrandEngineSource(source.data,brand.name,{publish:true,sourceKey:def.sourceKey||undefined});publishAllowed=true;}catch{}
 if(req.method==='GET'){
 let jobQuery=db.from('catalog_brand_jobs').select('id,mode,status,total_items,next_index,error_message,created_at,updated_at,lease_expires_at,manifest').eq('organization_id',org).eq('manifest->>brand',brand.name).eq('manifest->>source_key',def.sourceKey||'');
 if(wilmink)jobQuery=jobQuery.eq('manifest->>adapter','brand-exact.v1');
 const jobs=await jobQuery.order('created_at',{ascending:false}).limit(10);if(jobs.error)throw jobs.error;
 const discovery=wilmink?await db.rpc(support?'get_catalog_wilmink_support_status':'get_catalog_wilmink_status',support?{input_org:org,input_brand:brand.name}:{input_org:org}):{data:null,error:null};if(discovery.error)throw discovery.error;
 if(discovery.data?.failed){const failed=await db.from('catalog_brand_jobs').select('error_message').eq('organization_id',org).eq('manifest->>source_key',def.sourceKey!).eq('manifest->>adapter',support?'wilmink-support-discovery.v1':'wilmink-kolbenschmidt-discovery.v1').eq('status','failed').order('updated_at',{ascending:false}).limit(1).maybeSingle();if(failed.error)throw failed.error;discovery.data.error=failed.data?.error_message;}
 const correction=!support&&['INA','FAG','LUK'].includes(brand.name)?await db.rpc('get_catalog_spareto_correction_status',{input_org:org,input_brand:brand.name}):{data:null,error:null};
 const jobId=params.get('jobId')||jobs.data[0]?.id;
 if(jobId){const selected=await db.from('catalog_brand_jobs').select('id,mode,status,total_items,next_index,error_message,created_at,updated_at,lease_expires_at,manifest').eq('id',jobId).eq('organization_id',org).maybeSingle();if(selected.error||!matchesBrandEngineJob(selected.data,def)||(wilmink&&selected.data?.manifest?.adapter!=='brand-exact.v1'))return json({error:'BRAND_JOB_SCOPE_MISMATCH'},400);if(!jobs.data.some(j=>j.id===jobId)&&selected.data)jobs.data.push(selected.data);}
 const items=jobId?await db.from('catalog_brand_review_items').select('product_code,state,error_message,observation,checkpoint').eq('organization_id',org).eq('job_id',jobId).order('item_index'):{data:[],error:null};if(items.error)throw items.error;
 return json({sourceUrl:def.sourceUrl,capability:{reader:def.reader,family:def.family,engineName:'engineName' in def?def.engineName:undefined,workflow:def.workflow,listingAvailable:'listingAvailable' in def?def.listingAvailable:undefined,automaticApply:wilmink&&source.data?.metadata?.automatic_apply===true,status:brandEngineCapability(def,source.data)},readAllowed,publishAllowed,discovery:discovery.data,correction:correction.error?null:correction.data,jobs:jobs.data,items:(items.data||[]).map(i=>({productCode:i.product_code,state:i.state,error:i.error_message,observation:i.observation,result:i.checkpoint}))});
 }
 if(!readAllowed)return json({error:'OFFICIAL_ENGINE_NOT_CONFIGURED'},409);
 const action=body?.action;
 if(action==='discover'&&wilmink){
  const result=await db.rpc(support?'start_catalog_wilmink_support':'start_catalog_wilmink_scan',{input_org:org,input_actor:caller.profile.id,input_key:body.requestId,...(support?{input_brand:brand.name,input_urls:body.urls||[]}:{} )});if(result.error)return json({error:result.error.message},400);return json({job:result.data,dispatchPending:true},202);
 }
 if(!['start','resume','publish'].includes(action))return json({error:'Invalid action'},400);if(action==='publish'&&!publishAllowed)return json({error:'OFFICIAL_ENGINE_PUBLICATION_NOT_APPROVED'},409);
 if(action!=='start'){const selected=await db.from('catalog_brand_jobs').select('manifest').eq('id',body.jobId).eq('organization_id',org).maybeSingle();if(selected.error||!matchesBrandEngineJob(selected.data,def)||(wilmink&&selected.data?.manifest?.adapter!=='brand-exact.v1'))return json({error:'BRAND_JOB_SCOPE_MISMATCH'},400);}
 const args=action==='start'?{input_org:org,input_actor:caller.profile.id,input_codes:body.codes,input_brand:brand.name,input_key:body.requestId,input_source:def.sourceKey}:{input_org:org,input_job:body.jobId,input_publish:action==='publish'};
 const result=await db.rpc(action==='start'?'start_catalog_brand_job':'schedule_catalog_brand_job',args);if(result.error)return json({error:result.error.message},400);
 // A service-signed scheduled dispatcher owns execution; no user session is
 // required after admission and closing the browser does not stop the job.
 return json({job:result.data,dispatchPending:true},202);
 }catch(e){if(e instanceof HttpRequestError&&[401,403].includes(e.status))return json({error:'AUTH_REQUIRED'},401);console.error('catalog-brand request failed',e instanceof Error?e.name:'error');return json({error:'CATALOG_BRAND_REQUEST_FAILED'},500);}
};
export const config:Config={path:'/api/catalog-brand'};
