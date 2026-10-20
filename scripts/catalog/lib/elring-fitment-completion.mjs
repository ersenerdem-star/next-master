import {createHash} from 'node:crypto';
export const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function vehiclePlans(article){
 const plans=[];
 for(const g of article.genericArticles||[]){
  const types=g.linkageTargetTypes||[];
  const wanted=[...(types.some(t=>['V','L','P','O','C'].includes(t))?['PO']:[]),...(types.includes('B')?['B']:[])];
  if(wanted.length&&!Number.isInteger(g.legacyArticleId))throw Error('FITMENT_GENERIC_ID_MISSING');
  for(const type of wanted)if(!plans.some(p=>p.article_id===g.legacyArticleId&&p.target_type===type))plans.push({article_id:g.legacyArticleId,target_type:type});
 }return plans;
}
export async function collectCompleteVehicles(article,{call,vehiclesCache=new Map(),saveVehicle=async()=>{}}){
 if(article.mfrName!=='ELRING'||article.dataSupplierId!==10)throw Error('FITMENT_ARTICLE_IDENTITY');
 const coverage=[],vehicles=new Map(),evidence=[];
 for(const plan of vehiclePlans(article)){
  const base={articleId:plan.article_id,linkingTargetType:plan.target_type};
  const list=await call('getArticleLinkedAllLinkingTarget4',{...base,country:'GB',countryGroupFlag:false,withMainArticles:false});
  if(list.response.status!==200||!Array.isArray(list.response.data?.array))throw Error('FITMENT_LINK_LIST_INVALID');
  const raw=list.response.data.array.flatMap(r=>r.articleLinkages?.array||[]);
  if(raw.length>100000)throw Error('FITMENT_LINK_LIST_BOUND');
  if(raw.some(p=>!Number.isInteger(p.articleLinkId)||!Number.isInteger(p.linkingTargetId)||!['P','O','B'].includes(p.linkingTargetType)||typeof p.linked!=='boolean'))throw Error('FITMENT_LINK_IDENTITY_INVALID');
  const pairs=raw.filter(p=>p.linked),key=p=>`${p.linkingTargetType}:${p.linkingTargetId}`;
  evidence.push(list.evidence_ref||list.response_fingerprint||hash(list.response));
  for(const type of ['P','O','B']){
   const missing=[...new Map(pairs.filter(p=>p.linkingTargetType===type&&!vehiclesCache.has(key(p))).map(p=>[key(p),p])).values()];
   for(let offset=0;offset<missing.length;offset+=25){
    const wanted=missing.slice(offset,offset+25);
    const details=await call('getArticleLinkedAllLinkingTargetsByIds3',{articleId:plan.article_id,linkingTargetType:type,immediateAttributs:true,
     linkedArticlePairs:{array:wanted.map(p=>({articleLinkId:p.articleLinkId,linkingTargetId:p.linkingTargetId}))}});
    if(details.response.status!==200||!Array.isArray(details.response.data?.array))throw Error('FITMENT_DETAILS_INVALID');
    for(const pair of wanted){
     const matches=details.response.data.array.filter(r=>r.articleLinkId===pair.articleLinkId&&r.linkingTargetId===pair.linkingTargetId)
      .flatMap(r=>r.linkedVehicles?.array||[]).filter(v=>v.carId===pair.linkingTargetId&&v.linkingTargetType===type);
     if(matches.length!==1||!matches[0].manuDesc?.trim()||!matches[0].modelDesc?.trim())throw Error('FITMENT_TARGET_DETAILS_MISSING_OR_AMBIGUOUS');
     const entry={target_type:type,target_id:pair.linkingTargetId,manuDesc:matches[0].manuDesc.trim(),modelDesc:matches[0].modelDesc.trim(),
      detail_evidence:details.evidence_ref||details.response_fingerprint||hash(details.response)};
     vehiclesCache.set(key(pair),entry);await saveVehicle(key(pair),entry);
    }
   }
  }
  for(const pair of pairs){const entry=vehiclesCache.get(key(pair));if(!entry)throw Error('FITMENT_TARGET_UNRESOLVED');vehicles.set(key(pair),entry);}
  coverage.push({...plan,pairs_count:pairs.length,resolved_count:pairs.length,target_keys:pairs.map(key),complete:true,pairs_fingerprint:hash(list.response)});
 }
 const result={product_code:article.articleNumber,complete:true,coverage,vehicles:[...vehicles.values()]};
 result.evidence_manifest_sha256=hash({articleNumber:article.articleNumber,coverage,evidence,vehicles:result.vehicles});
 return result;
}
