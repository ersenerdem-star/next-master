// Separate distributor evidence from the primary manufacturer engines.
export const WILMINK_SUPPORT_SCAN='wilmink-support-discovery.v1';
const sources={
 Kolbenschmidt:{sourceKey:'wilmink_kolbenschmidt_v1',pageUrl:'https://www.wilminkengineparts.com/en/brands/kolbenschmidt'},
 Elring:{sourceKey:'wilmink_elring_support_v1',pageUrl:'https://www.wilminkengineparts.com/en/brands/elring'},
 INA:{sourceKey:'wilmink_ina_support_v1',pageUrl:null},
 Mahle:{sourceKey:'wilmink_mahle_support_v1',pageUrl:'https://www.wilminkengineparts.com/en/brands/mahle'},
};
export function wilminkSource(brand){const source=sources[brand];if(!source)throw Error('WILMINK_BRAND_UNAVAILABLE');return {...source,brand};}
export function wilminkSupportDefinition(brand,sourceKey){
 const source=sources[brand];if(!source||source.sourceKey!==sourceKey)return null;
 return {brand,family:brand==='Kolbenschmidt'?'wilmink_kolbenschmidt':'wilmink_support',engineName:`${brand} · Wilmink`,sourceKey,sourceUrl:source.pageUrl||'https://www.wilminkengineparts.com/en/homepage',reader:true,workflow:'brand',authority:'distributor',listingAvailable:Boolean(source.pageUrl)};
}
