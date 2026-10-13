import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeSupplierPriceRow,parseSupplierPriceAmount} from '../../apps/engine/supplier-price-shadow/src/streaming-csv.mjs';

test('ambiguous single separators cannot turn a supplier price into a thousandfold value',()=>{
 for(const text of ['1.234','1,234','12.345','12,345','123.456','123,456']){
  assert.deepEqual(parseSupplierPriceAmount(text),{value:null,ambiguous:true},text);
  const row=normalizeSupplierPriceRow({sourceRowNumber:1,row:{product_code:'SKU',buy_price:text,currency:'EUR',valid_from:'2026-10-13'}});
  assert.equal(row.buy_price,null,text);
  assert.equal(row.row_status,'rejected',text);
  assert.equal(row.error_code,'AMBIGUOUS_BUY_PRICE_FORMAT',text);
  assert.match(row.error_message,/write 1234/,text);
 }
});

test('clear decimal and grouped formats keep their intended value',()=>{
 const examples=new Map([
  ['1234',1234],['1234.567',1234.567],['1234,567',1234.567],
  ['1.2340',1.234],['12.28',12.28],['12,28',12.28],
  ['1,234.56',1234.56],['1.234,56',1234.56],
  ['1,234,567',1234567],['1.234.567',1234567],
  ['1 234,56',1234.56],['1\u202f234.56',1234.56],
 ]);
 for(const [text,expected] of examples){
  assert.deepEqual(parseSupplierPriceAmount(text),{value:expected,ambiguous:false},text);
 }
 for(const text of ['1,23,4','1.23.4','1,234.56.7','EUR 12','1e3']){
  assert.deepEqual(parseSupplierPriceAmount(text),{value:null,ambiguous:false},text);
 }
});

test('typed XLSX numbers retain their decimal value; XLSX text remains guarded',()=>{
 assert.deepEqual(parseSupplierPriceAmount('1.234',{typedNumeric:true}),{value:1.234,ambiguous:false});
 const typed=normalizeSupplierPriceRow({sourceRowNumber:1,buyPriceIsNumeric:true,row:{product_code:'SKU',buy_price:'1.234',currency:'EUR',valid_from:'2026-10-13'}});
 assert.equal(typed.row_status,'accepted');
 assert.equal(typed.buy_price,1.234);
 const string=normalizeSupplierPriceRow({sourceRowNumber:1,row:{product_code:'SKU',buy_price:'1.234',currency:'EUR',valid_from:'2026-10-13'}});
 assert.equal(string.error_code,'AMBIGUOUS_BUY_PRICE_FORMAT');
});
