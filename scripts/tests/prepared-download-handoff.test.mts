import assert from "node:assert/strict";
import test from "node:test";
import { clearPreparedDownloads, dismissPreparedDownload, offerPreparedDownload } from "../../apps/web/src/shared/preparedDownload.ts";
import { logoutPortalSession } from "../../apps/web/src/infrastructure/api/portalAccessApi.ts";
import { enMessages } from "../../apps/web/src/i18n/locales/en.ts";
import { trMessages } from "../../apps/web/src/i18n/locales/tr.ts";

async function browser(run: (state: any) => void | Promise<void>) {
  const originals = { window: globalThis.window, document: globalThis.document, fetch: globalThis.fetch,
    create: URL.createObjectURL, revoke: URL.revokeObjectURL, now: Date.now };
  let clock = 0, nextTimer = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const events = new Map<string, () => void>();
  const panels: any[] = [], blobs: Blob[] = [], revoked: string[] = [], clicks: any[] = [];
  class Element {
    tag: string; style = {}; attrs: any = {}; children: Element[] = []; listeners: any = {};
    href = ""; download = ""; textContent = ""; removed = false;
    constructor(tag: string) { this.tag = tag; }
    setAttribute(key: string, value: string) { this.attrs[key] = value; }
    append(...nodes: Element[]) { this.children.push(...nodes); }
    remove() { this.removed = true; }
    addEventListener(type: string, fn: () => void) { this.listeners[type] = fn; }
    click() {
      this.listeners.click?.();
      if (this.tag === "a") clicks.push({ href: this.href, download: this.download });
    }
  }
  globalThis.window = {
    setTimeout(fn: () => void, delay: number) { timers.set(++nextTimer, { at: clock + delay, fn }); return nextTimer; },
    clearTimeout(id: number) { timers.delete(id); },
    addEventListener(type: string, fn: () => void) { events.set(type, fn); },
    removeEventListener(type: string) { events.delete(type); },
  } as any;
  globalThis.document = {
    documentElement: { lang: "en" },
    createElement: (tag: string) => new Element(tag),
    body: { appendChild: (panel: Element) => panels.push(panel) },
  } as any;
  globalThis.fetch = async () => { throw new Error("Saving a prepared file must not refetch"); };
  Date.now = () => clock;
  URL.createObjectURL = (blob: Blob) => { blobs.push(blob); return `blob:test/${blobs.length}`; };
  URL.revokeObjectURL = (url: string) => { revoked.push(url); };
  const advance = (ms: number) => {
    const end = clock + ms;
    while (true) {
      const entry = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!entry) break;
      clock = entry[1].at; timers.delete(entry[0]); entry[1].fn();
    }
    clock = end;
  };
  try { await run({ panels, blobs, revoked, clicks, advance, events }); }
  finally {
    dismissPreparedDownload(); advance(30_000);
    globalThis.window = originals.window; globalThis.document = originals.document; globalThis.fetch = originals.fetch;
    URL.createObjectURL = originals.create; URL.revokeObjectURL = originals.revoke; Date.now = originals.now;
  }
}

test("blocked automatic handoff leaves an accessible direct save link to the same prepared bytes", async () => {
  await browser(({ panels, blobs, clicks, revoked }) => {
    const file = new Blob(["verified-file"]);
    offerPreparedDownload("Geba-B.xlsx", file);
    assert.equal(clicks.length, 1, "Only one automatic attempt");
    const panel = panels[0], link = panel.children.find((x: any) => x.tag === "a");
    assert.equal(panel.attrs.role, "status"); assert.equal(panel.attrs["aria-live"], "polite");
    assert.equal(link.href, "blob:test/1"); assert.equal(link.download, "Geba-B.xlsx");
    assert.equal(link.textContent, "Download again");
    assert.equal(panel.removed, false); assert.deepEqual(revoked, []);
    link.click(); // Simulates a later user gesture. Native default navigation is preserved.
    assert.equal(clicks.length, 2); assert.equal(blobs.length, 1); assert.equal(blobs[0], file);
    assert.deepEqual(clicks[0], clicks[1]);
  });
});

test("actual portal logout clears current and retired links before its network request", async () => {
  await browser(async ({ panels, revoked, advance }) => {
    offerPreparedDownload("A.xlsx", new Blob(["a"]));
    offerPreparedDownload("B.xlsx", new Blob(["b"]));
    globalThis.fetch = async (url) => {
      assert.equal(url, "/api/portal-logout");
      assert.ok(panels.every((x: any) => x.removed));
      assert.deepEqual(revoked, ["blob:test/1", "blob:test/2"]);
      return new Response(null, { status: 204 });
    };
    await logoutPortalSession();
    advance(330_000);
    assert.equal(revoked.length, 2);
  });
});

test("pagehide and explicit session cleanup revoke links without the dismissal grace period", async () => {
  await browser(({ panels, revoked, events, advance }) => {
    offerPreparedDownload("A.xlsx", new Blob(["a"]));
    events.get("pagehide")!();
    assert.equal(panels[0].removed, true); assert.deepEqual(revoked, ["blob:test/1"]);
    assert.equal(events.has("pagehide"), false);
    offerPreparedDownload("B.xlsx", new Blob(["b"]));
    clearPreparedDownloads();
    assert.equal(panels[1].removed, true); assert.deepEqual(revoked, ["blob:test/1", "blob:test/2"]);
    advance(330_000); assert.equal(revoked.length, 2);
  });
});

test("dismissal releases a file after the minimum handoff window, including a late retry", async () => {
  await browser(({ panels, revoked, advance }) => {
    offerPreparedDownload("Geba-B.xlsx", new Blob(["file"]));
    advance(299_000);
    panels[0].children.find((x: any) => x.tag === "a").click();
    panels[0].children.find((x: any) => x.tag === "button").click();
    assert.equal(panels[0].removed, true); assert.deepEqual(revoked, []);
    advance(29_999); assert.deepEqual(revoked, []);
    advance(1); assert.deepEqual(revoked, ["blob:test/1"]);
    advance(300_000); assert.deepEqual(revoked, ["blob:test/1"], "Revoke exactly once");
  });
});

test("only the latest file stays visible and five-minute expiry releases it", async () => {
  await browser(({ panels, revoked, clicks, advance }) => {
    offerPreparedDownload("A.xlsx", new Blob(["a"]));
    advance(1_000);
    offerPreparedDownload("B.xlsx", new Blob(["b"]));
    assert.equal(panels[0].removed, true); assert.equal(panels[1].removed, false);
    assert.equal(clicks.length, 2, "Replacing a card does not retry either file");
    advance(29_000); assert.deepEqual(revoked, ["blob:test/1"]);
    advance(271_000); assert.equal(panels[1].removed, true);
    assert.deepEqual(revoked, ["blob:test/1", "blob:test/2"]);
  });
});

test("Turkish fallback is keyboard-accessible and filenames remain plain text", async () => {
  await browser(({ panels }) => {
    document.documentElement.lang = "tr";
    offerPreparedDownload("<script>alert(1)</script>.xlsx", new Blob(["file"]));
    const panel = panels[0], link = panel.children.find((x: any) => x.tag === "a");
    assert.equal(panel.children[1].textContent, "<script>alert(1)</script>.xlsx");
    assert.equal(link.textContent, "İndirme başlamadıysa indir");
    assert.equal(panel.children.find((x: any) => x.tag === "button").textContent, "Kapat");
    assert.ok(link.href && link.download, "Native anchor supports keyboard activation without custom key handlers");
  });
});

test("price-list feedback describes the handoff rather than claiming a saved file", () => {
  assert.match(enMessages.sales["priceLists.downloaded"], /Download started.*Download again/);
  assert.doesNotMatch(enMessages.sales["priceLists.downloaded"], /price list downloaded/);
  assert.match(trMessages.sales["priceLists.downloaded"], /başlatıldı/);
  assert.doesNotMatch(trMessages.sales["priceLists.downloaded"], /indirildi/);
});
