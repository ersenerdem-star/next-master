import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, Fragment } from 'react';
import { create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Exercise the actual alert, messaging API/read event and conversation page.
// Only browser portal placement, translations, auth and network I/O are local
// substitutes. No test can send a request to a real customer or portal session.
const temporary = await mkdtemp(resolve('node_modules/.message-notification-test-'));
const output = resolve(temporary, 'components.mjs');
await build({
  stdin: { contents: `
    export {PersistentMessageAlert} from './apps/web/src/presentation/components/common/PersistentMessageAlert.tsx';
    export {CustomerMessagesPage} from './apps/web/src/presentation/pages/CustomerMessagesPage.tsx';
    export {notifyMessageRead,CUSTOMER_MESSAGES_READ} from './apps/web/src/infrastructure/api/customerMessagesApi.ts';
  `, resolveDir: process.cwd(), loader: 'tsx' },
  outfile: output, bundle: true, platform: 'node', format: 'esm', jsx: 'automatic', packages: 'external',
  plugins: [{ name: 'local-message-browser-and-auth', setup(builder) {
    builder.onResolve({ filter: /^react-dom$/ }, () => ({ path: 'portal', namespace: 'fixture' }));
    builder.onResolve({ filter: /supabaseClient$/ }, () => ({ path: 'auth', namespace: 'fixture' }));
    builder.onResolve({ filter: /I18nProvider$/ }, () => ({ path: 'i18n', namespace: 'fixture' }));
    builder.onResolve({ filter: /InterfaceText$/ }, () => ({ path: 'interface', namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ loader: 'js', contents:
      path === 'portal' ? `export const createPortal=children=>children;` :
      path === 'auth' ? `export const supabaseClient={auth:{getSession:async()=>({data:{session:{access_token:'synthetic-test-session'}},error:null})}};` :
      path === 'i18n' ? `export const useI18n=()=>({locale:'tr',t:x=>x});` :
      `export const useInterfaceText=()=>x=>x; export const InterfaceText=({text})=>text;`
    }));
  } }],
});
const { PersistentMessageAlert, CustomerMessagesPage, notifyMessageRead, CUSTOMER_MESSAGES_READ } = await import(pathToFileURL(output).href);
after(async () => { await rm(temporary, { recursive: true, force: true }); });

type Deferred = { promise: Promise<unknown>; resolve: (value: unknown) => void; reject: (reason: Error) => void };
function deferred(): Deferred {
  let resolve!: Deferred['resolve'], reject!: Deferred['reject'];
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
type Summary = { totalUnread: number; conversations: Array<{ customer_id: string; customer_name: string; unread_count: number }> };
const summary = (count: number, customerId = 'customer-a'): Summary => ({
  totalUnread: count,
  conversations: count ? [{ customer_id: customerId, customer_name: 'Synthetic customer', unread_count: count }] : [],
});
function content(node: ReactTestInstance | string): string {
  return typeof node === 'string' ? node : node.children.map(child => content(child)).join('');
}
class TrackedTarget extends EventTarget {
  listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  override addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: AddEventListenerOptions | boolean) {
    if (listener) { const listeners = this.listeners.get(type) || new Set(); listeners.add(listener); this.listeners.set(type, listeners); }
    super.addEventListener(type, listener, options);
  }
  override removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: EventListenerOptions | boolean) {
    if (listener) this.listeners.get(type)?.delete(listener);
    super.removeEventListener(type, listener, options);
  }
  listenerCount() { return [...this.listeners.values()].reduce((total, listeners) => total + listeners.size, 0); }
}
type Call = { portal: boolean; action: string; payload: Record<string, any>; signal?: AbortSignal; headers: Record<string, string> };
type ViewProps = { portal: boolean; scopeKey: string; showAlert: boolean; showChat: boolean };
async function fixture({ portal = false, initialUnread = summary(2), initialFailure = false }: { portal?: boolean; initialUnread?: Summary; initialFailure?: boolean } = {}) {
  const globals = globalThis as any;
  const previous = { window: globals.window, document: globals.document, fetch: globals.fetch, act: globals.IS_REACT_ACT_ENVIRONMENT };
  const timers = new Map<number, { callback: () => void; delay: number }>();
  let timerId = 0;
  const browser = Object.assign(new TrackedTarget(), {
    setInterval(callback: () => void, delay: number) { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearInterval(id: number) { timers.delete(id); }, setTimeout, clearTimeout,
  });
  const document = Object.assign(new TrackedTarget(), { visibilityState: 'visible', body: {} });
  globals.window = browser; globals.document = document; globals.IS_REACT_ACT_ENVIRONMENT = true;
  let unread: unknown = initialUnread;
  let failInitial = initialFailure;
  const calls: Call[] = [];
  const waiting: Array<{ action: string; request: Deferred }> = [];
  globals.fetch = async (url: string, init: RequestInit) => {
    assert.ok(url === '/api/portal-messages' || url === '/api/customer-messages', `Unexpected non-local message URL: ${url}`);
    assert.equal(init.method, 'POST'); assert.equal(init.credentials, 'same-origin'); assert.equal(init.cache, 'no-store');
    const requestPortal = url === '/api/portal-messages';
    const payload = JSON.parse(String(init.body));
    const headers = init.headers as Record<string, string>;
    assert.equal(headers.Authorization, requestPortal ? undefined : 'Bearer synthetic-test-session');
    calls.push({ portal: requestPortal, action: payload.action, payload, signal: init.signal || undefined, headers });
    const index = waiting.findIndex(item => item.action === payload.action);
    let data: unknown;
    if (index >= 0) data = await waiting.splice(index, 1)[0].request.promise;
    else if (payload.action === 'unread') {
      if (failInitial) { failInitial = false; throw Error('Synthetic initial network failure'); }
      data = unread;
    } else if (payload.action === 'inbox') data = {
      customers: [{ id: 'customer-a', name: 'Synthetic customer' }],
      conversations: [{ customer_id: 'customer-a', customer_name: 'Synthetic customer', last_message_at: '2026-11-06T12:00:00Z', unread_count: 2 }],
    };
    else if (payload.action === 'list') data = { messages: [{
      id: 'message-a', sender_kind: requestPortal ? 'admin' : 'customer', sender_name: 'Synthetic sender',
      body: 'Synthetic incoming message', created_at: '2026-11-06T12:00:00Z', read_at: null,
    }], next: null };
    else if (payload.action === 'read') data = {};
    else throw Error(`Unexpected message action: ${payload.action}`);
    return { ok: true, status: 200, json: async () => data };
  };
  const opened: Array<string | undefined> = [];
  let props: ViewProps = { portal, scopeKey: 'session-a', showAlert: true, showChat: false };
  const conversation = { customerId: 'customer-a', requestId: 1 };
  function Harness(properties: ViewProps) {
    return createElement(Fragment, null,
      properties.showAlert ? createElement(PersistentMessageAlert, { portal: properties.portal, scopeKey: properties.scopeKey, onOpenMessages: (id?: string) => opened.push(id) }) : null,
      properties.showChat ? createElement(CustomerMessagesPage, { portal: properties.portal, openConversation: conversation }) : null,
    );
  }
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(createElement(Harness, props)); });
  let unmounted = false;
  return {
    renderer, calls, opened, browser, document, timers,
    alerts: () => renderer.root.findAllByType('aside').filter(node => String(node.props.className).includes('persistent-message-alert')),
    text: () => content(renderer.root),
    countCalls: (action = 'unread') => calls.filter(call => call.action === action).length,
    setUnread(data: unknown) { unread = data; },
    hold(action = 'unread') { const request = deferred(); waiting.push({ action, request }); return request; },
    async resolve(request: Deferred, data: unknown) { await act(async () => { request.resolve(data); }); },
    async reject(request: Deferred) { await act(async () => { request.reject(Error('Synthetic network failure')); }); },
    async poll() { await act(async () => { for (const { callback, delay } of [...timers.values()]) { assert.equal(delay, 15000); callback(); } }); },
    async focus() { await act(async () => { browser.dispatchEvent(new Event('focus')); }); },
    async visible(visible: boolean) { await act(async () => { document.visibilityState = visible ? 'visible' : 'hidden'; document.dispatchEvent(new Event('visibilitychange')); }); },
    async readEvent(eventPortal = portal) { await act(async () => { notifyMessageRead(eventPortal); }); },
    async click(label: string) {
      const button = renderer.root.findAllByType('button').find(button => content(button) === label);
      assert.ok(button, `Missing rendered button: ${label}`); assert.ok(!button.props.disabled);
      await act(async () => { button.props.onClick(); });
    },
    async update(changes: Partial<ViewProps>) { props = { ...props, ...changes }; await act(async () => { renderer.update(createElement(Harness, props)); }); },
    async unmount() { await act(async () => { renderer.unmount(); }); unmounted = true; },
    async close() {
      if (!unmounted) await act(async () => { renderer.unmount(); });
      globals.window = previous.window; globals.document = previous.document; globals.fetch = previous.fetch; globals.IS_REACT_ACT_ENVIRONMENT = previous.act;
    },
  };
}

for (const portal of [false, true]) {
  const mode = portal ? 'customer portal' : 'admin';
  test(`${mode}: unread alert persists across navigation, polling and network failure; only confirmed zero clears it`, async () => {
    const view = await fixture({ portal });
    try {
      assert.equal(view.alerts().length, 1); assert.match(view.text(), /2 okunmamış mesaj/);
      assert.equal(view.calls[0].portal, portal);
      assert.equal(view.renderer.root.findAllByType('button').length, 1, 'there must be no dismiss button');
      await view.click('Mesajlara git'); assert.deepEqual(view.opened, ['customer-a']);
      assert.equal(view.alerts().length, 1, 'opening the messages must not acknowledge unread messages');
      assert.equal(view.countCalls('read'), 0, 'the notification cannot send a read receipt');
      await view.poll(); assert.equal(view.alerts().length, 1, 'a timer must not auto-dismiss the alert');
      view.setUnread(summary(5)); await view.poll(); assert.match(view.text(), /5 okunmamış mesaj/);
      const failed = view.hold(); await view.focus(); await view.reject(failed);
      assert.match(view.text(), /5 okunmamış mesaj/, 'temporary refresh failure must retain confirmed unread');
      const count = view.countCalls(); await view.readEvent(!portal);
      assert.equal(view.countCalls(), count, 'another portal mode must not refresh this alert');
      view.setUnread(summary(0)); await view.readEvent();
      assert.equal(view.alerts().length, 0, 'successful read-event refresh with zero unread clears the alert');
      view.setUnread(summary(1)); await view.focus(); assert.match(view.text(), /1 okunmamış mesaj/);
    } finally { await view.close(); }
  });

  test(`${mode}: actual conversation emits read acknowledgement only after the receipt succeeds`, async () => {
    const view = await fixture({ portal });
    try {
      let readEvents = 0;
      view.browser.addEventListener(CUSTOMER_MESSAGES_READ, () => { readEvents += 1; });
      const failedRead = view.hold('read'); await view.update({ showChat: true });
      assert.match(view.text(), /Synthetic incoming message/);
      assert.equal(view.countCalls('read'), 1);
      const receipt = view.calls.find(call => call.action === 'read')!;
      assert.equal(receipt.portal, portal);
      assert.deepEqual(receipt.payload.through, { createdAt: '2026-11-06T12:00:00Z', id: 'message-a' });
      assert.equal(view.alerts().length, 1); assert.equal(readEvents, 0, 'listing messages alone must not acknowledge receipt');
      await view.reject(failedRead);
      assert.equal(readEvents, 0); assert.equal(view.alerts().length, 1, 'failed receipt leaves the unread alert visible');
      const successfulRead = view.hold('read'); await view.click('Yenile');
      view.setUnread(summary(0)); await view.resolve(successfulRead, {});
      assert.equal(readEvents, 1); assert.equal(view.alerts().length, 0, 'confirmed receipt refreshes the shell unread count');
      assert.match(view.text(), /Synthetic incoming message/, 'receipt handling must preserve the delivered conversation');
    } finally { await view.close(); }
  });
}

test('a delayed older-message page cannot send a read receipt after its conversation unmounts', async () => {
  const view = await fixture({ portal: true });
  try {
    const initial = view.hold('list'); await view.update({ showChat: true });
    const message = { id: 'message-current', sender_kind: 'admin', sender_name: 'Synthetic sender',
      body: 'Current message', created_at: '2026-11-06T12:00:00Z', read_at: null };
    const cursor = { createdAt: message.created_at, id: message.id };
    await view.resolve(initial, { messages: [message], next: cursor });
    assert.equal(view.countCalls('read'), 1, 'the current visible page is acknowledged normally');
    const older = view.hold('list'); await view.click('Önceki mesajlar');
    assert.deepEqual(view.calls.filter(call => call.action === 'list').at(-1)?.payload.before, cursor);
    let readEvents = 0;
    view.browser.addEventListener(CUSTOMER_MESSAGES_READ, () => { readEvents += 1; });
    await view.update({ showChat: false });
    view.setUnread(summary(0));
    await view.resolve(older, { messages: [{ ...message, id: 'message-older', body: 'Older message', created_at: '2026-11-05T12:00:00Z' }], next: null });
    assert.equal(view.countCalls('read'), 1, 'late older-page I/O must not acknowledge a conversation no longer on screen');
    assert.equal(readEvents, 0, 'an unmounted conversation must not announce a read receipt');
    assert.equal(view.alerts().length, 1, 'late conversation I/O must not clear the unread shell alert');
  } finally { await view.close(); }
});

test('initial failure and invalid unread responses never invent or clear a confirmed count', async () => {
  const view = await fixture({ initialFailure: true });
  try {
    assert.equal(view.alerts().length, 0);
    await view.focus(); assert.match(view.text(), /2 okunmamış mesaj/);
    for (const malformed of [{ totalUnread: -1, conversations: [] }, { totalUnread: 1.5, conversations: [] }, { totalUnread: 0, conversations: null }]) {
      view.setUnread(malformed); await view.poll(); assert.match(view.text(), /2 okunmamış mesaj/);
    }
    view.setUnread(summary(0)); await view.poll(); assert.equal(view.alerts().length, 0);
  } finally { await view.close(); }
});

test('background polling pauses while hidden and visibility/focus refresh the current unread count', async () => {
  const view = await fixture();
  try {
    await view.visible(false); const before = view.countCalls();
    view.setUnread(summary(4)); await view.poll(); await view.focus();
    assert.equal(view.countCalls(), before); assert.match(view.text(), /2 okunmamış mesaj/);
    await view.visible(true); assert.equal(view.countCalls(), before + 1); assert.match(view.text(), /4 okunmamış mesaj/);
  } finally { await view.close(); }
});

test('session changes clear prior unread state, abort old I/O and ignore late responses', async () => {
  const view = await fixture();
  try {
    const old = view.hold(); await view.poll(); const oldCall = view.calls.at(-1)!;
    const next = view.hold(); await view.update({ scopeKey: 'session-b' });
    assert.equal(oldCall.signal?.aborted, true); assert.equal(view.alerts().length, 0, 'old session count must be hidden immediately');
    await view.resolve(old, summary(99, 'old-customer')); assert.equal(view.alerts().length, 0);
    await view.resolve(next, summary(3, 'new-customer')); assert.match(view.text(), /3 okunmamış mesaj/);
    await view.click('Mesajlara git'); assert.deepEqual(view.opened, ['new-customer']);
    assert.equal(view.timers.size, 1, 'scope reset must replace, rather than multiply, polling timers');
  } finally { await view.close(); }
});

test('read event replaces stale in-flight refresh, and unmount removes polls/listeners and aborts pending I/O', async () => {
  const view = await fixture();
  try {
    const stale = view.hold(); await view.poll(); const staleCall = view.calls.at(-1)!;
    const current = view.hold(); await view.readEvent(); assert.equal(staleCall.signal?.aborted, true);
    await view.resolve(current, summary(0)); assert.equal(view.alerts().length, 0);
    await view.resolve(stale, summary(50)); assert.equal(view.alerts().length, 0, 'late pre-read response must not restore a cleared alert');
    const pending = view.hold(); await view.focus(); const pendingCall = view.calls.at(-1)!;
    await view.unmount(); assert.equal(pendingCall.signal?.aborted, true);
    assert.equal(view.timers.size, 0); assert.equal(view.browser.listenerCount(), 0); assert.equal(view.document.listenerCount(), 0);
    const calls = view.countCalls(); await view.readEvent(); await view.focus(); await view.poll(); await view.resolve(pending, summary(7));
    assert.equal(view.countCalls(), calls); assert.equal(view.renderer.toJSON(), null);
  } finally { await view.close(); }
});
