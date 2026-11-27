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
function deferred(){let resolve!:(value:any)=>void;const promise=new Promise(r=>{resolve=r});return{promise,resolve}}
async function fixture(allPages=false){
 const calls:any[]=[]; const events:any[]=[]; let pending:any=null; let pendingOffer:any=null;
 (globalThis as any)[key]={feedback:{begin(s:any){events.push(['begin',s])},succeed(s:any){events.push(['succeed',s])},fail(s:any){events.push(['fail',s])},clear(){}},call(name:string,...args:any[]){calls.push({name,args});if(name==='fetchCloudBrands')return Promise.resolve([{id:'mann',name:'Mann'},{id:'bosch',name:'Bosch'}]);if(name==='fetchPriceListSettings')return Promise.resolve([]);if(name==='fetchSupplierComparisonOffers'){if(pendingOffer){const d=pendingOffer;pendingOffer=null;return d.promise}return Promise.resolve([])}if(name==='fetchCloudMasterFast'){if(pending){const d=pending;pending=null;return d.promise}const p=args[0];return Promise.resolve(Array.from({length:!allPages&&p.page===3?4:50},(_,i)=>row(p.brand,p.page,i)))}return Promise.resolve(null)}};
 let renderer:any;await act(async()=>{renderer=create(createElement(MasterPage))});
 const button=(label:string)=>renderer.root.findAllByType('button').find((b:any)=>text(b)===label);
 return{renderer,calls,events,button,hold(){pending=deferred();return pending},holdOffer(){pendingOffer=deferred();return pendingOffer},async click(label:string){const b=button(label);assert.ok(b,`missing button ${label}`);await act(async()=>b.props.onClick())},async close(){await act(async()=>renderer.unmount())}};
}

test('pages use the existing reader, next and previous preserve the brand and filters',async()=>{
 const v=await fixture();try{
  let requests=v.calls.filter(x=>x.name==='fetchCloudMasterFast');assert.equal(requests.at(-1).args[0].page,1);assert.equal(requests.at(-1).args[0].pageSize,50);
  assert.equal(v.button('Önceki').props.disabled,true);await v.click('Sonraki');requests=v.calls.filter(x=>x.name==='fetchCloudMasterFast');assert.equal(requests.at(-1).args[0].page,2);assert.equal(requests.at(-1).args[0].brand,'Mann');
  await v.click('Sonraki');assert.equal(v.button('Sonraki').props.disabled,true,'short last page ends navigation');assert.equal(v.button('Önceki').props.disabled,false);
  await v.click('Önceki');requests=v.calls.filter(x=>x.name==='fetchCloudMasterFast');assert.equal(requests.at(-1).args[0].page,2);
 }finally{await v.close()}
});

test('brand and search changes return to page one and late requests cannot replace new results',async()=>{
 const v=await fixture();try{
  const old=v.hold();await v.click('Sonraki');
  const selects=v.renderer.root.findAll((n:any)=>typeof n.type==='function'&&n.type.name==='Select');
  await act(async()=>selects.find((n:any)=>n.props.value==='mann').props.onChange('bosch'));
  let requests=v.calls.filter(x=>x.name==='fetchCloudMasterFast');assert.equal(requests.at(-1).args[0].page,1);assert.equal(requests.at(-1).args[0].brand,'Bosch');
  await act(async()=>old.resolve([row('Mann',2,0)]));
  assert.ok(!text(v.renderer.root).includes('Mann-2-0'),'late prior brand result must not replace current page');
  await v.click('Sonraki');const input=v.renderer.root.findAll((n:any)=>typeof n.type==='function'&&n.type.name==='Input')[0];await act(async()=>input.props.onChange('001/25'));await act(async()=>input.props.onEnter());requests=v.calls.filter(x=>x.name==='fetchCloudMasterFast');assert.equal(requests.at(-1).args[0].page,1);assert.equal(requests.at(-1).args[0].search,'001/25');
 }finally{await v.close()}
});


test('priced results stop at the actual 100-page RPC limit with an explicit message',async()=>{
 const v=await fixture(true);try{
  for(let n=2;n<=100;n++) await v.click('Sonraki');
  const requests=v.calls.filter(x=>x.name==='fetchCloudMasterFast');assert.equal(requests.at(-1).args[0].page,100);
  assert.equal(v.button('Sonraki').props.disabled,true);
  assert.match(text(v.renderer.root),/ilk 5\.000 ürün gösterilebilir/);
  assert.equal(requests.length,100);
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
  const initial=v.calls.filter(x=>x.name==='fetchCloudMasterFast').length;
  const completed=v.events.filter(x=>x[0]==='succeed').length;
  const pending=v.hold();
  await act(async()=>input.props.onEnter());
  assert.equal(v.calls.filter(x=>x.name==='fetchCloudMasterFast').length,initial+1);
  assert.equal(v.events.filter(x=>x[0]==='succeed').length,completed,'search must not report success while pending');
  await act(async()=>pending.resolve([row('Mann',1,0)]));
  assert.equal(v.events.filter(x=>x[0]==='succeed').length,completed+1);
 }finally{await v.close()}
});

test('switching brand with the same product code hides old details and ignores their late reply',async()=>{
 const v=await fixture();try{
  const p=v.hold();await v.click('Sonraki');await act(async()=>p.resolve([{...row('Mann',2,0),product_code:'SHARED-001',supplier_count:3}]));
  const offer=v.holdOffer();
  const details=v.renderer.root.findAllByType('button').find((b:any)=>text(b).includes('Diğer tedarikçileri gör')); assert.ok(details);
  await act(async()=>details.props.onClick());
  const next=v.hold();const selects=v.renderer.root.findAll((n:any)=>typeof n.type==='function'&&n.type.name==='Select');
  await act(async()=>selects.find((n:any)=>n.props.value==='mann').props.onChange('bosch'));
  await act(async()=>next.resolve([{...row('Bosch',1,0),product_code:'SHARED-001',supplier_count:3}]));
  await act(async()=>offer.resolve([{supplier_id:'one',supplier_name:'old supplier',buy_price:1,price_date:null,moq:null,order_multiple:null,stock_qty:null,valid_to:null,notes:null}]));
  assert.doesNotMatch(text(v.renderer.root),/old supplier/);
  const boschButton=v.renderer.root.findAllByType('button').find((b:any)=>text(b).includes('Diğer tedarikçileri gör'));assert.ok(boschButton);
  assert.equal(boschButton.props['aria-expanded'],false);
 }finally{await v.close()}
});
