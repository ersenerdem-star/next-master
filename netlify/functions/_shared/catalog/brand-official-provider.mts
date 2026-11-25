import {fetchMonroeCatalogFields,MONROE_TECALLIANCE_SOURCE} from './tecalliance-sync.mts';
import {fetchKnorrCatalogFields} from './knorr-official-provider.mjs';
import {normalizeBrandKey} from './brand-standardization.mts';
import {supplierOfficialProvider} from './supplier-official-completion.mts';
import {isSchaefflerBrand,SCHAEFFLER_ENGINE} from './schaeffler-family.mts';
import {fetchSchaefflerCatalogFields} from './schaeffler-official-provider.mjs';

// Generic brand jobs validate the registered source before using this reader.
// Keep supplier-upload source admission unchanged while Schaeffler is blocked.
export function brandOfficialProvider(brand:string){
 if(normalizeBrandKey(brand)==='knorrbremse')return {key:'knorr_bremse_aftermarket',fetch:fetchKnorrCatalogFields};
 if(normalizeBrandKey(brand)==='monroe')return {key:MONROE_TECALLIANCE_SOURCE,fetch:fetchMonroeCatalogFields};
 if(isSchaefflerBrand(brand))return {key:SCHAEFFLER_ENGINE.sourceKey,fetch:(code:string)=>fetchSchaefflerCatalogFields(brand,code)};
 return supplierOfficialProvider(brand);
}
