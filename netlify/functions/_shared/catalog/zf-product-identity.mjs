export const ZF_BRANDS=Object.freeze({zf:'ZF',sachs:'Sachs',boge:'Boge',trw:'TRW',lemforder:'Lemforder',wabco:'Wabco'});
export const zfBrandKey=v=>String(v??'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').trim().toLowerCase().replace(/[^a-z0-9]/g,'');
export const exactZfCode=v=>String(v??'').normalize('NFKC').trim().replace(/\s+/g,'').toUpperCase();
export function requireZfBrand(v){const brand=ZF_BRANDS[zfBrandKey(v)];if(!brand)throw Error('ZF_BRAND_NOT_SUPPORTED');return brand;}
export function exactZfSearchItem(items,code,brand){
 const target=requireZfBrand(brand),key=exactZfCode(code);
 const matches=items.filter(item=>exactZfCode(item.source_article_number)===key&&zfBrandKey(item.source_brand_name)===zfBrandKey(target));
 if(matches.length!==1)throw Error(matches.length?'OFFICIAL_EXACT_MATCH_AMBIGUOUS':'OFFICIAL_EXACT_MATCH_NOT_FOUND');
 return matches[0];
}
export function assertZfArticleIdentity(payload,code,brand){
 const d=payload?.details;
 if(!d||exactZfCode(d.number)!==exactZfCode(code)||zfBrandKey(d.brandName)!==zfBrandKey(requireZfBrand(brand)))throw Error('OFFICIAL_EXACT_MATCH_NOT_FOUND');
 return d;
}
function decimal(v){const s=String(v??'').trim().replace(',','.');return /^\d+(?:\.\d+)?$/.test(s)&&Number(s)>0?Number(s):null;}
export function zfArticleWeight(details){
 const types=Array.isArray(details?.productTypes)?details.productTypes:[];
 const gross=types.filter(t=>t.grossWeight!=null&&String(t.grossWeight).trim()).map(t=>{
  const value=decimal(t.grossWeight),unit=String(t.weightUnit||'').trim().toLowerCase();
  return value==null?null:unit==='kg'?value:unit==='g'?value/1000:null;
 });
 if(gross.length)return gross.every(v=>v!=null&&v===gross[0])?gross[0]:null;
 const w=details?.mainStage?.weight;
 if(!/^gross weight \(kg\)$/i.test(String(w?.label||'').trim()))return null;
 return decimal(w.value);
}
export function zfReplacementCandidates(details){
 const result=[];
 for(const [key,direction] of [['replacedBy','replaced_by'],['replaces','replaces']]){
  const raw=details?.[key];if(raw==null)continue;
  const entries=Array.isArray(raw)?raw:Array.isArray(raw.values)?raw.values:[raw];
  if(entries.length>20)throw Error('ZF_REPLACEMENT_BOUND_EXCEEDED');
  for(const entry of entries){const code=String(entry?.number||entry?.text||'').trim();
   if(!code||!/^[A-Z0-9][A-Z0-9 ./-]{0,59}$/i.test(code)||!/[0-9]/.test(code)||exactZfCode(code)===exactZfCode(details.number))continue;
   result.push({code,direction,brand:entry?.brandName||null});
  }
 }
 return [...new Map(result.map(r=>[`${r.direction}:${exactZfCode(r.code)}`,r])).values()];
}
