import {DuckDBInstance} from '@duckdb/node-api';
import {createWriteStream} from 'node:fs';
import {readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {once} from 'node:events';

const q=value=>`'${String(value).replaceAll("'","''")}'`;
const csv=value=>{const text=value==null?'':String(value);return /[",\n\r]/.test(text)?`"${text.replaceAll('"','""')}"`:text};
const safePageSize=value=>Number.isInteger(value)&&value>0&&value<=5000;

// Materializes authorized, already-priced export pages to a private CSV and
// lets DuckDB perform the bounded-memory ordering/projection before the normal
// deterministic workbook assembler consumes the result. The page callback
// remains the authority boundary; DuckDB never receives browser scope input.
export async function materializePagedExportWithDuckDB({fetchPage,binding,expectedRows,pageSize=1000,outputDir,tempDirectory=outputDir}){
 if(typeof fetchPage!=='function'||typeof binding!=='string'||!binding||!Number.isSafeInteger(expectedRows)||expectedRows<1||expectedRows>10_000_000||!safePageSize(pageSize)||typeof outputDir!=='string'||!outputDir||typeof tempDirectory!=='string'||!tempDirectory)throw Error('DUCKDB_EXPORT_CONFIG_INVALID');
 const inputPath=join(tempDirectory,'authorized-export-input.csv');
 const sortedPath=join(outputDir,'duckdb-export-sorted.csv');
 const stream=createWriteStream(inputPath,{flags:'wx',mode:0o600});
 stream.write('cursor_key,code,description,price,currency,price_date,discontinued,replacement_code,brand\n');
 let after=null,processed=0,pageCount=0;
 try{
  while(processed<expectedRows){
   const page=await fetchPage({binding,after,limit:Math.min(pageSize,expectedRows-processed)});
   if(!page||page.binding!==binding||!Array.isArray(page.rows)||!page.rows.length||page.rows.length>pageSize||page.done!==(processed+page.rows.length===expectedRows)||page.nextCursor!==(page.done?null:String(page.rows.at(-1).cursorKey??page.rows.at(-1).code)))throw Error('DUCKDB_EXPORT_PAGE_INVALID');
   for(const row of page.rows){
    if(typeof row.code!=='string'||typeof row.brand!=='string'||typeof row.currency!=='string'||typeof row.price!=='string'||typeof row.priceDate!=='string'||typeof row.discontinued!=='boolean')throw Error('DUCKDB_EXPORT_ROW_INVALID');
    const line=[row.cursorKey??'',row.code,row.description??'',row.price,row.currency,row.priceDate,row.discontinued?'true':'false',row.replacementCode??'',row.brand].map(csv).join(',')+'\n';
    if(!stream.write(line))await once(stream,'drain');
   }
   processed+=page.rows.length; pageCount++; after=page.nextCursor;
  }
  stream.end(); await once(stream,'close');
  const instance=await DuckDBInstance.create(':memory:',{memory_limit:'512MB',threads:'4',temp_directory:tempDirectory});
  const connection=await instance.connect();
  try{
   await connection.run(`copy (select cursor_key,code,description,price,currency,price_date,discontinued,replacement_code,brand from read_csv_auto(${q(inputPath)},header=true,ignore_errors=false) order by case when nullif(cursor_key,'') is null then 1 else 0 end,cursor_key,code) to ${q(sortedPath)} (header,delimiter ',')`);
  }finally{connection.disconnectSync();}
  return {engine:'duckdb',binding,expectedRows,processedRows:processed,pageCount,inputPath,sortedPath};
 }catch(error){stream.destroy();throw error;}
}

export async function readDuckDbExportCsv(path){
 if(typeof path!=='string'||!path)throw Error('DUCKDB_EXPORT_PATH_INVALID');
 return readFile(path,'utf8');
}

export async function cleanupDuckDbExportSource(directory){
 if(typeof directory==='string'&&directory)await rm(directory,{recursive:true,force:true});
}
