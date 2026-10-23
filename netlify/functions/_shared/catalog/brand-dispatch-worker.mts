import {brandDispatchSignature} from './brand-dispatch.mts';
export async function continueCatalogBrand({result,...input}:any){
 // A finished worker has released its lease. Chain one signed admission,
 // using the same fair selector and claim fence as the minute watchdog.
 // A duplicate invocation, pause or failure must not create a retry loop.
 if(result?.claimed===false||!['reviewed','completed'].includes(result?.status))return {status:'continuation_not_ready'};
 return dispatchCatalogBrand(input);
}
export async function dispatchCatalogBrand({db,target,send=fetch,now=Date.now}:any){
 const admitted=await db.rpc('admit_catalog_wilmink_application',{});
 if(admitted.error)throw Error('BRAND_DISPATCH_ADMISSION_FAILED');
 const selected=await db.rpc('next_catalog_brand_dispatch',{});
 if(selected.error)throw Error('BRAND_DISPATCH_SELECTION_FAILED');
 const job=selected.data;if(!job)return {status:'idle'};
 if(['paused','failed'].includes(job.status)){
  const resumed=await db.rpc('schedule_catalog_brand_job',{input_org:job.organization_id,input_job:job.id,input_publish:false});
  if(resumed.error)throw Error('BRAND_DISPATCH_RESUME_FAILED');
 }
 const time=String(now());
 const response=await send(target.portal+'/api/catalog-brand-worker-background',{method:'POST',redirect:'error',
  headers:{'content-type':'application/json','x-catalog-time':time,'x-catalog-signature':brandDispatchSignature(target.key,job.id,job.organization_id,time)},
  body:JSON.stringify({jobId:job.id,organizationId:job.organization_id}),signal:AbortSignal.timeout(8000)});
 if(!response.ok)throw Error('BRAND_DISPATCH_HTTP_'+response.status);
 return {status:'dispatched',jobId:job.id};
}
