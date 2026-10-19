export const SOURCE_VALIDATION_SAMPLE_LIMIT=500;
export const SOURCE_DIAGNOSTIC_FIELDS={
 MISSING_PRODUCT_CODE:['Product_Code','product_code'],MISSING_BUY_PRICE:['Buy_Price_Eur','buy_price'],
 INVALID_BUY_PRICE:['Buy_Price_Eur','buy_price'],AMBIGUOUS_BUY_PRICE_FORMAT:['Buy_Price_Eur','buy_price'],
 INVALID_WEIGHT:['Weight_kg','weight'],INVALID_MOQ:['MOQ','moq'],INVALID_LEAD_TIME:['Lead_Time_Days','lead_time_days'],
 INVALID_VALID_FROM:['Price_Date','valid_from'],MISSING_DATE:['Price_Date','valid_from'],
 MISSING_CURRENCY:['Currency','currency'],INVALID_CURRENCY:['Currency','currency'],UNSUPPORTED_CURRENCY:['Currency','currency'],
 DUPLICATE_PRODUCT_CODE:['Product_Code','product_code'],
};
export function createSourceValidationReport(validatorVersion='measurement-v1'){
 const report={version:1,validatorVersion,issueCount:0,counts:{},samples:[],truncated:false};
 return {report,add({sourceRowNumber,productCode='',code,value='',severity='error'}){
  const field=SOURCE_DIAGNOSTIC_FIELDS[code];if(!field||!Number.isSafeInteger(sourceRowNumber)||sourceRowNumber<1)throw Error('SOURCE_DIAGNOSTIC_INVALID');
  report.issueCount++;report.counts[code]=(report.counts[code]||0)+1;
  if(report.samples.length<SOURCE_VALIDATION_SAMPLE_LIMIT)report.samples.push({row:sourceRowNumber+1,productCode:String(productCode).slice(0,120),column:field[0],code,value:String(value??'').slice(0,200),severity});
  else report.truncated=true;
 }};
}
