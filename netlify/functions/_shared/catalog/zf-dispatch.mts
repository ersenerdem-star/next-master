import {createHmac,timingSafeEqual} from 'node:crypto';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const zfDispatchSignature=(key:string,job:string,org:string,time:string)=>
 createHmac('sha256',key).update(`catalog-zf-lifecycle-v1\n${job}\n${org}\n${time}`).digest('hex');

export function requireZfDispatch(req:Request,key:string,job:string,org:string){
 const time=req.headers.get('x-catalog-time')||'';
 const signature=req.headers.get('x-catalog-signature')||'';
 if(!UUID.test(job)||!UUID.test(org)||!/^\d{13}$/.test(time)||Math.abs(Date.now()-Number(time))>90000
  ||!/^[a-f0-9]{64}$/.test(signature)
  ||!timingSafeEqual(Buffer.from(signature,'hex'),Buffer.from(zfDispatchSignature(key,job,org,time),'hex')))
  throw Error('ZF_DISPATCH_DENIED');
}

export async function dispatchZfLifecycle({db,target,send=fetch,now=Date.now}:any){
 const current=await db.from('catalog_zf_jobs').select('id,status,lease_expires_at')
  .eq('manifest->>scope','lifecycle').eq('status','running').gt('lease_expires_at',new Date(now()).toISOString()).limit(1);
 if(current.error)throw Error('ZF_DISPATCH_ACTIVE_CHECK_FAILED');
 if(current.data?.length)return {status:'busy'};
 const pending=await db.from('catalog_zf_jobs').select('id,organization_id,status,created_at')
  .eq('manifest->>scope','lifecycle').in('status',['queued','paused'])
  .order('created_at',{ascending:true}).limit(1);
 if(pending.error)throw Error('ZF_DISPATCH_PENDING_CHECK_FAILED');
 const expired=await db.from('catalog_zf_jobs').select('id,organization_id,status,created_at')
  .eq('manifest->>scope','lifecycle').eq('status','running')
  .lt('lease_expires_at',new Date(now()).toISOString())
  .order('created_at',{ascending:true}).limit(1);
 if(expired.error)throw Error('ZF_DISPATCH_EXPIRED_CHECK_FAILED');
 let job=[...(pending.data||[]),...(expired.data||[])].sort((a,b)=>a.created_at.localeCompare(b.created_at))[0];
 if(!job){
  const sources=await db.from('catalog_external_sources').select('organization_id')
   .eq('source_key','zf_group_official_v2').eq('is_active',true).limit(20);
  if(sources.error)throw Error('ZF_DISPATCH_SOURCE_CHECK_FAILED');
  for(const source of sources.data||[]){
   const created=await db.rpc('enqueue_next_catalog_zf_lifecycle_job',{input_org:source.organization_id});
   if(created.error)throw Error('ZF_DISPATCH_PACKAGE_FAILED');
   if(created.data){job={...created.data,organization_id:source.organization_id};break;}
  }
 }
 if(!job)return {status:'idle'};
 if(job.status==='paused'){
  const resumed=await db.rpc('schedule_catalog_zf_job',{input_org:job.organization_id,input_job:job.id,input_publish:false});
  if(resumed.error)throw Error('ZF_DISPATCH_RESUME_FAILED');
 }
 const time=String(now());
 const response=await send(target.portal+'/api/catalog-zf-worker-background',{
  method:'POST',redirect:'error',headers:{'content-type':'application/json','x-catalog-time':time,
   'x-catalog-signature':zfDispatchSignature(target.key,job.id,job.organization_id,time)},
  body:JSON.stringify({jobId:job.id,organizationId:job.organization_id}),signal:AbortSignal.timeout(8000),
 });
 if(!response.ok)throw Error('ZF_DISPATCH_HTTP_'+response.status);
 return {status:'dispatched',jobId:job.id};
}
