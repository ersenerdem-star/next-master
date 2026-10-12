import {DuckDBInstance} from '@duckdb/node-api';
import {basename} from 'node:path';

const safePath=value=>{
  if(typeof value!=='string'||!value.trim()||value.includes('\0'))throw Error('DUCKDB_INPUT_PATH_INVALID');
  return value;
};
const q=value=>`'${String(value).replaceAll("'","''")}'`;

// Executes bounded-memory validation outside Postgres. DuckDB streams CSV and
// spills intermediates to its temp directory when an aggregate needs it.
export async function validateCsvWithDuckDB({inputPath,delimiter=';',memoryLimit='512MB',threads=4,tempDirectory}){
  const path=safePath(inputPath);
  const instance=await DuckDBInstance.create(':memory:',{memory_limit:memoryLimit,threads:String(threads),...(tempDirectory?{temp_directory:tempDirectory}:{})});
  const connection=await instance.connect();
  try{
    const source=`read_csv_auto(${q(path)},header=true,delim=${q(delimiter)},sample_size=-1,ignore_errors=false)`;
    const reader=await connection.runAndReadAll(`with rows as (select regexp_replace(upper(coalesce(Product_Code,'')),'[^A-Z0-9]','','g') code,* from ${source}) select count(*)::UBIGINT total_rows,count(distinct nullif(code,''))::UBIGINT distinct_codes,(count(*)-count(distinct nullif(code,'')))::UBIGINT duplicate_rows,count(*) filter(where Buy_Price_EUR is null or nullif(trim(cast(Buy_Price_EUR as varchar)),'') is null)::UBIGINT missing_price_rows,count(distinct nullif(trim(cast(Currency as varchar)),''))::UBIGINT currency_count from rows`);
    const row=reader.getRowObjectsJson()[0];
    return {engine:'duckdb',source:basename(path),totalRows:Number(row.total_rows),distinctCodes:Number(row.distinct_codes),duplicateRows:Number(row.duplicate_rows),missingPriceRows:Number(row.missing_price_rows),currencyCount:Number(row.currency_count),publishable:Number(row.duplicate_rows)===0&&Number(row.missing_price_rows)===0&&Number(row.currency_count)<=1};
  }finally{connection.disconnectSync();}
}
