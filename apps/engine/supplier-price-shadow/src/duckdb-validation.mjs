import {createSourceValidationReport,SOURCE_VALIDATION_SAMPLE_LIMIT} from './source-validation-report.mjs';
import {DuckDBInstance} from '@duckdb/node-api';
import {createReadStream,createWriteStream} from 'node:fs';
import {mkdtemp,rm} from 'node:fs/promises';
import {basename,join} from 'node:path';
import {tmpdir} from 'node:os';
import {once} from 'node:events';
import {finished} from 'node:stream/promises';
import {parseNormalizedSupplierPriceRowsFromXlsx} from './streaming-xlsx.mjs';
import {parseNormalizedSupplierPriceRows} from './streaming-csv.mjs';
import {applyReleaseSourceDate} from './storage-scan.mjs';
export {requirePublishableSupplierPriceValidation} from './supplier-price-validation-gate.mjs';

const safePath=value=>{
  if(typeof value!=='string'||!value.trim()||value.includes('\0'))throw Error('DUCKDB_INPUT_PATH_INVALID');
  return value;
};
const q=value=>`'${String(value).replaceAll("'","''")}'`;
const csvCell=value=>{
 const text=value==null?'':String(value);
 return /[",\n\r]/.test(text)?`"${text.replaceAll('"','""')}"`:text;
};

// Parse with the same delimiter, header aliases, number/date and code rules
// that stage rows. DuckDB never reinterprets the supplier's original file.
async function writeNormalizedCsv(inputPath,outputPath,sourceDate,commercialFields,diagnostics){
 const rows=/\.xlsx$/i.test(inputPath)
  ?parseNormalizedSupplierPriceRowsFromXlsx(inputPath,{commercialFields,sourceDate,onDiagnostic:diagnostics.add})
  :parseNormalizedSupplierPriceRows(createReadStream(inputPath),{commercialFields,sourceDate,onDiagnostic:diagnostics.add});
 // Resolve the supplier header before opening the output stream. A malformed
 // header must fail without destroying a stream with an in-flight write.
 const first=await rows.next();
 const output=createWriteStream(outputPath,{flags:'wx',mode:0o600});
 const completed=finished(output);
 // Observe an asynchronous open/write error even if the source parser fails
 // before the first drain. Cleanup must wait for this owned stream to close.
 completed.catch(()=>{});
 try{
  output.write('source_row_number,normalized_code,buy_price,currency,valid_from,row_status,error_message\n');
  const emit=async parsed=>{
   const row=applyReleaseSourceDate(parsed,sourceDate);
   if(row.currency&&row.currency!=='EUR')diagnostics.add({sourceRowNumber:row.source_row_number,productCode:row.product_code,code:'UNSUPPORTED_CURRENCY',value:row.currency});
   if(!row.valid_from&&!row.error_message?.includes('INVALID_VALID_FROM'))diagnostics.add({sourceRowNumber:row.source_row_number,productCode:row.product_code,code:'MISSING_DATE'});
   const line=[row.source_row_number,row.normalized_code,row.buy_price,row.currency,row.valid_from,row.row_status,row.error_message]
    .map(csvCell).join(',')+'\n';
   if(!output.write(line))await once(output,'drain');
  };
  if(!first.done)await emit(first.value);
  for await(const parsed of rows){
   await emit(parsed);
  }
  output.end();
  await completed;
 }catch(error){output.destroy();await completed.catch(()=>{});throw error;}
}

// Current commercial prices and exports are EUR-only. Other currencies need
// an explicit FX design before they can be marked publishable.
export async function validateCsvWithDuckDB({inputPath,memoryLimit='512MB',threads=4,tempDirectory,sourceDate=null,commercialFields=false}){
 const input=safePath(inputPath);
 const workDir=await mkdtemp(join(tempDirectory||tmpdir(),'supplier-price-validate-'));
 const path=join(workDir,'normalized.csv');
 let connection;
 try{
  const diagnostics=createSourceValidationReport(commercialFields?'measurement-v1':'legacy');
  await writeNormalizedCsv(input,path,sourceDate,commercialFields,diagnostics);
  const instance=await DuckDBInstance.create(':memory:',{memory_limit:memoryLimit,threads:String(threads),...(tempDirectory?{temp_directory:tempDirectory}:{})});
  connection=await instance.connect();
  const source=`read_csv(${q(path)},auto_detect=false,header=true,delim=',',quote='"',escape='"',
    columns={'source_row_number':'BIGINT','normalized_code':'VARCHAR','buy_price':'VARCHAR','currency':'VARCHAR',
      'valid_from':'VARCHAR','row_status':'VARCHAR','error_message':'VARCHAR'},
    strict_mode=true,ignore_errors=false,null_padding=false)`;
  const reader=await connection.runAndReadAll(`with rows as (
    select nullif(trim(normalized_code),'') code,
           nullif(trim(buy_price),'') price,
           nullif(trim(currency),'') currency,
           nullif(trim(valid_from),'') valid_from,
           row_status,error_message from ${source}
   ) select
     count(*)::UBIGINT total_rows,
     count(distinct code)::UBIGINT distinct_codes,
     (count(code)-count(distinct code))::UBIGINT duplicate_rows,
     count(*) filter(where code is null or not regexp_matches(code,'[A-Z0-9]'))::UBIGINT invalid_code_rows,
     count(*) filter(where price is null or try_cast(price as decimal(20,6)) is null)::UBIGINT missing_price_rows,
     count(*) filter(where try_cast(price as decimal(20,6))<=0)::UBIGINT nonpositive_price_rows,
     count(*) filter(where currency is null or not regexp_matches(currency,'^[A-Z]{3}$'))::UBIGINT invalid_currency_rows,
     count(*) filter(where currency is not null and currency<>'EUR')::UBIGINT non_eur_currency_rows,
     count(distinct currency)::UBIGINT currency_count,
     count(*) filter(where valid_from is null)::UBIGINT missing_date_rows,
     count(*) filter(where strpos(coalesce(error_message,''),'INVALID_VALID_FROM')>0)::UBIGINT invalid_date_rows,
     count(*) filter(where row_status='rejected')::UBIGINT rejected_rows,
     count(*) filter(where row_status='warning')::UBIGINT warning_rows
   from rows`);
  const raw=reader.getRowObjectsJson()[0];
  const numeric=['totalRows','distinctCodes','duplicateRows','invalidCodeRows','missingPriceRows',
   'nonPositivePriceRows','invalidCurrencyRows','nonEurCurrencyRows','currencyCount',
   'missingDateRows','invalidDateRows','rejectedRows','warningRows'];
  const keys=['total_rows','distinct_codes','duplicate_rows','invalid_code_rows','missing_price_rows',
   'nonpositive_price_rows','invalid_currency_rows','non_eur_currency_rows','currency_count',
   'missing_date_rows','invalid_date_rows','rejected_rows','warning_rows'];
  const result={engine:'duckdb',source:basename(input)};
  numeric.forEach((key,index)=>{result[key]=Number(raw[keys[index]]);});
  result.publishable=result.totalRows>0&&result.duplicateRows===0&&result.invalidCodeRows===0
   &&result.missingPriceRows===0&&result.nonPositivePriceRows===0&&result.invalidCurrencyRows===0
   &&result.nonEurCurrencyRows===0&&result.currencyCount===1&&result.missingDateRows===0
   &&result.invalidDateRows===0&&result.rejectedRows===0&&result.warningRows===0;
  const duplicateReader=await connection.runAndReadAll(`select source_row_number,normalized_code from (
    select source_row_number,normalized_code,row_number()over(partition by normalized_code order by source_row_number) occurrence
    from ${source} where nullif(trim(normalized_code),'') is not null
   ) where occurrence>1 order by source_row_number limit ${SOURCE_VALIDATION_SAMPLE_LIMIT}`);
  const duplicates=duplicateReader.getRowObjectsJson();
  for(const row of duplicates)diagnostics.add({sourceRowNumber:Number(row.source_row_number),productCode:row.normalized_code,code:'DUPLICATE_PRODUCT_CODE',value:row.normalized_code});
  if(result.duplicateRows>duplicates.length){const extra=result.duplicateRows-duplicates.length;diagnostics.report.issueCount+=extra;diagnostics.report.counts.DUPLICATE_PRODUCT_CODE=result.duplicateRows;diagnostics.report.truncated=true;}
  result.diagnostics=diagnostics.report;
  return result;
 }finally{connection?.disconnectSync();await rm(workDir,{recursive:true,force:true});}
}
