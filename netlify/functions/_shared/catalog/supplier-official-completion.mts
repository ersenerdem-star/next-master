import {fetchDensoSupplierCatalogFields} from './denso-official-provider.mjs';
import {fetchDelphiOfficialFields} from './delphi-official-provider.mts';
import {fetchSkfSupplierCatalogFields} from './skf-official-provider.mjs';
import {createHash} from 'node:crypto';
import {fetchZfSupplierCatalogFields} from './zf-aftermarket-sync.mts';
import {fetchBoschSupplierCatalogFields} from './bosch-aftermarket-sync.mts';
import {fetchMannSupplierCatalogFields} from './mann-sync.mts';
import {fetchTecAllianceSupplierCatalogFields} from './tecalliance-sync.mts';
import {resolveTecAllianceBrandEntry} from './tecalliance-brand-registry.mts';
import {normalizeBrandKey} from './brand-standardization.mts';
import {CATALOG_FIELDS,exactCatalogCode} from './supplier-enrichment-plan.mjs';
import {catalogLifecycleReview} from './catalog-completion-review.mjs';

type SourceFetch = {fetchImpl?:typeof fetch};

export function supplierOfficialProvider(brand:string){
 const key=normalizeBrandKey(brand);
 if(key==='denso')return {key:'denso_official',budgetGroup:'denso',fetch:(code:string,options?:SourceFetch)=>fetchDensoSupplierCatalogFields(code,20000,options?.fetchImpl)};
 if(key==='delphi')return {key:'delphi_official_catalog',budgetGroup:'delphi',fetch:fetchDelphiOfficialFields};
 if(key==='skf')return {key:'skf_automotive_official',budgetGroup:'skf',fetch:(code:string,options?:SourceFetch)=>fetchSkfSupplierCatalogFields(code,20000,options?.fetchImpl)};
 if(['sachs','lemforder','zf','trw','boge','wabco','lemfoerder'].includes(key))return {key:'zf',budgetGroup:'zf',fetch:(code:string,options?:SourceFetch)=>fetchZfSupplierCatalogFields(brand,code,15000,options?.fetchImpl)};
 if(key==='bosch')return {key:'bosch',budgetGroup:'bosch',fetch:(code:string,options?:SourceFetch)=>fetchBoschSupplierCatalogFields(code,12000,options?.fetchImpl)};
 if(['mann','mannfilter'].includes(key))return {key:'mann',budgetGroup:'mann',fetch:(code:string,options?:SourceFetch)=>fetchMannSupplierCatalogFields(code,12000,options?.fetchImpl)};
 const entry=resolveTecAllianceBrandEntry(brand);
 if(entry)return {key:entry.preferredProviderKey,budgetGroup:'tecalliance' as const,
  fetch:(code:string,options?:{fetchImpl?:typeof fetch})=>fetchTecAllianceSupplierCatalogFields(brand,code,entry.sync,12000,options?.fetchImpl)};
 return null;
}
export function safeSupplierOfficialObservation(value:any,code:string,brandId:string){
 if(value?.code!==exactCatalogCode(code)||typeof value.sourceUrl!=='string')throw Error('OFFICIAL_OBSERVATION_IDENTITY_INVALID');
 const u=new URL(value.sourceUrl);
 if(u.protocol!=='https:'||!['aftermarket.zf.com','ps.emea.dxtservice.com','www.mann-filter.com','web.tecalliance.net','www.denso-am.eu','automotive.skf.com','vehiclelifetimesolutions.schaeffler.com','www.delphiautoparts.com','mytruckservices.knorr-bremse.com'].includes(u.hostname)||u.username||u.password)throw Error('OFFICIAL_OBSERVATION_SOURCE_INVALID');
 const fields=Object.fromEntries(CATALOG_FIELDS.filter(k=>value.fields?.[k]!=null).map(k=>[k,value.fields[k]]));
 const lifecycle=catalogLifecycleReview(value);
 return {fields,evidence:{authority:'official',code:exactCatalogCode(code),brandId,sourceUrl:u.href,
  sourceEan:fields.ean??null,lifecycle,observedAt:new Date().toISOString(),fingerprint:createHash('sha256').update(JSON.stringify({code:exactCatalogCode(code),source:u.href,fields,lifecycle})).digest('hex'),
  ...(typeof value.sourceFingerprint==='string'&&/^[a-f0-9]{64}$/.test(value.sourceFingerprint)?{sourceFingerprint:value.sourceFingerprint}:{}),
  ...(Array.isArray(value.diagnostics)?{sourceDiagnostics:value.diagnostics.filter((v:any)=>typeof v==='string'&&/^[A-Z_]{1,100}$/.test(v)).slice(0,12)}:{})}};
}
