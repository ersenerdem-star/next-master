import {ELRING, assertSource, readElringArticle} from './elring-official-provider.mjs';
import {budgetedCatalogFetch,CatalogSourceDeferred,deferCatalogSourceJob} from './source-request-budget.mts';
import {processPackage} from './elring-provider-package.mjs';

export async function runElringJob({db,organizationId,jobId,fetchImpl=fetch,readArticle=readElringArticle,process=processPackage,maxMs=11*60*1000}) {
  const rpc=async(name,args)=>{const r=await db.rpc(name,args);if(r.error)throw Object.assign(Error(r.error.message),{code:r.error.code});return r.data;};
  const job=await rpc('claim_catalog_elring_job',{input_org:organizationId,input_job:jobId});
  if(!job)return {claimed:false};
  const started=Date.now();
  const request=budgetedCatalogFetch(db,'tecalliance',fetchImpl);
  const scope={input_org:organizationId,input_job:jobId,input_token:job.lease_token};
  const heartbeat=async()=>rpc('heartbeat_catalog_elring_job',{input_org:organizationId,input_job:jobId,input_token:job.lease_token});
  const source=await db.from('catalog_external_sources').select('*').eq('organization_id',organizationId).eq('source_key',ELRING.sourceKey).single();
  const bounded=job.manifest.adapter==='elring-bounded-review.v1';
  const brand=await db.from('brands').select('id').eq('organization_id',organizationId).eq('name',ELRING.brand).single();
  for(let index=job.next_index;index<job.total_items;index++) {
    const found=await db.from('catalog_elring_job_items').select('*').eq('organization_id',organizationId).eq('job_id',jobId).eq('item_index',index).single();
    if(found.error)throw Error(found.error.message);
    const item=found.data;
    let observation=item.observation;
    const checkpoint=item.checkpoint || {};
    const save=async(state='processing',advance=false,endStatus=null,error=null)=>rpc('checkpoint_catalog_elring_job',{
      input_org:organizationId,input_job:jobId,input_token:job.lease_token,input_index:index,input_observation:observation,
      input_checkpoint:checkpoint,input_state:state,input_advance:advance,input_end_status:endStatus,input_error:error});
    try {
      if(source.error||brand.error)throw Error('Elring source or brand unavailable');
      assertSource(source.data,{publish:job.mode==='publish',approvalActor:source.data.metadata?.approval_actor,
        approvalReference:source.data.metadata?.publication_approval_reference});
      if((bounded&&job.mode!=='stage')||(source.data.metadata?.bounded_review_only===true&&!bounded))throw Error('ELRING_BOUNDED_REVIEW_SCOPE');
      if(!observation) {
        await new Promise(resolve=>setTimeout(resolve,1100));
        observation=await readArticle(item.product_code,{defaultMarketSegment:job.manifest.segment,withFitment:true,
          fitmentMaxRequests:job.manifest.fitment_max_requests,
          fetchImpl:async(url,options)=>{
            if(Date.now()-started>maxMs)throw Error('ELRING_TIME_WINDOW');
            await heartbeat();return request(url,options);
          }});
        if(!bounded)await save('observed');
      }
      if(bounded){
        // The job receipt is the review record. No generic staging or product
        // writer runs on this lane.
        observation={...observation,fitment:observation.fitment?{
          complete:observation.fitment.complete,requests:observation.fitment.requests,
          vehicle_count:observation.fitment.vehicles?.length||0,
          evidence:observation.fitment.evidence?.map(({request,retrieved_at,response_fingerprint})=>({
            method:Object.keys(request)[0],retrieved_at,response_fingerprint,
          })),
        }:null};
        if(Buffer.byteLength(JSON.stringify(observation))>512*1024)throw Error('ELRING_REVIEW_RECEIPT_TOO_LARGE');
        checkpoint.state='reviewed';
        await save('reviewed',true);
        continue;
      }
      // Lease-check every database mutation too; an expired worker cannot
      // continue publishing after another invocation takes ownership.
      const guardedDb={from:db.from.bind(db),rpc:async(name,args)=>{await heartbeat();return db.rpc(name,args);}};
      await process({db:guardedDb,organizationId,brandId:brand.data.id,observations:[observation],
        collectionKey:`elring-ui-${jobId}-${index}`,publish:job.mode==='publish',
        approvalActor:source.data.metadata?.approval_actor,approvalReference:source.data.metadata?.publication_approval_reference,
        checkpoint,save:()=>save()});
      const endStatus=index+1<job.total_items && Date.now()-started>maxMs?'paused':null;
      await save(job.mode==='publish'?'completed':'reviewed',true,endStatus);
      if(endStatus)return {claimed:true,status:'paused'};
    }catch(error){
      if(['55P03','57014','40P01','40001'].includes(error?.code)){
        const status=await rpc('defer_catalog_elring_lock_wait',scope);
        return {claimed:true,status,error:'ELRING_REVIEW_DATABASE_BUSY'};
      }
      if(error instanceof CatalogSourceDeferred)return deferCatalogSourceJob(db,scope,error,'defer_catalog_elring_source_request');
      const message=String(error?.message||'Elring package failed').slice(0,500);
      const status=message==='ELRING_TIME_WINDOW'?'paused':'failed';
      try{await save('failed',false,status,message);}catch{/* A lost lease must not be overwritten. */}
      return {claimed:true,status,error:message};
    }
  }
  return {claimed:true,status:job.mode==='publish'?'completed':'reviewed'};
}
