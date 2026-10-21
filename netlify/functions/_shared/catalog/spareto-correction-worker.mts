import {fetchExactSparetoSecondary} from './spareto-secondary-provider.mjs';
import {planSparetoReviewedCorrection,SPARETO_CORRECTION_SOURCE,SPARETO_CORRECTION_ADAPTER} from './spareto-reviewed-correction.mjs';
import {exactCatalogCode} from './supplier-enrichment-plan.mjs';

export async function runClaimedSparetoCorrection({db,organizationId,job,maxMs=210000,transportWaitMs=125000,wait=(ms:number)=>new Promise(r=>setTimeout(r,ms)),fetchSecondary=fetchExactSparetoSecondary}:any){
 const rpc=async(name:string,args:any)=>{const r=await db.rpc(name,args);if(r.error)throw Error(r.error.message);return r.data;};
 const scope={input_org:organizationId,input_job:job.id,input_token:job.lease_token};
 const started=Date.now();let processed=0;
 for(let index=job.next_index;index<job.total_items;index++){
  const found=await db.from('catalog_brand_job_items').select('*').eq('organization_id',organizationId).eq('job_id',job.id).eq('item_index',index).single();
  if(found.error)throw Error(found.error.message);const item=found.data;let observation=item.observation,checkpoint=item.checkpoint||{};
  const save=(advance=false,endStatus:any=null,error:any=null)=>rpc('checkpoint_catalog_brand_job',{...scope,input_index:index,input_observation:observation,input_checkpoint:checkpoint,input_state:advance?'completed':observation?'observed':'pending',input_advance:advance,input_end_status:endStatus,input_error:error});
  try{
   if(job.manifest.source_key!==SPARETO_CORRECTION_SOURCE||job.manifest.adapter!==SPARETO_CORRECTION_ADAPTER||job.mode!=='publish')throw Error('CORRECTION_MANIFEST_INVALID');
   let reserved=await rpc('reserve_catalog_spareto_correction',scope);
   // Keep this fenced brand lease while an already-running supplemental row
   // drains. Releasing immediately lets its loop reclaim the transport forever.
   const transportDeadline=Math.min(started+maxMs,Date.now()+transportWaitMs);
   while(!reserved&&Date.now()<transportDeadline){
    await wait(2500);await rpc('heartbeat_catalog_brand_job',scope);
    reserved=await rpc('reserve_catalog_spareto_correction',scope);
   }
   if(!reserved){await save(false,'paused');return {status:'paused',reason:'SPARETO_READER_BUSY',processed};}
   await rpc('heartbeat_catalog_brand_job',scope);
   if(!observation){
    const current=await db.from('catalog_products').select('*').eq('organization_id',organizationId).eq('brand_id',job.manifest.brand_id).eq('normalized_code',item.product_code.replace(/[^a-z0-9]/gi,'').toUpperCase());
    if(current.error)throw Error(current.error.message);
    const exact=(current.data||[]).filter((p:any)=>exactCatalogCode(p.product_code)===exactCatalogCode(item.product_code));
    if(exact.length!==1)observation={brand:job.manifest.brand,code:exactCatalogCode(item.product_code),unavailable:'CATALOG_IDENTITY_MISSING_OR_AMBIGUOUS',observedAt:new Date().toISOString()};
    else{
     try{
      const secondary=await fetchSecondary({brand:job.manifest.brand,code:item.product_code,expectedEan:exact[0].ean});
      observation={...secondary,sourceKey:SPARETO_CORRECTION_SOURCE,before:exact[0],proposal:planSparetoReviewedCorrection({brand:job.manifest.brand,code:item.product_code,before:exact[0],observation:secondary})};
     }catch(e:any){
      // An absent, ambiguous or mismatched product is a per-item outcome;
      // a security block or transient transport problem is never bypassed.
      if(!['SPARETO_EXACT_MATCH_NOT_FOUND','SPARETO_EXACT_MATCH_AMBIGUOUS','SPARETO_EXACT_IDENTITY_MISMATCH','SPARETO_EAN_IDENTITY_CONFLICT','SPARETO_SEARCH_BOUND_EXCEEDED','SPARETO_HTTP_404'].includes(e.message))throw e;
      observation={brand:job.manifest.brand,code:exactCatalogCode(item.product_code),before:exact[0],unavailable:e.message,requestEvidence:e.evidence||{},observedAt:new Date().toISOString()};
     }
    }
    await save(); // Seal source/before/proposal before the separate application.
   }
   checkpoint=await rpc('apply_catalog_spareto_correction_item',{...scope,input_index:index});
   if(checkpoint.status==='deferred'){await save(false,'paused');return {status:'paused',reason:checkpoint.reason,processed};}
   const pause=index+1<job.total_items&&Date.now()-started>=maxMs;
   await save(true,pause?'paused':null);processed++;
   if(pause)return {status:'paused',processed};
  }catch(e:any){
   const message=String(e.message||'CORRECTION_FAILED').slice(0,180);
   const transient=/HTTP[_ ]?(429|5[0-9]{2})|timeout|abort|fetch failed|ECONN|network/i.test(message)&&Number(job.retry_attempts||0)<4;
   await save(false,transient?'paused':'failed',message).catch(()=>{});
   return {status:transient?'paused':'failed',error:message,processed};
  }
 }
 return {status:'completed',processed};
}
