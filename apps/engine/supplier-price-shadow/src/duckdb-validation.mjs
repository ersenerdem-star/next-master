import {DuckDBInstance} from '@duckdb/node-api';
import {createWriteStream} from 'node:fs';
import {basename,join} from 'node:path';
import {once} from 'node:events';
import {parseNormalizedSupplierPriceRowsFromXlsx} from './streaming-xlsx.mjs';

const safePath=value=>{
  if(typeof value!=='string'||!value.trim()||value.includes('\0'))throw Error('DUCKDB_INPUT_PATH_INVALID');
  return value;
};
const q=value=>`'${String(value).replaceAll("'","''")}'`;

const csvCell=value=>{
 const text=value==null?'':String(value);
 return /[",\n\r]/.test(text)?`"${text.replaceAll('"','""')}"`:text;
};

async function xlsxToValidationCsv(inputPath,tempDirectory){
 if(!tempDirectory)throw Error('DUCKDB_XLSX_TEMP_DIRECTORY_REQUIRED');
 const outputPath=join(tempDirectory,'duckdb-validation-input.csv');
 const output=createWriteStream(outputPath,{flags:'wx',mode:0o600});
 output.write('Product_Code,Buy_Price_EUR,Currency\n');
 for await(const row of parseNormalizedSupplierPriceRowsFromXlsx(inputPath)){
  const line=[row.product_code,row.buy_price,row.currency].map(csvCell).join(',')+'\n';
  if(!output.write(line))await once(output,'drain');
 }
 output.end();
 await once(output,'close');
 return outputPath;
}

// Executes bounded-memory validation outside Postgres. DuckDB streams CSV and
// spills intermediates to its temp directory when an aggregate needs it.
export async function validateCsvWithDuckDB({inputPath,delimiter=';',memoryLimit='512MB',threads=4,tempDirectory}){
  const input=safePath(inputPath);
  const isXlsx=/\.xlsx$/i.test(input);
  const path=isXlsx?await xlsxToValidationCsv(input,tempDirectory):input;
  const instance=await DuckDBInstance.create(':memory:',{memory_limit:memoryLimit,threads:String(threads),...(tempDirectory?{temp_directory:tempDirectory}:{})});
  const connection=await instance.connect();
  try{
    const source=`read_csv_auto(${q(path)},header=true,delim=${q(isXlsx?',':delimiter)},sample_size=-1,ignore_errors=false)`;
    const reader=await connection.runAndReadAll(`with rows as (select regexp_replace(upper(coalesce(Product_Code,'')),'[^A-Z0-9]','','g') code,* from ${source}) select count(*)::UBIGINT total_rows,count(distinct nullif(code,''))::UBIGINT distinct_codes,(count(*)-count(distinct nullif(code,'')))::UBIGINT duplicate_rows,count(*) filter(where Buy_Price_EUR is null or nullif(trim(cast(Buy_Price_EUR as varchar)),'') is null)::UBIGINT missing_price_rows,count(distinct nullif(trim(cast(Currency as varchar)),''))::UBIGINT currency_count from rows`);
    const row=reader.getRowObjectsJson()[0];
    return {engine:'duckdb',source:basename(path),totalRows:Number(row.total_rows),distinctCodes:Number(row.distinct_codes),duplicateRows:Number(row.duplicate_rows),missingPriceRows:Number(row.missing_price_rows),currencyCount:Number(row.currency_count),publishable:Number(row.duplicate_rows)===0&&Number(row.missing_price_rows)===0&&Number(row.currency_count)<=1};
  }finally{connection.disconnectSync();}
}
