import {createHash} from 'node:crypto';
import {WILMINK_SUPPORT_SCAN,wilminkSource} from './wilmink-sources.mjs';
import {catalogRowFailure} from './catalog-row-failures.mjs';
import {WILMINK_SCAN,parseWilminkBrandPage,parseWilminkProduct,readWilminkHtml,wilminkReview} from './wilmink-kolbenschmidt.mjs';
import {exactCatalogCode} from './supplier-enrichment-plan.mjs';

export async function runWilminkDiscovery({db,organizationId,job,maxMs=210000,readHtml=readWilminkHtml}:any){
 const support=job.manifest.adapter===WILMINK_SUPPORT_SCAN,config=wilminkSource(support?job.manifest.brand:'Kolbenschmidt');
 const read=(url:string)=>readHtml(url,{brand:config.brand});
 const scope={input_org:organizationId,input_job:job.id,input_token:job.lease_token},started=Date.now();
 const rpc=async(name:string,args:any)=>{const r=await db.rpc(name,args);if(r.error)throw Error(r.error.message);return r.data;};
 const source=await db.from('catalog_external_sources').select('*').eq('organization_id',organizationId).eq('source_key',config.sourceKey).single();
 const found=await db.from('catalog_brand_job_items').select('*').eq('organization_id',organizationId).eq('job_id',job.id).eq('item_index',0).single();
 let checkpoint=found.data?.checkpoint||{};
 const save=(status:any=null,error:any=null)=>rpc('checkpoint_catalog_brand_job',{...scope,input_index:0,input_observation:null,input_checkpoint:checkpoint,input_state:'pending',input_advance:false,input_end_status:status,input_error:error});
 try{
  if(source.error||found.error)throw Error('WILMINK_SOURCE_UNAVAILABLE');
  if(!([WILMINK_SCAN,WILMINK_SUPPORT_SCAN].includes(job.manifest.adapter))||(!support&&config.brand!=='Kolbenschmidt')||job.manifest.brand!==config.brand||job.manifest.source_key!==config.sourceKey||job.mode!=='stage'||!source.data.is_active||!['allowed','internal_review_required'].includes(source.data.license_posture)||source.data.credential_boundary!=='none'||source.data.rate_limit_posture!=='bounded'||source.data.metadata?.brand_engine_read_allowed!==true||!source.data.metadata?.allowed_brands?.includes(config.brand))throw Error('WILMINK_SOURCE_UNAVAILABLE');
  const brand=await db.from('brands').select('id').eq('organization_id',organizationId).eq('name',config.brand).single();if(brand.error)throw Error('WILMINK_BRAND_UNAVAILABLE');
  if(!checkpoint.page){const page=job.manifest.urls?{pageUrl:null,page:null,pageFingerprint:createHash('sha256').update(JSON.stringify(job.manifest.urls)).digest('hex'),urls:job.manifest.urls,nextUrl:null,lastPage:null}:parseWilminkBrandPage(await read(job.manifest.page_url),job.manifest.page_url,config.brand);checkpoint={page,captured:[]};await save();}
  for(let n=checkpoint.captured.length;n<checkpoint.page.urls.length;n++){
   await rpc('heartbeat_catalog_brand_job',scope);const url=checkpoint.page.urls[n];
   try{
    const product=parseWilminkProduct(await read(url),{sourceUrl:url,expectedBrand:config.brand});
    const current=await db.from('catalog_products').select('*').eq('organization_id',organizationId).eq('brand_id',brand.data.id).eq('normalized_code',product.code.replace(/[^a-z0-9]/gi,'').toUpperCase());if(current.error)throw Error(current.error.message);
    const exact=(current.data||[]).filter((p:any)=>exactCatalogCode(p.product_code)===product.code);
    const review=exact.length===1?wilminkReview(product,exact[0]):{...product,fields:{},before:null,unavailable:exact.length?'CATALOG_IDENTITY_AMBIGUOUS':'CATALOG_PRODUCT_NOT_REGISTERED'};
    checkpoint.captured.push(Buffer.byteLength(JSON.stringify(review))>128000?{sourceUrl:url,code:product.code,unavailable:'CATALOG_REVIEW_RECEIPT_TOO_LARGE'}:review);
   }catch(e:any){if(!['WILMINK_HTTP_404','WILMINK_EXACT_IDENTITY_INVALID','WILMINK_DESCRIPTION_MISSING'].includes(e.message)&&!catalogRowFailure(e))throw e;checkpoint.captured.push({sourceUrl:url,unavailable:e.message});}
   await save();
   if(Date.now()-started>=maxMs){await save('paused');return {status:'paused',captured:checkpoint.captured.length};}
  }
  if(support){const counts=new Map<string,number>();for(const v of checkpoint.captured)if(v.code&&!v.unavailable)counts.set(v.code,(counts.get(v.code)||0)+1);for(const v of checkpoint.captured)if((counts.get(v.code)||0)>1){v.fields={};v.unavailable='WILMINK_DUPLICATE_ARTICLE';}await save();}
  const result=await rpc(support?'complete_catalog_wilmink_support':'complete_catalog_wilmink_discovery',{...scope,input_page:checkpoint.page,input_products:checkpoint.captured});
  return {status:'reviewed',...result};
 }catch(e:any){const message=String(e.message||'WILMINK_DISCOVERY_FAILED').slice(0,200),transient=/HTTP_(429|5\d\d)|timeout|abort|fetch failed|ECONN|network/i.test(message)&&Number(job.retry_attempts||0)<4;
  await save(transient?'paused':'failed',message).catch(()=>{});return {status:transient?'paused':'failed',error:message};}
}

export function wilminkProvider(db:any,organizationId:string,brandId:string,brandName='Kolbenschmidt'){const config=wilminkSource(brandName);return {key:config.sourceKey,fetch:async(code:string)=>{
 const current=await db.from('catalog_products').select('id,product_code').eq('organization_id',organizationId).eq('brand_id',brandId).eq('normalized_code',code.replace(/[^a-z0-9]/gi,'').toUpperCase());if(current.error)throw Error(current.error.message);
 const exact=(current.data||[]).filter((p:any)=>exactCatalogCode(p.product_code)===exactCatalogCode(code));if(exact.length!==1)throw Error('CATALOG_IDENTITY_MISSING_OR_AMBIGUOUS');
 const receipt=await db.from('catalog_product_source_records').select('source_url').eq('organization_id',organizationId).eq('catalog_product_id',exact[0].id).eq('source_key',config.sourceKey).order('retrieved_at',{ascending:false}).limit(1).maybeSingle();if(receipt.error)throw Error(receipt.error.message);if(!receipt.data)throw Error('WILMINK_SOURCE_INDEX_MISSING');
 return parseWilminkProduct(await readWilminkHtml(receipt.data.source_url),{sourceUrl:receipt.data.source_url,expectedCode:code,expectedBrand:config.brand});
 }};}
