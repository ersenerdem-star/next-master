import {readZfOfficialProduct} from './zf-aftermarket-sync.mts';
import {requireZfBrand,exactZfCode} from './zf-product-identity.mjs';
export const ZF_SOURCE='zf_group_official_v2';
export function assertZfSource(source,brand,{apply=false}={}){
 requireZfBrand(brand);
 if(source?.source_key!==ZF_SOURCE||!source.is_active||!['allowed','internal_review_required'].includes(source.license_posture)
  ||source.credential_boundary!=='none'||source.rate_limit_posture!=='bounded'||source.base_url!=='https://aftermarket.zf.com'
  ||source.metadata?.automated_read_only_approved!==true||source.metadata?.internal_observation_allowed!==true
  ||!source.metadata?.allowed_brands?.includes(brand))throw Error('ZF_SOURCE_NOT_AUTHORIZED');
 if(apply&&(source.metadata?.internal_catalog_correction_allowed!==true||!source.metadata?.approval_actor||!source.metadata?.publication_approval_reference))throw Error('ZF_CORRECTION_NOT_AUTHORIZED');
}
const notFound=error=>String(error?.message||'')==='OFFICIAL_EXACT_MATCH_NOT_FOUND';
/** Collect once; later applications use the same immutable source and reviewed before-values. */
export async function collectZfObservation({brand,code,before,readArticle=readZfOfficialProduct,fetchImpl=fetch}){
 let observation;try{observation=await readArticle(brand,code,15000,fetchImpl);}catch(e){if(notFound(e))return{brand,code,before,unavailable:'OFFICIAL_EXACT_MATCH_NOT_FOUND',observedAt:new Date().toISOString()};throw e;}
 const replacements=[];
 for(const candidate of observation.replacementCandidates){
  if(candidate.brand&&candidate.brand.normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase()!==brand.toLowerCase()){
   replacements.push({...candidate,error:'TARGET_BRAND_CONFLICT'});continue;}
  try{const target=await readArticle(brand,candidate.code,15000,fetchImpl);
   replacements.push({...candidate,target:{brand:target.brand,code:target.code,raw:{details:{number:target.raw.details.number,brandName:target.raw.details.brandName,status:target.raw.details.status}},sourceUrl:target.sourceUrl}});
  }catch(e){if(notFound(e))replacements.push({...candidate,error:'TARGET_IDENTITY_NOT_VERIFIED'});else throw e;}
 }
 const receipt={...observation,before,replacements};
 if(new TextEncoder().encode(JSON.stringify(receipt)).byteLength>5*1024*1024)throw Error('ZF_OBSERVATION_TOO_LARGE');
 return receipt;
}
export async function runZfJob({db,organizationId,jobId,fetchImpl=fetch,readArticle=readZfOfficialProduct,maxMs=10*60*1000,requestDelayMs=1100}){
 const rpc=async(name,args)=>{const r=await db.rpc(name,args);if(r.error)throw Error(r.error.message);return r.data;};
 const job=await rpc('claim_catalog_zf_job',{input_org:organizationId,input_job:jobId});if(!job)return{claimed:false};
 const started=Date.now();const heartbeat=()=>rpc('heartbeat_catalog_zf_job',{input_org:organizationId,input_job:jobId,input_token:job.lease_token});
 const source=await db.from('catalog_external_sources').select('*').eq('organization_id',organizationId).eq('source_key',ZF_SOURCE).single();
 const brand=await db.from('brands').select('id').eq('organization_id',organizationId).eq('name',job.manifest.brand).single();
 for(let index=job.next_index;index<job.total_items;index++){
  const found=await db.from('catalog_zf_job_items').select('*').eq('organization_id',organizationId).eq('job_id',jobId).eq('item_index',index).single();
  if(found.error)throw Error(found.error.message);const item=found.data;let observation=item.observation;let checkpoint=item.checkpoint||{};
  const save=(state='observed',advance=false,endStatus=null,error=null)=>rpc('checkpoint_catalog_zf_job',{
   input_org:organizationId,input_job:jobId,input_token:job.lease_token,input_index:index,input_observation:observation,
   input_checkpoint:checkpoint,input_state:state,input_advance:advance,input_end_status:endStatus,input_error:error});
  try{
   if(source.error||brand.error)throw Error('ZF_SOURCE_OR_BRAND_UNAVAILABLE');assertZfSource(source.data,job.manifest.brand,{apply:job.mode==='publish'});
   if(!observation){
    if(job.mode!=='stage')throw Error('ZF_REVIEW_RECEIPT_MISSING');
    const current=await db.from('catalog_products').select('id,product_code,description,weight_kg,ean,origin,hs_code,lifecycle_status,lifecycle_note,updated_at')
     .eq('organization_id',organizationId).eq('brand_id',brand.data.id).eq('normalized_code',item.product_code.replace(/[^a-z0-9]/gi,'').toUpperCase());
    if(current.error)throw Error(current.error.message);
    const exact=(current.data||[]).filter(p=>exactZfCode(p.product_code)===exactZfCode(item.product_code));
    if(exact.length!==1)throw Error('ZF_CATALOG_IDENTITY_MISSING_OR_AMBIGUOUS');
    observation=await collectZfObservation({brand:job.manifest.brand,code:item.product_code,before:exact[0],readArticle,
     fetchImpl:async(url,init)=>{
      if(Date.now()-started>maxMs)throw Error('ZF_TIME_WINDOW');
      if(requestDelayMs)await new Promise(resolve=>setTimeout(resolve,requestDelayMs));await heartbeat();
      return fetchImpl(url,init);
     }});
    await save();
   }
   if(job.mode==='publish'){
    await heartbeat();checkpoint=await rpc('apply_catalog_zf_job_item',{input_org:organizationId,input_job:jobId,input_token:job.lease_token,input_index:index});
   }
   const pause=index+1<job.total_items&&Date.now()-started>maxMs;
   await save(job.mode==='publish'?'completed':'reviewed',true,pause?'paused':null);
   if(pause)return{claimed:true,status:'paused'};
  }catch(error){
   const message=String(error?.message||'ZF_REQUEST_FAILED').slice(0,350);
   const status=message==='ZF_TIME_WINDOW'?'paused':'failed';
   try{await save('failed',false,status,`${job.manifest.brand} / ${item.product_code}: ${message}`);}catch{/* A lost lease cannot overwrite another owner. */}
   return{claimed:true,status,error:message};
  }
 }
 return{claimed:true,status:job.mode==='publish'?'completed':'reviewed'};
}
