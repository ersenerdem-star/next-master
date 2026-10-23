import {wilminkSupportDefinition} from './wilmink-sources.mjs';
import {normalizeBrandKey} from './brand-standardization.mts';
import {resolveTecAllianceBrandEntry} from './tecalliance-brand-registry.mts';
import {resolveCatalogSyncPlan} from './catalog-sync-provider.mts';
import {SCHAEFFLER_ENGINE,isSchaefflerBrand} from './schaeffler-family.mts';
const knownOfficialSources:Record<string,{sourceKey:string;sourceUrl:string;family:string;access?:string}>={
 vag:{family:'vag',sourceKey:'vag_partslink24_authorized',sourceUrl:'https://www.partslink24.com/',access:'authorization_required'},
 febi:{family:'bilstein',sourceKey:'bilstein_group_partsfinder_observation',sourceUrl:'https://partsfinder.bilsteingroup.com/en/',access:'authorization_required'},
 swag:{family:'bilstein',sourceKey:'bilstein_group_partsfinder_observation',sourceUrl:'https://partsfinder.bilsteingroup.com/en/',access:'authorization_required'},
 blueprint:{family:'bilstein',sourceKey:'bilstein_group_partsfinder_observation',sourceUrl:'https://partsfinder.bilsteingroup.com/en/',access:'authorization_required'},
 borgwarnerberu:{family:'borgwarner',sourceKey:'borgwarner_beru_official_catalog',sourceUrl:'https://catalog.borgwarner.com'},
 borgwarnerkkk:{family:'borgwarner',sourceKey:'borgwarner_3k_official_catalog',sourceUrl:'https://catalog.borgwarner.com'},
 borgwarnerschwitzer:{family:'borgwarner',sourceKey:'borgwarner_schwitzer_official_catalog',sourceUrl:'https://catalog.borgwarner.com'},
 delphi:{family:'delphi',sourceKey:'delphi_official_catalog',sourceUrl:'https://www.delphiautoparts.com/de-de/catalogue'},
 victorreinz:{family:'tecalliance',sourceKey:'tecalliance_victor_reinz',sourceUrl:'https://web.tecalliance.net/reinz/en/home'},
};
export function brandEngineDefinition(brand:string){
 const key=normalizeBrandKey(brand),tec=resolveTecAllianceBrandEntry(brand);
 if(key==='kolbenschmidt')return {brand,family:'wilmink_kolbenschmidt',engineName:'Kolbenschmidt · Wilmink',sourceKey:'wilmink_kolbenschmidt_v1',sourceUrl:'https://www.wilminkengineparts.com/en/brands/kolbenschmidt',reader:true,workflow:'brand',authority:'distributor'};
 if(isSchaefflerBrand(brand))return {brand,family:SCHAEFFLER_ENGINE.family,engineName:SCHAEFFLER_ENGINE.name,sourceKey:SCHAEFFLER_ENGINE.sourceKey,sourceUrl:SCHAEFFLER_ENGINE.sourceUrl,reader:true,workflow:'brand',access:'server_access_required'};
 if(['sachs','boge','trw','lemforder','lemfoerder','wabco','zf'].includes(key))return {brand,family:'zf',sourceKey:'zf_group_official_v2',sourceUrl:'https://aftermarket.zf.com/en/aftermarket-portal/',reader:true,workflow:'zf'};
 if(key==='elring')return {brand,family:'elring',sourceKey:'tecalliance_elring',sourceUrl:'https://web.tecalliance.net/elring/en/home',reader:true,workflow:'elring'};
 if(key==='denso')return {brand,family:'denso',sourceKey:'denso_official_v1',sourceUrl:'https://www.denso-am.eu/catalog/pv',reader:true,workflow:'brand'};
 if(key==='delphi')return {brand,...knownOfficialSources.delphi,reader:true,workflow:'brand'};
 if(key==='skf')return {brand,family:'skf_automotive',sourceKey:'skf_official_product_v1',sourceUrl:'https://automotive.skf.com/eur/en/product-catalogue',reader:true,workflow:'brand'};
 if(key==='bosch')return {brand,family:'bosch',sourceKey:'mira_legacy_bosch',sourceUrl:'https://www.boschaftermarket.com/',reader:true,workflow:'brand'};
 if(['mann','mannfilter'].includes(key))return {brand,family:'mann',sourceKey:'mira_legacy_mann',sourceUrl:'https://www.mann-filter.com/en/catalog.html',reader:true,workflow:'brand'};
 if(tec)return {brand,family:'tecalliance',sourceKey:tec.preferredProviderKey,sourceUrl:tec.preferredSourceUrl,reader:true,workflow:'brand'};
 if(key==='unbranded')return {brand,family:'manual',sourceKey:null,sourceUrl:'',reader:false,workflow:'brand'};
 if(knownOfficialSources[key])return {brand,...knownOfficialSources[key],reader:false,workflow:'brand'};
 const plan=resolveCatalogSyncPlan(brand);
 return {brand,family:'unconfigured',sourceKey:null,sourceUrl:plan.preferredSourceType==='official'?plan.preferredSourceUrl:'',reader:false,workflow:'brand'};
}
export function brandEngineForSource(brand:string,sourceKey?:string){
 const primary=brandEngineDefinition(brand);if(!sourceKey||sourceKey===primary.sourceKey)return primary;
 const helper=wilminkSupportDefinition(brand,sourceKey);if(!helper)throw Error('BRAND_SOURCE_CONFIGURATION_CHANGED');return helper;
}
export function assertBrandEngineSource(source:any,brand:string,{publish=false,sourceKey=undefined as string|undefined}={}){
 const def=brandEngineForSource(brand,sourceKey);
 if(def.family==='schaeffler'&&source?.metadata?.server_access_verified!==true)throw Error('SCHAEFFLER_OFFICIAL_SERVER_ACCESS_REQUIRED');
 if(!def.reader||def.workflow!=='brand'||source?.source_key!==def.sourceKey||!source.is_active||!['allowed','internal_review_required'].includes(source.license_posture)
  ||source.credential_boundary!=='none'||source.rate_limit_posture!=='bounded'||source.metadata?.brand_engine_read_allowed!==true||!source.metadata?.allowed_brands?.includes(brand))throw Error('OFFICIAL_ENGINE_NOT_CONFIGURED');
 if(publish&&(source.metadata?.brand_engine_enrichment_allowed!==true||!source.metadata?.approval_actor||!source.metadata?.publication_approval_reference))throw Error('OFFICIAL_ENGINE_PUBLICATION_NOT_APPROVED');
 return def;
}

export function brandEngineCapability(def:any,source:any){
 if(def.workflow==='zf')return source?.is_active?'existing_review_engine':'source_registration_required';
 if(def.workflow==='elring')return source?.is_active?'existing_review_engine':'operational_hold';
 if(def.family==='manual')return 'manual_only';if(def.access==='authorization_required')return 'authorized_access_required';
 if(def.access==='server_access_required'&&source?.metadata?.server_access_verified!==true)return 'server_access_required';
 if(!def.reader)return def.sourceUrl?'adapter_required':'official_link_required';
 try{assertBrandEngineSource(source,def.brand,{sourceKey:def.sourceKey});return 'ready';}catch{return 'source_registration_required';}
}
export function matchesBrandEngineJob(job:any,definition:any){return job?.manifest?.brand===definition.brand&&job?.manifest?.source_key===definition.sourceKey;}
