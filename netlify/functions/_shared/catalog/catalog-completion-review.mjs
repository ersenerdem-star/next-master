import {createHash} from 'node:crypto';
import {CATALOG_FIELDS,exactCatalogCode,planSupplierCatalogEnrichment} from './supplier-enrichment-plan.mjs';

export const COMPLETION_REVIEW_POLICY='official-first-spareto-missing-only-v1';
const blank=v=>v==null||typeof v==='string'&&!v.trim();
const brand=v=>String(v??'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').trim().toLowerCase().replace(/\s+/g,' ');
const productionEnded=v=>/^(discontinued|discontinued article|production discontinued|no longer produced|end of production|production ended)$/i.test(String(v??'').trim());

// Mandatory coverage is distinct from a positive lifecycle assertion. Raw
// replacement candidates are never silently promoted to operational mappings.
export function catalogLifecycleReview(raw={}, {unavailable=null}={}){
 const checks={replacement:'unsupported',discontinued:'unsupported'};
 if(unavailable)return {policy:COMPLETION_REVIEW_POLICY,checks:{replacement:'blocked',discontinued:'blocked'},reason:unavailable,reviewOnly:true};
 const parsed=raw.lifecycle;
 if(parsed?.checks){
  const valid=['unsupported','no_explicit_signal','found','unverified_target_identity'];
  for(const k of Object.keys(checks))if(valid.includes(parsed.checks[k]))checks[k]=parsed.checks[k];
 }
 const status=String(raw.sourceStatus??'').trim();
 if(status)checks.discontinued=productionEnded(status)?'found':'no_explicit_signal';
 const candidates=raw.replacementCandidates;
 const hasCandidates=candidates&&Object.values(candidates).some(v=>Array.isArray(v)?v.length>0:!!v);
 if(hasCandidates&&checks.replacement!=='found')checks.replacement='review_required';
 return {policy:COMPLETION_REVIEW_POLICY,checks,sourceStatus:status||null,
  evidence:parsed?.evidence||{},replacementCandidates:hasCandidates?structuredClone(candidates):null,reviewOnly:true};
}

export function catalogReplacementReviewRows(lifecycle,code){
 return (lifecycle.evidence?.replacement?.relations||[]).flatMap(r=>{
  if(exactCatalogCode(r.old_code)===exactCatalogCode(code))return [{code:r.new_code,direction:'replaced_by',verified:false}];
  if(exactCatalogCode(r.new_code)===exactCatalogCode(code))return [{code:r.old_code,direction:'replaces',verified:false}];
  return [];
 });
}

// Produces a separate review candidate, not an official patch or DB mutation.
// Exact official identity is a prerequisite, not a marketplace fallback switch.
export function planSparetoMissingCompletion({brand:requestedBrand,code,existing={},official,secondary}={}){
 const result={policy:COMPLETION_REVIEW_POLICY,status:'review_required',fields:{},provenance:{},issues:[],lifecycle:secondary?.lifecycle??catalogLifecycleReview({}, {unavailable:'SECONDARY_NOT_READ'}),canonicalWrite:false};
 if(!official||official.authority!=='official'||official.unavailable||brand(official.brand)!==brand(requestedBrand)||exactCatalogCode(official.code)!==exactCatalogCode(code)||!official.fingerprint||!official.sourceUrl){result.issues.push('EXACT_OFFICIAL_RECEIPT_REQUIRED');return result;}
 let source;
 try{source=new URL(secondary?.sourceUrl);}catch{result.issues.push('SECONDARY_RECEIPT_REQUIRED');return result;}
 if(source.origin!=='https://spareto.com'||source.username||source.password||source.search||source.hash||!source.pathname.startsWith('/products/')||!secondary.fingerprint||!secondary.observedAt||secondary.exactIdentity!==true||brand(secondary.brand)!==brand(requestedBrand)||exactCatalogCode(secondary.code)!==exactCatalogCode(code)){
  result.issues.push('SECONDARY_IDENTITY_OR_SOURCE_INVALID');return result;
 }
 const primary={...existing};
 // Both current canonical and the official snapshot protect every field.
 for(const field of CATALOG_FIELDS)if(blank(primary[field])&&!blank(official.fields?.[field]))primary[field]=official.fields[field];
 const eans=[existing.ean,official.fields?.ean,secondary.fields?.ean].filter(v=>!blank(v)).map(v=>String(v).trim());
 if(new Set(eans).size>1){result.issues.push('EAN_IDENTITY_CONFLICT');return result;}
 const incoming=Object.fromEntries(CATALOG_FIELDS.filter(k=>blank(primary[k])&&!blank(secondary.fields?.[k])).map(k=>[k,secondary.fields[k]]));
 const planned=planSupplierCatalogEnrichment({existing:primary,incoming,phase:'official'});
 result.fields=planned.patch;result.issues.push(...planned.issues.map(i=>i.field+':'+i.code));
 for(const field of Object.keys(result.fields))result.provenance[field]={authority:'secondary',source:'Spareto',sourceUrl:source.href,observedAt:secondary.observedAt,fingerprint:secondary.fingerprint};
 result.status='staged_candidate';result.fingerprint=createHash('sha256').update(JSON.stringify({official:official.fingerprint,secondary:secondary.fingerprint,fields:result.fields})).digest('hex');
 return result;
}
