export function requirePublishableSupplierPriceValidation(summary,expectedRows){
 if(!summary||summary.engine!=='duckdb'||!Number.isSafeInteger(summary.totalRows)
  ||summary.totalRows<1||summary.totalRows!==Number(expectedRows)||summary.publishable!==true)
  throw Error('SUPPLIER_PRICE_FILE_VALIDATION_BLOCKED');
 return summary;
}
