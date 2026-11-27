import {fetchSparetoSecondaryPage} from './spareto-secondary-provider.mjs';

export const VAG_SPARETO_SOURCE='spareto_vag_exact_review_v1';
export const VAG_SPARETO_ADAPTER='vag-spareto-exact-review.v1';

export function validateVagSparetoItem(code:unknown,sourceUrl:unknown){
 if(typeof code!=='string'||!/^[A-Z0-9]{5,24}$/.test(code)||
   typeof sourceUrl!=='string'||sourceUrl.length>250)throw Error('VAG_SPARETO_ITEM_INVALID');
 const match=sourceUrl.match(/^https:\/\/spareto\.com\/products\/volkswagen-ag-[a-z0-9-]+\/([a-z0-9-]+)$/);
 if(!match||match[1].replace(/-/g,'').toUpperCase()!==code)throw Error('VAG_SPARETO_ITEM_INVALID');
 return {code,sourceUrl};
}

export async function readVagSparetoObservation(input:{code:string;sourceUrl:string;expectedEan?:string|null},fetchImpl:typeof fetch){
 const {code,sourceUrl}=validateVagSparetoItem(input.code,input.sourceUrl);
 const raw=await fetchSparetoSecondaryPage({brand:'Volkswagen AG',code,sourceUrl,expectedEan:input.expectedEan},{fetchImpl});
 const checks=raw.lifecycle.checks;
 return {brand:'VAG',code,sourceKey:VAG_SPARETO_SOURCE,sourceBrand:raw.sourceBrand,authority:'secondary',sourceUrl,
   observedAt:raw.observedAt,fingerprint:raw.fingerprint,before:{},fields:{},sourceFields:raw.fields,replacements:[],
   lifecycle:{checks,reviewOnly:true},fitmentEvidence:{status:raw.fields.vehicle_model?'source_model_summary':'no_vehicle_links'},
   canonicalWrite:false};
}
