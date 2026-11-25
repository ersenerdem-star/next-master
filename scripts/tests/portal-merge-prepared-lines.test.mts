import test from 'node:test';
import assert from 'node:assert/strict';
import { mergePortalPreparedLines } from '../../apps/web/src/modules/portal/mergePortalPreparedLines.ts';

test('merges duplicate codes within the same brand and segment without mutating inputs',()=>{
  const line=(code:string,brand:string,segment:string,qty:number)=>({requestedCode:code,resolvedCode:code,brand,market_segment:segment,qty,sell_price:12}) as any;
  const current=[line('P-123','Bosch','truck',2),line('P123','Mann','truck',3)];
  const next=[line('p-123','BOSCH','TRUCK',4),line('P123','Bosch','car',5),line('p-123','bosch','truck',6)];
  const result=mergePortalPreparedLines(current,next);
  assert.deepEqual(result.map(x=>x.qty),[12,3,5]);
  assert.equal(current[0].qty,2);assert.equal(next[0].qty,4);assert.equal(result[0].sell_price,12);
});
test('does not merge distinct punctuated SKUs for the same brand or mutate either input',()=>{
  const line=(code:string,brand:string)=>({requestedCode:code,resolvedCode:code,brand,market_segment:'truck',qty:1,sell_price:12}) as any;
  for (const brand of ['Knorr-Bremse','Kolbenschmidt','Elring','Bosch','Wahler']) {
    const rows=[line('105-03366',brand),line('10503366',brand)];
    const result=mergePortalPreparedLines([],rows);
    assert.equal(result.length,2,brand);
    assert.deepEqual(result.map(x=>x.requestedCode),['105-03366','10503366']);
  }
});
test('handles a 200-line import without dropping or merging distinct products',()=>{
  const rows=Array.from({length:200},(_,i)=>({requestedCode:`P${i}`,brand:'Bosch',qty:i+1}) as any);
  const result=mergePortalPreparedLines([],rows);
  assert.equal(result.length,200);assert.deepEqual(result.map(x=>x.qty),rows.map(x=>x.qty));
});
