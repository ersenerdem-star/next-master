import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement } from 'react';
import { create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { build } from 'esbuild';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

// Render the real sales-order editor, cache effects, table and save handlers.
// Only remote I/O, translations and feedback presentation are substituted.
const temporary = await mkdtemp(resolve('node_modules/.sales-reopen-test-'));
const output = resolve(temporary, 'page.mjs');
const fixtureKey = '__salesOrderCustomerPricingUiTest';
const baseline = process.env.SALES_REOPEN_BASELINE_REV;
if (baseline && !/^[0-9a-f]{7,40}$/.test(baseline)) throw Error('Invalid baseline revision');
await build({
  stdin: { contents: `export {QuotesPage} from './apps/web/src/presentation/pages/QuotesPage.tsx';`, resolveDir: process.cwd(), loader: 'tsx' },
  outfile: output, bundle: true, platform: 'node', format: 'esm', jsx: 'automatic', packages: 'external',
  plugins: [{ name: 'local-only-sales-order-io', setup(builder) {
    if (baseline) builder.onLoad({ filter: /QuotesPage\.tsx$/ }, () => ({ loader: 'tsx', contents:
      execFileSync('git', ['show', `${baseline}:apps/web/src/presentation/pages/QuotesPage.tsx`], { encoding: 'utf8' }),
    }));
    builder.onResolve({ filter: /shared\/salesOrderCatalogSync$/ }, () => ({path:'catalogSync',namespace:'fixture'}));
    builder.onResolve({ filter: /infrastructure\/api\// }, args => ({ path: basename(args.path), namespace: 'api-fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'api-fixture' }, async ({ path }) => {
      const source = await readFile(resolve('apps/web/src/infrastructure/api', `${path}.ts`), 'utf8');
      const names = [...source.matchAll(/export\s+(?:async\s+)?(?:function|const|class)\s+(\w+)/g)].map(match => match[1]);
      for (const match of source.matchAll(/export\s*\{([^}]+)\}/g)) names.push(...match[1].split(',').map(name => name.trim().split(/\s+as\s+/).at(-1)!).filter(name => /^[A-Za-z_]\w*$/.test(name)));
      return { loader: 'js', contents: [...new Set(names)].map(name => `export const ${name}=(...args)=>globalThis.${fixtureKey}.call(${JSON.stringify(name)},...args);`).join('\n') };
    });
    builder.onResolve({ filter: /I18nProvider$/ }, () => ({ path: 'i18n', namespace: 'fixture' }));
    builder.onResolve({ filter: /InterfaceText$/ }, () => ({ path: 'interface', namespace: 'fixture' }));
    builder.onResolve({ filter: /common\/ActionFeedback$/ }, () => ({ path: 'feedback', namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ loader: 'js', contents:
      path === 'catalogSync' ? `export const resyncSalesOrderWithCodeReferenceFallback=(...args)=>globalThis.${fixtureKey}.call('resyncSalesOrderWithCodeReferenceFallback',...args);export const salesOrderResyncPriceSummary=()=>({failed:0});` :
      path === 'i18n' ? `const t=(key,params)=>key+(params?' '+JSON.stringify(params):'');export const useI18n=()=>({locale:'en',t});` :
      path === 'interface' ? `export const useInterfaceText=()=>x=>x;export const InterfaceText=({text})=>text;` :
      `export const useActionFeedback=()=>globalThis.${fixtureKey}.feedback;`
    }));
  } }],
});
const { QuotesPage } = await import(pathToFileURL(output).href);
after(async () => { await rm(temporary, { recursive: true, force: true }); });

type Deferred = { promise: Promise<any>; resolve: (value: any) => void; reject: (reason: Error) => void };
function deferred(): Deferred {
  let resolve!: Deferred['resolve'], reject!: Deferred['reject'];
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const line = (code = 'TEST-001') => ({
  lineId: `line-${code}`, requestedCode: code, resolvedCode: code, brand: 'Synthetic', description: `Part ${code}`,
  qty: 3, buy_price: 10, sell_price: 14.5, manual_sell_price: true, supplier_name: 'Synthetic supplier',
  supplierOptions: [], selectedSupplierKey: '', found: true, codeChanged: false, codeChangeWarning: '',
  oem_no: '', hs_code: '', origin: '', weight_kg: null, price_date: '', notes: '',
});
const fullOrder = (id = 'saved-existing', lines = [line()]) => ({
  id, sales_order_no: `SO-${id}`, customer_id: null, customer_name: 'Synthetic customer', seller_company: 'Synthetic seller',
  purchase_company: 'Synthetic buyer', quote_date: '2026-11-06', currency: 'EUR', customer_type: 'A', shipping_cost: 0,
  discount_amount: 0, supplier_mode: 'Best price', preferred_supplier: '', seller_info: '', buyer_info: 'Synthetic buyer',
  delivery_term: '', payment_terms: '', packing_details: '', notes: '', status: 'draft', purchase_total: 30,
  sales_total: 43.5, profit_total: 13.5, margin_percent: 31.03, source_channel: 'internal', portal_invite_id: null,
  portal_submitted_at: null, portal_seen_at: null, created_at: '2026-11-06T10:00:00Z', updated_at: '2026-11-06T10:00:00Z',
  confirmed_at: null, lines,
});
const summary = (order: ReturnType<typeof fullOrder>) => ({ ...order, lines: [] });
const draftCache = () => ({
  salesOrdersView: 'detail', workbenchMode: 'new', selectedLocalSalesOrderId: '', quoteNo: 'SO-NEW',
  customerName: 'Synthetic customer', customerSelection: 'Synthetic customer', sellerCompany: 'Synthetic seller',
  quoteDate: '2026-11-06', customerType: 'A', currency: 'EUR', buyerInfo: 'Synthetic buyer',
  supplierMode: 'Best price', quoteBuilderLines: [line()],
});
const existingCache = (order: ReturnType<typeof fullOrder>, lines = order.lines) => ({
  ...draftCache(), workbenchMode: 'existing', selectedLocalSalesOrderId: order.id, quoteNo: order.sales_order_no,
  quoteBuilderLines: lines,
});
function content(node: ReactTestInstance | string): string {
  return typeof node === 'string' ? node : node.children.map(child => content(child)).join('');
}
async function fixture({ cache = draftCache(), orders = [fullOrder()], selectedSalesOrderId = '', selectedQuoteId = '', holdDetail = false, failDetail = false, holdQuotes = false, holdQuoteDetail = false }: {
  cache?: Record<string, any>; orders?: Array<ReturnType<typeof fullOrder>>; selectedSalesOrderId?: string; selectedQuoteId?:string; holdDetail?: boolean; failDetail?: boolean; holdQuotes?:boolean; holdQuoteDetail?:boolean;
} = {}) {
  const globals = globalThis as any;
  const previous = { window: globals.window, document: globals.document, HTMLElement: globals.HTMLElement, fetch: globals.fetch, fixture: globals[fixtureKey], act: globals.IS_REACT_ACT_ENVIRONMENT };
  const storage = new Map<string, string>([['next-master-sales-order-workspace', JSON.stringify(cache)]]);
  const store = { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) };
  const timers = new Map<number, () => void>(); let timerId = 0;
  const confirms: string[] = [], prompts: string[] = []; let confirmResponse=false;
  const session = new Map<string,string>();
  const browser = Object.assign(new EventTarget(), {
    localStorage: store, sessionStorage: { getItem: (key:string) => session.get(key) ?? null, setItem: (key:string,value:string) => session.set(key,value), removeItem: (key:string) => session.delete(key) },
    setTimeout(callback: () => void) { const id = ++timerId; timers.set(id, callback); return id; },
    clearTimeout(id: number) { timers.delete(id); },
    confirm(text: string) { confirms.push(text); return confirmResponse; },
    prompt(text:string) { prompts.push(text); return null; },
  });
  globals.window = browser; globals.document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  globals.HTMLElement = class {};
  globals.fetch = () => { throw Error('Unexpected real network access'); }; globals.IS_REACT_ACT_ENVIRONMENT = true;
  const summaryQueue: Deferred[] = [];
  const importRequest = deferred();
  const resyncRequest = deferred();
  const resolveRequest = deferred(); let holdLineLookup=false;
  const quoteListRequest = deferred(), quoteDetailRequest = deferred();
  const firstDetail = holdDetail ? deferred() : null;
  const calls: Array<{ name: string; args: any[] }> = [];
  const feedbackEvents: Array<{ kind: string; text: string }> = [];
  const saved: Array<ReturnType<typeof fullOrder>> = [];
  let storedOrders = [...orders];
  let detailFailure = failDetail;
  globals[fixtureKey] = {
    feedback: Object.fromEntries(['begin', 'succeed', 'fail', 'clear'].map(kind => [kind, (text: string) => feedbackEvents.push({ kind, text })])),
    call(name: string, ...args: any[]) {
      calls.push({ name, args });
      if (name === 'fetchSalesOrderSummaries') return summaryQueue.shift()?.promise ?? Promise.resolve(storedOrders.map(summary));
      if (name === 'fetchSalesOrderById') {
        if (firstDetail) return firstDetail.promise;
        if (detailFailure) return Promise.reject(Error('Synthetic detail load failed'));
        const order = storedOrders.find(order => order.id === args[0]);
        return order ? Promise.resolve(order) : Promise.reject(Error('Order not found'));
      }
      if (name === 'upsertSalesOrder') {
        const order = { ...args[0] };
        saved.push(order); storedOrders = [order, ...storedOrders.filter(row => row.id !== order.id)];
        return Promise.resolve(order);
      }
      if (name === 'fetchCompanyProfiles') return Promise.resolve([{ id: 'seller', companyName: 'Synthetic seller' }]);
      if (name === 'fetchCustomers') return Promise.resolve([
        { id:'customer-a',display_name:'Customer A',company_name:'Customer A',price_list_type:'A' },
        { id:'customer-b',display_name:'Customer B',company_name:'Customer B',price_list_type:'B' },
      ]);
      if (name === 'findCustomerByNameInList') return args[0].find((customer: any) => customer.id === args[1] || customer.display_name === args[1]) || null;
      if (name === 'findCompanyProfileByName') return args[0].find((company: any) => company.companyName === args[1]) || null;
      if (name === 'buildInventoryAvailabilityLookup') return new Map();
      if (name === 'inventoryAvailabilityLookupKey') return args.join('|');
      if (name === 'fetchCPriceMapForRows') return Promise.resolve(new Map());
      if (name === 'getCPriceForRow') return null;
      if (name === 'fetchCloudBrands') return Promise.resolve([{id:'brand',name:'Synthetic'}]);
      if (name === 'batchResolveQuoteImportRows') return importRequest.promise;
      if (name === 'resyncSalesOrderWithCodeReferenceFallback') return resyncRequest.promise;
      if (name === 'findCodeReferenceMatch') return Promise.resolve(null);
      if (name === 'resolveQuoteLine') return holdLineLookup ? resolveRequest.promise : Promise.reject(Error('Synthetic enrichment unavailable'));
      if (name === 'fetchCloudQuotes') return holdQuotes ? quoteListRequest.promise : Promise.resolve([]);
      if (name === 'fetchCloudQuoteDetail') return holdQuoteDetail ? quoteDetailRequest.promise : Promise.reject(Error('unexpected quote detail'));
      if (['fetchPurchaseOrderSalesLinkSummaries', 'fetchInvoiceSalesLinkSummaries', 'fetchSalesOrderBrandSummaries', 'fetchInventoryAvailabilitySummary', 'fetchPriceListSettings'].includes(name)) return Promise.resolve([]);
      throw Error(`Unexpected API call ${name}`);
    },
  };
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(createElement(QuotesPage, { appRole: 'superadmin', selectedSalesOrderId, selectedQuoteId })); });
  let unmounted = false;
  return {
    renderer, calls, saved, feedbackEvents, confirms, prompts, firstDetail, importRequest, resyncRequest, resolveRequest, quoteListRequest, quoteDetailRequest,
    text: () => content(renderer.root),
    buttons: (label: string) => renderer.root.findAllByType('button').filter(button => content(button) === label),
    lineRows: () => renderer.root.findAll(node => typeof node.type === 'function' && node.type.name === 'DataTable' && node.props.wrapClassName === 'sales-lines-table').flatMap(node => node.props.rows),
    cache: () => JSON.parse(storage.get('next-master-sales-order-workspace') || 'null'),
    setDetailFailure(failed: boolean) { detailFailure = failed; },
    setConfirmResponse(value: boolean) { confirmResponse=value; },
    holdSummary() { const request = deferred(); summaryQueue.push(request); return request; },
    async click(label: string) {
      const button = renderer.root.findAllByType('button').find(button => content(button) === label);
      assert.ok(button, `Missing rendered button ${label}`); assert.ok(!button.props.disabled, `Disabled rendered button ${label}`);
      await act(async () => { button.props.onClick(); });
    },
    async clickOrder(id: string) {
      const row = renderer.root.findAllByType('tr').find(row => row.props.onClick && content(row).includes(`SO-${id}`));
      assert.ok(row, `Missing rendered order row ${id}`);
      await act(async () => { row.props.onClick({ target: null }); });
    },
    async selectCustomer(value: string) {
      const select = renderer.root.findAll(node => typeof node.type==='function' && node.type.name==='Select' && node.props.label==='sales.orders.customer')[0];
      assert.ok(select,'customer selection missing'); await act(async()=>select.props.onChange(value));
    },
    async externalOrder(id: string) {
      await act(async()=>renderer.update(createElement(QuotesPage,{appRole:'superadmin',selectedSalesOrderId:id})));
    },
    async queueCatalogHandoff() {
      session.set('next-master:pending-catalog-sales-item',JSON.stringify({product_code:'HANDOFF',brand:'Synthetic'}));
      await act(async()=>renderer.update(createElement(QuotesPage,{appRole:'superadmin',selectedSalesOrderId,onSelectedSalesOrderChange:()=>{}})));
    },
    handoffPending: () => session.has('next-master:pending-catalog-sales-item'),
    async startImport() {
      const input=renderer.root.findAllByType('input').find(node=>node.props.type==='file' && String(node.props.accept||'').includes('.csv'));
      assert.ok(input,'import file input missing');
      await act(async()=>{input.props.onChange({target:{files:[{name:'parts.csv',text:async()=> 'part_no,brand,qty\n0012,Synthetic,3'}]}});});
    },
    async fillNewLine() {
      holdLineLookup=true;
      const input=renderer.root.findAll(node=>typeof node.type==='function'&&node.type.name==='Input'&&node.props.placeholder==='sales.orders.partNoOrName')[0];
      const brand=renderer.root.findAll(node=>typeof node.type==='function'&&node.type.name==='Select'&&node.props.label===''&&node.props.options.some((option:any)=>option.value==='Synthetic'))[0];
      assert.ok(input && brand,'new line controls missing'); await act(async()=>{input.props.onChange('0012');brand.props.onChange('Synthetic');});
    },
    holdSingleLookup() { holdLineLookup=true; },
    async rerender() { await act(async()=>renderer.update(createElement(QuotesPage,{appRole:'superadmin',selectedSalesOrderId,selectedQuoteId,onSelectedSalesOrderChange:()=>{}}))); },
    async resolve(request: Deferred, value: any) { await act(async () => { request.resolve(value); }); },
    async reject(request: Deferred) { await act(async () => { request.reject(Error('Synthetic list refresh failed')); }); },
    async flushCache() { await act(async () => { for (const callback of [...timers.values()]) callback(); timers.clear(); }); },
    async unmount() { await act(async () => { renderer.unmount(); }); unmounted = true; },
    async close() {
      if (!unmounted) await act(async () => { renderer.unmount(); });
      globals.window = previous.window; globals.document = previous.document; globals.fetch = previous.fetch;
      globals.HTMLElement = previous.HTMLElement;
      globals[fixtureKey] = previous.fixture; globals.IS_REACT_ACT_ENVIRONMENT = previous.act;
    },
  };
}

const unpricedLine = () => ({...line('0012'),buy_price:100,sell_price:110,manual_sell_price:false,
  supplierOptions:[{supplier_name:'Synthetic supplier',buy_price:100,sell_price:110,price_date:null,notes:null}],
  selectedSupplierKey:'Synthetic supplier-0'});
const customerlessCache = (lines:any[]=[unpricedLine()]) => ({...draftCache(),customerName:'',customerSelection:'',quoteBuilderLines:lines});

test('real sales editor waits for an actual customer, then computes the chosen customer list',async()=>{
  const view=await fixture({cache:customerlessCache()});
  try {
    assert.equal(view.lineRows().length,1);
    assert.equal(view.lineRows()[0].sell_price,null);
    assert.equal(view.lineRows()[0].supplierOptions[0].sell_price,null);
    const table=view.renderer.root.findAll(node => typeof node.type==='function' && node.type.name==='DataTable' && node.props.wrapClassName==='sales-lines-table')[0];
    const sell=table.props.columns.find((c:any)=>c.key==='sell').render(view.lineRows()[0]);
    const total=table.props.columns.find((c:any)=>c.key==='sellTotal').render(view.lineRows()[0]);
    assert.equal(sell.props.value,''); assert.equal(total,'—','a missing sales price must not look like a zero-priced line');
    await view.selectCustomer('customer-a'); assert.equal(view.lineRows()[0].sell_price,110);
    await view.selectCustomer('customer-b'); assert.equal(view.lineRows()[0].sell_price,115);
    await view.selectCustomer(''); assert.equal(view.lineRows()[0].sell_price,null);
  } finally {await view.close()}
});

test('real editor preserves pre-existing stored prices when customer selection changes',async()=>{
  const oldLine={...unpricedLine(),sell_price:73.5}; const order=fullOrder('historic',[oldLine]);
  const view=await fixture({cache:existingCache(order,[oldLine]),orders:[order]});
  try {
    assert.equal(view.lineRows()[0].sell_price,73.5);
    await view.selectCustomer('customer-b'); assert.equal(view.lineRows()[0].sell_price,73.5);
    assert.equal(view.saved.length,0);
  } finally {await view.close()}
});

test('real editor preserves an explicitly typed sale price when customer changes',async()=>{
  const view=await fixture({cache:customerlessCache()});
  try {
    const input=view.renderer.root.findAllByType('input').find(node=>node.props.className==='inline-edit-input' && node.props.type==='number');
    assert.ok(input,'manual sale price input missing');
    await act(async()=>input.props.onChange({target:{value:'73.50'}}));
    await view.selectCustomer('customer-a'); assert.equal(view.lineRows()[0].sell_price,73.5);
    await view.selectCustomer('customer-b'); assert.equal(view.lineRows()[0].sell_price,73.5);
  } finally {await view.close()}
});

test('saved customerless pending line is priced after selecting customer without repricing older lines',async()=>{
  const pending={...unpricedLine(),sell_price:null,customer_pricing_pending:true};
  const old={...unpricedLine(),lineId:'old-line',sell_price:73.5,customer_pricing_pending:false};
  const order=fullOrder('pending',[pending,old]);
  const view=await fixture({cache:{...existingCache(order,[pending,old]),customerName:'',customerSelection:''},orders:[order]});
  try {
    assert.equal(view.lineRows()[0].sell_price,null); assert.equal(view.lineRows()[1].sell_price,73.5);
    await view.selectCustomer('customer-b');
    assert.equal(view.lineRows()[0].sell_price,115); assert.equal(view.lineRows()[1].sell_price,73.5);
    assert.equal(view.saved.length,0);
  } finally {await view.close()}
});

test('late import uses the customer selected while the supplier request was pending',async()=>{
  const view=await fixture({cache:customerlessCache([])});
  try {
    await view.startImport();
    assert.ok(view.calls.some(c=>c.name==='batchResolveQuoteImportRows'));
    await view.selectCustomer('customer-b');
    await view.resolve(view.importRequest,[{...unpricedLine(),sell_price:null,
      supplierOptions:[{supplier_name:'Synthetic supplier',buy_price:100,sell_price:null,price_date:null,notes:null}]}]);
    assert.equal(view.lineRows().length,1); assert.equal(view.lineRows()[0].sell_price,115);
    assert.equal(view.lineRows()[0].requestedCode,'0012');
  } finally {await view.close()}
});

test('late import cannot restore a price after the selected customer is removed',async()=>{
  const view=await fixture({cache:customerlessCache([])});
  try {
    await view.selectCustomer('customer-b'); await view.startImport();
    assert.ok(view.calls.some(c=>c.name==='batchResolveQuoteImportRows'));
    await view.selectCustomer('');
    await view.resolve(view.importRequest,[{...unpricedLine(),sell_price:115,
      supplierOptions:[{supplier_name:'Synthetic supplier',buy_price:100,sell_price:115,price_date:null,notes:null}]}]);
    assert.equal(view.lineRows().length,1); assert.equal(view.lineRows()[0].sell_price,null);
    assert.equal(view.lineRows()[0].supplierOptions[0].sell_price,null);
  } finally {await view.close()}
});

test('late import uses customer B when selection changes from A to B in flight',async()=>{
  const view=await fixture({cache:customerlessCache([])});
  try {
    await view.selectCustomer('customer-a'); await view.startImport();
    assert.ok(view.calls.some(c=>c.name==='batchResolveQuoteImportRows'));
    await view.selectCustomer('customer-b');
    await view.resolve(view.importRequest,[{...unpricedLine(),sell_price:110}]);
    assert.equal(view.lineRows().length,1); assert.equal(view.lineRows()[0].sell_price,115);
  } finally {await view.close()}
});

test('late import cannot add lines to another saved order after leaving its original workspace',async()=>{
  const oldLine={...unpricedLine(),requestedCode:'OLD',resolvedCode:'OLD',sell_price:73.5};
  const order=fullOrder('historic',[oldLine]);
  const view=await fixture({cache:customerlessCache([]),orders:[order]});
  try {
    await view.startImport(); assert.ok(view.calls.some(c=>c.name==='batchResolveQuoteImportRows'));
    const clears=view.feedbackEvents.filter(e=>e.kind==='clear').length;
    await view.click('sales.orders.exit'); await view.clickOrder(order.id);
    assert.ok(view.feedbackEvents.filter(e=>e.kind==='clear').length>clears,'leaving an in-progress import must clear its progress indicator');
    assert.equal(view.lineRows().length,1); assert.equal(view.lineRows()[0].sell_price,73.5);
    const settled=[...view.feedbackEvents];
    await view.resolve(view.importRequest,[{...unpricedLine(),sell_price:null}]);
    assert.deepEqual(view.feedbackEvents,settled,'late import must not recreate progress or success in the next order');
    assert.equal(view.lineRows().length,1,'late result must not append to another order');
    assert.equal(view.lineRows()[0].resolvedCode,'OLD'); assert.equal(view.lineRows()[0].sell_price,73.5);
    assert.equal(view.saved.length,0);
  } finally {await view.close()}
});

test('navigation save refuses a partial order while an import is in flight and reports the reason',async()=>{
  const view=await fixture({cache:customerlessCache([unpricedLine()])});
  try {
    await view.selectCustomer('customer-a'); await view.startImport();
    assert.ok(view.calls.some(c=>c.name==='batchResolveQuoteImportRows'));
    view.setConfirmResponse(true); await view.click('sales.orders.exit');
    assert.equal(view.saved.length,0,'navigation-save must not persist incomplete order');
    assert.equal(view.confirms.length,1);
    assert.ok(view.feedbackEvents.some(e=>e.kind==='fail' && /operation before saving/i.test(e.text)), 'failure should explain that import is pending');
    assert.equal(view.lineRows().length,1,'the editor must remain open');
    await view.resolve(view.importRequest,[{...unpricedLine(),lineId:'line-new',requestedCode:'NEW',resolvedCode:'NEW',sell_price:null}]);
    assert.equal(view.lineRows().length,2,'finishing the import returns the editor to a usable state');
    await view.click('sales.orders.saveDraft'); assert.equal(view.saved.length,1);
    assert.equal(view.saved[0].lines.length,2);
  } finally {await view.close()}
});

test('in-flight catalog sync holds navigation and never writes its result to the next order',async()=>{
  const oldLine={...unpricedLine(),requestedCode:'OLD',resolvedCode:'OLD',sell_price:73.5};
  const nextLine={...unpricedLine(),lineId:'next',requestedCode:'NEXT',resolvedCode:'NEXT',sell_price:45};
  const old=fullOrder('old',[oldLine]), next=fullOrder('next',[nextLine]);
  const view=await fixture({cache:existingCache(old,[oldLine]),orders:[old,next]});
  try {
    await view.click('sales.orders.resyncFromCatalog');
    assert.ok(view.calls.some(c=>c.name==='resyncSalesOrderWithCodeReferenceFallback'));
    await view.click('sales.orders.clearDraft');
    assert.ok(view.feedbackEvents.some(e=>e.kind==='fail'&&/synchronization.*clearing/i.test(e.text)),'clearing must explain why it is deferred');
    assert.equal(view.lineRows()[0].resolvedCode,'OLD');
    await view.click('sales.orders.exit');
    assert.ok(view.feedbackEvents.some(e=>e.kind==='fail'&&/synchronization/i.test(e.text)),'the reason for waiting must be visible');
    assert.equal(view.lineRows()[0].resolvedCode,'OLD');
    await view.externalOrder('next');
    assert.equal(view.lineRows()[0].resolvedCode,'OLD','external navigation must wait for the in-flight save');
    await view.resolve(view.resyncRequest,{lines:[{...oldLine,description:'Refreshed'}],preservedOtherPrices:false});
    assert.equal(view.saved.length,1); assert.equal(view.saved[0].id,'old');
    assert.equal(view.saved[0].lines[0].resolvedCode,'OLD');
    assert.equal(view.lineRows().length,1); assert.equal(view.lineRows()[0].resolvedCode,'NEXT');
    assert.equal(view.lineRows()[0].sell_price,45);
  } finally {await view.close()}
});

test('catalog item handoff waits for in-flight sync and resumes afterwards',async()=>{
  const oldLine={...unpricedLine(),requestedCode:'OLD',resolvedCode:'OLD',sell_price:73.5};
  const old=fullOrder('old',[oldLine]); const view=await fixture({cache:existingCache(old,[oldLine]),orders:[old]});
  try {
    await view.click('sales.orders.resyncFromCatalog');
    await view.queueCatalogHandoff();
    assert.equal(view.prompts.length,0,'the catalog handoff must not interrupt the current sync');
    assert.equal(view.handoffPending(),true);
    await view.resolve(view.resyncRequest,{lines:[{...oldLine,description:'Refreshed'}],preservedOtherPrices:false});
    assert.equal(view.saved.length,1); assert.equal(view.saved[0].id,'old');
    assert.equal(view.prompts.length,1,'the handoff should resume when synchronization completes');
    assert.equal(view.handoffPending(),false);
  } finally {await view.close()}
});

test('a late cloud quote list cannot replace a new draft while catalog sync is in flight',async()=>{
  const original={...unpricedLine(),requestedCode:'ORIGINAL',resolvedCode:'ORIGINAL'};
  const view=await fixture({cache:customerlessCache([original]),holdQuotes:true,holdQuoteDetail:true});
  try {
    await view.click('sales.orders.resyncFromCatalog');
    assert.ok(view.calls.some(c=>c.name==='resyncSalesOrderWithCodeReferenceFallback'));
    await view.resolve(view.quoteListRequest,[{quote_id:'stale-quote',quote_no:'OLD-QUOTE'}]);
    assert.equal(view.calls.filter(c=>c.name==='fetchCloudQuoteDetail').length,0,'late list must not select a quote in the editor');
    assert.equal(view.lineRows()[0].resolvedCode,'ORIGINAL');
    await view.resolve(view.resyncRequest,{lines:[original],preservedOtherPrices:false});
    assert.equal(view.lineRows()[0].resolvedCode,'ORIGINAL');
  } finally {await view.close()}
});

test('a late cloud quote detail cannot overwrite a draft while catalog sync is in flight',async()=>{
  const original={...unpricedLine(),requestedCode:'ORIGINAL',resolvedCode:'ORIGINAL'};
  const view=await fixture({cache:customerlessCache([original]),selectedQuoteId:'stale-quote',holdQuotes:true,holdQuoteDetail:true});
  try {
    assert.equal(view.calls.filter(c=>c.name==='fetchCloudQuoteDetail').length,1);
    await view.click('sales.orders.resyncFromCatalog');
    await view.resolve(view.quoteDetailRequest,{quote:{quote_no:'STALE',customer_name:'Other customer'},lines:[]});
    assert.equal(view.lineRows().length,1); assert.equal(view.lineRows()[0].resolvedCode,'ORIGINAL');
    await view.resolve(view.resyncRequest,{lines:[original],preservedOtherPrices:false});
    assert.equal(view.lineRows()[0].resolvedCode,'ORIGINAL');
  } finally {await view.close()}
});

test('a selected cloud quote still opens normally when no catalog sync is running',async()=>{
  const view=await fixture({cache:customerlessCache([]),selectedQuoteId:'real-quote',holdQuotes:true,holdQuoteDetail:true});
  try {
    assert.equal(view.calls.filter(c=>c.name==='fetchCloudQuoteDetail').length,1);
    await view.resolve(view.quoteDetailRequest,{quote:{quote_no:'Q-REAL',customer_name:'Customer A'},lines:[{
      id:'q1',product_code:'CODE',brand_text:'Synthetic',description:'Quote product',qty:2,buy_price:10,sell_price:13,supplier_name:'Supplier',
    }]});
    assert.equal(view.lineRows().length,1); assert.equal(view.lineRows()[0].resolvedCode,'CODE');
    assert.equal(view.lineRows()[0].sell_price,13);
  } finally {await view.close()}
});

test('catalog sync waits for a pending import instead of synchronizing only partial lines',async()=>{
  const view=await fixture({cache:customerlessCache([unpricedLine()])});
  try {
    await view.startImport(); assert.ok(view.calls.some(c=>c.name==='batchResolveQuoteImportRows'));
    const syncButton=view.buttons('sales.orders.resyncFromCatalog')[0];
    assert.equal(syncButton.props.disabled,true,'sync button must be disabled during import');
    await act(async()=>syncButton.props.onClick()); // Simulate a same-turn event queued before disabled state rendered.
    assert.equal(view.calls.filter(c=>c.name==='resyncSalesOrderWithCodeReferenceFallback').length,0);
    assert.ok(view.feedbackEvents.some(e=>e.kind==='fail'&&/line loading/i.test(e.text)));
    await view.resolve(view.importRequest,[{...unpricedLine(),lineId:'new',sell_price:null}]);
    assert.equal(view.lineRows().length,2);
  } finally {await view.close()}
});

test('an import request cannot start during an in-flight catalog sync',async()=>{
  const view=await fixture({cache:customerlessCache([unpricedLine()])});
  try {
    await view.click('sales.orders.resyncFromCatalog');
    assert.ok(view.calls.some(c=>c.name==='resyncSalesOrderWithCodeReferenceFallback'));
    assert.equal(view.buttons('Import CSV')[0].props.disabled,true,'import button must be disabled during sync');
    await view.startImport(); // Simulate a file dialog result already in flight.
    assert.equal(view.calls.filter(c=>c.name==='batchResolveQuoteImportRows').length,0);
    assert.ok(view.feedbackEvents.some(e=>e.kind==='fail'&&/operation before importing/i.test(e.text)));
    await view.resolve(view.resyncRequest,{lines:[unpricedLine()],preservedOtherPrices:false});
    assert.equal(view.lineRows().length,1);
  } finally {await view.close()}
});

test('a pending single-item lookup and catalog sync cannot overlap in either direction',async()=>{
  const first=await fixture({cache:customerlessCache([unpricedLine()])});
  try {
    await first.fillNewLine(); await first.click('sales.orders.addNewRow');
    assert.ok(first.calls.some(c=>c.name==='resolveQuoteLine'));
    const button=first.buttons('sales.orders.resyncFromCatalog')[0]; assert.equal(button.props.disabled,true);
    await act(async()=>button.props.onClick());
    assert.equal(first.calls.filter(c=>c.name==='resyncSalesOrderWithCodeReferenceFallback').length,0);
    assert.ok(first.feedbackEvents.some(e=>e.kind==='fail'&&/line loading/i.test(e.text)));
    await first.resolve(first.resolveRequest,{resolved:{found:true,product_code:'0012',brand:'Synthetic',buy_price:100,sell_price:null},supplierOptions:[]});
  } finally {await first.close()}
  const second=await fixture({cache:customerlessCache([unpricedLine()])});
  try {
    await second.fillNewLine(); await second.click('sales.orders.resyncFromCatalog');
    const button=second.buttons('sales.orders.addNewRow')[0]; assert.equal(button.props.disabled,true);
    await act(async()=>button.props.onClick());
    assert.equal(second.calls.filter(c=>c.name==='resolveQuoteLine').length,0);
    assert.ok(second.feedbackEvents.some(e=>e.kind==='fail'&&/operation before adding/i.test(e.text)));
    await second.resolve(second.resyncRequest,{lines:[unpricedLine()],preservedOtherPrices:false});
  } finally {await second.close()}
});

test('catalog handoff serializes price work, survives rerender, then unlocks the editor',async()=>{
  const view=await fixture({cache:customerlessCache([unpricedLine()]),orders:[]});
  try {
    view.holdSingleLookup(); await view.queueCatalogHandoff();
    assert.equal(view.calls.filter(c=>c.name==='resolveQuoteLine').length,1,'catalog transfer should start supplier lookup');
    const syncButton=view.buttons('sales.orders.resyncFromCatalog')[0];
    assert.equal(syncButton.props.disabled,true,'sync must be disabled until catalog transfer completes');
    assert.equal(view.buttons('Import CSV')[0].props.disabled,true,'import must be disabled until catalog transfer completes');
    await act(async()=>syncButton.props.onClick()); await view.startImport();
    assert.equal(view.calls.filter(c=>c.name==='resyncSalesOrderWithCodeReferenceFallback').length,0);
    assert.equal(view.calls.filter(c=>c.name==='batchResolveQuoteImportRows').length,0);
    await view.rerender();
    await view.resolve(view.resolveRequest,{resolved:{found:true,product_code:'HANDOFF',brand:'Synthetic',buy_price:100,sell_price:null},supplierOptions:[]});
    assert.ok(view.lineRows().some(row=>row.resolvedCode==='HANDOFF'),'a harmless rerender must not lose the transferred item');
    assert.equal(view.buttons('sales.orders.resyncFromCatalog')[0].props.disabled,false);
    assert.equal(view.buttons('Import CSV')[0].props.disabled,false);
    await view.click('sales.orders.resyncFromCatalog');
    assert.equal(view.calls.filter(c=>c.name==='resyncSalesOrderWithCodeReferenceFallback').length,1);
    await view.resolve(view.resyncRequest,{lines:view.lineRows(),preservedOtherPrices:false});
  } finally {await view.close()}
});

test('leaving the screen during catalog handoff clears progress and ignores the late response',async()=>{
  const view=await fixture({cache:customerlessCache([unpricedLine()]),orders:[]});
  try {
    view.holdSingleLookup(); await view.queueCatalogHandoff();
    assert.equal(view.calls.filter(c=>c.name==='resolveQuoteLine').length,1);
    const clears=view.feedbackEvents.filter(e=>e.kind==='clear').length;
    await view.unmount();
    assert.ok(view.feedbackEvents.filter(e=>e.kind==='clear').length>clears,'leaving must clear catalog transfer progress');
    const settled=[...view.feedbackEvents];
    await view.resolve(view.resolveRequest,{resolved:{found:true,product_code:'HANDOFF',brand:'Synthetic',buy_price:100,sell_price:null},supplierOptions:[]});
    assert.deepEqual(view.feedbackEvents,settled,'late response must not recreate status after leaving');
    assert.equal(view.saved.length,0);
  } finally {await view.close()}
});

test('catalog handoff waits for active import and runs after the import completes',async()=>{
  const view=await fixture({cache:customerlessCache([unpricedLine()]),orders:[]});
  try {
    view.holdSingleLookup(); await view.startImport(); await view.queueCatalogHandoff();
    assert.equal(view.handoffPending(),true); assert.equal(view.calls.filter(c=>c.name==='resolveQuoteLine').length,0);
    await view.resolve(view.importRequest,[{...unpricedLine(),lineId:'imported',requestedCode:'IMPORT',resolvedCode:'IMPORT',sell_price:null}]);
    assert.equal(view.calls.filter(c=>c.name==='resolveQuoteLine').length,1);
    assert.equal(view.handoffPending(),false);
    await view.resolve(view.resolveRequest,{resolved:{found:true,product_code:'HANDOFF',brand:'Synthetic',buy_price:100,sell_price:null},supplierOptions:[]});
    assert.ok(view.lineRows().some(row=>row.resolvedCode==='HANDOFF'));
    assert.ok(view.lineRows().some(row=>row.resolvedCode==='IMPORT'));
    assert.equal(view.buttons('Import CSV')[0].props.disabled,false);
  } finally {await view.close()}
});

