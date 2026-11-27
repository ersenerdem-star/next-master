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
async function fixture({ cache = draftCache(), orders = [fullOrder()], selectedSalesOrderId = '', selectedQuoteId = '', holdDetail = false, failDetail = false, holdQuotes = false, holdQuoteDetail = false, failSeen = false, failPostConfirmRefresh = false }: {
  cache?: Record<string, any>; orders?: Array<ReturnType<typeof fullOrder>>; selectedSalesOrderId?: string; selectedQuoteId?:string; holdDetail?: boolean; failDetail?: boolean; holdQuotes?:boolean; holdQuoteDetail?:boolean; failSeen?:boolean; failPostConfirmRefresh?:boolean;
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
  let confirmed = false;
  globals[fixtureKey] = {
    feedback: Object.fromEntries(['begin', 'succeed', 'fail', 'clear'].map(kind => [kind, (text: string) => feedbackEvents.push({ kind, text })])),
    call(name: string, ...args: any[]) {
      calls.push({ name, args });
      if (name === 'fetchSalesOrderSummaries') return confirmed && failPostConfirmRefresh ? Promise.reject(Error('Synthetic refresh failure')) : summaryQueue.shift()?.promise ?? Promise.resolve(storedOrders.map(summary));
      if (name === 'callAppRpc') {
        if (args[0] === 'cloud_sales_order_preserved_supplier_lines') return Promise.resolve({preserved_indices: args[1].input_lines.map((_row:any,index:number)=>index), disabled_indices: []});
        if (args[0] === 'cloud_current_supplier_price_options_batch') return Promise.resolve(args[1].input_requests.map((_row:any,index:number)=>({request_index:index,has_published_scope:false,options:[]})));
        throw Error(`Unexpected RPC ${args[0]}`);
      }
      if (name === 'confirmSalesOrderWithPurchases') {
        const source=storedOrders.find(row=>row.id===args[0].id);
        const savedOrder = {...args[0], source_channel:source?.source_channel || 'internal', portal_submitted_at:source?.portal_submitted_at || null, status:'confirmed', updated_at:'2026-11-26T10:00:00Z', confirmed_at:'2026-11-26T10:00:00Z'};
        storedOrders = [savedOrder, ...storedOrders.filter(row => row.id !== savedOrder.id)]; confirmed = true;
        return Promise.resolve({salesOrder:savedOrder, purchaseOrders:[{id:'synthetic-po'}]});
      }
      if (name === 'markSalesOrderPortalSeen') return failSeen ? Promise.reject(Error('Synthetic seen failure')) : Promise.resolve(null);
      if (name === 'createFullSalesInvoices') return Promise.resolve([{id:'synthetic-invoice'}]);
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
      if (name === 'resolveQuoteLine' || name === 'fetchCurrentSupplierOptionsForOrder') return holdLineLookup ? resolveRequest.promise : Promise.reject(Error('Synthetic enrichment unavailable'));
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

test('saved sales order blocks file import from both controls and accepts manual add',async()=>{
  const oldLine={...unpricedLine(),requestedCode:'OLD',resolvedCode:'OLD',sell_price:73.5};
  const order=fullOrder('historic',[oldLine]);
  const view=await fixture({cache:existingCache(order,[oldLine]),orders:[order]});
  try {
    assert.equal(view.buttons('Import CSV')[0].props.disabled,true);
    assert.equal(view.buttons('sales.orders.addItemsInBulk')[0].props.disabled,true);
    assert.match(view.text(),/Add products individually to a saved order/);
    await view.startImport(); // Also guards a stale native file-picker result.
    assert.equal(view.calls.filter(c=>c.name==='batchResolveQuoteImportRows').length,0);
    assert.ok(view.feedbackEvents.some(e=>e.kind==='fail'&&/Files cannot be imported into a saved order/i.test(e.text)));
    assert.equal(view.lineRows().length,1); assert.equal(view.lineRows()[0].sell_price,73.5);
    await view.fillNewLine();
    assert.equal(view.buttons('sales.orders.addNewRow')[0].props.disabled,false);
    await view.click('sales.orders.addNewRow');
    assert.equal(view.calls.filter(c=>c.name==='resolveQuoteLine').length,1);
    await view.resolve(view.resolveRequest,{resolved:{found:true,product_code:'0012',brand:'Synthetic',buy_price:100,sell_price:110},supplierOptions:[]});
    assert.equal(view.lineRows().length,2); assert.equal(view.lineRows()[1].resolvedCode,'OLD');
    assert.equal(view.saved.length,0);
  } finally {await view.close()}
});

test('file import remains available for an unsaved new order',async()=>{
  const view=await fixture({cache:customerlessCache([])});
  try {
    assert.equal(view.buttons('Import CSV')[0].props.disabled,false);
    await view.startImport();
    assert.equal(view.calls.filter(c=>c.name==='batchResolveQuoteImportRows').length,1);
    await view.resolve(view.importRequest,[{...unpricedLine(),sell_price:null}]);
    assert.equal(view.lineRows().length,1);
  } finally {await view.close()}
});

test('duplicate sales order number is shown as an actionable error in the real editor',async()=>{
  const view=await fixture({cache:draftCache()});
  try {
    const mock=(globalThis as any)[fixtureKey]; const original=mock.call;
    mock.call=(name:string,...args:any[])=>name==='upsertSalesOrder'
      ? Promise.reject(new Error('SALES_ORDER_NUMBER_ALREADY_USED')) : original(name,...args);
    await view.click('sales.orders.saveDraft');
    assert.ok(view.feedbackEvents.some(e=>e.kind==='fail'&&/sales order number is already in use.*different order number/i.test(e.text)));
    assert.equal(view.saved.length,0);
  } finally {await view.close()}
});

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
    view.holdSingleLookup();
    await view.click('sales.orders.resyncFromCatalog');
    await view.queueCatalogHandoff();
    assert.equal(view.prompts.length,0,'the catalog handoff must not interrupt the current sync');
    assert.equal(view.handoffPending(),true);
    await view.resolve(view.resyncRequest,{lines:[{...oldLine,description:'Refreshed'}],preservedOtherPrices:false});
    assert.equal(view.saved.length,1); assert.equal(view.saved[0].id,'old');
    assert.equal(view.prompts.length,0,'saved orders must not be offered as transfer targets');
    assert.equal(view.handoffPending(),false);
    assert.equal(view.calls.filter(c=>c.name==='resolveQuoteLine').length,1,'the handoff should resume when synchronization completes');
    await view.resolve(view.resolveRequest,{resolved:{found:true,product_code:'HANDOFF',brand:'Synthetic',buy_price:100,sell_price:null},supplierOptions:[]});
    assert.deepEqual(view.lineRows().map(row=>row.resolvedCode),['HANDOFF']);
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

test('catalog handoff cannot choose an existing order even when several share the same number',async()=>{
  const first={...fullOrder('first'),sales_order_no:'DUPLICATE',customer_name:'Customer one'};
  const second={...fullOrder('second'),sales_order_no:'DUPLICATE',customer_name:'Customer two'};
  const view=await fixture({cache:customerlessCache([unpricedLine()]),orders:[first,second]});
  try {
    view.holdSingleLookup(); await view.queueCatalogHandoff();
    assert.equal(view.prompts.length,0,'saved order selection must not be offered');
    assert.equal(view.calls.filter(c=>c.name==='fetchSalesOrderById').length,0,'no existing order may be loaded');
    await view.resolve(view.resolveRequest,{resolved:{found:true,product_code:'HANDOFF',brand:'Synthetic',buy_price:100,sell_price:null},supplierOptions:[]});
    assert.ok(view.lineRows().some(row=>row.resolvedCode==='HANDOFF'));
    assert.ok(view.lineRows().some(row=>row.resolvedCode==='0012'),'current new draft must be preserved');
    assert.equal(view.saved.length,0);
  } finally {await view.close()}
});

test('catalog handoff does not discard unsaved edits on an existing order when navigation is declined',async()=>{
  const order=fullOrder('existing'); const changed=[...order.lines,line('UNSAVED')];
  const view=await fixture({cache:existingCache(order,changed),orders:[order]});
  try {
    view.setConfirmResponse(false); view.holdSingleLookup(); await view.queueCatalogHandoff();
    assert.equal(view.confirms.length,1,'user must be asked to preserve edits');
    assert.equal(view.saved.length,0);
    assert.equal(view.calls.filter(c=>c.name==='resolveQuoteLine').length,0,'cancelled navigation must not start transfer');
    assert.deepEqual(view.lineRows().map(row=>row.resolvedCode),['TEST-001','UNSAVED']);
  } finally {await view.close()}
});

test('catalog handoff saves confirmed unsaved edits then opens a fresh customerless order',async()=>{
  const order={...fullOrder('existing'),customer_id:'customer-a',customer_name:'Customer A'}; const changed=[...order.lines,line('UNSAVED')];
  const cache={...existingCache(order,changed),customerName:'Customer A',customerSelection:'customer-a'};
  const view=await fixture({cache,orders:[order]});
  try {
    view.setConfirmResponse(true); view.holdSingleLookup(); await view.queueCatalogHandoff();
    assert.equal(view.saved.length,1,'explicit save before leaving preserves the old order');
    assert.deepEqual(view.saved[0].lines.map((row:any)=>row.resolvedCode),['TEST-001','UNSAVED']);
    assert.equal(view.calls.filter(c=>c.name==='resolveQuoteLine').length,1);
    assert.equal(view.calls.find(c=>c.name==='resolveQuoteLine')?.args[0].calculateSellPrice,false,'the prior customer must not be used even while React state resets');
    await view.resolve(view.resolveRequest,{resolved:{found:true,product_code:'HANDOFF',brand:'Synthetic',buy_price:100,sell_price:null},supplierOptions:[]});
    assert.deepEqual(view.lineRows().map(row=>row.resolvedCode),['HANDOFF']);
    assert.equal(view.lineRows()[0].sell_price,null,'the previous customer must not price the new order');
    await view.flushCache(); assert.equal(view.cache().selectedLocalSalesOrderId,'');
  } finally {await view.close()}
});


test('confirmation remains successful if the portal marker fails, and invoice uses the server version', async()=>{
  const order={...fullOrder('portal-postcommit'),source_channel:'portal',portal_submitted_at:'2026-11-26T09:00:00Z'};
  const view=await fixture({cache:existingCache(order),orders:[order],failSeen:true});
  try {
    await view.click('sales.orders.markConfirmed');
    assert.equal(view.calls.filter(call=>call.name==='confirmSalesOrderWithPurchases').length,1);
    assert.ok(view.feedbackEvents.some(event=>event.kind==='succeed' && /was confirmed.*could not be refreshed/.test(event.text)),JSON.stringify(view.feedbackEvents));
    assert.ok(!view.feedbackEvents.some(event=>event.kind==='fail'),JSON.stringify(view.feedbackEvents));
    await view.click('sales.orders.convertToInvoice');
    const invoiceCall=view.calls.find(call=>call.name==='createFullSalesInvoices');
    assert.equal(invoiceCall?.args[1][0].updated_at,'2026-11-26T10:00:00Z');
  } finally { await view.close(); }
});

test('confirmation remains successful and invoice prompt stays usable if list refresh fails', async()=>{
  const order=fullOrder('list-postcommit');
  const view=await fixture({cache:existingCache(order),orders:[order],failPostConfirmRefresh:true});
  try {
    await view.click('sales.orders.markConfirmed');
    assert.equal(view.calls.filter(call=>call.name==='confirmSalesOrderWithPurchases').length,1);
    assert.ok(view.feedbackEvents.some(event=>event.kind==='succeed' && /was confirmed.*could not be refreshed/.test(event.text)),JSON.stringify(view.feedbackEvents));
    assert.ok(!view.feedbackEvents.some(event=>event.kind==='fail'),JSON.stringify(view.feedbackEvents));
    assert.ok(view.text().includes('sales.orders.convertToInvoiceDescription'));
  } finally { await view.close(); }
});

test('an already-seen portal order is reloaded for the invoice version', async()=>{
  const order={...fullOrder('portal-already-seen'),source_channel:'portal',portal_submitted_at:'2026-11-26T09:00:00Z'};
  const view=await fixture({cache:existingCache(order),orders:[order]});
  try {
    await view.click('sales.orders.markConfirmed');
    const markIndex=view.calls.findIndex(call=>call.name==='markSalesOrderPortalSeen');
    assert.ok(markIndex>=0);
    assert.ok(view.calls.slice(markIndex+1).some(call=>call.name==='fetchSalesOrderById' && call.args[0]===order.id));
    await view.click('sales.orders.convertToInvoice');
    assert.equal(view.calls.find(call=>call.name==='createFullSalesInvoices')?.args[1][0].updated_at,'2026-11-26T10:00:00Z');
  } finally { await view.close(); }
});

const supplierOption = (name: string, buy: number, extra: Record<string, unknown> = {}) => ({
  supplier_id: name.toLowerCase(), supplier_name:name, buy_price:buy, sell_price:buy * 1.1,
  price_date:'2026-11-26', notes:null, moq:1, order_multiple:1, stock_qty:5, valid_to:null, ...extra,
});
const supplierLine = () => ({...line(), manual_sell_price:false, supplier_name:'Supplier A', buy_price:10, sell_price:11,
  supplierOptions:[supplierOption('Supplier A',10),supplierOption('Supplier B',15)], selectedSupplierKey:'Supplier A-0'});
async function chooseSupplier(view: Awaited<ReturnType<typeof fixture>>, value: string) {
  const control=view.renderer.root.findAllByType('select').find(node => node.props['aria-label']==='TEST-001 sales.orders.purchaseOption');
  assert.ok(control,'supplier choice must be visible on each normal order row');
  await act(async()=>control.props.onChange({target:{value}}));
}

test('existing order supplier choice updates purchase while preserving its sale, and survives save and reopen',async()=>{
  const order={...fullOrder('supplier-choice',[supplierLine()]),customer_id:'customer-a',customer_name:'Customer A'};
  const cache={...existingCache(order),customerName:'Customer A',customerSelection:'customer-a'};
  const view=await fixture({cache,orders:[order]}); let savedOrder:any;
  try {
    await chooseSupplier(view,'Supplier B-1');
    const updated=view.lineRows()[0];
    assert.equal(updated.supplier_name,'Supplier B'); assert.equal(updated.buy_price,15); assert.equal(updated.sell_price,11);
    assert.equal(updated.manual_sell_price,false); assert.equal(updated.supplier_override_keep_sell_price,true); assert.equal(updated.customer_price_basis_buy_price,10);
    await view.click('sales.orders.saveDraft');
    savedOrder=view.saved.at(-1); assert.equal(savedOrder.lines[0].supplier_name,'Supplier B'); assert.equal(savedOrder.lines[0].sell_price,11);
  } finally {await view.close()}
  const reopened=await fixture({cache:existingCache(savedOrder),orders:[savedOrder]});
  try {assert.equal(reopened.lineRows()[0].supplier_name,'Supplier B');assert.equal(reopened.lineRows()[0].sell_price,11);assert.equal(reopened.lineRows()[0].selectedSupplierKey,'Supplier B-1');} finally {await reopened.close()}
});

test('changing to a distinct same-name supplier is dirty even if prices and conditions match',async()=>{
  const first=supplierOption('Supplier A',10,{supplier_id:'vendor-a'});
  const second=supplierOption('Supplier A',10,{supplier_id:'vendor-b'});
  const samePrice={...supplierLine(),supplier_override_keep_sell_price:true,customer_price_basis_buy_price:10,
    explicit_supplier_choice_id:'vendor-a',supplierOptions:[first,second],selectedSupplierKey:'Supplier A-0'};
  const order=fullOrder('same-name-suppliers',[samePrice]);const view=await fixture({cache:{...draftCache(),salesOrdersView:'list',workbenchMode:'existing',selectedLocalSalesOrderId:'',quoteBuilderLines:[]},orders:[order]});
  try {
    await view.clickOrder(order.id);view.setConfirmResponse(false);
    await chooseSupplier(view,'Supplier A-1');
    assert.equal(view.lineRows()[0].explicit_supplier_choice_id,'vendor-b');
    assert.equal(view.lineRows()[0].sell_price,11); assert.equal(view.lineRows()[0].buy_price,10);
    await view.click('sales.orders.exit');
    assert.ok(view.confirms.some(text=>/unsavedChangesPrompt/.test(text)),'navigation must ask before discarding the different supplier');
    assert.equal(view.lineRows()[0].explicit_supplier_choice_id,'vendor-b');
    assert.equal(view.saved.length,0);
  } finally {await view.close()}
});

test('refreshing options or changing their order does not create a false unsaved change',async()=>{
  const noSupplierId={...supplierLine(),price_date:'2026-11-26',moq:1,order_multiple:1,stock_qty:5,valid_to:null,supplierOptions:[supplierOption('Supplier A',10,{supplier_id:null}),supplierOption('Supplier B',15)]};
  const order=fullOrder('supplier-refresh-no-dirty',[noSupplierId]);const view=await fixture({cache:{...draftCache(),salesOrdersView:'list',workbenchMode:'existing',selectedLocalSalesOrderId:'',quoteBuilderLines:[]},orders:[order]});
  try {
    await view.clickOrder(order.id);view.setConfirmResponse(false);view.holdSingleLookup();await view.click('Current options');
    await view.resolve(view.resolveRequest,[supplierOption('Supplier B',15),supplierOption('Supplier A',10,{supplier_id:'newly-known'})]);
    assert.equal(view.lineRows()[0].supplier_name,'Supplier A');assert.equal(view.lineRows()[0].selectedSupplierKey,'Supplier A-1');
    assert.equal(view.lineRows()[0].buy_price,10);assert.equal(view.lineRows()[0].sell_price,11);
    await view.click('sales.orders.exit');
    assert.equal(view.confirms.length,0,'loading option metadata is not a commercial change');
    assert.match(view.text(),/sales.orders.listTitle/);
    assert.equal(view.saved.length,0);
  } finally {await view.close()}
});

test('catalog sync asks before changing quantities and declining does not save or change the line',async()=>{
  const original=supplierLine(); const order=fullOrder('resync-quantity-declined',[original]);
  const view=await fixture({cache:{...draftCache(),salesOrdersView:'list',workbenchMode:'existing',selectedLocalSalesOrderId:'',quoteBuilderLines:[]},orders:[order]});
  try {
    await view.clickOrder(order.id);view.setConfirmResponse(false);
    await view.click('sales.orders.resyncFromCatalog');
    await view.resolve(view.resyncRequest,{lines:[{...original,qty:6,purchase_qty_recheck_required:true}],preservedOtherPrices:false});
    assert.match(view.confirms.at(-1) || '',/TEST-001: 3 → 6/);
    assert.equal(view.saved.length,0);assert.equal(view.lineRows()[0].qty,3);
    assert.ok(view.feedbackEvents.some(event=>event.kind==='succeed' && /cancelled.*not changed/i.test(event.text)));
  } finally {await view.close()}
});

test('accepting catalog quantity adjustment saves it and reports pending tier verification',async()=>{
  const original=supplierLine(); const order=fullOrder('resync-quantity-approved',[original]);
  const view=await fixture({cache:{...draftCache(),salesOrdersView:'list',workbenchMode:'existing',selectedLocalSalesOrderId:'',quoteBuilderLines:[]},orders:[order]});
  try {
    await view.clickOrder(order.id);view.setConfirmResponse(true);
    await view.click('sales.orders.resyncFromCatalog');
    await view.resolve(view.resyncRequest,{lines:[{...original,qty:6,purchase_qty_recheck_required:true}],preservedOtherPrices:false});
    assert.match(view.confirms.at(-1) || '',/TEST-001: 3 → 6/);
    assert.equal(view.saved.length,1);assert.equal(view.saved[0].lines[0].qty,6);
    assert.equal(view.saved[0].lines[0].purchase_qty_recheck_required,true);
    assert.match(view.text(),/Verify the current quantity-tier supplier price on 1 lines/);
  } finally {await view.close()}
});

test('supplier MOQ or pack adjustment asks explicitly before changing the customer quantity',async()=>{
  const original={...supplierLine(),supplierOptions:[supplierOption('Supplier A',10),supplierOption('Supplier B',15,{moq:5,order_multiple:2})]};
  const order=fullOrder('supplier-quantity',[original]); const view=await fixture({cache:existingCache(order),orders:[order]});
  try {
    view.setConfirmResponse(false); await chooseSupplier(view,'Supplier B-1');
    assert.equal(view.lineRows()[0].qty,3);assert.equal(view.lineRows()[0].supplier_name,'Supplier A');assert.equal(view.lineRows()[0].sell_price,11);
    assert.match(view.confirms.at(-1) || '',/3 to 6/);
    view.setConfirmResponse(true); await chooseSupplier(view,'Supplier B-1');
    assert.equal(view.lineRows()[0].qty,6);assert.equal(view.lineRows()[0].supplier_name,'Supplier B');assert.equal(view.lineRows()[0].sell_price,11);
  } finally {await view.close()}
});

test('without customer a different supplier does not establish sale price; choosing customer uses original price basis',async()=>{
  const fresh={...supplierLine(),sell_price:null,customer_pricing_pending:true};
  const cache={...draftCache(),customerName:'',customerSelection:'',quoteBuilderLines:[fresh]};
  const view=await fixture({cache,orders:[]});
  try {
    assert.equal(view.lineRows()[0].sell_price,null);
    await chooseSupplier(view,'Supplier B-1');
    assert.equal(view.lineRows()[0].buy_price,15);assert.equal(view.lineRows()[0].sell_price,null);
    await view.selectCustomer('customer-a');
    assert.equal(view.lineRows()[0].sell_price,11);assert.equal(view.lineRows()[0].buy_price,15);
  } finally {await view.close()}
});

test('refreshing supplier options is buy-only and preserves the order choice and both prices',async()=>{
  const order=fullOrder('supplier-refresh',[supplierLine()]); const view=await fixture({cache:existingCache(order),orders:[order]});
  try {
    view.holdSingleLookup(); await view.click('Current options');
    assert.deepEqual(view.calls.find(call=>call.name==='fetchCurrentSupplierOptionsForOrder')?.args[0],{code:'TEST-001',brand:'Synthetic',quantity:3});
    await view.resolve(view.resolveRequest,[supplierOption('Supplier A',12),supplierOption('Supplier B',15),supplierOption('Supplier C',16)]);
    const row=view.lineRows()[0];assert.equal(row.supplier_name,'Supplier A');assert.equal(row.buy_price,10);assert.equal(row.sell_price,11);
    assert.equal(row.supplierOptions.length,4);assert.equal(row.supplierOptions[0].saved_order_offer,true);
    await chooseSupplier(view,'Supplier C-3');assert.equal(view.lineRows()[0].buy_price,16);assert.equal(view.lineRows()[0].sell_price,11);
  } finally {await view.close()}
});

test('bulk supplier choice skips quantity-adjusted lines and keeps sale prices and quantities',async()=>{
  const a=supplierLine();
  const missing={...line('TEST-002'),supplier_name:'Supplier A',manual_sell_price:false,buy_price:10,sell_price:12,
    supplierOptions:[supplierOption('Supplier A',10)],selectedSupplierKey:'Supplier A-0'};
  const pack={...line('TEST-003'),supplier_name:'Supplier A',manual_sell_price:false,buy_price:10,sell_price:13,
    supplierOptions:[supplierOption('Supplier A',10),supplierOption('Supplier B',15,{moq:5,order_multiple:2})],selectedSupplierKey:'Supplier A-0'};
  const order=fullOrder('bulk-supplier',[a,missing,pack]);const view=await fixture({cache:existingCache(order),orders:[order]});
  try {
    const bulk=view.renderer.root.findAllByType('select').find(node=>node.props['aria-label']==='Bulk supplier');assert.ok(bulk);
    await act(async()=>bulk.props.onChange({target:{value:'supplier b'}}));
    view.setConfirmResponse(false);await view.click('Apply to eligible lines');
    assert.deepEqual(view.lineRows().map(row=>row.supplier_name),['Supplier A','Supplier A','Supplier A']);
    assert.match(view.confirms.at(-1) || '',/1 eligible lines/);assert.match(view.confirms.at(-1) || '',/1 lines needing quantity changes were skipped/);
    view.setConfirmResponse(true);await view.click('Apply to eligible lines');
    assert.deepEqual(view.lineRows().map(row=>row.supplier_name),['Supplier B','Supplier A','Supplier A']);
    assert.deepEqual(view.lineRows().map(row=>row.sell_price),[11,12,13]);assert.deepEqual(view.lineRows().map(row=>row.qty),[3,3,3]);
  } finally {await view.close()}
});

test('new order with a customer keeps the same customer sale price after selecting a different supplier',async()=>{
  const fresh={...supplierLine(),customer_pricing_pending:false};
  const cache={...draftCache(),customerName:'Customer A',customerSelection:'customer-a',quoteBuilderLines:[fresh]};
  const view=await fixture({cache,orders:[]});
  try {
    assert.equal(view.lineRows()[0].sell_price,11);
    await chooseSupplier(view,'Supplier B-1');
    assert.equal(view.lineRows()[0].buy_price,15);assert.equal(view.lineRows()[0].sell_price,11);
    assert.equal(view.lineRows()[0].supplier_override_keep_sell_price,true);
  } finally {await view.close()}
});

test('supplier selected before a customer stays selected across draft save and reopen',async()=>{
  const fresh={...supplierLine(),sell_price:null,customer_pricing_pending:true};
  const cache={...draftCache(),customerName:'',customerSelection:'',quoteBuilderLines:[fresh]};
  const view=await fixture({cache,orders:[]});let savedOrder:any;
  try {
    await chooseSupplier(view,'Supplier B-1');assert.equal(view.lineRows()[0].sell_price,null);
    await view.click('sales.orders.saveDraft');savedOrder=view.saved.at(-1);
    assert.equal(savedOrder.lines[0].supplier_name,'Supplier B');assert.equal(savedOrder.lines[0].sell_price,null);
  } finally {await view.close()}
  const reopened=await fixture({cache:{...existingCache(savedOrder),customerName:'',customerSelection:''},orders:[savedOrder]});
  try {
    assert.equal(reopened.lineRows()[0].supplier_name,'Supplier B');assert.equal(reopened.lineRows()[0].sell_price,null);
    await reopened.selectCustomer('customer-a');assert.equal(reopened.lineRows()[0].sell_price,11);assert.equal(reopened.lineRows()[0].buy_price,15);
  } finally {await reopened.close()}
});

test('a stored zero sales price remains zero when a different supplier is chosen',async()=>{
  const freeLine={...supplierLine(),sell_price:0,manual_sell_price:false};
  const order=fullOrder('supplier-free',[freeLine]); const view=await fixture({cache:existingCache(order),orders:[order]});
  try {await chooseSupplier(view,'Supplier B-1');assert.equal(view.lineRows()[0].sell_price,0);assert.equal(view.lineRows()[0].buy_price,15);}
  finally {await view.close()}
});

test('quantity-tier supplier change requires fresh offer for adjusted quantity before confirmation',async()=>{
  const tier={...supplierLine(),brand:'Wahler',supplierOptions:[supplierOption('Supplier A',10,{applied_min_quantity:1}),supplierOption('Supplier B',15,{moq:5,order_multiple:2,applied_min_quantity:1})]};
  const order=fullOrder('tier-supplier',[tier]);const view=await fixture({cache:existingCache(order),orders:[order]});
  try {
    view.setConfirmResponse(true);await chooseSupplier(view,'Supplier B-1');
    assert.equal(view.lineRows()[0].qty,6);assert.equal(view.lineRows()[0].sell_price,11);assert.equal(view.lineRows()[0].purchase_qty_recheck_required,true);
    await view.click('sales.orders.markConfirmed');
    assert.equal(view.calls.filter(call=>call.name==='confirmSalesOrderWithPurchases').length,0);
    assert.ok(view.feedbackEvents.some(event=>event.kind==='fail' && /quantity tier changed/i.test(event.text)));
    view.holdSingleLookup();await view.click('Current options');
    assert.equal(view.calls.find(call=>call.name==='fetchCurrentSupplierOptionsForOrder')?.args[0].quantity,6);
    await view.resolve(view.resolveRequest,[supplierOption('Supplier A',10,{applied_min_quantity:1}),supplierOption('Supplier B',18,{moq:5,order_multiple:2,applied_min_quantity:6})]);
    assert.equal(view.lineRows()[0].buy_price,15);assert.equal(view.lineRows()[0].purchase_qty_recheck_required,true);
    await chooseSupplier(view,'Supplier B-2');assert.equal(view.lineRows()[0].buy_price,18);assert.equal(view.lineRows()[0].sell_price,11);
    assert.equal(view.lineRows()[0].purchase_qty_recheck_required,false);
    await view.click('sales.orders.markConfirmed');
    const confirmCall=view.calls.find(call=>call.name==='confirmSalesOrderWithPurchases');assert.ok(confirmCall);
    assert.equal(confirmCall.args[0].lines[0].buy_price,18);assert.equal(confirmCall.args[0].lines[0].sell_price,11);
  } finally {await view.close()}
});

test('bulk choice updates 200 eligible order rows while retaining every customer sale price and quantity',async()=>{
  const rows=Array.from({length:200},(_,index)=>({...supplierLine(),lineId:`bulk-${index}`,requestedCode:`SKU-${index}`,resolvedCode:`SKU-${index}`,sell_price:11+index/100}));
  const order=fullOrder('bulk-200',rows);const view=await fixture({cache:existingCache(order),orders:[order]});
  try {
    const bulk=view.renderer.root.findAllByType('select').find(node=>node.props['aria-label']==='Bulk supplier');assert.ok(bulk);
    await act(async()=>bulk.props.onChange({target:{value:'supplier b'}}));view.setConfirmResponse(true);
    await view.click('Apply to eligible lines');
    assert.match(view.confirms.at(-1) || '',/200 eligible lines/);
    assert.equal(view.lineRows().length,200);
    view.lineRows().forEach((row,index)=>{assert.equal(row.supplier_name,'Supplier B');assert.equal(row.buy_price,15);assert.equal(row.sell_price,11+index/100);assert.equal(row.qty,3)});
  } finally {await view.close()}
});

test('failed supplier offer refresh preserves the selected supplier and both prices',async()=>{
  const order=fullOrder('supplier-refresh-error',[supplierLine()]);const view=await fixture({cache:existingCache(order),orders:[order]});
  try {
    view.holdSingleLookup();await view.click('Current options');await view.reject(view.resolveRequest);
    assert.equal(view.lineRows()[0].supplier_name,'Supplier A');assert.equal(view.lineRows()[0].buy_price,10);assert.equal(view.lineRows()[0].sell_price,11);
    assert.ok(view.text().includes('supplier options could not be loaded'));
  } finally {await view.close()}
});

test('late supplier offer refresh does not modify another order after navigation',async()=>{
  const first=fullOrder('refresh-first',[supplierLine()]);
  const second=fullOrder('refresh-second',[{...supplierLine(),supplier_name:'Supplier A',buy_price:20,sell_price:22}]);
  const view=await fixture({cache:existingCache(first),orders:[first,second]});
  try {
    view.holdSingleLookup();await view.click('Current options');
    await view.externalOrder(second.id);assert.equal(view.lineRows()[0].buy_price,20);
    await view.resolve(view.resolveRequest,[supplierOption('Supplier A',12),supplierOption('Supplier B',15)]);
    assert.equal(view.lineRows()[0].buy_price,20);assert.equal(view.lineRows()[0].sell_price,22);
  } finally {await view.close()}
});

test('supplier choice, current offer refresh, draft save and confirmation never write customer or supplier price lists',async()=>{
  const order=fullOrder('supplier-isolation',[supplierLine()]);const view=await fixture({cache:existingCache(order),orders:[order]});
  try {
    await chooseSupplier(view,'Supplier B-1');view.holdSingleLookup();await view.click('Current options');
    await view.resolve(view.resolveRequest,[supplierOption('Supplier A',10),supplierOption('Supplier B',16)]);
    await chooseSupplier(view,'Supplier B-2');await view.click('sales.orders.saveDraft');await view.click('sales.orders.markConfirmed');
    const saved=view.calls.find(call=>call.name==='upsertSalesOrder');
    const confirmed=view.calls.find(call=>call.name==='confirmSalesOrderWithPurchases');
    assert.equal(saved?.args[0].lines[0].buy_price,16);assert.equal(saved?.args[0].lines[0].sell_price,11);
    assert.equal(confirmed?.args[0].lines[0].buy_price,16);assert.equal(confirmed?.args[0].lines[0].sell_price,11);
    assert.deepEqual(view.calls.filter(call=>call.name==='callAppRpc').map(call=>call.args[0]),['cloud_sales_order_preserved_supplier_lines','cloud_current_supplier_price_options_batch']);
    assert.equal(view.calls.some(call=>/(?:write|save|update|upsert|publish|delete|import).*(?:price.?list|supplier.?price|publication)/i.test(call.name)),false);
  } finally {await view.close()}
});
