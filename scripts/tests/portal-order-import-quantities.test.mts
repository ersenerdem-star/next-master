import test from 'node:test';
import assert from 'node:assert/strict';
import { File } from 'node:buffer';
import { parseOrderImportFile } from '../../apps/web/src/shared/orderImport.ts';
import * as XLSX from 'xlsx';

test('CSV and XLSX preserve valid quantities and blank defaults',async()=>{
  const csv=new File(['Part_No,Brand,Qty\nP550428,Donaldson,14\nP2,Donaldson,\n'],'order.csv');
  const rows=await parseOrderImportFile(csv as unknown as globalThis.File);
  assert.deepEqual(rows.map(row=>row.qty),[14,1]);
  const wb=XLSX.utils.book_new();XLSX.utils.book_append_sheet(wb,XLSX.utils.aoa_to_sheet([['Part_No','Brand','Qty'],['P550428','Donaldson',14]]),'order');
  const file=new File([XLSX.write(wb,{type:'buffer',bookType:'xlsx'})],'order.xlsx');
  assert.equal((await parseOrderImportFile(file as unknown as globalThis.File))[0].qty,14);
});
test('invalid or fractional quantities fail instead of becoming one',async()=>{
  for(const qty of ['0','-1','abc','1.5','2147483648']) {
    const file=new File([`Part_No,Brand,Qty\nP550428,Donaldson,${qty}\n`],'order.csv');
    await assert.rejects(()=>parseOrderImportFile(file as unknown as globalThis.File),/Invalid quantity for P550428/);
  }
});
