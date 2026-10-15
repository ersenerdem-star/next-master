import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Render the real component with synthetic account data. Never load portal
// session storage, credentials, or a remote runtime.
const dir = await mkdtemp(resolve('node_modules/.customer-desk-test-'));
const entry = resolve(dir,'component.mjs');
await build({entryPoints:['apps/web/src/modules/portal/components/CustomerDeskHome.tsx'],bundle:true,outfile:entry,format:'esm',platform:'node',jsx:'automatic',packages:'external'});
const {CustomerDeskHome} = await import(pathToFileURL(entry).href);
const noop=()=>{};
const render=(creditAmount:number,openAmount:number,status='unpaid')=>renderToStaticMarkup(createElement(CustomerDeskHome,{
 snapshot:{invite:{party_name:'Synthetic customer'},accountSummary:{currency:'EUR',creditAmount,openAmount},pricingProfile:null,salesOrders:[{id:'local-order',sales_order_no:'SO-LOCAL',status,lines:[],sales_total:12,currency:'EUR'}],accountRows:[]},
 searchValue:'',onSearchValueChange:noop,onSearch:noop,onOpenSearch:noop,onOpenOrders:noop,onOpenBilling:noop,onOpenPriceLists:noop,
}));
try {
 test('account credit never substitutes outstanding debt',()=>{
   assert.match(render(0,450),/Account credit<\/small><strong>0\.00 EUR/);
   assert.match(render(25,450),/Account credit<\/small><strong>25\.00 EUR/);
 });
 test('unpaid and incomplete orders do not display a completed success tone',()=>{
   for(const status of ['unpaid','partially paid','incomplete','undelivered'])assert.match(render(0,0,status),/customer-desk-order-status--warning/);
   for(const status of ['paid','fully_paid','completed','delivered'])assert.match(render(0,0,status),/customer-desk-order-status--success/);
   assert.match(render(0,0,'cancelled'),/customer-desk-order-status--danger/);
 });
 test('price-list entry describes navigation without promising a PDF download',()=>{
   const html=render(0,0);
   assert.ok(html.includes('View price lists'));
   assert.ok(!html.includes('Download (PDF)'));
 });
} finally { await rm(dir,{recursive:true,force:true}); }
