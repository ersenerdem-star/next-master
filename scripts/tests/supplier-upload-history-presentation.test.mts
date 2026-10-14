import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {SupplierLegacyHistory} from '../../apps/web/src/modules/admin/SupplierLegacyHistory.tsx';
import {downloadSupplierTemplate,VERIFIED_SUPPLIER_IMPORT_COLUMNS} from '../../apps/web/src/shared/importTemplates.ts';
import {parseCsv} from '../../apps/web/src/shared/csv.ts';
import {I18nProvider,useI18n} from '../../apps/web/src/i18n/I18nProvider.tsx';

test('verified template round-trips supported commercial fields without inventing supplier stock',async()=>{
 const original={document:globalThis.document,window:globalThis.window,create:URL.createObjectURL,revoke:URL.revokeObjectURL};
 const blobs:Blob[]=[],names:string[]=[];
 try {
  URL.createObjectURL=(blob)=>{blobs.push(blob as Blob);return 'blob:template-test';};URL.revokeObjectURL=()=>{};
  globalThis.document={createElement:()=>({href:'',download:'',click(){names.push(this.download);},remove(){}}),body:{appendChild(){}}} as unknown as Document;
  globalThis.window={setTimeout:(fn:()=>void)=>{fn();return 0;}} as unknown as Window&typeof globalThis;
  downloadSupplierTemplate({verified:true});downloadSupplierTemplate();
  assert.deepEqual(names,['supplier-import-template.csv','supplier-import-template.csv']);
  const verified=parseCsv(await blobs[0].text()),legacy=parseCsv(await blobs[1].text());
  assert.deepEqual(verified[0],[...VERIFIED_SUPPLIER_IMPORT_COLUMNS]);
  assert.equal(verified[0].length,verified[1].length);
  assert.equal(verified[1][verified[0].indexOf('MOQ')],'1');
  assert.equal(verified[1][verified[0].indexOf('Lead_Time_Days')],'7');
  assert.equal(verified[1][verified[0].indexOf('Notes')],'Sample row');
  for(const supported of ['Order_Multiple','Stock_Qty','Valid_To']){assert(verified[0].includes(supported));assert.equal(verified[1][verified[0].indexOf(supported)],'');}
  assert(!legacy[0].includes('Stock_Qty'));assert(!legacy[0].includes('Valid_To'));
  assert(legacy[0].includes('Order_Multiple'));assert.equal(legacy[1][legacy[0].indexOf('Order_Multiple')],'');
  assert.equal(legacy[0].length,legacy[1].length);
 } finally {globalThis.document=original.document;globalThis.window=original.window;URL.createObjectURL=original.create;URL.revokeObjectURL=original.revoke;}
});

test('verified status center history starts collapsed while retaining all cards and retry controls',()=>{
 const cards=Array.from({length:49},(_,i)=>React.createElement('article',{key:i},`Historical row ${i+1}`,React.createElement('button',{type:'button'},'Retry')));
 const html=renderToStaticMarkup(React.createElement(SupplierLegacyHistory,{enabled:true,title:'Earlier upload history',summary:'49 supplier / brand records',children:cards}));
 assert.match(html,/^<details[^>]*supplier-legacy-history/);assert.doesNotMatch(html,/<details[^>]*\sopen(?:=|\s|>)/);
 assert.match(html,/<summary><span>Earlier upload history<\/span><small>49 supplier \/ brand records<\/small><\/summary>/);
 assert.equal((html.match(/<article>/g)||[]).length,49);assert.equal((html.match(/>Retry<\/button>/g)||[]).length,49);
});

test('environments without verified release review keep legacy operations immediately visible',()=>{
 const html=renderToStaticMarkup(React.createElement(SupplierLegacyHistory,{enabled:false,title:'Earlier upload history',summary:'1 record',children:React.createElement('button',{},'Retry existing upload')}));
 assert.doesNotMatch(html,/<details|<summary/);assert.match(html,/>Retry existing upload<\/button>/);
});

test('actual Turkish and English translations advertise only supported verified fields and distinguish supplier from warehouse stock',()=>{
 function Hint({columns}:{columns:string}){const {t}=useI18n();return React.createElement('p',{},t('purchases.suppliers.import.expectedColumns',{columns}));}
 const previous=(globalThis as any).React;(globalThis as any).React=React;
 try{
  for(const preferredLocale of ['tr','en']){
   const render=(columns:string)=>renderToStaticMarkup(React.createElement(I18nProvider,{preferredLocale,children:React.createElement(Hint,{columns})}));
   const verified=render(VERIFIED_SUPPLIER_IMPORT_COLUMNS.join(', '));
   assert.doesNotMatch(verified,/\{columns\}/);for(const field of ['Order_Multiple','Stock_Qty','Valid_To'])assert.match(verified,new RegExp(field));
   assert.match(verified,/Product_Code, Brand, Product_Name, OEM_No, Buy_Price_EUR/);assert.match(verified,/Lead_Time_Days, Notes/);
   assert.match(verified,/EAN, Vehicle, Vehicle_Model/);
   function Guidance(){const {t}=useI18n();return React.createElement('p',{},t('purchases.suppliers.import.verifiedMetadataHint'));}
   const guidance=renderToStaticMarkup(React.createElement(I18nProvider,{preferredLocale,children:React.createElement(Guidance)}));
   assert.match(guidance,preferredLocale==='tr'?/bizim depo mevcudumuz değildir/:/not our warehouse availability/);
   assert.match(guidance,/0–2147483647/);assert.match(guidance,/1–2147483647/);assert.match(guidance,/YYYY-MM-DD/);
   assert.match(guidance,preferredLocale==='tr'?/günü dahildir/:/inclusive/);
   assert.doesNotMatch(guidance,/not supported|desteklenmez/);
  }
 }finally{(globalThis as any).React=previous;}
});
