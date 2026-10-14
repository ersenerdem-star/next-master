import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import ExcelJS from 'exceljs';
import {normalizeSupplierPriceRow,parseNormalizedSupplierPriceRows} from '../../apps/engine/supplier-price-shadow/src/streaming-csv.mjs';
import {parseNormalizedSupplierPriceRowsFromXlsx} from '../../apps/engine/supplier-price-shadow/src/streaming-xlsx.mjs';
import {validateCsvWithDuckDB} from '../../apps/engine/supplier-price-shadow/src/duckdb-validation.mjs';

const base={product_code:'001/2',buy_price:'10.50',currency:'EUR',valid_from:'2026-10-14'};
const collect=async rows=>{const result=[];for await(const row of rows)result.push(row);return result;};
const aliases={stock_qty:['Stock_Qty','Stock Quantity','Stock','Qty_In_Stock','Quantity In Stock','Available Stock','Available_Quantity'],
 order_multiple:['Order_Multiple','Order Multiple','Order_Qty_Multiple','Pack_Multiple','Pack Multiple','Case_Qty','Case Quantity'],
 valid_to:['Valid_To','Valid Until','Valid Through','Price_Valid_To','Expiry Date','Expiration_Date','End Date']};

test('every supported commercial-field alias rejects nonempty values including numeric zero without echoing source values',()=>{
 for(const [field,headers]of Object.entries(aliases))for(const header of headers)for(const value of [0,'0','5','sensitive supplier cell']){
  assert.throws(()=>normalizeSupplierPriceRow({sourceRowNumber:23,row:{...base,[header]:value}}),error=>{
   assert.equal(error.code,'SUPPLIER_UNSUPPORTED_COMMERCIAL_FIELD');assert.deepEqual(error.fields,[field]);
   assert.equal(error.sourceRowNumber,23);assert.ok(!error.message.includes('sensitive supplier cell'));return true;
  });
 }
});

test('blank unsupported columns retain identical normalized business data and row hash; metadata stays source-preserved',()=>{
 const row={...base,ean:'0123456789012',vehicle:'Vehicle',vehicle_model:'Model',market_segment:'pc',
  weight:'1.25',description_tr:'Ürün',origin:'DE',dimensions:'1x2',tariff:'8708',image_url:'https://example.invalid/image.png'};
 const expected=normalizeSupplierPriceRow({sourceRowNumber:1,row});
 const blank=Object.fromEntries(Object.values(aliases).flat().map((header,i)=>[header,[null,undefined,'',' \t'][i%4]]));
 assert.deepEqual(normalizeSupplierPriceRow({sourceRowNumber:1,row:{...row,...blank}}),expected);
 for(const field of ['ean','vehicle','vehicle_model','market_segment','description_tr','origin','dimensions','tariff','image_url'])assert.equal(expected[field],row[field]);
 assert.equal(expected.weight,1.25);assert.equal(expected.normalized_code,'001/2');
});

test('duplicate commercial aliases cannot overwrite a populated cell with a blank one',async()=>{
 const csv='Product_Code,Buy_Price_EUR,Order_Multiple,Case Quantity\nA,10.50,12,\n';
 await assert.rejects(collect(parseNormalizedSupplierPriceRows(Readable.from([csv]))),/CSV_DUPLICATE_HEADER/);
});

test('actual CSV and XLSX pipelines reject a later unsupported cell and allow blank template columns',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'supplier-commercial-fields-'));
 try{
  for(const [field,header]of [['order_multiple','Pack Multiple'],['stock_qty','Stock Quantity'],['valid_to','Valid Until']]){
   const columns=['Product_Code','Buy_Price_EUR','Price_Date',header,'EAN'];
   const records=[['001/2',10.5,'2026-10-14','','0123456789012'],['003',12.5,'2026-10-14',0,'0123456789013']];
   const csv=[columns,...records].map(row=>row.join(',')).join('\n')+'\n';
   const csvPath=join(dir,field+'.csv');await writeFile(csvPath,csv);
   const book=new ExcelJS.Workbook();const sheet=book.addWorksheet('Prices');sheet.addRows([columns,...records]);
   const xlsxPath=join(dir,field+'.xlsx');await book.xlsx.writeFile(xlsxPath);
   const rejected=error=>error.code==='SUPPLIER_UNSUPPORTED_COMMERCIAL_FIELD'&&error.sourceRowNumber===2&&error.fields.includes(field);
   await assert.rejects(collect(parseNormalizedSupplierPriceRows(Readable.from([csv]))),rejected);
   await assert.rejects(collect(parseNormalizedSupplierPriceRowsFromXlsx(xlsxPath)),rejected);
   await assert.rejects(validateCsvWithDuckDB({inputPath:csvPath,tempDirectory:dir}),rejected);
   await assert.rejects(validateCsvWithDuckDB({inputPath:xlsxPath,tempDirectory:dir}),rejected);
   sheet.getCell('D3').value=null;await book.xlsx.writeFile(xlsxPath);
   const allowed=await collect(parseNormalizedSupplierPriceRowsFromXlsx(xlsxPath));
   assert.equal(allowed.length,2);assert.ok(allowed.every(row=>row.row_status==='accepted'));
   assert.equal(allowed[0].ean,'0123456789012');
  }
 }finally{await rm(dir,{recursive:true,force:true});}
});
