import {fetchKnorrDiscoveryPage} from './knorr-discovery.mjs';
import {assertBrandEngineSource} from './brand-engine-registry.mts';
export const KNORR_DISCOVERY_ADAPTER='knorr-official-discovery.v1';
// One bounded page is an independently leased review item. No result is
// interpreted as permission to publish or as proof of whole-catalog coverage.
export async function runClaimedKnorrDiscovery({db,organizationId,job,fetchPage=fetchKnorrDiscoveryPage,wait=ms=>new Promise(resolve=>setTimeout(resolve,ms))}:any){
 const scope={input_org:organizationId,input_job:job.id,input_token:job.lease_token};
 const rpc=async(name:string,args:any)=>{const r=await db.rpc(name,args);if(r.error)throw Error(r.error.message);return r.data;};
 try{
  if(job.manifest?.adapter!==KNORR_DISCOVERY_ADAPTER||job.manifest?.brand!=='Knorr-Bremse'||job.manifest?.source_key!=='knorr_bremse_aftermarket'||job.mode!=='stage'||job.total_items!==1||job.next_index!==0||!Number.isSafeInteger(job.manifest.page)||job.manifest.page<0)throw Error('KNORR_DISCOVERY_JOB_INVALID');
  const source=await db.from('catalog_external_sources').select('*').eq('organization_id',organizationId).eq('source_key','knorr_bremse_aftermarket').single();if(source.error)throw Error('KNORR_DISCOVERY_SOURCE_UNAVAILABLE');assertBrandEngineSource(source.data,'Knorr-Bremse');
  await rpc('heartbeat_catalog_brand_job',scope);
  await wait(1100);
  const page=await fetchPage(job.manifest.page,{previous:job.manifest.previous||undefined});
  if(page.page!==job.manifest.page||page.canonicalWrite!==false||page.complete!==false)throw Error('KNORR_DISCOVERY_RECEIPT_INVALID');
  await rpc('complete_catalog_knorr_discovery',{...scope,input_page:page});
  return {claimed:true,status:'reviewed',page:page.page};
 }catch(e:any){const message=String(e?.message||'KNORR_DISCOVERY_FAILED').slice(0,200);const retry=/HTTP_(429|5\d\d)|timeout|abort|fetch failed|ECONN|network/i.test(message)&&Number(job.retry_attempts||0)<4;
  await rpc('checkpoint_catalog_brand_job',{...scope,input_index:0,input_observation:null,input_checkpoint:{},input_state:'failed',input_advance:false,input_end_status:retry?'paused':'failed',input_error:message}).catch(()=>{});
  return {claimed:true,status:retry?'paused':'failed',error:message};
 }
}
