import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement } from 'react';
import { create, type ReactTestInstance } from 'react-test-renderer';
import { build } from 'esbuild';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
import { pathToFileURL } from 'node:url';

const temporary=await mkdtemp(resolve('node_modules/.master-page-test-'));
const output=resolve(temporary,'page.mjs');
const key='__masterPaginationTest';
await build({stdin:{contents:`export {MasterPage} from './apps/web/src/presentation/pages/MasterPage.tsx';`,resolveDir:process.cwd(),loader:'tsx'},outfile:output,bundle:true,platform:'node',format:'esm',jsx:'automatic',packages:'external',plugins:[{name:'mock-api',setup(builder){
 builder.onResolve({filter:/infrastructure\/api\//},args=>({path:basename(args.path),namespace:'api'}));
 builder.onLoad({filter:/.*/,namespace:'api'},async({path})=>{const source=await readFile(resolve('apps/web/src/infrastructure/api',`${path}.ts`),'utf8');const names=[...source.matchAll(/export\s+(?:async\s+)?(?:function|const|class)\s+(\w+)/g)].map(m=>m[1]);return {loader:'js',contents:[...new Set(names)].map(name=>`export const ${name}=(...args)=>globalThis.${key}.call(${JSON.stringify(name)},...args);`).join('\n')}});
 builder.onResolve({filter:/I18nProvider$/},()=>({path:'i18n',namespace:'fixture'}));
 builder.onResolve({filter:/InterfaceText$/},()=>({path:'interface',namespace:'fixture'}));
 builder.onResolve({filter:/common\/ActionFeedback$/},()=>({path:'feedback',namespace:'fixture'}));
 builder.onLoad({filter:/.*/,namespace:'fixture'},({path})=>({loader:'js',contents:path==='i18n'?`const t=(key,params)=>key+(params?' '+JSON.stringify(params):'');export const useI18n=()=>({locale:'tr',t});`:path==='interface'?`export const useInterfaceText=()=>x=>x;export const InterfaceText=({text})=>text;`:`export const useActionFeedback=()=>globalThis.${key}.feedback;`}));
}}]});
const {MasterPage}=await import(pathToFileURL(output).href);
after(async()=>{await rm(temporary,{recursive:true,force:true})});
(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
const row=(brand:string,page:number,index:number)=>({product_id:null,product_code:`${brand}-${page}-${index}`,brand,description:'',oem_no:'',hs_code:'',origin:'',weight_kg:null,cheapest_supplier:'A',cheapest_price:1,second_supplier_name:'B',second_price:2,price_gap:1,price_gap_percent:100,price_date:'',sales_a:1,sales_b:2,supplier_count:2,catalog_status:'',notes:'',has_notes:false,total_count:100000,total_count_is_estimate:true});
function text(node:ReactTestInstance|string):string{return typeof node==='string'?node:node.children.map(x=>text(x)).join('')}
function deferred(){let resolve!:(value:any)=>void;let reject!:(reason:any)=>void;const promise=new Promise((r,j)=>{resolve=r;reject=j});return{promise,resolve,reject}}
async function fixture(allPages=false){
 const calls:any[]=[]; const events:any[]=[]; let pending:any=null; let pendingOffer:any=null; let pendingCatalog:any=null; let sortedTooLarge=false; let sortedSearchUnsupported=false; let cursorStale=false; let sortedStale=false;
 (globalThis as any)[key]={feedback:{begin(s:any){events.push(['begin',s])},succeed(s:any){events.push(['succeed',s])},fail(s:any){events.push(['fail',s])},clear(){}},call(name:string,...args:any[]){calls.push({name,args});if(name==='fetchCloudBrands')return Promise.resolve([{id:'mann',name:'Mann'},{id:'bosch',name:'Bosch'}]);if(name==='fetchPriceListSettings')return Promise.resolve([]);if(name==='enrichSupplierReportCatalog'){if(pendingCatalog){const d=pendingCatalog;pendingCatalog=null;return d.promise}return Promise.resolve(args[1])}if(name==='fetchSupplierComparisonNoteIndicators')return Promise.resolve(Object.fromEntries(args[1].map((code:string)=>[code,code==='HASOTHERNOTE'])));if(name==='fetchSupplierComparisonOffers'){if(pendingOffer){const d=pendingOffer;pendingOffer=null;return d.promise}return Promise.resolve([])}if(name==='fetchCloudMasterGloballySorted'){if(sortedSearchUnsupported)return Promise.reject(Object.assign(new Error('unsupported'),{code:'SORT_SEARCH_UNSUPPORTED'}));if(sortedTooLarge)return Promise.reject(Object.assign(new Error('too large'),{code:'SORT_SCOPE_TOO_LARGE'}));if(sortedStale)return Promise.reject(Object.assign(new Error('stale'),{code:'SUPPLIER_CURSOR_STALE'}));const p=args[0],rows=allPages?Array.from({length:50},(_,i)=>({...row(p.brand,p.page,i),total_count:100000,total_count_is_estimate:false})):[{...row(p.brand,p.page,0),product_id:'a',product_code:'A001',total_count:2,total_count_is_estimate:false},{...row(p.brand,p.page,1),product_id:'z',product_code:'Z001',total_count:2,total_count_is_estimate:false}];return Promise.resolve({rows,sourceVersion:'v1'})}if(name==='fetchCloudMasterCursor'){if(cursorStale)return Promise.reject(Object.assign(new Error('stale'),{code:'SUPPLIER_CURSOR_STALE'}));const p=args[0],pack=(rows:any[])=>({rows,nextCode:rows.length?'cursor-'+p.page:null,sourceVersion:'v1'});if(pending){const d=pending;pending=null;return d.promise.then(pack)}return Promise.resolve(pack(Array.from({length:!allPages&&p.page===3?4:50},(_,i)=>row(p.brand,p.page,i))))}if(name==='fetchCloudMasterFast'){if(pending){const d=pending;pending=null;return d.promise}const p=args[0];return Promise.resolve(Array.from({length:!allPages&&p.page===3?4:50},(_,i)=>row(p.brand,p.page,i)))}return Promise.resolve(null)}};
 let renderer:any;await act(async()=>{renderer=create(createElement(MasterPage))});
 const button=(label:string)=>renderer.root.findAllByType('button').find((b:any)=>text(b)===label);
 return{renderer,calls,events,button,failGlobalSort(){sortedTooLarge=true},failSortedStale(){sortedStale=true},restoreSorted(){sortedStale=false},failGlobalSearch(){sortedSearchUnsupported=true},failCursor(){cursorStale=true},restoreCursor(){cursorStale=false},hold(){pending=deferred();return pending},holdOffer(){pendingOffer=deferred();return pendingOffer},holdCatalog(){pendingCatalog=deferred();return pendingCatalog},async click(label:string){const b=button(label);assert.ok(b,`missing button ${label}`);await act(async()=>b.props.onClick())},async close(){await act(async()=>renderer.unmount())}};
}

test('catalog enrichment finishes before success and late prior-brand metadata cannot replace current rows',async()=>{
 const v=await fixture();try{
  const old=v.holdCatalog();await v.click('Sonraki');
  const selects=v.renderer.root.findAll((n:any)=>typeof n.type==='function'&&n.type.name==='Select');
  await act(async()=>selects.find((n:any)=>n.props.value==='mann').props.onChange('bosch'));
  await act(async()=>old.resolve([{...row('Mann',2,0),description:'stale metadata'}]));
  assert.doesNotMatch(text(v.renderer.root),/stale metadata/);
  assert.match(text(v.renderer.root),/BOSCH10/);
  const input=v.renderer.root.findAll((n:any)=>typeof n.type==='function'&&n.type.name==='Input')[0];
  await act(async()=>input.props.onChange('W11025'));
  const current=v.holdCatalog();const completed=v.events.filter(x=>x[0]==='succeed').length;
  await act(async()=>input.props.onEnter());
  assert.equal(v.events.filter(x=>x[0]==='succeed').length,completed);
  await act(async()=>current.resolve([{...row('Bosch',1,0),product_code:'W11025',description:'Oil Filter'}]));
  assert.match(text(v.renderer.root),/Oil Filter/);
  assert.equal(v.events.filter(x=>x[0]==='succeed').length,completed+1);
 }finally{await v.close()}
});

test('catalog lookup failure does not announce success or show unverified details',async()=>{
 const v=await fixture();try{
  const input=v.renderer.root.findAll((n:any)=>typeof n.type==='function'&&n.type.name==='Input')[0];
  await act(async()=>input.props.onChange('W11025'));
  const pending=v.holdCatalog();const completed=v.events.filter(x=>x[0]==='succeed').length;
  await act(async()=>input.props.onEnter());
  await act(async()=>pending.reject(new Error('offline')));
  assert.equal(v.events.filter(x=>x[0]==='succeed').length,completed);
  assert.match(text(v.renderer.root),/Katalog veya tedarikçi notları yüklenemedi/);
  assert.ok(v.events.some(x=>x[0]==='fail' && String(x[1]).includes('Katalog veya tedarikçi notları yüklenemedi')));
 }finally{await v.close()}
});

test('pages use the existing reader, next and previous preserve the brand and filters',async()=>{
 const v=await fixture();try{
  let requests=v.calls.filter(x=>(x.name==='fetchCloudMasterFast'||x.name==='fetchCloudMasterCursor'));assert.equal(requests.at(-1).args[0].page,1);assert.equal(requests.at(-1).args[0].pageSize,50);
  assert.equal(v.button('Önceki').props.disabled,true);await v.click('Sonraki');requests=v.calls.filter(x=>(x.name==='fetchCloudMasterFast'||x.name==='fetchCloudMasterCursor'));assert.equal(requests.at(-1).args[0].page,2);assert.equal(requests.at(-1).args[0].brand,'Mann');
  await v.click('Sonraki');assert.equal(v.button('Sonraki').props.disabled,true,'short last page ends navigation');assert.equal(v.button('Önceki').props.disabled,false);
  await v.click('Önceki');requests=v.calls.filter(x=>(x.name==='fetchCloudMasterFast'||x.name==='fetchCloudMasterCursor'));assert.equal(requests.at(-1).args[0].page,2);
 }finally{await v.close()}
});

test('brand and search changes return to page one and late requests cannot replace new results',async()=>{
 const v=await fixture();try{
  const old=v.hold();await v.click('Sonraki');
  const selects=v.renderer.root.findAll((n:any)=>typeof n.type==='function'&&n.type.name==='Select');
  await act(async()=>selects.find((n:any)=>n.props.value==='mann').props.onChange('bosch'));
  let requests=v.calls.filter(x=>(x.name==='fetchCloudMasterFast'||x.name==='fetchCloudMasterCursor'));assert.equal(requests.at(-1).args[0].page,1);assert.equal(requests.at(-1).args[0].brand,'Bosch');
  await act(async()=>old.resolve([row('Mann',2,0)]));
  assert.ok(!text(v.renderer.root).includes('Mann-2-0'),'late prior brand result must not replace current page');
  await v.click('Sonraki');const input=v.renderer.root.findAll((n:any)=>typeof n.type==='function'&&n.type.name==='Input')[0];await act(async()=>input.props.onChange('001/25'));await act(async()=>input.props.onEnter());requests=v.calls.filter(x=>(x.name==='fetchCloudMasterFast'||x.name==='fetchCloudMasterCursor'));assert.equal(requests.at(-1).args[0].page,1);assert.equal(requests.at(-1).args[0].search,'001/25');
 }finally{await v.close()}
});


test('priced result cursor reaches beyond 5,000 and supports backward navigation',async()=>{
 const v=await fixture(true);try{
  for(let n=2;n<=101;n++) await v.click('Sonraki');
  let requests=v.calls.filter((x:any)=>x.name==='fetchCloudMasterCursor');assert.equal(requests.at(-1).args[0].page,101);
  assert.equal(requests.at(-1).args[0].afterCode,'cursor-100');assert.equal(requests.at(-1).args[0].expectedVersion,'v1');
  assert.equal(v.button('Sonraki').props.disabled,false);assert.doesNotMatch(text(v.renderer.root),/ilk 5\.000 ürün gösterilebilir/);
  await v.click('Önceki');requests=v.calls.filter((x:any)=>x.name==='fetchCloudMasterCursor');assert.equal(requests.at(-1).args[0].page,100);assert.equal(requests.at(-1).args[0].afterCode,'cursor-99');
 }finally{await v.close()}
});

test('clearing the brand while loading does not leave a spinner or accept an old result',async()=>{
 const v=await fixture();try{
  const old=v.hold();await v.click('Sonraki');
  const selects=v.renderer.root.findAll((n:any)=>typeof n.type==='function'&&n.type.name==='Select');
  await act(async()=>selects.find((n:any)=>n.props.value==='mann').props.onChange(''));
  assert.doesNotMatch(text(v.renderer.root),/reports\.master\.loading\.buildingSupplierComparison/);
  assert.match(text(v.renderer.root),/reports\.master\.empty\.selectBrandOrSearch/);
  await act(async()=>old.resolve([row('Mann',2,0)]));
  assert.doesNotMatch(text(v.renderer.root),/Mann-2-0/);
 }finally{await v.close()}
});

test('repeating the same search requests current data and waits for a real response before success',async()=>{
 const v=await fixture();try{
  const input=v.renderer.root.findAll((n:any)=>typeof n.type==='function'&&n.type.name==='Input')[0];
  await act(async()=>input.props.onChange('001/25'));
  await act(async()=>input.props.onEnter());
  const initial=v.calls.filter(x=>(x.name==='fetchCloudMasterFast'||x.name==='fetchCloudMasterCursor')).length;
  const completed=v.events.filter(x=>x[0]==='succeed').length;
  const pending=v.hold();
  await act(async()=>input.props.onEnter());
  assert.equal(v.calls.filter(x=>(x.name==='fetchCloudMasterFast'||x.name==='fetchCloudMasterCursor')).length,initial+1);
  assert.equal(v.events.filter(x=>x[0]==='succeed').length,completed,'search must not report success while pending');
  await act(async()=>pending.resolve([row('Mann',1,0)]));
  assert.equal(v.events.filter(x=>x[0]==='succeed').length,completed+1);
 }finally{await v.close()}
});

test('switching brand with the same product code hides old details and ignores their late reply',async()=>{
 const v=await fixture();try{
  const p=v.hold();await v.click('Sonraki');await act(async()=>p.resolve([{...row('Mann',2,0),product_code:'SHARED-001',supplier_count:3}]));
  const offer=v.holdOffer();
  const details=v.renderer.root.findAllByType('button').find((b:any)=>text(b).includes('Tedarikçiler ve notları')); assert.ok(details);
  await act(async()=>details.props.onClick());
  const next=v.hold();const selects=v.renderer.root.findAll((n:any)=>typeof n.type==='function'&&n.type.name==='Select');
  await act(async()=>selects.find((n:any)=>n.props.value==='mann').props.onChange('bosch'));
  await act(async()=>next.resolve([{...row('Bosch',1,0),product_code:'SHARED-001',supplier_count:3}]));
  await act(async()=>offer.resolve([{supplier_id:'one',supplier_name:'old supplier',buy_price:1,price_date:null,moq:null,order_multiple:null,stock_qty:null,valid_to:null,notes:null}]));
  assert.doesNotMatch(text(v.renderer.root),/old supplier/);
  const boschButton=v.renderer.root.findAllByType('button').find((b:any)=>text(b).includes('Tedarikçiler ve notları'));assert.ok(boschButton);
  assert.equal(boschButton.props['aria-expanded'],false);
 }finally{await v.close()}
});

test('supplier summary notes are visible with the product before expanding supplier details',async()=>{
 const v=await fixture();try{
  const pending=v.hold();await v.click('Sonraki');
  await act(async()=>pending.resolve([{...row('Mann',2,0),product_code:'W11025',notes:'5.53 SNP TPM',has_notes:true}]));
  const cells=v.renderer.root.findAllByType('td');
  const productCell=cells.find((c:any)=>text(c).includes('W11025'));assert.ok(productCell);
  assert.match(text(productCell),/Tedarikçi notu: 5\.53 SNP TPM/);
  const secondSupplierCell=cells.find((c:any)=>text(c).includes('Tedarikçiler ve notları'));assert.ok(secondSupplierCell);
  assert.doesNotMatch(text(secondSupplierCell),/5\.53 SNP TPM/);
  assert.equal(v.calls.filter((x:any)=>x.name==='fetchSupplierComparisonOffers').length,0);
 }finally{await v.close()}
});

test('the summary indicates a note on any supplier even if the cheapest has none',async()=>{
 const v=await fixture();try{
  const pending=v.hold();await v.click('Sonraki');
  await act(async()=>pending.resolve([{...row('Mann',2,0),product_code:'HASOTHERNOTE',notes:null,has_notes:false}]));
  const productCell=v.renderer.root.findAllByType('td').find((c:any)=>text(c).includes('HASOTHERNOTE'));
  assert.ok(productCell);assert.match(text(productCell),/Tedarikçi notu var/);
 }finally{await v.close()}
});

test('supplier details expand under their own product row across all columns',async()=>{
 const v=await fixture();try{
  const pending=v.hold();await v.click('Sonraki');
  await act(async()=>pending.resolve([
    {...row('Mann',2,0),product_id:'first-id',product_code:'W11025'},
    {...row('Mann',2,1),product_id:'second-id',product_code:'W11025'},
  ]));
  let buttons=v.renderer.root.findAllByType('button').filter((b:any)=>text(b).includes('Tedarikçiler ve notları'));
  assert.equal(buttons.length,2);assert.notEqual(buttons[0].props['aria-controls'],buttons[1].props['aria-controls']);
  await act(async()=>buttons[0].props.onClick());
  let detailRows=v.renderer.root.findAllByType('tr').filter((r:any)=>r.props.className==='data-table__details-row');
  assert.equal(detailRows.length,1);assert.equal(detailRows[0].findByType('td').props.colSpan,7);
  buttons=v.renderer.root.findAllByType('button').filter((b:any)=>String(b.props['aria-label']||'').includes('tedarikçileri'));
  assert.deepEqual(buttons.map((b:any)=>b.props['aria-expanded']),[true,false]);
  await act(async()=>buttons[1].props.onClick());
  buttons=v.renderer.root.findAllByType('button').filter((b:any)=>String(b.props['aria-label']||'').includes('tedarikçileri'));
  assert.deepEqual(buttons.map((b:any)=>b.props['aria-expanded']),[false,true]);
  detailRows=v.renderer.root.findAllByType('tr').filter((r:any)=>r.props.className==='data-table__details-row');assert.equal(detailRows.length,1);
 }finally{await v.close()}
});

test('repeating a search closes details so stale offers cannot remain visible',async()=>{
 const v=await fixture();try{
  const button=v.renderer.root.findAllByType('button').find((b:any)=>text(b).includes('Tedarikçiler ve notları'));assert.ok(button);
  await act(async()=>button.props.onClick());assert.equal(v.renderer.root.findAllByType('tr').filter((r:any)=>r.props.className==='data-table__details-row').length,1);
  const input=v.renderer.root.findAll((n:any)=>typeof n.type==='function'&&n.type.name==='Input')[0];
  await act(async()=>input.props.onEnter());
  assert.equal(v.renderer.root.findAllByType('tr').filter((r:any)=>r.props.className==='data-table__details-row').length,0);
 }finally{await v.close()}
});

test('sorting requests the whole-brand server and returns to the first page',async()=>{
 const v=await fixture();try{
  const pending=v.hold();await v.click('Sonraki');
  await act(async()=>pending.resolve([
    {...row('Mann',2,0),product_id:'z',product_code:'Z001'},
    {...row('Mann',2,1),product_id:'a',product_code:'A001'},
  ]));
  const target=v.renderer.root.findAllByType('button').find((b:any)=>String(b.props['aria-label']||'').startsWith('Z001:'));assert.ok(target);
  await act(async()=>target.props.onClick());
  const productHeader=v.renderer.root.findAllByType('th')[0].findByType('button');
  await act(async()=>productHeader.props.onClick());
  const sortedCall=v.calls.filter((x:any)=>x.name==='fetchCloudMasterGloballySorted').at(-1);assert.ok(sortedCall);assert.equal(sortedCall.args[0].sort,'product');assert.equal(sortedCall.args[0].direction,'asc');assert.equal(sortedCall.args[0].page,1);
  const rows=v.renderer.root.findAllByType('tr');assert.equal(rows.filter((r:any)=>r.props.className==='data-table__details-row').length,0);assert.match(text(rows[1]),/A001/);assert.match(text(rows[2]),/Z001/);
 }finally{await v.close()}
});


test('large brands fail explicitly and allow clear sort, without local partial ordering',async()=>{
 const v=await fixture();try{
  v.failGlobalSort();const n=v.calls.filter((x:any)=>(x.name==='fetchCloudMasterFast'||x.name==='fetchCloudMasterCursor')).length;
  const header=v.renderer.root.findAllByType('th')[2].findByType('button');await act(async()=>header.props.onClick());
  assert.match(text(v.renderer.root),/arka plan hazırlığı gerekiyor/);assert.equal(v.calls.filter((x:any)=>(x.name==='fetchCloudMasterFast'||x.name==='fetchCloudMasterCursor')).length,n);
  await v.click('Sıralamayı kaldır');assert.equal(v.calls.filter((x:any)=>(x.name==='fetchCloudMasterFast'||x.name==='fetchCloudMasterCursor')).length,n+1);
 }finally{await v.close()}
});


test('changed source blocks later cursor page and offers explicit restart',async()=>{
 const v=await fixture();try{
  v.failCursor();await v.click('Sonraki');assert.match(text(v.renderer.root),/Tedarikçi fiyatları değişti/);assert.ok(v.button('İlk sayfadan yenile'));
  v.restoreCursor();await v.click('İlk sayfadan yenile');const call=v.calls.filter((x:any)=>x.name==='fetchCloudMasterCursor').at(-1);assert.equal(call.args[0].page,1);assert.equal(call.args[0].afterCode,'');assert.equal(call.args[0].expectedVersion,null);
 }finally{await v.close()}
});


test('legacy search refuses global sorting explicitly without presenting incomplete results',async()=>{
 const v=await fixture();try{
  v.failGlobalSearch();const input=v.renderer.root.findAll((n:any)=>typeof n.type==='function'&&n.type.name==='Input')[0];await act(async()=>input.props.onChange('Filter'));await act(async()=>input.props.onEnter());
  const header=v.renderer.root.findAllByType('th')[2].findByType('button');await act(async()=>header.props.onClick());
  assert.match(text(v.renderer.root),/tüm sonuçları için genel sıralama henüz hazır değil/);assert.ok(v.button('Sıralamayı kaldır'));
 }finally{await v.close()}
});


test('sorted pages are version-fenced and offer restart if supplier prices change',async()=>{
 const v=await fixture(true);try{
  const header=v.renderer.root.findAllByType('th')[2].findByType('button');await act(async()=>header.props.onClick());
  let calls=v.calls.filter((x:any)=>x.name==='fetchCloudMasterGloballySorted');assert.equal(calls.at(-1).args[0].page,1);assert.equal(calls.at(-1).args[0].expectedVersion,null);
  v.failSortedStale();await v.click('Sonraki');calls=v.calls.filter((x:any)=>x.name==='fetchCloudMasterGloballySorted');assert.equal(calls.at(-1).args[0].page,2);assert.equal(calls.at(-1).args[0].expectedVersion,'v1');assert.match(text(v.renderer.root),/Tedarikçi fiyatları değişti/);
  v.restoreSorted();await v.click('İlk sayfadan yenile');calls=v.calls.filter((x:any)=>x.name==='fetchCloudMasterGloballySorted');assert.equal(calls.at(-1).args[0].page,1);assert.equal(calls.at(-1).args[0].expectedVersion,null);
 }finally{await v.close()}
});
