import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement } from 'react';
import { create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

// Render the real page and the real feedback provider. Only remote I/O,
// translations and downloads are replaced; React effects/state are genuine.
const temporary = await mkdtemp(resolve('node_modules/.portal-pagination-test-'));
const output = resolve(temporary, 'component.mjs');
const fixtureKey = '__portalAccessPaginationTest';
// Optional diagnostic: prove this regression suite fails against a prior page
// without editing the active worktree or using a real portal session.
const baseline = process.env.PORTAL_ACCESS_TEST_BASELINE_REV;
if (baseline && !/^[0-9a-f]{7,40}$/.test(baseline)) throw Error('Invalid baseline revision');
await build({
  stdin: { contents: `export {PortalAccessReportPage} from './apps/web/src/presentation/pages/PortalAccessReportPage.tsx';
    export {ActionFeedbackProvider} from './apps/web/src/presentation/components/common/ActionFeedback.tsx';`, resolveDir: process.cwd(), loader: 'tsx' },
  outfile: output, bundle: true, platform: 'node', format: 'esm', jsx: 'automatic', packages: 'external',
  plugins: [{ name: 'local-only-page-io', setup(builder) {
    if (baseline) builder.onLoad({ filter: /PortalAccessReportPage\.tsx$/ }, () => ({ loader: 'tsx', contents:
      execFileSync('git', ['show', `${baseline}:apps/web/src/presentation/pages/PortalAccessReportPage.tsx`], { encoding: 'utf8' }),
    }));
    builder.onResolve({ filter: /portalAccessReportApi$/ }, () => ({ path: 'api', namespace: 'fixture' }));
    builder.onResolve({ filter: /I18nProvider$/ }, () => ({ path: 'i18n', namespace: 'fixture' }));
    builder.onResolve({ filter: /InterfaceText$/ }, () => ({ path: 'interface', namespace: 'fixture' }));
    builder.onResolve({ filter: /shared\/xlsx$/ }, () => ({ path: 'xlsx', namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ loader: 'js', contents:
      path === 'api' ? `export const fetchPortalAccessReport=(...args)=>globalThis.${fixtureKey}.fetch(...args);
        export const fetchPortalAccessExport=()=>{throw Error('Unexpected export in pagination fixture')};` :
      path === 'i18n' ? `export const useI18n=()=>({locale:'tr',t:x=>x});` :
      path === 'interface' ? `export const useInterfaceText=()=>x=>x; export const InterfaceText=({text})=>text;` :
      `export const buildXlsxBlobAsync=()=>{throw Error('Unexpected download')}; export const downloadBlob=()=>{};`
    }));
  } }],
});
const { PortalAccessReportPage, ActionFeedbackProvider } = await import(pathToFileURL(output).href);
after(async () => { await rm(temporary, { recursive: true, force: true }); });

type Pending = { promise: Promise<unknown>; resolve: (value: unknown) => void; reject: (reason: Error) => void };
function pending(): Pending {
  let resolve!: Pending['resolve'], reject!: Pending['reject'];
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const report = (page: number) => ({
  page, pageSize: 50, total: 120, asOf: '2026-11-06T12:00:00.000Z', parties: [], countries: [],
  rows: Array.from({ length: page === 3 ? 20 : 50 }, (_, index) => ({
    id: `${page}-${index}`, created_at: '2026-11-06T10:00:00Z', party_name: 'Synthetic customer',
    email: 'test@example.invalid', event_type: 'portal_login', status: 'ok', country_code: 'TR',
    ip_address: '192.0.2.1', reason: null, is_legacy: false,
  })),
});
function content(node: ReactTestInstance | string): string {
  return typeof node === 'string' ? node : node.children.map(child => content(child)).join('');
}
function Harness({ visible = true }: { visible?: boolean }) {
  return createElement(ActionFeedbackProvider, null, visible ? createElement(PortalAccessReportPage) : null);
}
async function fixture() {
  const previous = { window: (globalThis as any).window, act: (globalThis as any).IS_REACT_ACT_ENVIRONMENT, io: (globalThis as any)[fixtureKey] };
  (globalThis as any).window = { setTimeout, clearTimeout };
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const calls: Array<{ page: number; asOf?: string }> = [];
  const queue: Array<Pending> = [];
  (globalThis as any)[fixtureKey] = { fetch: (_filters: unknown, page: number, _size: number, asOf?: string) => {
    calls.push({ page, asOf });
    return queue.shift()?.promise || Promise.resolve(report(page));
  } };
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(createElement(Harness)); });
  const findButton = (label: string) => renderer.root.findAllByType('button').find(button => content(button) === label);
  return {
    renderer, calls,
    progress: () => renderer.root.findAll(node => typeof node.props.className === 'string' && node.props.className.split(' ').includes('action-feedback--progress')).length,
    success: () => renderer.root.findAll(node => typeof node.props.className === 'string' && node.props.className.split(' ').includes('action-feedback--success')).length,
    text: () => content(renderer.root),
    hold() { const request = pending(); queue.push(request); return request; },
    async click(label: string) {
      const button = findButton(label); assert.ok(button, `Missing actual rendered button: ${label}`); assert.equal(button.props.disabled, false);
      await act(async () => { button.props.onClick(); });
    },
    async resolve(request: Pending, page: number) { await act(async () => { request.resolve(report(page)); }); },
    async reject(request: Pending) { await act(async () => { request.reject(new Error('PORTAL_ACCESS_LOAD_FAILED')); }); },
    async hide() { await act(async () => { renderer.update(createElement(Harness, { visible: false })); }); },
    async close() {
      await act(async () => { renderer.unmount(); });
      (globalThis as any).window = previous.window;
      (globalThis as any).IS_REACT_ACT_ENVIRONMENT = previous.act;
      (globalThis as any)[fixtureKey] = previous.io;
    },
  };
}

test('initial page2 and previous-page actions finish the actual blocking feedback without requiring a refresh', async () => {
  const view = await fixture();
  try {
    assert.equal(view.progress(), 0, 'initial automatic load must not create a blocking action');
    assert.equal(view.success(), 0, 'initial automatic load must not create an unsolicited success notification');
    assert.match(view.text(), /Sayfa 1 \/ 3/);
    const next = view.hold(); await view.click('Sonraki');
    assert.equal(view.progress(), 1); assert.match(view.text(), /2\. sayfa yükleniyor/);
    await view.resolve(next, 2);
    assert.equal(view.progress(), 0, 'successful initial page2 must end progress even with refresh counter0');
    assert.equal(view.success(), 1, 'successful page action must display completed feedback');
    assert.match(view.text(), /Sayfa 2 \/ 3/);
    const previous = view.hold(); await view.click('Önceki'); assert.equal(view.progress(), 1);
    await view.resolve(previous, 1); assert.equal(view.progress(), 0); assert.match(view.text(), /Sayfa 1 \/ 3/);
    assert.deepEqual(view.calls.map(call => call.page), [1, 2, 1]);
    assert.equal(view.calls[1].asOf, view.calls[2].asOf, 'pagination must retain the server anchor');
  } finally { await view.close(); }
});

test('refresh and failed pagination both settle the feedback and restore controls', async () => {
  const view = await fixture();
  try {
    const refresh = view.hold(); await view.click('Yenile'); assert.equal(view.progress(), 1);
    await view.resolve(refresh, 1); assert.equal(view.progress(), 0);
    assert.equal(view.calls.at(-1)?.asOf, undefined, 'refresh must obtain a new snapshot');
    const failed = view.hold(); await view.click('Sonraki'); assert.equal(view.progress(), 1);
    await view.reject(failed); assert.equal(view.progress(), 0);
    assert.match(view.text(), /Portal giriş\/çıkış kayıtları alınamadı/);
    const retry = view.hold(); await view.click('Yenile');
    await view.resolve(retry, 1); assert.equal(view.progress(), 0); assert.match(view.text(), /Sayfa 1 \/ 3/);
  } finally { await view.close(); }
});

test('leaving the page clears pending global feedback and ignores its late response', async () => {
  const view = await fixture();
  try {
    const next = view.hold(); await view.click('Sonraki'); assert.equal(view.progress(), 1);
    await view.hide(); assert.equal(view.progress(), 0, 'feedback provider stays mounted when the report page leaves');
    await view.resolve(next, 2); assert.equal(view.progress(), 0);
    assert.doesNotMatch(view.text(), /kayıt bulundu|2\. sayfa yükleniyor/);
  } finally { await view.close(); }
});
