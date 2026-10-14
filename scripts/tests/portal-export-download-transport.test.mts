import assert from "node:assert/strict";
import { test } from "node:test";
import { downloadUrl } from "../../apps/web/src/shared/xlsx.ts";
import { dismissPreparedDownload } from "../../apps/web/src/shared/preparedDownload.ts";

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
    clearTimeout: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
  } as unknown as Window & typeof globalThis;
  globalThis.document = {
    documentElement: { lang: "en" },
    createElement: (tag: string) => {
      return {
        href: "", download: "", rel: "", style: {},
        click() { if (tag === "a") clicks.push({ href: this.href, name: this.download }); },
        remove() {}, append() {}, setAttribute() {}, addEventListener() {},
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
    dismissPreparedDownload();
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
    assert.equal(blobs[0].type, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
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

test("admin signed Storage URLs verify the full workbook before saving", async () => {
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
    const downloading = downloadUrl("admin.xlsx", signedUrl, undefined, workbook.byteLength);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(clicks.length, 0);
    finishTransfer();
    await downloading;
    assert.deepEqual(clicks, [{ href: `blob:${site}/1`, name: "admin.xlsx" }]);
    assert.deepEqual(new Uint8Array(await blobs[0].arrayBuffer()), workbook);
  });
});

test("admin signed Storage URL rejects incomplete transfers before saving", async () => {
  await withBrowserMocks(async ({ clicks, setFetch }) => {
    setFetch(async () => new Response(workbook.slice(0, 4), {
      status: 200, headers: { "Content-Length": "8" },
    }));
    await assert.rejects(downloadUrl("admin.xlsx", signedUrl, undefined, workbook.byteLength), /incomplete/);
    assert.equal(clicks.length, 0);
  });
});

test("signed CSV exports do not require an XLSX container signature", async () => {
  await withBrowserMocks(async ({ clicks, blobs, setFetch }) => {
    const csv = new TextEncoder().encode("Product_Code,Brand\nABC-1,Bosch\n");
    setFetch(async () => new Response(csv, {
      status: 200, headers: { "Content-Length": String(csv.byteLength) },
    }));
    await downloadUrl("catalog.csv", signedUrl, undefined, csv.byteLength);
    assert.deepEqual(clicks, [{ href: `blob:${site}/1`, name: "catalog.csv" }]);
    assert.equal(blobs[0].type, "text/csv;charset=utf-8");
    assert.deepEqual(new Uint8Array(await blobs[0].arrayBuffer()), csv);
  });
});

test("signed CSV exports reject incomplete transfers with a neutral export error", async () => {
  await withBrowserMocks(async ({ clicks, blobs, setFetch }) => {
    const csv = new TextEncoder().encode("Product_Code,Brand\nABC-1,Bosch\n");
    setFetch(async () => new Response(csv.slice(0, csv.byteLength - 2), {
      status: 200, headers: { "Content-Length": String(csv.byteLength) },
    }));
    await assert.rejects(downloadUrl("catalog.csv", signedUrl, undefined, csv.byteLength), /Export download was incomplete/);
    assert.equal(clicks.length, 0);
    assert.equal(blobs.length, 0);
  });
});

test("multipart download fetches three pieces sequentially and saves the exact assembled workbook", async () => {
  await withBrowserMocks(async ({ clicks, blobs, setFetch }) => {
    const pieces = [workbook.slice(0, 2), workbook.slice(2, 5), workbook.slice(5)];
    const parts = pieces.map((piece, index) => ({ signedUrl: signedUrl.replace("file.xlsx", `part-${index + 1}`), byteSize: piece.byteLength }));
    const requests: string[] = [];
    let finishFirst!: () => void;
    setFetch(async (input) => {
      const index = requests.length;
      requests.push(String(input));
      assert.equal(input, parts[index].signedUrl);
      const body = index === 0 ? new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(pieces[0].slice(0, 1));
          finishFirst = () => { controller.enqueue(pieces[0].slice(1)); controller.close(); };
        },
      }) : pieces[index];
      return new Response(body, { status: 200, headers: { "Content-Length": String(pieces[index].byteLength) } });
    });
    const downloading = downloadUrl("master.xlsx", parts[0].signedUrl, undefined, workbook.byteLength, parts);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(requests.length, 1);
    assert.equal(clicks.length, 0);
    finishFirst();
    await downloading;
    assert.deepEqual(requests, parts.map((part) => part.signedUrl));
    assert.deepEqual(clicks, [{ href: `blob:${site}/1`, name: "master.xlsx" }]);
    assert.equal(blobs[0].size, workbook.byteLength);
    assert.deepEqual(new Uint8Array(await blobs[0].arrayBuffer()), workbook);
  });
});

test("multipart download never saves or fetches later pieces after an incomplete part", async () => {
  await withBrowserMocks(async ({ clicks, blobs, setFetch }) => {
    const pieces = [workbook.slice(0, 2), workbook.slice(2, 5), workbook.slice(5)];
    const parts = pieces.map((piece, index) => ({ signedUrl: signedUrl.replace("file.xlsx", `part-${index + 1}`), byteSize: piece.byteLength }));
    let requests = 0;
    setFetch(async () => {
      const index = requests++;
      return new Response(index === 1 ? pieces[index].slice(0, 2) : pieces[index], {
        status: 200, headers: { "Content-Length": String(pieces[index].byteLength) },
      });
    });
    await assert.rejects(downloadUrl("master.xlsx", parts[0].signedUrl, undefined, workbook.byteLength, parts), /incomplete/);
    assert.equal(requests, 2);
    assert.equal(clicks.length, 0);
    assert.equal(blobs.length, 0);
  });
});

test("multipart download rejects a wrong total or different Storage origin before fetching", async () => {
  await withBrowserMocks(async ({ clicks, setFetch }) => {
    const parts = [
      { signedUrl, byteSize: 4 },
      { signedUrl: signedUrl.replace("file.xlsx", "part-2"), byteSize: 4 },
    ];
    let requests = 0;
    setFetch(async () => { requests += 1; throw new Error("Fetch must not start"); });
    await assert.rejects(downloadUrl("master.xlsx", signedUrl, undefined, 9, parts), /complete file size/);
    await assert.rejects(downloadUrl("master.xlsx", signedUrl, undefined, 8, [
      parts[0], { ...parts[1], signedUrl: parts[1].signedUrl.replace("storage.example.test", "other.example.test") },
    ]), /parts are invalid/);
    assert.equal(requests, 0);
    assert.equal(clicks.length, 0);
  });
});
