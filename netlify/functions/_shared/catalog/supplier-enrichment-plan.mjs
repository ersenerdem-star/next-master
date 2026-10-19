// Pure field policy for the versioned supplier publication projection.
// Source parsing and historical release hashes remain unchanged.
export const ENRICHMENT_POLICY='supplier-catalog-enrichment-v1';
export const CATALOG_FIELDS=['description','description_tr','oem_no','vehicle','vehicle_model','ean','market_segment','weight_kg','dimensions','origin','hs_code'];
export const CATALOG_COMPLETION_FIELDS=['description','oem_no','vehicle','vehicle_model','ean','weight_kg','origin','hs_code'];
export const exactCatalogCode=v=>String(v??'').trim().replace(/\s+/g,'').toUpperCase();
const blank=v=>v==null||typeof v==='string'&&!v.trim();
const same=(a,b)=>JSON.stringify(a??null)===JSON.stringify(b??null);
const aliases={TURKEY:'TR',TURKIYE:'TR',TUR:'TR',GERMANY:'DE',DEUTSCHLAND:'DE',ALMANYA:'DE',DEU:'DE',CHINA:'CN',ROMANIA:'RO',SPAIN:'ES',ITALY:'IT',FRANCE:'FR',POLAND:'PL',ARGENTINA:'AR',MEXICO:'MX',JAPAN:'JP',SLOVAKIA:'SK',NETHERLANDS:'NL'};
function origin(v){const s=String(v).trim().normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toUpperCase();return aliases[s]||s;}
export function mergeCatalogIdentifiers(oldValue,newValue){
 const values=[],seen=new Set();
 for(const s of [oldValue,newValue])for(const raw of String(s??'').split(/[,;|\r\n]+/)){
  const value=raw.trim(),key=exactCatalogCode(value);if(key&&!seen.has(key)){seen.add(key);values.push(value);}
 }
 return values.join('; ');
}
export function sourceCatalogFields(row){return Object.fromEntries(CATALOG_FIELDS.map(k=>[k,row[k==='hs_code'?'tariff':k==='weight_kg'?'weight':k]??null]));}
export function planSupplierCatalogEnrichment({existing={},incoming={},phase='file',fieldState={},sourceDate=null,conflicts=[]}={}){
 if(!['file','official'].includes(phase))throw Error('CATALOG_ENRICHMENT_PHASE_INVALID');
 const patch={},issues=[];
 const issue=(field,code)=>issues.push({field,code});
 for(const field of CATALOG_FIELDS){
  let value=incoming[field];if(blank(value))continue;
  if(typeof value==='string')value=value.trim();
  const previous=existing[field];
  if(['oem_no','vehicle','vehicle_model'].includes(field)){
   if(typeof value!=='string'||value.length>12000){issue(field,'INVALID_FIELD_VALUE');continue;}
   const merged=mergeCatalogIdentifiers(previous,value);if(!same(merged,previous)&&merged)patch[field]=merged;continue;
  }
  if(phase==='official'&&!blank(previous))continue; // Official completion never replaces a supplied value.
  if(field==='origin'){
   value=origin(value);if(!/^[A-Z]{2}$/.test(value)){issue(field,'INVALID_ORIGIN');continue;}
  }else if(field==='hs_code'){
   if(typeof value!=='string'||!/^\d[\d.\s-]{1,30}\d$/.test(value)){issue(field,'INVALID_TARIFF_TEXT');continue;}
  }else if(field==='weight_kg'){
   value=Number(value);if(!Number.isFinite(value)||value<=0||value>1000000){issue(field,'INVALID_WEIGHT');continue;}
  }else if(field==='dimensions'){
   if(typeof value==='string'){try{const parsed=JSON.parse(value);value=parsed&&typeof parsed==='object'&&!Array.isArray(parsed)?parsed:{source_text:value};}catch{value={source_text:value};}}
   if(!value||typeof value!=='object'||Array.isArray(value)){issue(field,'INVALID_DIMENSIONS');continue;}
   value={...(previous&&typeof previous==='object'?previous:{}),...value};
  }else if(typeof value!=='string'||value.length>12000){issue(field,'INVALID_FIELD_VALUE');continue;}
  if(same(value,previous))continue;
  if(field==='ean'&&!blank(previous)){issue(field,'EAN_CONFLICT');continue;}
  if(conflicts.includes(field)){issue(field,'SOURCE_CONFLICT');continue;}
  const state=fieldState[field];
  if(phase==='file'&&state?.source_date&&sourceDate&&sourceDate<state.source_date){issue(field,'OLDER_SOURCE');continue;}
  if(phase==='file'&&state&&!blank(previous)&&!same(state.applied_value,previous)){issue(field,'CATALOG_CHANGED_AFTER_SOURCE');continue;}
  patch[field]=value;
 }
 const next={...existing,...patch};
 // Fields absent from an official catalogue remain unknown, not fabricated.
 const missing=CATALOG_COMPLETION_FIELDS.filter(k=>blank(next[k]));
 return {patch,issues,missing};
}
