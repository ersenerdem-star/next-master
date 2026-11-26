import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement } from 'react';
import { create } from 'react-test-renderer';
import { build } from 'esbuild';
import { readFile, rm } from 'node:fs/promises';
import { resolve, basename } from 'node:path';
import { pathToFileURL } from 'node:url';

const globals = globalThis as any;
let consumed = false;
const events: any[] = [];
let resolveOrders: (rows: any[]) => void = () => {};
globals.IS_REACT_ACT_ENVIRONMENT = true;
globals.window = Object.assign(new EventTarget(), {
  localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  sessionStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
  setTimeout, clearTimeout, confirm: () => false,
});
globals.document = Object.assign(new EventTarget(), { visibilityState: 'visible' });
globals.HTMLElement = class {};
globals.__poAudit = {
  feedback: Object.fromEntries(['begin', 'succeed', 'fail', 'clear'].map(k => [k, (v: any) => events.push([k, v])])),
  call(name: string, ...args: any[]) {
    if (name === 'fetchPurchaseOrderSummaries') return new Promise((resolve) => { resolveOrders = resolve; });
    if (name === 'buildInventoryAvailabilityLookup') return new Map();
    if (name === 'inventoryAvailabilityLookupKey') return args.join('|');
    if (name.startsWith('fetch')) return Promise.resolve([]);
    return null;
  },
  consume() { if (consumed) return null; consumed = true; return { product_code: 'AUDIT-CODE-123', brand: 'Synthetic', description: 'Synthetic product' }; },
};
const output = resolve('scripts/tests/.purchase-catalog-transfer-fixture.mjs');
after(async () => { await rm(output, { force: true }); });
await build({
  stdin: { contents: `export {PurchasesPage} from './apps/web/src/presentation/pages/PurchasesPage.tsx';`, resolveDir: process.cwd(), loader: 'tsx' },
  outfile: output, bundle: true, platform: 'node', format: 'esm', jsx: 'automatic', packages: 'external',
  plugins: [{ name: 'mockio', setup(builder) {
    builder.onResolve({ filter: /infrastructure\/api\// }, args => ({ path: basename(args.path), namespace: 'api' }));
    builder.onLoad({ filter: /.*/, namespace: 'api' }, async ({ path }) => {
      const source = await readFile(resolve('apps/web/src/infrastructure/api', `${path}.ts`), 'utf8');
      const names = [...source.matchAll(/export\s+(?:async\s+)?(?:function|const|class)\s+(\w+)/g)].map(m => m[1]);
      for (const match of source.matchAll(/export\s*\{([^}]+)\}/g)) names.push(...match[1].split(',').map(name => name.trim().split(/\s+as\s+/).at(-1)!).filter(name => /^[A-Za-z_]\w*$/.test(name)));
      return { loader: 'js', contents: [...new Set(names)].map(n => `export const ${n}=(...args)=>globalThis.__poAudit.call(${JSON.stringify(n)},...args);`).join('\n') };
    });
    builder.onResolve({ filter: /I18nProvider$/ }, () => ({ path: 'i18n', namespace: 'fixture' }));
    builder.onResolve({ filter: /common\/ActionFeedback$/ }, () => ({ path: 'feedback', namespace: 'fixture' }));
    builder.onResolve({ filter: /shared\/catalogTransfer$/ }, () => ({ path: 'transfer', namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ loader: 'js', contents:
      path === 'i18n' ? `export const useI18n=()=>({locale:'tr',t:(key,params)=>key+(params?JSON.stringify(params):'')}); export const useInterfaceLocale=()=>({locale:'tr'});` :
      path === 'feedback' ? `export const useActionFeedback=()=>globalThis.__poAudit.feedback;` :
      `export const PENDING_CATALOG_PURCHASE_ITEM_KEY='x';export const consumeCatalogTransfer=()=>globalThis.__poAudit.consume();`
    }));
  }}],
});
const { PurchasesPage } = await import(pathToFileURL(output).href);
test('catalog purchase draft survives initial loading and late purchase order list', async () => {
  let rendered: any;
  await act(async () => { rendered = create(createElement(PurchasesPage, { activeTab: 'Purchase Orders' })); await Promise.resolve(); });
  const output = JSON.stringify(rendered.toJSON());
  assert.equal(events.some(([k,v]) => k === 'succeed' && String(v).includes('productAddedToPurchaseDraft')), true);
  assert.equal(output.includes('AUDIT-CODE-123'), true);
  await act(async () => { resolveOrders([{ id: 'other-po', lines: [], status: 'draft', currency: 'EUR' }]); await Promise.resolve(); });
  assert.equal(JSON.stringify(rendered.toJSON()).includes('AUDIT-CODE-123'), true);
  await act(async () => rendered.unmount());
});
