import {exactCatalogCode,mergeCatalogIdentifiers} from './supplier-enrichment-plan.mjs';
export const SPARETO_CORRECTION_SOURCE='spareto_schaeffler_correction_v1';
export const SPARETO_CORRECTION_ADAPTER='spareto-reviewed-correction.v1';
export const SPARETO_CORRECTION_FIELDS=['description','oem_no','market_segment','image_url'];
export function planSparetoReviewedCorrection({brand,code,before,observation}){
 if(!['INA','FAG','LUK'].includes(brand)||observation?.brand!==brand||observation.exactIdentity!==true||exactCatalogCode(observation.code)!==exactCatalogCode(code))throw Error('CORRECTION_EXACT_IDENTITY_REQUIRED');
 const u=new URL(observation.sourceUrl);if(u.origin!=='https://spareto.com'||u.search||u.hash||u.username||u.password||!u.pathname.startsWith('/products/'))throw Error('CORRECTION_SOURCE_INVALID');
 const expected=String(before.ean??'').replace(/\s/g,'');
 if(expected&&!observation.eanCandidates?.includes(expected))return {status:'held',reason:'EAN_IDENTITY_CONFLICT',patch:{}};
 if(!expected&&(!observation.fields?.ean||!observation.eanCandidates?.includes(observation.fields.ean)))return {status:'held',reason:'SOURCE_EAN_MISSING',patch:{}};
 const patch={},f=observation.fields||{};
 if(typeof f.description==='string'&&f.description.trim()&&f.description.length<=500&&f.description!==before.description)patch.description=f.description;
 if(typeof f.oem_no==='string'&&f.oem_no.trim()){
  const merged=mergeCatalogIdentifiers(before.oem_no,f.oem_no);if(merged&&merged!==before.oem_no&&merged.length<=12000)patch.oem_no=merged;
 }
 if(['pc','cv','lcv','motorcycle','off_highway','agriculture','industrial','marine','engines','universal'].includes(f.market_segment)&&observation.segmentEvidence?.status==='explicit_vehicle_class'&&f.market_segment!==before.market_segment)patch.market_segment=f.market_segment;
 if(observation.imageCandidate&&observation.imageEvidence?.scope==='primary_product_meta'&&observation.imageEvidence?.candidates?.includes(observation.imageCandidate)){
  const image=new URL(observation.imageCandidate);
  if(image.protocol==='https:'&&image.hostname==='cdn.spareto.com'&&!image.port&&!image.hash&&!image.username&&!image.password&&/^\/variants\/images\/[A-Za-z0-9/_-]+\.(?:jpe?g|png|webp)$/i.test(image.pathname)&&!/(placeholder|no[-_]?image|default)/i.test(image.pathname)&&image.href!==before.image_url)patch.image_url=image.href;
 }
 return {status:'reviewed',patch,missing:['description','oem_no','market_segment','image_url'].filter(k=>!(k==='image_url'?observation.imageCandidate:f[k])),segmentStatus:observation.segmentEvidence?.status||'source_missing'};
}
