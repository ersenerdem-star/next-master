// Local-only UI fixture: actual application components, synthetic identity/data.
// No Supabase/Netlify connection, credentials, upload, publication or business write.
import { build } from "esbuild";
import { createServer } from "node:http";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, sep, extname } from "node:path";

if (!process.argv.includes("--local-only")) throw new Error("Explicit --local-only required");
const root = resolve(new URL("../..", import.meta.url).pathname);
const output = await mkdtemp(resolve(tmpdir(), "nm-workspace-preview-"));
const port = 4188;
const identity = { userId: "b0000000-0000-4000-8000-000000000010", email: "local-review@example.invalid", organizationId: "b0000000-0000-4000-8000-000000000001", role: "superadmin", department: "management", permissions: {}, customerScopeMode: "all" };
const session = { access_token: "local-synthetic-token", user: { id: identity.userId, email: identity.email } };
const mockClient = `
const session=${JSON.stringify(session)};
const releases=[{id:'40000000-0000-4000-8000-000000000001',brand_id:'40000000-0000-4000-8000-000000000002',supplier_id:'40000000-0000-4000-8000-000000000003',brands:{name:'Synthetic brand'},suppliers:{name:'Synthetic supplier'},status:'staged',created_at:'2026-10-15T08:00:00Z',updated_at:'2026-10-15T08:00:00Z',total_rows:10,processed_rows:10,accepted_rows:9,rejected_rows:1,warning_rows:0,conflict_rows:0,error_code:null,error_message:null,brand_identity_audit:{policy:'cross-brand-v1',checked:true,review_required:false,selected_brand_id:'40000000-0000-4000-8000-000000000002',distinct_incoming_codes:9,brands:[]}}];
function chain(table){return new Proxy({}, {get(_target,key){
  if(key==='then')return (resolve)=>resolve({data:table==='supplier_price_releases'?releases:table==='supplier_price_release_rows'?[{id:1,source_row_number:4,product_code:'LOCAL-INVALID',buy_price:null,row_status:'rejected',error_code:'INVALID_BUY_PRICE',error_message:'Synthetic invalid price row'}]:[],error:null,count:0});
  if(['insert','update','delete','upsert'].includes(key))return ()=>Promise.reject(new Error('Local preview blocks business writes'));
  return ()=>chain(table);
}});}
export const supabaseClient={auth:{getSession:async()=>({data:{session},error:null}),getUser:async()=>({data:{user:session.user},error:null}),onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}}),signOut:async()=>({error:null})},from:(table)=>chain(table),rpc:async()=>({data:[],error:null})};`;
const meta = { appId: "shared", appVersion: "0.1.0", buildVersion: "local-controlled-integration", gitSha: "local", environment: "local", context: "local", branch: "codex/price-engine-integration", builtAt: new Date().toISOString(), apiContractVersion: "2026-06-30" };
await build({
  absWorkingDir: root, entryPoints: ["apps/web/src/main.tsx"], bundle: true, outdir: output,
  entryNames: "app", format: "esm", platform: "browser", jsx: "automatic", sourcemap: false,
  define: { "process.env.NODE_ENV": '"development"', "import.meta.env": JSON.stringify({ MODE: "development", DEV: true, PROD: false, VITE_COMMERCIAL_DOCUMENT_UPGRADE_ENABLED: "true", VITE_SUPPLIER_RELEASE_REVIEW_ENABLED: "true" }), __APP_BUILD_META__: JSON.stringify(meta) },
  plugins: [{ name: "local-read-only-client", setup(build) {
    build.onLoad({ filter: /\/supabaseClient\.ts$/ }, () => ({ contents: mockClient, loader: "ts" }));
    build.onResolve({ filter: /^\// }, (args) => args.kind === "url-token" ? { path: args.path, external: true } : undefined);
  } }],
});
const mime = { ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml", ".woff2": "font/woff2" };
createServer(async (req, res) => {
  const path = new URL(req.url, `http://127.0.0.1:${port}`).pathname;
  const json = (value, status = 200) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
  if (path === "/version.json") return json(meta);
  if (path === "/api/app-session") return json({ ok: true, user: session.user, profile: { organization_id: identity.organizationId, role: identity.role, department: identity.department, permissions: {} } });
  if (path === "/api/app-rpc" && req.method === "POST") {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const { name } = JSON.parse(raw || "{}");
    if (["reporting_customer_balance_by_brand_product", "reporting_supplier_balance_by_brand_product"].includes(name)) return json({ ok: true, data: [
      { id: "local-eur", party_name: "Synthetic account", customer_name: "Synthetic customer", supplier_name: "Synthetic supplier", currency: "EUR", debit_amount: 12.34, credit_amount: 2, balance_amount: 10.34, line_count: 1 },
      { id: "local-usd", party_name: "Synthetic account", customer_name: "Synthetic customer", supplier_name: "Synthetic supplier", currency: "USD", debit_amount: 25, credit_amount: 0, balance_amount: 25, line_count: 1 },
    ] });
    if (name === "list_cloud_suppliers") return json({ok:true,data:[{supplier_id:"40000000-0000-4000-8000-000000000003",name:"Synthetic supplier",is_active:true}]});
    if (["cloud_supplier_price_commercial_page_v3","cloud_supplier_brand_summary"].includes(name)) return json({ok:true,data:[]});
    if (name === "get_latest_supplier_price_rollup_refresh_run") return json({ok:true,data:null});
    if (String(name).startsWith("reporting_")) return json({ ok: true, data: [] });
    return json({ error: "Local preview blocks this operation." }, 403);
  }
  if (path === "/api/app-admin-records" && req.method === "POST") {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || "{}");
    return body.action === "list" ? json({ok:true,data:[]}) : json({error:"Local preview blocks writes."},403);
  }
  if (path.startsWith("/api/")) return json({ error: "Local preview has no remote runtime." }, 403);
  if (req.method !== "GET") return json({ error: "Read-only fixture." }, 405);
  if (path === "/" || path === "/portal") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Local integration fixture</title><link rel="stylesheet" href="/app.css"></head><body><div style="position:fixed;bottom:0;right:0;z-index:99999;background:#fff1b8;padding:6px;font:12px sans-serif">LOCAL UI FIXTURE — synthetic account and data; remote operations blocked</div><div id="root"></div><script type="module" src="/app.js"></script></body></html>');
  }
  const base = path === "/app.js" || path === "/app.css" ? output : resolve(root, "apps/web/public");
  const file = resolve(base, `.${path}`);
  if (!file.startsWith(base + sep)) { res.writeHead(403); return res.end(); }
  try { const data = await readFile(file); res.writeHead(200, { "Content-Type": mime[extname(file)] || "application/octet-stream" }); res.end(data); }
  catch { res.writeHead(404); res.end(); }
}).listen(port, "127.0.0.1", () => console.log(`Local synthetic UI fixture: http://127.0.0.1:${port}`));
