// Separate distributor evidence from the primary manufacturer engines.
export const WILMINK_SUPPORT_SCAN='wilmink-support-discovery.v1';
const sources={
 Kolbenschmidt:{sourceKey:'wilmink_kolbenschmidt_v1',pageUrl:'https://www.wilminkengineparts.com/en/brands/kolbenschmidt'},
 Elring:{sourceKey:'wilmink_elring_support_v1',pageUrl:'https://www.wilminkengineparts.com/en/brands/elring',secondarySources:[{sourceKey:'spareto_elring_product_catalog',label:'Spareto · Elring ikincil kaynak',url:'https://spareto.com/products?utf8=%E2%9C%93&sort_by=&brand%5B%5D=ELRING',mode:'missing_only',automaticApply:false}]},
 INA:{sourceKey:'wilmink_ina_support_v1',pageUrl:null},
 Mahle:{sourceKey:'wilmink_mahle_support_v1',pageUrl:'https://www.wilminkengineparts.com/en/brands/mahle'},
 Glyco:{sourceKey:'wilmink_glyco_support_v1',pageUrl:'https://www.wilminkengineparts.com/en/brands/glyco'},
 Goetze:{sourceKey:'wilmink_goetze_support_v1',pageUrl:'https://www.wilminkengineparts.com/en/brands/goetze'},
 // Nural is present in Wilmink's tagged search results, but has no stable
 // public brand listing. Keep it URL-package only until a listing contract is
 // verified; this prevents a partial search result from being reported as a
 // whole-brand scan.
 Nural:{sourceKey:'wilmink_nural_support_v1',pageUrl:null},
};
export function wilminkSource(brand){const source=sources[brand];if(!source)throw Error('WILMINK_BRAND_UNAVAILABLE');return {...source,brand};}
export function wilminkSupportDefinition(brand,sourceKey){
 const source=sources[brand];if(!source||source.sourceKey!==sourceKey)return null;
 return {brand,family:brand==='Kolbenschmidt'?'wilmink_kolbenschmidt':'wilmink_support',engineName:`${brand} · Wilmink`,sourceKey,sourceUrl:source.pageUrl||'https://www.wilminkengineparts.com/en/homepage',reader:true,workflow:'brand',authority:'distributor',listingAvailable:Boolean(source.pageUrl),secondarySources:source.secondarySources||[]};
}
