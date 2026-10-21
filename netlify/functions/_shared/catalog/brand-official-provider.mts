import {supplierOfficialProvider} from './supplier-official-completion.mts';
import {isSchaefflerBrand,SCHAEFFLER_ENGINE} from './schaeffler-family.mts';
import {fetchSchaefflerCatalogFields} from './schaeffler-official-provider.mjs';

// Generic brand jobs validate the registered source before using this reader.
// Keep supplier-upload source admission unchanged while Schaeffler is blocked.
export function brandOfficialProvider(brand:string){
 if(isSchaefflerBrand(brand))return {key:SCHAEFFLER_ENGINE.sourceKey,fetch:(code:string)=>fetchSchaefflerCatalogFields(brand,code)};
 return supplierOfficialProvider(brand);
}
