import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
import { multiplyMoney, sumMoney, requireUnitPrice, requireQuantity, roundMoney, marginPercent, salesOrderTotals } from '../../shared/order-money.mjs';
import { recomputeInvoiceTotals, recomputeBillTotals, previewInvoiceMoney } from '../../apps/web/src/shared/invoiceMoney.ts';

// Exercise the actual implementation, including the pre-repair nested editor
// functions. No copied calculator or mocked arithmetic.
function calculator(name, page) {
  const shared = 'apps/web/src/shared/invoiceMoney.ts';
  const path = fs.existsSync(shared) ? shared : page;
  const source = ts.createSourceFile(path, fs.readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
  let declaration;
  function visit(node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) declaration = node;
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert(declaration, `Actual ${name} implementation required`);
  const code = ts.transpileModule(declaration.getText(source).replace(/^export /, ''), {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
  return new Function('multiplyMoney','sumMoney','requireUnitPrice','requireQuantity','roundMoney','marginPercent','salesOrderTotals',`${code};return ${name};`)(multiplyMoney,sumMoney,requireUnitPrice,requireQuantity,roundMoney,marginPercent,salesOrderTotals);
}
const invoice = calculator('recomputeInvoiceTotals','apps/web/src/presentation/pages/SalesPage.tsx');
const bill = calculator('recomputeBillTotals','apps/web/src/presentation/pages/PurchasesPage.tsx');
const draft=(qty=1, buy=1.005, sell=2.005)=>({id:'synthetic-editor-only',updated_at:'unchanged',shipping_cost:0,discount_amount:0,lines:[{qty,buy_price:buy,sell_price:sell,description:'preserve',notes:'preserve'}]});

test('sales invoice editor rounds decimal products once, matching conversion',()=>{
  const result=invoice(draft());
  assert.deepEqual([result.purchase_total,result.subtotal,result.total_amount,result.profit_total],[1.01,2.01,2.01,1]);
  assert.equal(result.margin_percent,49.75);
});
test('purchase invoice editor uses the same decimal line rule',()=>{
  assert.equal(bill(draft()).lines[0].line_total,1.01);
  assert.equal(bill(draft()).total_amount,1.01);
});
test('both editors preserve valid fractional quantities and unit precision',()=>{
  for(const compute of [invoice,bill]){
    const result=compute(draft(.5,1.005,2.005));
    assert.equal(result.lines[0].qty,.5);
    assert.equal(result.lines[0].buy_price,1.005);
  }
});
test('invalid quantities, prices and excessive discounts are rejected, not coerced',()=>{
  for(const compute of [invoice,bill]){
    for(const qty of [0,-1,NaN,Infinity,.0000001])assert.throws(()=>compute(draft(qty)));
    for(const buy of [-1,NaN,Infinity])assert.throws(()=>compute(draft(1,buy)));
    assert.throws(()=>compute({...draft(),discount_amount:100}),/Discount/);
  }
});
test('shipping and discount round independently, before cent summation',()=>{
  const source={...draft(),shipping_cost:1.005,discount_amount:.005};
  assert.equal(invoice(source).total_amount,3.01);
  assert.equal(bill(source).total_amount,2.01);
});
test('calculators preserve input and are deterministic without timestamps or side effects',()=>{
  for(const compute of [invoice,bill]){
    const source=draft(3,.0025,1.005),before=JSON.stringify(source);
    const first=compute(source);
    assert.equal(JSON.stringify(source),before);
    assert.equal(first.updated_at,'unchanged');
    assert.deepEqual(first,compute(source));
    assert.equal(first.lines[0].description,'preserve');
  }
});

test('invalid intermediate editor input gives an error and no plausible preview total',()=>{
  for(const calculate of [recomputeInvoiceTotals,recomputeBillTotals]){
    const source=draft(0),before=JSON.stringify(source);
    assert.deepEqual(previewInvoiceMoney(calculate,null),{value:null,error:null});
    const result=previewInvoiceMoney(calculate,source);
    assert.equal(result.value,null);
    assert.match(result.error,/Quantity/);
    assert.equal(JSON.stringify(source),before);
    assert.equal(previewInvoiceMoney(calculate,draft()).error,null);
  }
});

test('actual API save functions normalize amounts and reject invalid data BEFORE transport',async()=>{
  const path='apps/web/src/infrastructure/api/ordersApi.ts';
  const source=ts.createSourceFile(path,fs.readFileSync(path,'utf8'),ts.ScriptTarget.Latest,true);
  const declarations=source.statements.filter(node=>ts.isFunctionDeclaration(node)&&['upsertInvoice','upsertBill'].includes(node.name?.text));
  assert.equal(declarations.length,2);
  const code=ts.transpileModule(declarations.map(d=>d.getText(source).replace(/^export /,'')).join('\n'),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
  const calls=[];
  const identity=v=>v;
  const rpc=async(name,payload)=>{calls.push({name,payload});return {[name==='save_invoice_atomic'?'invoice':'bill']:payload.payload};};
  const saves=new Function('recomputeInvoiceTotals','recomputeBillTotals','resolveInvoiceWarehouseDefaults','callAppRpc','mapInvoicePayload','mapBillPayload','mapInvoiceRow','mapBillRow',`${code};return [upsertInvoice,upsertBill];`)(recomputeInvoiceTotals,recomputeBillTotals,identity,rpc,identity,identity,identity,identity);
  for(const save of saves){
    const result=await save({...draft(),subtotal:999,total_amount:999},'same-id');
    assert.notEqual(result.subtotal,999);
    assert.equal(result.lines[0].buy_price,1.005);
    assert.equal(calls.at(-1).payload.previous_id,'same-id');
    const count=calls.length;
    await assert.rejects(save(draft(0)),/Quantity/);
    assert.equal(calls.length,count,'invalid input must not reach RPC');
  }
});

test('existing sixty-row fixture amount stays identical through editor calculation',()=>{
  const source={...draft(),shipping_cost:2.5,discount_amount:1,lines:Array.from({length:60},()=>({qty:2,buy_price:10.25,sell_price:16.5}))};
  const result=recomputeInvoiceTotals(source);
  assert.deepEqual([result.lines.length,result.subtotal,result.total_amount,result.purchase_total,result.profit_total,result.margin_percent],[60,1980,1981.5,1230,751.5,37.93]);
  assert.equal(recomputeBillTotals({...source,shipping_cost:0,discount_amount:0}).total_amount,1230);
});
