import {brandDispatchSignature} from './brand-dispatch.mts';
export async function dispatchCatalogBrand({db,target,send=fetch,now=Date.now}:any){
 const selected=await db.rpc('next_catalog_brand_dispatch',{});
 if(selected.error)throw Error('BRAND_DISPATCH_SELECTION_FAILED');
 const job=selected.data;if(!job)return {status:'idle'};
 if(job.status==='paused'){
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
