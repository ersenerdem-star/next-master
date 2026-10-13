import assert from "node:assert/strict";
import { test } from "node:test";
import { downloadUrl } from "../../apps/web/src/shared/xlsx.ts";

const site = "https://next-master-v3-staging-20261006.netlify.app";
const fallbackUrl = "/api/portal-export-file?jobId=job-1";
const signedUrl = "https://storage.example.test/storage/v1/object/sign/price/file.xlsx?token=secret";
const workbook = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]);

async function withBrowserMocks(run: (state: {
  clicks: Array<{ href: string; name: string }>;
  blobs: Blob[];
  setFetch: (fetcher: typeof fetch) => void;
}) => Promise<void>) {
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const originalFetch = globalThis.fetch;
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  const clicks: Array<{ href: string; name: string }> = [];
  const blobs: Blob[] = [];
  globalThis.window = {
    location: new URL(`${site}/portal`),
    setTimeout: () => 0,
  } as unknown as Window & typeof globalThis;
  globalThis.document = {
    createElement: (tag: string) => {
      assert.equal(tag, "a");
      return {
        href: "", download: "", rel: "",
        click() { clicks.push({ href: this.href, name: this.download }); },
        remove() {},
      };
    },
    body: { appendChild() {} },
  } as unknown as Document;
  URL.createObjectURL = (blob: Blob) => {
    blobs.push(blob);
    return `blob:${site}/${blobs.length}`;
  };
  URL.revokeObjectURL = () => {};
  try {
    await run({ clicks, blobs, setFetch: (fetcher) => { globalThis.fetch = fetcher; } });
  } finally {
    globalThis.window = originalWindow;
    globalThis.document = originalDocument;
    globalThis.fetch = originalFetch;
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
  }
}

test("portal download waits for the complete signed Storage workbook before clicking the link", async () => {
  await withBrowserMocks(async ({ clicks, blobs, setFetch }) => {
    let finishTransfer!: () => void;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(workbook.slice(0, 4));
        finishTransfer = () => { controller.enqueue(workbook.slice(4)); controller.close(); };
      },
    });
    setFetch(async (url, options) => {
      assert.equal(url, signedUrl);
      assert.equal(options?.credentials, "omit");
      assert.equal(options?.cache, "no-store");
      assert.equal(options?.redirect, "error");
      assert.equal(options?.mode, "cors");
      return new Response(body, { status: 200, headers: { "Content-Length": "8" } });
    });
    const downloading = downloadUrl("price-list.xlsx", signedUrl, fallbackUrl, workbook.byteLength);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(clicks.length, 0);
    finishTransfer();
    await downloading;
    assert.deepEqual(clicks, [{ href: `blob:${site}/1`, name: "price-list.xlsx" }]);
    assert.deepEqual(new Uint8Array(await blobs[0].arrayBuffer()), workbook);
  });
});

test("portal HTTP errors and incomplete transfers never trigger a download", async () => {
  await withBrowserMocks(async ({ clicks, setFetch }) => {
    setFetch(async () => new Response("expired", { status: 401 }));
    await assert.rejects(downloadUrl("price-list.xlsx", signedUrl, fallbackUrl, 8), /HTTP 401/);
    assert.equal(clicks.length, 0);

    setFetch(async () => new Response(workbook.slice(0, 4), {
      status: 200, headers: { "Content-Length": "8" },
    }));
    await assert.rejects(downloadUrl("price-list.xlsx", signedUrl, fallbackUrl, 8), /incomplete/);
    assert.equal(clicks.length, 0);
  });
});

test("portal rejects oversized or invalid workbook responses before saving", async () => {
  await withBrowserMocks(async ({ clicks, setFetch }) => {
    setFetch(async () => new Response(workbook, {
      status: 200, headers: { "Content-Length": String(128 * 1024 * 1024 + 1) },
    }));
    await assert.rejects(downloadUrl("price-list.xlsx", signedUrl, fallbackUrl), /too large/);

    setFetch(async () => new Response(new TextEncoder().encode("not xlsx"), {
      status: 200, headers: { "Content-Length": "8" },
    }));
    await assert.rejects(downloadUrl("price-list.xlsx", signedUrl, fallbackUrl, 8), /invalid workbook/);
    assert.equal(clicks.length, 0);
  });
});

test("admin signed Storage URLs retain direct browser streaming", async () => {
  await withBrowserMocks(async ({ clicks, blobs, setFetch }) => {
    setFetch(async () => { throw new Error("admin download must not use fetch"); });
    await downloadUrl("admin.xlsx", signedUrl);
    assert.deepEqual(clicks, [{ href: signedUrl, name: "admin.xlsx" }]);
    assert.equal(blobs.length, 0);
  });
});
