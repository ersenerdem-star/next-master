import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import {preparePriceExport,assemblePriceExport,exportBinding} from '../../apps/engine/supplier-price-shadow/src/export/partitioned-price-export.mjs';
import {parseManualMarginPercent, adminPriceListFileLabel} from '../../shared/admin-price-list-margin.mjs';
import {markupMoney} from '../../shared/order-money.mjs';
import {quantityTierLabels} from '../../shared/wahler-price-tiers.mjs';
import {
  materializeSealedSnapshotWithDuckDB,
  materializePagedExportWithDuckDB,
  createDuckDbPagedExportSource,
} from '../../apps/engine/supplier-price-shadow/src/export/duckdb-export-source.mjs';

test('sealed snapshot DuckDB CSV round trip preserves priced fields and paging', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'duckdb-sealed-roundtrip-'));
  const binding = 'sealed-snapshot-test-binding';
  const snapshotId = '00000000-0000-4000-8000-000000000001';
  const rows = [
    { code: '61/1', description: 'Oil filter, "premium"\nseries', price: '12.34' },
    { code: '611', description: 'Different SKU', price: '2.50' },
    { code: 'A-3', description: 'Third part', price: '100.00' },
    { code: 'B 4', description: 'Fourth part', price: '0.99' },
    { code: 'Z/5', description: 'Fifth part', price: '20.10' },
  ].map((row, index) => ({
    ordinal: index + 1,
    payload: {
      cursorKey: String(index + 1).padStart(12, '0'),
      code: row.code,
      description: row.description,
      price: row.price,
      currency: 'EUR',
      priceDate: '2026-10-13',
      discontinued: index === 2,
      replacementCode: index === 2 ? 'A-4' : '',
      brand: 'Clevite',
    },
  }));
  let released = false;
  const pool = {
    async connect() {
      return {
        async query(sql, params) {
          assert.match(sql, /export_snapshot_private\.rows/);
          assert.equal(params[0], snapshotId);
          return { rows: rows.filter((row) => row.ordinal > params[1]).slice(0, params[2]) };
        },
        release() { released = true; },
      };
    },
  };

  try {
    const materialized = await materializeSealedSnapshotWithDuckDB({
      pool, snapshotId, binding, expectedRows: rows.length,
      outputDir: directory, tempDirectory: directory, batchSize: 2,
    });
    assert.equal(materialized.processedRows, 5);
    assert.equal(materialized.pageCount, 3);
    assert.equal(released, true);

    const fetchPage = createDuckDbPagedExportSource({
      sortedPath: materialized.sortedPath, binding, expectedRows: rows.length, pageSize: 2,
    });
    const first = await fetchPage({ binding, after: null, limit: 2 });
    assert.equal(first.done, false);
    assert.equal(first.nextCursor, '000000000002');
    const second = await fetchPage({ binding, after: first.nextCursor, limit: 2 });
    assert.equal(second.done, false);
    assert.equal(second.nextCursor, '000000000004');
    const third = await fetchPage({ binding, after: second.nextCursor, limit: 2 });
    assert.equal(third.done, true);
    assert.equal(third.nextCursor, null);

    const actual = [...first.rows, ...second.rows, ...third.rows];
    assert.deepEqual(actual.map(({ cursorKey, code, description, price, priceDate }) => ({
      cursorKey, code, description, price, priceDate,
    })), rows.map(({ payload }) => ({
      cursorKey: payload.cursorKey, code: payload.code,
      description: payload.description, price: payload.price, priceDate: payload.priceDate,
    })));
    assert.equal(actual[2].discontinued, true);
    assert.equal(actual[2].replacementCode, 'A-4');
    assert.equal(actual[0].brand, 'Clevite');
    assert.equal(actual[0].currency, 'EUR');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

for(const kind of ['sealed','paged'])test(`${kind} export preserves rare commas/quotes/newlines beyond the CSV sniff sample`,async()=>{
 const directory=await mkdtemp(join(tmpdir(),'duckdb-late-quote-'));
 const binding='late-quote',snapshotId='00000000-0000-4000-8000-000000000002';
 const values=Array.from({length:30003},(_,i)=>({cursorKey:String(i+1).padStart(12,'0'),code:`P${i}`,
  description:'',price:'7.01',currency:'EUR',priceDate:'2026-10-16',discontinued:false,replacementCode:'',brand:'VAG'}));
 values[30000].code='FOLIA3,5';
 values[30001].description='Quoted "label", € price\nsecond line';
 values[30002].replacementCode='R,"2"';
 const source=async after=>values.filter(v=>after==null||v.cursorKey>after).slice(0,5000);
 try{
  const input={binding,expectedRows:values.length,outputDir:directory,tempDirectory:directory};
  const result=kind==='sealed'?await materializeSealedSnapshotWithDuckDB({...input,snapshotId,
   pool:{async connect(){return {async query(_sql,args){return {rows:values.slice(Number(args[1]),Number(args[1])+args[2]).map(v=>({ordinal:Number(v.cursorKey),payload:v}))};},release(){}};}}})
   :await materializePagedExportWithDuckDB({...input,pageSize:5000,fetchPage:async({after})=>{
    const rows=await source(after),done=rows.at(-1).cursorKey===values.at(-1).cursorKey;
    return {binding,rows,done,nextCursor:done?null:rows.at(-1).cursorKey};
   }});
  const read=createDuckDbPagedExportSource({...input,sortedPath:result.sortedPath,pageSize:5000});
  let after=null,count=0;
  for(;;){const page=await read({binding,after,limit:5000});
   for(const row of page.rows){assert.deepEqual(row,values[count]);count++;}
   if(page.done)break;after=page.nextCursor;
  }
  assert.equal(count,values.length);
 }finally{await rm(directory,{recursive:true,force:true});}
});

async function checkWahlerWorkbook({customerId,audience,margin,base,tiersText}){
 const directory=await mkdtemp(join(tmpdir(),'wahler-ready-workbook-'));
 const input={tenantId:'org',requesterId:'actor',customerId,audience,
  snapshotId:'wahler-snapshot',pricingVersion:'test',brand:'Wahler',currency:'EUR',expectedRows:1};
 const binding=exportBinding(input);
 const tiers=quantityTierLabels([
  {code:'411471.103D',minimum_quantity:256,unit_buy_price:28.82},
  {code:'411471.103D',minimum_quantity:16,unit_buy_price:'29.68'},
 ],margin);
 const row={cursorKey:'000000000001',code:'411471.103D',brand:'Wahler',description:'Thermostat',
  price:markupMoney('30.58',margin).toFixed(2),priceDate:'2026-11-12',currency:'EUR',discontinued:false,
  quantityTiers:tiers.get('411471.103D')};
 try{
  const result=await materializePagedExportWithDuckDB({
   outputDir:directory,binding,expectedRows:1,fetchPage:async()=>({binding,rows:[row],done:true,nextCursor:null}),
  });
  const fetchPage=createDuckDbPagedExportSource({sortedPath:result.sortedPath,binding,expectedRows:1});
  await preparePriceExport({input,directory,fetchPage});
  const artifact=await assemblePriceExport({input,directory});
  const workbook=new ExcelJS.Workbook();
  await workbook.xlsx.readFile(join(directory,artifact.file));
  const sheet=workbook.worksheets[0];
  assert.equal(sheet.rowCount,2);
  assert.equal(sheet.getCell('F1').value,'Quantity_Prices_EUR');
  assert.equal(sheet.getCell('A2').value,'411471.103D');
  assert.equal(sheet.getCell('C2').value,base);
  assert.equal(sheet.getCell('F2').value,tiersText);
 }finally{await rm(directory,{recursive:true,force:true});}
}

test('Wahler customer workbook carries selling tiers through DuckDB with one base row',async()=>{
 await checkWahlerWorkbook({customerId:'customer',audience:'customer',margin:10,base:33.64,tiersText:'16+: 32.65 | 256+: 31.70'});
});

test('Wahler admin workbook carries the custom 12,5% rate through DuckDB',async()=>{
 const margin=parseManualMarginPercent('12,5');
 assert.equal(margin,0.125);
 assert.equal(parseManualMarginPercent('12.5'),margin);
 assert.equal(parseManualMarginPercent('0'),0);
 assert.equal(parseManualMarginPercent(''),null);
 assert.equal(adminPriceListFileLabel('Manual',margin),'Manual-12.5pct');
 assert.equal(adminPriceListFileLabel('A',margin),'A');
 await checkWahlerWorkbook({customerId:null,audience:'admin',margin:margin*100,base:34.40,tiersText:'16+: 33.39 | 256+: 32.42'});
});
