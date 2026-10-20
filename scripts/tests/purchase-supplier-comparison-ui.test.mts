import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PurchaseSupplierComparison } from '../../apps/web/src/presentation/components/purchases/PurchaseSupplierComparison.tsx';

test('rendered comparison exposes independent TPM/GroupAuto prices, differences, source terms and missing price',()=>{
 const order:any={supplier_name:'Romany',currency:'EUR',lines:[{product_code:'000366',brand:'SACHS',qty:2,buy_price:10,description:'Damper'},{product_code:'000369',brand:'SACHS',qty:2,buy_price:20,description:'Strut'}]};
 const base={product_code:'000366',brand:'SACHS',price_date:'2026-10-19',moq:1,order_multiple:1,stock_qty:100,valid_to:null};
 const rows=[[{...base,supplier_id:'TPM',supplier_name:'TPM',buy_price:12,notes:'Ships together'},{...base,supplier_id:'GA',supplier_name:'GroupAuto',buy_price:11,notes:'Collection only'}],[{...base,product_code:'000369',supplier_id:'TPM',supplier_name:'TPM',buy_price:23}]];
 const markup=renderToStaticMarkup(createElement(PurchaseSupplierComparison,{order,rows,indices:[0,1],supplierId:'',locale:'tr',vendors:[{display_name:'TPM',company_name:'TPM',payment_terms:'Net 30'}] as any,onSelectSupplier:()=>{},onSelectLines:()=>{}}));
 for(const text of ['TPM','GroupAuto','€12,00','€11,00','€70,00','+€10,00','000366','Net 30','Ships together','Collection only','Güncel fiyat yok','Belirtilmemiş']) assert.ok(markup.includes(text),text);
 assert.ok(markup.includes('aria-pressed="false"'));
 assert.ok(!markup.includes('aria-pressed="true"'),'never auto-select the cheapest supplier');
});
