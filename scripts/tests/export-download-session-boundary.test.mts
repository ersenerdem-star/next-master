import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

// Bundle the real client API with only Auth transport replaced. Both API and
// session cleanup share the same actual helper instance, just as in the app.
const bundled = await build({
  stdin: { contents: `export * from './apps/web/src/infrastructure/api/exportJobsApi.ts'; export {clearPreparedDownloads} from './apps/web/src/shared/preparedDownload.ts';`,
    resolveDir: fileURLToPath(new URL("../../", import.meta.url)), loader: "ts" },
  bundle: true, write: false, format: "esm", platform: "node", logLevel: "silent",
  plugins: [{ name: "synthetic-auth-only", setup(b) {
    b.onResolve({ filter: /^\.\/supabaseClient$/ }, () => ({ path: "auth", namespace: "fixture" }));
    b.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: `export const supabaseClient={auth:{async getSession(){return {data:{session:{access_token:'synthetic'}}}}}};`, loader: "js" }));
  } }],
});
const api = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`);

async function run(body: (state: { setFetch: (f: typeof fetch) => void; timers: Array<() => void>; created: () => number }) => Promise<void>) {
  const previous = { fetch: globalThis.fetch, window: globalThis.window, document: globalThis.document, create: URL.createObjectURL };
  const timers: Array<() => void> = []; let created = 0;
  globalThis.window = { location: new URL("https://example.test"), setTimeout(fn: () => void) { timers.push(fn); return timers.length; }, clearTimeout() {} } as any;
  globalThis.document = { createElement() { throw Error("No save UI should be created after logout"); } } as any;
  URL.createObjectURL = () => { created += 1; return "blob:unexpected"; };
  try { await body({ setFetch: f => { globalThis.fetch = f; }, timers, created: () => created }); }
  finally { api.clearPreparedDownloads(); Object.assign(globalThis, { fetch: previous.fetch, window: previous.window, document: previous.document }); URL.createObjectURL = previous.create; }
}

test("logout during admin export preparation rejects the real start response", async () => run(async ({ setFetch, created }) => {
  let finish!: (r: Response) => void;
  setFetch(async input => { assert.equal(input, "/api/admin-export-start"); return new Promise(resolve => { finish = resolve; }); });
  const preparing = api.startAdminPriceListExport({ brandId: "brand", brandName: "Geba", priceListType: "B", marginPercent: 0.15 });
  await new Promise(resolve => setImmediate(resolve)); api.clearPreparedDownloads();
  finish(Response.json({ job: { id: "job", status: "finalized" } }));
  await assert.rejects(preparing, /session changed/); assert.equal(created(), 0);
}));

test("logout while a background export is queued stops polling before any new request", async () => run(async ({ setFetch, timers, created }) => {
  let requests = 0; setFetch(async () => { requests += 1; throw Error("Must not poll after logout"); });
  const waiting = api.waitForExportJob({ id: "job", status: "queued" });
  assert.equal(timers.length, 1); api.clearPreparedDownloads(); timers[0]();
  await assert.rejects(waiting, /session changed/); assert.equal(requests, 0); assert.equal(created(), 0);
}));

test("logout during real download-job metadata fetch never fetches Storage or creates a URL", async () => run(async ({ setFetch, created }) => {
  let finish!: (r: Response) => void; const requests: string[] = [];
  setFetch(async input => { requests.push(String(input)); return new Promise(resolve => { finish = resolve; }); });
  const downloading = api.downloadExportJob("job");
  await new Promise(resolve => setImmediate(resolve)); api.clearPreparedDownloads();
  finish(Response.json({ signedUrl: "https://storage.example.test/storage/v1/object/sign/file?token=synthetic", fileName: "B.xlsx", byteSize: 8 }));
  await assert.rejects(downloading, /session changed/);
  assert.deepEqual(requests, ["/api/admin-export-download"]); assert.equal(created(), 0);
}));
