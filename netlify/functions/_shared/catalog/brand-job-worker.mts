import {createHash} from 'node:crypto';
import {WILMINK_SUPPORT_SCAN} from './wilmink-sources.mjs';
import {safeSupplierOfficialObservation} from './supplier-official-completion.mts';
import {brandOfficialProvider} from './brand-official-provider.mts';
import {brandEngineForSource,assertBrandEngineSource} from './brand-engine-registry.mts';
import {CATALOG_FIELDS,exactCatalogCode,planSupplierCatalogEnrichment} from './supplier-enrichment-plan.mjs';
import {KNORR_DISCOVERY_ADAPTER,runClaimedKnorrDiscovery} from './knorr-discovery-worker.mts';
import {assessKnorrRecordedOwnership} from './knorr-code-identity.mjs';
import {fetchKnorrWilminkReview} from './knorr-wilmink-review.mjs';
import {fetchExactSparetoSecondary,fetchSparetoSecondaryPage} from './spareto-secondary-provider.mjs';
import {catalogLifecycleReview,catalogReplacementReviewRows,planSparetoMissingCompletion} from './catalog-completion-review.mjs';
import {runClaimedSparetoCorrection} from './spareto-correction-worker.mts';
import {SPARETO_CORRECTION_ADAPTER} from './spareto-reviewed-correction.mjs';
import {WILMINK_SCAN,safeWilminkObservation} from './wilmink-kolbenschmidt.mjs';
import {runWilminkDiscovery,wilminkProvider} from './wilmink-discovery-worker.mts';
import {catalogRowFailure} from './catalog-row-failures.mjs';
export async function runBrandJob({db,organizationId,jobId,maxMs=8*60*1000,providerFactory=brandOfficialProvider,fetchSecondary=fetchExactSparetoSecondary,fetchSecondaryPage=fetchSparetoSecondaryPage,fetchWilmink=fetchKnorrWilminkReview,delayMs=1100}:any){
 const rpc=async(name:string,args:any)=>{const r=await db.rpc(name,args);if(r.error)throw Error(r.error.message);return r.data;};
 const job=await rpc('claim_catalog_brand_job',{input_org:organizationId,input_job:jobId});if(!job)return {claimed:false};
 if(job.manifest.adapter===KNORR_DISCOVERY_ADAPTER)return runClaimedKnorrDiscovery({db,organizationId,job});
 if(job.manifest.adapter===SPARETO_CORRECTION_ADAPTER)return runClaimedSparetoCorrection({db,organizationId,job});
 if([WILMINK_SCAN,WILMINK_SUPPORT_SCAN].includes(job.manifest.adapter))return runWilminkDiscovery({db,organizationId,job});
 const started=Date.now(),scope={input_org:organizationId,input_job:jobId,input_token:job.lease_token};
 const def=brandEngineForSource(job.manifest.brand,job.manifest.source_key);let provider=providerFactory(job.manifest.brand);
 const source=await db.from('catalog_external_sources').select('*').eq('organization_id',organizationId).eq('source_key',def.sourceKey).single();
 const monroe=def.family==='monroe';
 const monroeFitment=monroe&&job.manifest.monroe_policy==='monroe-fitment-fill.v1';
 const monroeVehicles=new Map();
 const monroeImageOnly=monroe&&job.manifest.monroe_policy==='monroe-image-fill.v1';
 const knorrAutomatic=def.family==='knorr_bremse'&&job.manifest.automatic_application?.policy==='knorr-official-missing-only.v1'&&Boolean(job.manifest.discovery_job);
 const automatic=def.authority==='distributor'&&job.manifest.automatic_application?.policy==='wilmink-missing-only.v1'&&Boolean(job.manifest.discovery_job);
 const brand=await db.from('brands').select('id').eq('organization_id',organizationId).eq('name',job.manifest.brand).single();
 if(def.authority==='distributor'&&!brand.error)provider=wilminkProvider(db,organizationId,brand.data.id,job.manifest.brand);
 for(let index=job.next_index;index<job.total_items;index++){
 const found=await db.from('catalog_brand_job_items').select('*').eq('organization_id',organizationId).eq('job_id',jobId).eq('item_index',index).single();
 if(found.error)throw Error(found.error.message);const item=found.data;let observation=item.observation,checkpoint=item.checkpoint||{};
 const save=(state='observed',advance=false,endStatus:any=null,error:any=null)=>rpc('checkpoint_catalog_brand_job',{...scope,input_index:index,input_observation:observation,input_checkpoint:checkpoint,input_state:state,input_advance:advance,input_end_status:endStatus,input_error:error});
 try{
 if(job.manifest.source_key!==def.sourceKey)throw Error('BRAND_SOURCE_CONFIGURATION_CHANGED');
 if(source.error||brand.error||!provider)throw Error('OFFICIAL_ENGINE_NOT_CONFIGURED');assertBrandEngineSource(source.data,job.manifest.brand,{publish:job.mode==='publish',sourceKey:def.sourceKey});
 if(monroeFitment&&source.data.metadata?.monroe_background_fitment_only!==true)throw Error('MONROE_AUTOMATIC_FITMENT_REVOKED');
 if(monroeImageOnly&&source.data.metadata?.monroe_background_image_only!==true)throw Error('MONROE_AUTOMATIC_APPLICATION_REVOKED');
 if(knorrAutomatic&&(source.data.metadata?.automatic_apply!==true||source.data.metadata?.automatic_application_policy!=='knorr-official-missing-only.v1'))throw Error('KNORR_AUTOMATIC_APPLICATION_REVOKED');
 if(automatic&&source.data.metadata?.automatic_apply!==true)throw Error('WILMINK_AUTOMATIC_APPLICATION_REVOKED');
 await rpc('heartbeat_catalog_brand_job',scope);
 if(!observation){
 if(job.mode!=='stage')throw Error('BRAND_REVIEW_RECEIPT_MISSING');
 const current=await db.from('catalog_products').select('id,product_code,'+CATALOG_FIELDS.join(',')+(monroe?',image_url':'')).eq('organization_id',organizationId).eq('brand_id',brand.data.id).eq('normalized_code',item.product_code.replace(/[^a-z0-9]/gi,'').toUpperCase());
 if(current.error)throw Error(current.error.message);
 const matches=current.data||[];
 const exact=matches.filter((p:any)=>exactCatalogCode(p.product_code)===exactCatalogCode(item.product_code));
 // Knorr formatting marks do not change the manufacturer's article number.
 // Only a unique canonical row is eligible; provenance and EAN are checked below.
 const rows=def.family==='knorr_bremse'&&exact.length===0&&matches.length===1&&/^[A-Z0-9][A-Z0-9.-]*$/.test(exactCatalogCode(item.product_code))?matches:exact;
 const missingKnorr=def.family==='knorr_bremse'&&rows.length===0&&(current.data||[]).length===0;
 if(rows.length!==1&&!missingKnorr){const reason='CATALOG_IDENTITY_MISSING_OR_AMBIGUOUS';observation={brand:job.manifest.brand,sourceKey:def.sourceKey,code:exactCatalogCode(item.product_code),before:{},fields:{},replacements:[],lifecycle:catalogLifecycleReview({}, {unavailable:reason}),observedAt:new Date().toISOString(),unavailable:reason};}else{
 await new Promise(r=>setTimeout(r,delayMs));
 try{const raw=monroeFitment
  ?await provider.fetch(item.product_code,{fitment:true,vehiclesCache:monroeVehicles,vehicle:!rows[0].vehicle?.trim()||!rows[0].vehicle_model?.trim()})
  :await provider.fetch(item.product_code),safe=def.authority==='distributor'?safeWilminkObservation(raw,item.product_code,job.manifest.brand):safeSupplierOfficialObservation(raw,item.product_code,brand.data.id);
 const before=rows[0]||{};
 const plan=planSupplierCatalogEnrichment({existing:before,incoming:safe.fields,phase:'official'});
 if(monroeFitment){
  for(const field of ['oem_no','vehicle','vehicle_model'])if(before[field]?.trim())delete plan.patch[field];
 }
 if(monroeImageOnly)delete plan.patch.weight_kg;
 if(monroe)delete plan.patch.ean; // EAN checks identity; it is outside Monroe's write scope.
 observation={brand:job.manifest.brand,sourceKey:def.sourceKey,code:exactCatalogCode(item.product_code),sourceUrl:safe.evidence.sourceUrl,observedAt:safe.evidence.observedAt,fingerprint:safe.evidence.fingerprint,before,missingCatalogProduct:missingKnorr,fields:plan.patch,sourceFields:safe.fields,sourceStatus:raw.sourceStatus||null,...(def.family==='knorr_bremse'?{identity:raw.identity}:{}),lifecycle:safe.evidence.lifecycle,replacements:catalogReplacementReviewRows(safe.evidence.lifecycle,item.product_code),issues:plan.issues,missing:plan.missing,...(def.authority==='distributor'?{authority:'distributor',sourceSku:raw.sourceSku,technicalAttributes:raw.technicalAttributes,imageCandidate:raw.imageCandidate}:{})};
 if(monroe){
  observation.imageCandidate=raw.imageCandidate;
  observation.sourceLogistics=raw.sourceLogistics;
  if(monroeFitment)observation.fitmentEvidence=raw.fitmentEvidence;
  observation.fingerprint=createHash('sha256').update(JSON.stringify([safe.evidence.fingerprint,raw.imageCandidate,raw.sourceLogistics,raw.fitmentEvidence])).digest('hex');
 }
 if(def.family==='knorr_bremse'&&!missingKnorr){
  const records=await db.from('catalog_product_source_records').select('source_key,source_product_id,payload_fingerprint').eq('organization_id',organizationId).eq('catalog_product_id',rows[0].id).eq('source_key','knorr_bremse_aftermarket').limit(1001);
  if(records.error)throw Error(records.error.message);
  try{observation.recordedOwnership=assessKnorrRecordedOwnership({sourceCode:exactCatalogCode(item.product_code),catalogCode:exactCatalogCode(rows[0].product_code),sourceRecords:records.data||[]});}
  catch(e:any){observation.recordedOwnership={status:'invalid',reason:String(e?.message||'KNORR_SOURCE_RECORD_INVALID'),canonicalWrite:false};}
 }
 if(def.family==='knorr_bremse'&&!missingKnorr&&source.data.metadata?.secondary_wilmink_read_allowed===true&&!plan.issues.some((v:any)=>v.code==='EAN_IDENTITY_CONFLICT')){
  const helper=await db.from('catalog_external_sources').select('*').eq('organization_id',organizationId).eq('source_key','wilmink_knorr_bremse_support_v1').maybeSingle();
  if(helper.error)throw Error(helper.error.message);
  const hs=helper.data;
  if(hs?.is_active&&['allowed','internal_review_required'].includes(hs.license_posture)&&hs.credential_boundary==='none'&&hs.rate_limit_posture==='bounded'&&hs.metadata?.brand_engine_read_allowed===true&&hs.metadata?.allowed_brands?.includes('Knorr-Bremse')){
   const index=await db.from('catalog_product_source_records').select('source_url').eq('organization_id',organizationId).eq('catalog_product_id',rows[0].id).eq('source_key','wilmink_knorr_bremse_support_v1').order('retrieved_at',{ascending:false}).limit(1).maybeSingle();
   if(index.error)throw Error(index.error.message);
   if(index.data?.source_url){
    const official={authority:'official',brand:job.manifest.brand,code:safe.evidence.code,sourceUrl:safe.evidence.sourceUrl,fingerprint:safe.evidence.fingerprint};
    try{observation.wilmink=await fetchWilmink({sourceUrl:index.data.source_url,code:item.product_code,official});}
    catch(e:any){const message=String(e?.message||'');observation.wilmink={status:'unavailable',reason:/^[A-Z][A-Z0-9_]{1,99}$/.test(message)?message:'WILMINK_SOURCE_FAILED',canonicalWrite:false};}
   }
  }
 }
 if(monroe&&!monroeFitment&&!plan.issues.some(issue=>issue.code==='EAN_IDENTITY_CONFLICT')){
  try{
   const secondarySource=await db.from('catalog_external_sources').select('*').eq('organization_id',organizationId)
    .eq('source_key','spareto_secondary_exact_v1').maybeSingle();
   if(secondarySource.error)throw secondarySource.error;
   const helper=secondarySource.data;
   if(!source.data.metadata?.secondary_spareto_read_allowed||!helper?.is_active||
      !['allowed','internal_review_required'].includes(helper.license_posture)||helper.credential_boundary!=='none'||
      helper.robots_posture!=='allowed'||helper.rate_limit_posture!=='bounded'||
      helper.metadata?.secondary_review_read_allowed!==true||!helper.metadata?.allowed_brands?.includes('Monroe')){
    throw Error('SECONDARY_SOURCE_NOT_AUTHORIZED');
   }
   const code=exactCatalogCode(item.product_code);
   const indexed=await db.from('catalog_product_source_records').select('source_url').eq('organization_id',organizationId)
    .eq('catalog_product_id',before.id).in('source_key',[helper.source_key,'spareto_monroe_sitemap_v1']).order('retrieved_at',{ascending:false}).limit(1).maybeSingle();
   if(indexed.error)throw indexed.error;
   const sourceUrl=indexed.data?.source_url??source.data.metadata?.secondary_product_urls?.[code];
   if(!sourceUrl)throw Error('SPARETO_PRODUCT_URL_NOT_INDEXED');
   await new Promise(r=>setTimeout(r,Math.max(1100,delayMs)));
   const secondary=await fetchSecondaryPage({brand:'Monroe',code,sourceUrl,expectedEan:safe.fields.ean||before.ean||null});
   const official={authority:'official',brand:'Monroe',code:safe.evidence.code,sourceUrl:safe.evidence.sourceUrl,
    fingerprint:safe.evidence.fingerprint,fields:safe.fields};
   const {hs_code,origin}=secondary.fields;
   observation.secondary={
    ...planSparetoMissingCompletion({brand:'Monroe',code,existing:before,official,secondary:{...secondary,fields:{hs_code,origin}}}),
    sourceUrl,reportedFields:{hs_code,origin},
   };
  }catch(e:any){
   const message=String(e?.message||'');
   observation.secondary={status:'unavailable',reason:/^[A-Z][A-Z0-9_]{1,99}$/.test(message)?message:'SECONDARY_SOURCE_FAILED',canonicalWrite:false};
  }
 }
 if(def.family==='knorr_bremse'&&!missingKnorr&&source.data.metadata?.secondary_spareto_read_allowed===true&&!plan.issues.some((v:any)=>v.code==='EAN_IDENTITY_CONFLICT')){
  try{
   const secondary=await fetchSecondary({brand:job.manifest.brand,code:item.product_code,expectedEan:safe.fields.ean||rows[0].ean||null});
   const official={authority:'official',brand:job.manifest.brand,code:safe.evidence.code,sourceUrl:safe.evidence.sourceUrl,fingerprint:safe.evidence.fingerprint,fields:safe.fields};
   observation.secondary=planSparetoMissingCompletion({brand:job.manifest.brand,code:item.product_code,existing:rows[0],official,secondary});
  }catch(e:any){const message=String(e?.message||'');observation.secondary={status:'unavailable',reason:/^[A-Z][A-Z0-9_]{1,99}$/.test(message)?message:'SECONDARY_SOURCE_FAILED',canonicalWrite:false};}
 }
 }catch(e:any){const reason=catalogRowFailure(e);if(!reason)throw e;observation={brand:job.manifest.brand,sourceKey:def.sourceKey,code:exactCatalogCode(item.product_code),before:rows[0],fields:{},replacements:[],lifecycle:catalogLifecycleReview({}, {unavailable:reason}),observedAt:new Date().toISOString(),unavailable:reason};}
 }
 await save();
 }
 if(job.mode==='publish'){
 await rpc('heartbeat_catalog_brand_job',scope);
 const held=def.family==='knorr_bremse'&&['collision','invalid'].includes(observation?.recordedOwnership?.status)?'KNORR_RECORDED_SOURCE_COLLISION':knorrAutomatic&&(observation?.unavailable||observation?.issues?.length)?(observation?.unavailable||'KNORR_SOURCE_ISSUES_REQUIRE_REVIEW'):def.family==='knorr_bremse'&&observation?.identity?.requiresCollisionReview&&observation?.identity?.status!=='search_consistent'?'KNORR_CANONICAL_IDENTITY_REVIEW_REQUIRED':def.family==='knorr_bremse'&&observation?.missingCatalogProduct===true&&!['CODE30','CODE40'].includes(observation?.lifecycle?.evidence?.salesStatusCode)?'KNORR_LIFECYCLE_REVIEW_REQUIRED':automatic&&(observation?.unavailable||observation?.issues?.some((v:any)=>v.code==='EAN_IDENTITY_CONFLICT')&&'EAN_IDENTITY_CONFLICT');
 if(held)checkpoint={status:'held',reason:held,changes:{},sourceUrl:observation.sourceUrl};
 else try{checkpoint=await rpc(knorrAutomatic?'apply_catalog_knorr_auto_item':observation?.missingCatalogProduct===true&&def.family==='knorr_bremse'?'apply_catalog_knorr_create_item':def.family==='knorr_bremse'?'apply_catalog_knorr_owned_item':automatic?'apply_catalog_wilmink_automatic_item':monroe?'apply_catalog_monroe_job_item':'apply_catalog_brand_job_item',{...scope,input_index:index});}catch(error:any){
  if(!automatic||!/^Brand catalog identity (missing or ambiguous|changed)$/.test(error.message))throw error;
  checkpoint={status:'held',reason:'CATALOG_IDENTITY_CHANGED_SINCE_REVIEW',changes:{},sourceUrl:observation.sourceUrl};
 }
 }
 const pause=index+1<job.total_items&&Date.now()-started>maxMs;await save(job.mode==='publish'?'completed':'reviewed',true,pause?'paused':null);
 if(pause)return {claimed:true,status:'paused'};
 }catch(e:any){const message=String(e.message||'BRAND_SOURCE_FAILED').slice(0,350);const retry=/(?:HTTP[_ ]?|TecAlliance request failed )(429|5[0-9]{2})|timeout|timed out|abort|fetch failed|ECONN|network/i.test(message)&&Number(job.retry_attempts||0)<4;try{await save('failed',false,retry?'paused':'failed',message);}catch{}return {claimed:true,status:retry?'paused':'failed',error:message};}
 }
 return {claimed:true,status:job.mode==='publish'?'completed':'reviewed'};
}
