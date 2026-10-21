import {WILMINK_SOURCE,WILMINK_SCAN,parseWilminkBrandPage,parseWilminkProduct,readWilminkHtml,wilminkReview} from './wilmink-kolbenschmidt.mjs';
import {exactCatalogCode} from './supplier-enrichment-plan.mjs';

export async function runWilminkDiscovery({db,organizationId,job,maxMs=210000,readHtml=readWilminkHtml}:any){
 const scope={input_org:organizationId,input_job:job.id,input_token:job.lease_token},started=Date.now();
 const rpc=async(name:string,args:any)=>{const r=await db.rpc(name,args);if(r.error)throw Error(r.error.message);return r.data;};
 const source=await db.from('catalog_external_sources').select('*').eq('organization_id',organizationId).eq('source_key',WILMINK_SOURCE).single();
 const found=await db.from('catalog_brand_job_items').select('*').eq('organization_id',organizationId).eq('job_id',job.id).eq('item_index',0).single();
 let checkpoint=found.data?.checkpoint||{};
 const save=(status:any=null,error:any=null)=>rpc('checkpoint_catalog_brand_job',{...scope,input_index:0,input_observation:null,input_checkpoint:checkpoint,input_state:'pending',input_advance:false,input_end_status:status,input_error:error});
 try{
  if(source.error||found.error)throw Error('WILMINK_SOURCE_UNAVAILABLE');
  if(job.manifest.adapter!==WILMINK_SCAN||job.manifest.brand!=='Kolbenschmidt'||job.manifest.source_key!==WILMINK_SOURCE||job.mode!=='stage'||!source.data.is_active||!['allowed','internal_review_required'].includes(source.data.license_posture)||source.data.credential_boundary!=='none'||source.data.rate_limit_posture!=='bounded'||source.data.metadata?.brand_engine_read_allowed!==true||!source.data.metadata?.allowed_brands?.includes('Kolbenschmidt'))throw Error('WILMINK_SOURCE_UNAVAILABLE');
  const brand=await db.from('brands').select('id').eq('organization_id',organizationId).eq('name','Kolbenschmidt').single();if(brand.error)throw Error('WILMINK_BRAND_UNAVAILABLE');
  if(!checkpoint.page){checkpoint={page:parseWilminkBrandPage(await readHtml(job.manifest.page_url),job.manifest.page_url),captured:[]};await save();}
  for(let n=checkpoint.captured.length;n<checkpoint.page.urls.length;n++){
   await rpc('heartbeat_catalog_brand_job',scope);const url=checkpoint.page.urls[n];
   try{
    const product=parseWilminkProduct(await readHtml(url),{sourceUrl:url});
    const current=await db.from('catalog_products').select('*').eq('organization_id',organizationId).eq('brand_id',brand.data.id).eq('normalized_code',product.code.replace(/[^a-z0-9]/gi,'').toUpperCase());if(current.error)throw Error(current.error.message);
    const exact=(current.data||[]).filter((p:any)=>exactCatalogCode(p.product_code)===product.code);
    checkpoint.captured.push(exact.length===1?wilminkReview(product,exact[0]):{...product,fields:{},before:null,unavailable:exact.length?'CATALOG_IDENTITY_AMBIGUOUS':'CATALOG_PRODUCT_NOT_REGISTERED'});
   }catch(e:any){if(!['WILMINK_HTTP_404','WILMINK_EXACT_IDENTITY_INVALID','WILMINK_DESCRIPTION_MISSING'].includes(e.message))throw e;checkpoint.captured.push({sourceUrl:url,unavailable:e.message});}
   await save();
   if(Date.now()-started>=maxMs){await save('paused');return {status:'paused',captured:checkpoint.captured.length};}
  }
  const result=await rpc('complete_catalog_wilmink_discovery',{...scope,input_page:checkpoint.page,input_products:checkpoint.captured});
  return {status:'reviewed',...result};
 }catch(e:any){const message=String(e.message||'WILMINK_DISCOVERY_FAILED').slice(0,200),transient=/HTTP_(429|5\d\d)|timeout|abort|fetch failed|ECONN|network/i.test(message)&&Number(job.retry_attempts||0)<4;
  await save(transient?'paused':'failed',message).catch(()=>{});return {status:transient?'paused':'failed',error:message};}
}

export function wilminkProvider(db:any,organizationId:string,brandId:string){return {key:WILMINK_SOURCE,fetch:async(code:string)=>{
 const current=await db.from('catalog_products').select('id,product_code').eq('organization_id',organizationId).eq('brand_id',brandId).eq('normalized_code',code.replace(/[^a-z0-9]/gi,'').toUpperCase());if(current.error)throw Error(current.error.message);
 const exact=(current.data||[]).filter((p:any)=>exactCatalogCode(p.product_code)===exactCatalogCode(code));if(exact.length!==1)throw Error('CATALOG_IDENTITY_MISSING_OR_AMBIGUOUS');
 const receipt=await db.from('catalog_product_source_records').select('source_url').eq('organization_id',organizationId).eq('catalog_product_id',exact[0].id).eq('source_key',WILMINK_SOURCE).order('retrieved_at',{ascending:false}).limit(1).maybeSingle();if(receipt.error)throw Error(receipt.error.message);if(!receipt.data)throw Error('WILMINK_SOURCE_INDEX_MISSING');
 return parseWilminkProduct(await readWilminkHtml(receipt.data.source_url),{sourceUrl:receipt.data.source_url,expectedCode:code});
 }};}
