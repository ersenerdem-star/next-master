import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement } from 'react';
import { create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { build } from 'esbuild';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';
import rpcHandler from '../../netlify/functions/app-rpc.mts';

// Keep the real editor, its price-preservation guard and PO projection. Only
// remote APIs, translations and shell feedback are substituted. No test can
// access a live order, confirm it, or send a real network request.
const temporary = await mkdtemp(resolve('node_modules/.gnk-vendor-test-'));
const output = resolve(temporary, 'page.mjs');
const fixtureKey = '__gnkVendorConfirmationTest';
const baseline = process.env.GNK_VENDOR_BASELINE_REV;
if (baseline && !/^[0-9a-f]{7,40}$/.test(baseline)) throw Error('Invalid baseline revision');
await build({
  stdin: { contents: `export {QuotesPage} from './apps/web/src/presentation/pages/QuotesPage.tsx';
    export {buildPurchaseOrdersFromSalesOrder} from './apps/web/src/shared/localOrders.ts';`, resolveDir: process.cwd(), loader: 'tsx' },
  outfile: output, bundle: true, platform: 'node', format: 'esm', jsx: 'automatic', packages: 'external',
  plugins: [{ name: 'synthetic-gnk-order-io', setup(builder) {
    if (baseline) builder.onLoad({ filter: /(?:QuotesPage\.tsx|localOrders\.ts)$/ }, args => {
      const relative = args.path.slice(process.cwd().length + 1);
      return { loader: relative.endsWith('.tsx') ? 'tsx' : 'ts', contents:
        execFileSync('git', ['show', `${baseline}:${relative}`], { encoding: 'utf8' }) };
    });
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
      path === 'i18n' ? `const t=(key,params)=>key+(params?' '+JSON.stringify(params):'');export const useI18n=()=>({locale:'en',t});` :
      path === 'interface' ? `export const useInterfaceText=()=>x=>x;export const InterfaceText=({text})=>text;` :
      `export const useActionFeedback=()=>globalThis.${fixtureKey}.feedback;`
    }));
  } }],
});
const { QuotesPage, buildPurchaseOrdersFromSalesOrder } = await import(pathToFileURL(output).href);
after(async () => { await rm(temporary, { recursive: true, force: true }); });

const gnkVendorId = '10000000-0000-4000-8000-000000000001';
const otherVendorId = '10000000-0000-4000-8000-000000000002';
const legacyNames = ['GNK-Diesel', 'GNK-Mechanik', 'GNK-Pump'];
const line = (supplier = 'GNK', index = 0) => ({
  lineId: `line-${index}`, requestedCode: `000TEST${index}`, resolvedCode: `000TEST${index}`, brand: 'Bosch',
  description: `Synthetic Bosch part ${index}`, qty: index + 2, buy_price: 10 + index / 4, sell_price: 14.5 + index / 4,
  manual_sell_price: true, supplier_name: supplier, supplierOptions: [{ supplier_id: `old-supplier-${index}`, supplier_name: supplier, buy_price: 10 + index / 4 }],
  selectedSupplierKey: `${supplier}-0`, found: true, codeChanged: false, codeChangeWarning: '',
  oem_no: '', hs_code: '851110', origin: 'DE', weight_kg: 0.04, price_date: '2026-10-30', notes: '',
});
const fullOrder = (lines = legacyNames.map(line), status = 'draft') => ({
  id: 'synthetic-saved-order', sales_order_no: 'SYNTHETIC-FU26-GNK', customer_id: null, customer_name: 'Synthetic customer', seller_company: 'Synthetic seller',
  purchase_company: 'Synthetic buyer', quote_date: '2026-11-06', currency: 'EUR', customer_type: 'A', shipping_cost: 0,
  discount_amount: 0, supplier_mode: 'Best price', preferred_supplier: '', seller_info: '', buyer_info: 'Synthetic buyer',
  delivery_term: '', payment_terms: '', packing_details: '', notes: '', status, purchase_total: 0,
  sales_total: 0, profit_total: 0, margin_percent: 0, source_channel: 'internal', portal_invite_id: null,
  portal_submitted_at: null, portal_seen_at: null, created_at: '2026-11-06T10:00:00Z', updated_at: '2026-11-06T10:00:00Z',
  confirmed_at: status === 'confirmed' ? '2026-11-09T10:00:00Z' : null, lines,
});
const recipients = (names = legacyNames, vendorId = gnkVendorId) => names.map(requested_supplier_name => ({ requested_supplier_name, supplier_name: 'GNK', vendor_id: vendorId }));
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}
function content(node: ReactTestInstance | string): string {
  return typeof node === 'string' ? node : node.children.map(child => content(child)).join('');
}

// Evaluate the actual exported resolver with its RPC dependency replaced, not
// a reimplementation of its validation. Other order APIs stay out of the test.
const ordersApiSource = await readFile(resolve('apps/web/src/infrastructure/api/ordersApi.ts'), 'utf8');
const ordersApiAst = ts.createSourceFile('ordersApi.ts', ordersApiSource, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
const resolverDeclaration = ordersApiAst.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === 'resolvePurchaseOrderVendors');
assert.ok(resolverDeclaration, 'actual vendor resolution API must exist');
const resolverJavaScript = ts.transpileModule(resolverDeclaration.getText(ordersApiAst), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
function resolverFixture(response: unknown, failure?: Error) {
  const calls: Array<{ rpc: string; args: any }> = [];
  const rpc = async (name: string, args: unknown) => { calls.push({ rpc: name, args }); if (failure) throw failure; return response; };
  const resolveVendors = new Function('callAppRpc', `const exports={};${resolverJavaScript};return resolvePurchaseOrderVendors;`)(rpc);
  return { calls, resolveVendors };
}

test('actual recipient API deduplicates names, uses the authenticated RPC and retains returned vendor identity', async () => {
  const fixture = resolverFixture(recipients(['GNK-Diesel', 'GNK-Mechanik']));
  const actual = await fixture.resolveVendors([' GNK-Diesel ', 'gnk-diesel', 'GNK-Mechanik']);
  assert.deepEqual(actual, recipients(['GNK-Diesel', 'GNK-Mechanik']));
  assert.deepEqual(fixture.calls, [{ rpc: 'resolve_purchase_order_vendors', args: { input_suppliers: ['gnk-diesel', 'GNK-Mechanik'] } }]);
});

test('actual recipient API rejects missing, foreign, duplicate and conflicting mappings before PO projection', async () => {
  const requested = ['GNK-Diesel', 'GNK-Mechanik'];
  const valid = recipients(requested);
  const failures = [null, {}, [], valid.slice(0, 1), [...valid, valid[0]],
    [valid[0], valid[0]], [valid[0], { ...valid[1], requested_supplier_name: 'Unknown supplier' }],
    [valid[0], { ...valid[1], vendor_id: 'not-a-uuid' }],
    [valid[0], { ...valid[1], supplier_name: 'Different company for same UUID' }],
    [valid[0], { ...valid[1], supplier_name: '' }], [valid[0], { ...valid[1], supplier_name: 'x'.repeat(181) }],
  ];
  for (const result of failures) await assert.rejects(resolverFixture(result).resolveVendors(requested), /could not be verified/);
  await assert.rejects(resolverFixture(valid, Error('Synthetic offline')).resolveVendors(requested), /Synthetic offline/);
});

test('actual recipient API input guards prevent any RPC for absent, oversized or malformed supplier names', async () => {
  for (const names of [[], [''], [' '], [null], ['x'.repeat(181)], Array.from({ length: 101 }, (_, index) => `supplier-${index}`)]) {
    const fixture = resolverFixture([]); await assert.rejects(fixture.resolveVendors(names));
    assert.equal(fixture.calls.length, 0);
  }
});

test('three preserved legacy supplier categories project into one GNK PO without mutating the sales order or its prices', () => {
  const order = freeze(fullOrder()); const original = JSON.stringify(order);
  const purchase = buildPurchaseOrdersFromSalesOrder(order, recipients());
  assert.equal(purchase.length, 1); assert.equal(purchase[0].supplier_name, 'GNK'); assert.equal(purchase[0].vendor_id, gnkVendorId);
  assert.equal(purchase[0].line_count, 3); assert.equal(purchase[0].lines.length, 3);
  assert.deepEqual(purchase[0].lines.map((row: any) => [row.product_code, row.qty, row.buy_price]), order.lines.map(row => [row.resolvedCode, row.qty, row.buy_price]));
  assert.deepEqual(purchase[0].lines.map((row: any) => row.supplier_name), ['GNK', 'GNK', 'GNK']);
  assert.deepEqual(purchase[0].lines.map((row: any) => row.source_supplier_name), legacyNames);
  const total = order.lines.reduce((sum, row) => sum + Math.round(row.qty * row.buy_price * 100), 0) / 100;
  assert.equal(purchase[0].total_amount, total); assert.equal(JSON.stringify(order), original);
  assert.deepEqual(order.lines.map(row => row.selectedSupplierKey), legacyNames.map(name => `${name}-0`));
});

test('same names cannot merge different resolved vendor identities, and incomplete resolution fails closed', () => {
  const order = fullOrder();
  assert.throws(() => buildPurchaseOrdersFromSalesOrder(order, recipients().slice(0, 2)), /supplier|vendor|recipient|resolution/i);
  assert.throws(() => buildPurchaseOrdersFromSalesOrder(order, [...recipients(), { requested_supplier_name: legacyNames[0], supplier_name: 'Other', vendor_id: otherVendorId }]), /supplier|vendor|recipient|resolution/i);
  const separate = recipients(); separate[1] = { ...separate[1], vendor_id: otherVendorId, supplier_name: 'Another vendor' };
  const orders = buildPurchaseOrdersFromSalesOrder(order, separate);
  assert.equal(orders.length, 2); assert.deepEqual(new Set(orders.map((row: any) => row.vendor_id)), new Set([gnkVendorId, otherVendorId]));
});

test('canonical GNK projection retains all 41 lines, exact quantities and historical unit prices', () => {
  const order = freeze(fullOrder(Array.from({ length: 41 }, (_, index) => line('GNK', index)), 'confirmed'));
  const original = JSON.stringify(order); const purchase = buildPurchaseOrdersFromSalesOrder(order, recipients(['GNK']));
  assert.equal(purchase.length, 1); assert.equal(purchase[0].line_count, 41); assert.equal(purchase[0].vendor_id, gnkVendorId);
  assert.deepEqual(purchase[0].lines.map((row: any) => [row.product_code, row.qty, row.buy_price]), order.lines.map(row => [row.resolvedCode, row.qty, row.buy_price]));
  assert.equal(JSON.stringify(order), original);
});

type Deferred = { promise: Promise<unknown>; resolve: (value: unknown) => void; reject: (reason: Error) => void };
function deferred(): Deferred {
  let resolve!: Deferred['resolve'], reject!: Deferred['reject']; const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function fixture({ order = fullOrder(), missingVendor = false, holdVendor = false, preserved = true }: { order?: ReturnType<typeof fullOrder>; missingVendor?: boolean; holdVendor?: boolean; preserved?: boolean } = {}) {
  const globals = globalThis as any;
  const previous = { window: globals.window, document: globals.document, HTMLElement: globals.HTMLElement, fetch: globals.fetch, fixture: globals[fixtureKey], act: globals.IS_REACT_ACT_ENVIRONMENT };
  const cache = { salesOrdersView: 'detail', workbenchMode: 'existing', selectedLocalSalesOrderId: order.id, quoteNo: order.sales_order_no,
    customerName: order.customer_name, customerSelection: order.customer_name, sellerCompany: order.seller_company, quoteDate: order.quote_date,
    customerType: 'A', currency: 'EUR', buyerInfo: order.buyer_info, supplierMode: 'Best price', quoteBuilderLines: structuredClone(order.lines) };
  const storage = new Map([['next-master-sales-order-workspace', JSON.stringify(cache)]]);
  const store = { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) };
  const timers = new Map<number, () => void>(); let timerId = 0;
  globals.window = Object.assign(new EventTarget(), { localStorage: store, sessionStorage: store,
    setTimeout(callback: () => void) { const id = ++timerId; timers.set(id, callback); return id; }, clearTimeout(id: number) { timers.delete(id); },
    confirm() { throw Error('Unexpected confirmation prompt'); }, prompt() { throw Error('Unexpected prompt'); } });
  globals.document = Object.assign(new EventTarget(), { visibilityState: 'visible' }); globals.HTMLElement = class {};
  globals.fetch = () => { throw Error('Unexpected real network access'); }; globals.IS_REACT_ACT_ENVIRONMENT = true;
  const calls: Array<{ name: string; args: any[] }> = [], saved: any[] = [], purchaseWrites: any[] = [], feedbackEvents: Array<{ kind: string; text: string }> = [];
  const vendorRequest = holdVendor ? deferred() : null;
  let stored = structuredClone(order);
  globals[fixtureKey] = {
    feedback: Object.fromEntries(['begin', 'succeed', 'fail', 'clear'].map(kind => [kind, (text: string) => feedbackEvents.push({ kind, text })])),
    call(name: string, ...args: any[]) {
      calls.push({ name, args });
      if (name === 'resolvePurchaseOrderVendors') {
        if (vendorRequest) return vendorRequest.promise;
        if (missingVendor) return Promise.reject(Error('Vendor was not found: GNK'));
        return Promise.resolve(recipients([...new Set(stored.lines.map(row => row.supplier_name))]));
      }
      if (name === 'callAppRpc') {
        const [rpc, payload] = args;
        if (rpc === 'cloud_sales_order_preserved_supplier_lines') return Promise.resolve({ preserved_indices: preserved ? payload.input_lines.map((_row: unknown, index: number) => index) : [], disabled_indices: [] });
        if (rpc === 'cloud_current_supplier_price_options_batch') return Promise.resolve(payload.input_requests.map((request: any, request_index: number) => {
          const row = stored.lines.find(value => value.resolvedCode === request.code)!;
          return { request_index, has_published_scope: true, options: [{ product_code: request.code, supplier_name: preserved ? 'GNK' : row.supplier_name, supplier_id: row.supplierOptions[0].supplier_id, buy_price: preserved ? 9999 : row.buy_price }] };
        }));
        throw Error(`Unexpected RPC ${rpc}`);
      }
      if (name === 'fetchSalesOrderSummaries') return Promise.resolve([{ ...stored, lines: [] }]);
      if (name === 'fetchSalesOrderById') return Promise.resolve(stored);
      if (name === 'upsertSalesOrder') { stored = structuredClone(args[0]); saved.push(structuredClone(stored)); return Promise.resolve(stored); }
      if (name === 'replacePurchaseOrdersForSalesOrder') {
        if (missingVendor) return Promise.reject(Error('Vendor was not found'));
        purchaseWrites.push(structuredClone(args)); return Promise.resolve(args[1]);
      }
      if (name === 'fetchCompanyProfiles') return Promise.resolve([{ id: 'seller', companyName: 'Synthetic seller' }]);
      if (name === 'fetchCustomers') return Promise.resolve([{ id: 'customer', display_name: 'Synthetic customer', company_name: 'Synthetic customer', price_list_type: 'A' }]);
      if (name === 'findCustomerByNameInList') return args[0].find((row: any) => row.id === args[1] || row.display_name === args[1]) || null;
      if (name === 'findCompanyProfileByName') return args[0].find((row: any) => row.companyName === args[1]) || null;
      if (name === 'buildInventoryAvailabilityLookup') return new Map();
      if (name === 'inventoryAvailabilityLookupKey') return args.join('|');
      if (name === 'fetchCPriceMapForRows') return Promise.resolve(new Map());
      if (name === 'getCPriceForRow') return null;
      if (['fetchPurchaseOrderSalesLinkSummaries', 'fetchInvoiceSalesLinkSummaries', 'fetchSalesOrderBrandSummaries', 'fetchInventoryAvailabilitySummary', 'fetchPriceListSettings', 'fetchCloudQuotes', 'fetchCloudBrands'].includes(name)) return Promise.resolve([]);
      throw Error(`Unexpected API call ${name}`);
    },
  };
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(createElement(QuotesPage, { appRole: 'superadmin' })); });
  return { calls, saved, purchaseWrites, feedbackEvents, vendorRequest,
    async confirm() { const button = renderer.root.findAllByType('button').find(button => content(button) === 'sales.orders.markConfirmed'); assert.ok(button); assert.ok(!button.props.disabled); await act(async () => { button.props.onClick(); }); },
    async resolveVendor(value: unknown) { await act(async () => { vendorRequest!.resolve(value); }); },
    async close() { await act(async () => { renderer.unmount(); }); globals.window = previous.window; globals.document = previous.document; globals.HTMLElement = previous.HTMLElement; globals.fetch = previous.fetch; globals[fixtureKey] = previous.fixture; globals.IS_REACT_ACT_ENVIRONMENT = previous.act; },
  };
}

test('missing vendor fails the actual confirmation before any SO save or PO replacement', async () => {
  const view = await fixture({ missingVendor: true });
  try {
    assert.equal(view.saved.length, 0); await view.confirm();
    assert.ok(view.calls.some(call => call.name === 'resolvePurchaseOrderVendors'));
    assert.equal(view.saved.length, 0, 'a missing recipient must not leave the SO confirmed');
    assert.equal(view.calls.filter(call => call.name === 'replacePurchaseOrdersForSalesOrder').length, 0, 'preflight cannot delete/replace existing PO rows');
    assert.ok(view.feedbackEvents.some(event => event.kind === 'fail' && /Vendor/.test(event.text)));
  } finally { await view.close(); }
});

test('actual confirmation awaits vendor resolution, preserves historic SO lines and projects one canonical GNK PO', async () => {
  const order = fullOrder(); const view = await fixture({ order, holdVendor: true });
  try {
    await view.confirm(); assert.equal(view.saved.length, 0); assert.equal(view.purchaseWrites.length, 0);
    await view.resolveVendor(recipients());
    assert.equal(view.saved.length, 1); assert.equal(view.purchaseWrites.length, 1);
    assert.deepEqual(view.saved[0].lines, order.lines, 'the SO source supplier keys, quantities and prices must stay unchanged');
    const purchase = view.purchaseWrites[0][1]; assert.equal(purchase.length, 1); assert.equal(purchase[0].supplier_name, 'GNK'); assert.equal(purchase[0].vendor_id, gnkVendorId);
    assert.deepEqual(purchase[0].lines.map((row: any) => [row.qty, row.buy_price]), order.lines.map(row => [row.qty, row.buy_price]));
    const resolution = view.calls.findIndex(call => call.name === 'resolvePurchaseOrderVendors'), save = view.calls.findIndex(call => call.name === 'upsertSalesOrder');
    assert.ok(resolution >= 0 && resolution < save);
    assert.ok(view.calls.some(call => call.name === 'callAppRpc' && call.args[0] === 'cloud_sales_order_preserved_supplier_lines'));
    assert.equal(view.calls.filter(call => call.name === 'resolveQuoteLine').length, 0, 'canonical vendor routing must not reprice old order lines');
  } finally { await view.close(); }
});

test('a confirmed order missing POs does nothing automatically and user retry retains all 41 GNK lines', async () => {
  const order = fullOrder(Array.from({ length: 41 }, (_, index) => line('GNK', index)), 'confirmed');
  const view = await fixture({ order, preserved: false });
  try {
    assert.equal(view.saved.length, 0); assert.equal(view.purchaseWrites.length, 0, 'opening an order is not consent to create POs');
    await view.confirm();
    assert.equal(view.saved.length, 1); assert.equal(view.saved[0].status, 'confirmed'); assert.equal(view.purchaseWrites.length, 1);
    assert.deepEqual(view.saved[0].lines, order.lines);
    const purchase = view.purchaseWrites[0][1]; assert.equal(purchase.length, 1); assert.equal(purchase[0].line_count, 41);
    assert.equal(purchase[0].supplier_name, 'GNK'); assert.equal(purchase[0].vendor_id, gnkVendorId);
    assert.deepEqual(purchase[0].lines.map((row: any) => [row.product_code, row.qty, row.buy_price]), order.lines.map(row => [row.resolvedCode, row.qty, row.buy_price]));
  } finally { await view.close(); }
});

test('actual gateway limits recipient lookup to active staff and forwards only the caller JWT to bounded own-org SQL resolution', async () => {
  const globals = globalThis as any, previousFetch = globals.fetch, previousNetlify = globals.Netlify;
  let role = 'admin', active = true;
  const dispatched: Array<{ headers: Headers; payload: unknown }> = [];
  globals.Netlify = { env: { get: (key: string) => ({ SUPABASE_URL: 'https://gnk-gateway.invalid', SUPABASE_ANON_KEY: 'synthetic-anon', SUPABASE_SERVICE_ROLE_KEY: 'synthetic-service' } as Record<string, string>)[key] } };
  globals.fetch = async (input: string, init: RequestInit) => {
    const url = new URL(String(input)); assert.equal(url.origin, 'https://gnk-gateway.invalid');
    if (url.pathname === '/auth/v1/user') return Response.json({ id: 'actor', email: 'actor@example.invalid' });
    if (url.pathname === '/rest/v1/profiles') return Response.json([{ organization_id: 'synthetic-org', role, department: 'viewer', permissions: {}, is_active: active }]);
    if (url.pathname === '/rest/v1/staff_office_access') return Response.json([]);
    assert.equal(url.pathname, '/rest/v1/rpc/resolve_purchase_order_vendors');
    const headers = new Headers(init.headers), payload = JSON.parse(String(init.body));
    assert.equal(headers.get('Authorization'), 'Bearer synthetic-caller-session'); assert.equal(headers.get('apikey'), 'synthetic-anon');
    dispatched.push({ headers, payload }); return Response.json(recipients(['GNK-Diesel']));
  };
  const request = (names: unknown) => new Request('https://portal.example.invalid/api/app-rpc', { method: 'POST', headers: { Authorization: 'Bearer synthetic-caller-session', 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'resolve_purchase_order_vendors', args: { input_suppliers: names } }) });
  try {
    role = 'viewer'; assert.equal((await rpcHandler(request(['GNK-Diesel']), {} as any)).status, 403); assert.equal(dispatched.length, 0);
    role = 'admin'; active = false; assert.ok([401, 403].includes((await rpcHandler(request(['GNK-Diesel']), {} as any)).status)); assert.equal(dispatched.length, 0);
    active = true;
    for (const names of [[], [''], ['GNK', 'gnk'], ['x'.repeat(181)], Array.from({ length: 101 }, (_, index) => `supplier-${index}`)]) {
      assert.equal((await rpcHandler(request(names), {} as any)).status, 400); assert.equal(dispatched.length, 0);
    }
    const response = await rpcHandler(request(['GNK-Diesel']), {} as any);
    assert.equal(response.status, 200); assert.equal(dispatched.length, 1);
    assert.deepEqual(dispatched[0].payload, { input_suppliers: ['GNK-Diesel'] });
    assert.deepEqual((await response.json()).data, recipients(['GNK-Diesel']));
  } finally { globals.fetch = previousFetch; globals.Netlify = previousNetlify; }
});
