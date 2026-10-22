import {WILMINK_SUPPORT_SCAN} from './wilmink-sources.mjs';
import {safeSupplierOfficialObservation} from './supplier-official-completion.mts';
import {brandOfficialProvider} from './brand-official-provider.mts';
import {brandEngineForSource,assertBrandEngineSource} from './brand-engine-registry.mts';
import {CATALOG_FIELDS,exactCatalogCode,planSupplierCatalogEnrichment} from './supplier-enrichment-plan.mjs';
import {catalogLifecycleReview,catalogReplacementReviewRows} from './catalog-completion-review.mjs';
import {runClaimedSparetoCorrection} from './spareto-correction-worker.mts';
import {SPARETO_CORRECTION_ADAPTER} from './spareto-reviewed-correction.mjs';
import {WILMINK_SCAN,safeWilminkObservation} from './wilmink-kolbenschmidt.mjs';
import {runWilminkDiscovery,wilminkProvider} from './wilmink-discovery-worker.mts';
import {catalogRowFailure} from './catalog-row-failures.mjs';
export async function runBrandJob({db,organizationId,jobId,maxMs=8*60*1000,providerFactory=brandOfficialProvider,delayMs=1100}:any){
 const rpc=async(name:string,args:any)=>{const r=await db.rpc(name,args);if(r.error)throw Error(r.error.message);return r.data;};
 const job=await rpc('claim_catalog_brand_job',{input_org:organizationId,input_job:jobId});if(!job)return {claimed:false};
 if(job.manifest.adapter===SPARETO_CORRECTION_ADAPTER)return runClaimedSparetoCorrection({db,organizationId,job});
 if([WILMINK_SCAN,WILMINK_SUPPORT_SCAN].includes(job.manifest.adapter))return runWilminkDiscovery({db,organizationId,job});
 const started=Date.now(),scope={input_org:organizationId,input_job:jobId,input_token:job.lease_token};
 const def=brandEngineForSource(job.manifest.brand,job.manifest.source_key);let provider=providerFactory(job.manifest.brand);
 const source=await db.from('catalog_external_sources').select('*').eq('organization_id',organizationId).eq('source_key',def.sourceKey).single();
 const brand=await db.from('brands').select('id').eq('organization_id',organizationId).eq('name',job.manifest.brand).single();
 if(def.authority==='distributor'&&!brand.error)provider=wilminkProvider(db,organizationId,brand.data.id,job.manifest.brand);
 for(let index=job.next_index;index<job.total_items;index++){
 const found=await db.from('catalog_brand_job_items').select('*').eq('organization_id',organizationId).eq('job_id',jobId).eq('item_index',index).single();
 if(found.error)throw Error(found.error.message);const item=found.data;let observation=item.observation,checkpoint=item.checkpoint||{};
 const save=(state='observed',advance=false,endStatus:any=null,error:any=null)=>rpc('checkpoint_catalog_brand_job',{...scope,input_index:index,input_observation:observation,input_checkpoint:checkpoint,input_state:state,input_advance:advance,input_end_status:endStatus,input_error:error});
 try{
 if(job.manifest.source_key!==def.sourceKey)throw Error('BRAND_SOURCE_CONFIGURATION_CHANGED');
 if(source.error||brand.error||!provider)throw Error('OFFICIAL_ENGINE_NOT_CONFIGURED');assertBrandEngineSource(source.data,job.manifest.brand,{publish:job.mode==='publish',sourceKey:def.sourceKey});
 await rpc('heartbeat_catalog_brand_job',scope);
 if(!observation){
 if(job.mode!=='stage')throw Error('BRAND_REVIEW_RECEIPT_MISSING');
 const current=await db.from('catalog_products').select('id,product_code,'+CATALOG_FIELDS.join(',')).eq('organization_id',organizationId).eq('brand_id',brand.data.id).eq('normalized_code',item.product_code.replace(/[^a-z0-9]/gi,'').toUpperCase());
 if(current.error)throw Error(current.error.message);const rows=(current.data||[]).filter((p:any)=>exactCatalogCode(p.product_code)===exactCatalogCode(item.product_code));
 if(rows.length!==1){const reason='CATALOG_IDENTITY_MISSING_OR_AMBIGUOUS';observation={brand:job.manifest.brand,sourceKey:def.sourceKey,code:exactCatalogCode(item.product_code),before:{},fields:{},replacements:[],lifecycle:catalogLifecycleReview({}, {unavailable:reason}),observedAt:new Date().toISOString(),unavailable:reason};}else{
 await new Promise(r=>setTimeout(r,delayMs));
 try{const raw=await provider.fetch(item.product_code),safe=def.authority==='distributor'?safeWilminkObservation(raw,item.product_code,job.manifest.brand):safeSupplierOfficialObservation(raw,item.product_code,brand.data.id);
 const plan=planSupplierCatalogEnrichment({existing:rows[0],incoming:safe.fields,phase:'official'});
 observation={brand:job.manifest.brand,sourceKey:def.sourceKey,code:exactCatalogCode(item.product_code),sourceUrl:safe.evidence.sourceUrl,observedAt:safe.evidence.observedAt,fingerprint:safe.evidence.fingerprint,before:rows[0],fields:plan.patch,sourceFields:safe.fields,sourceStatus:raw.sourceStatus||null,lifecycle:safe.evidence.lifecycle,replacements:catalogReplacementReviewRows(safe.evidence.lifecycle,item.product_code),issues:plan.issues,missing:plan.missing,...(def.authority==='distributor'?{authority:'distributor',sourceSku:raw.sourceSku,technicalAttributes:raw.technicalAttributes,imageCandidate:raw.imageCandidate}:{})};
 }catch(e:any){const reason=catalogRowFailure(e);if(!reason)throw e;observation={brand:job.manifest.brand,sourceKey:def.sourceKey,code:exactCatalogCode(item.product_code),before:rows[0],fields:{},replacements:[],lifecycle:catalogLifecycleReview({}, {unavailable:reason}),observedAt:new Date().toISOString(),unavailable:reason};}
 }
 await save();
 }
 if(job.mode==='publish'){await rpc('heartbeat_catalog_brand_job',scope);checkpoint=await rpc('apply_catalog_brand_job_item',{...scope,input_index:index});}
 const pause=index+1<job.total_items&&Date.now()-started>maxMs;await save(job.mode==='publish'?'completed':'reviewed',true,pause?'paused':null);
 if(pause)return {claimed:true,status:'paused'};
 }catch(e:any){const message=String(e.message||'BRAND_SOURCE_FAILED').slice(0,350);const retry=/HTTP[_ ]?(429|5[0-9]{2})|timeout|timed out|abort|fetch failed|ECONN|network/i.test(message)&&Number(job.retry_attempts||0)<4;try{await save('failed',false,retry?'paused':'failed',message);}catch{}return {claimed:true,status:retry?'paused':'failed',error:message};}
 }
 return {claimed:true,status:job.mode==='publish'?'completed':'reviewed'};
}
