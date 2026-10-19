import {fetchDensoSupplierCatalogFields} from './denso-official-provider.mjs';
import {createHash} from 'node:crypto';
import {fetchZfSupplierCatalogFields} from './zf-aftermarket-sync.mts';
import {fetchBoschSupplierCatalogFields} from './bosch-aftermarket-sync.mts';
import {fetchMannSupplierCatalogFields} from './mann-sync.mts';
import {fetchTecAllianceSupplierCatalogFields} from './tecalliance-sync.mts';
import {resolveTecAllianceBrandEntry} from './tecalliance-brand-registry.mts';
import {normalizeBrandKey} from './brand-standardization.mts';
import {CATALOG_FIELDS,exactCatalogCode} from './supplier-enrichment-plan.mjs';

export function supplierOfficialProvider(brand:string){
 const key=normalizeBrandKey(brand);
 if(key==='denso')return {key:'denso_official',fetch:fetchDensoSupplierCatalogFields};
 if(['sachs','lemforder','zf','trw','boge','wabco','lemfoerder'].includes(key))return {key:'zf',fetch:(code:string)=>fetchZfSupplierCatalogFields(brand,code)};
 if(key==='bosch')return {key:'bosch',fetch:fetchBoschSupplierCatalogFields};
 if(['mann','mannfilter'].includes(key))return {key:'mann',fetch:fetchMannSupplierCatalogFields};
 const entry=resolveTecAllianceBrandEntry(brand);
 if(entry)return {key:entry.preferredProviderKey,fetch:(code:string)=>fetchTecAllianceSupplierCatalogFields(brand,code,entry.sync)};
 return null;
}
export function safeSupplierOfficialObservation(value:any,code:string,brandId:string){
 if(value?.code!==exactCatalogCode(code)||typeof value.sourceUrl!=='string')throw Error('OFFICIAL_OBSERVATION_IDENTITY_INVALID');
 const u=new URL(value.sourceUrl);
 if(u.protocol!=='https:'||!['aftermarket.zf.com','ps.emea.dxtservice.com','www.mann-filter.com','web.tecalliance.net','www.denso-am.eu'].includes(u.hostname)||u.username||u.password)throw Error('OFFICIAL_OBSERVATION_SOURCE_INVALID');
 const fields=Object.fromEntries(CATALOG_FIELDS.filter(k=>value.fields?.[k]!=null).map(k=>[k,value.fields[k]]));
 return {fields,evidence:{authority:'official',code:exactCatalogCode(code),brandId,sourceUrl:u.href,
  observedAt:new Date().toISOString(),fingerprint:createHash('sha256').update(JSON.stringify({code:exactCatalogCode(code),source:u.href,fields})).digest('hex')}};
}
