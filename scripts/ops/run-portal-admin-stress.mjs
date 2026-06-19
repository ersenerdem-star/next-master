import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../..");

function getArg(name, fallback = "") {
  const prefix = `--${name}=`;
  const arg = process.argv.find((value) => String(value || "").startsWith(prefix));
  const raw = arg ? String(arg).slice(prefix.length) : "";
  return raw || fallback;
}

function getNumberArg(name, fallback) {
  const value = Number(getArg(name, String(fallback)));
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}

function pickBaseUrl() {
  return (
    getArg("base-url") ||
    String(process.env.APP_BASE_URL || "").trim() ||
    String(process.env.SITE_URL || "").trim() ||
    "http://localhost:8888"
  ).replace(/\/+$/, "");
}

async function fetchWithTimeout(url, init = {}, timeoutMs = 30000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
  const started = performance.now();
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
    });
    const elapsedMs = Math.round(performance.now() - started);
    return { response, elapsedMs };
  } finally {
    clearTimeout(timeout);
  }
}

function parseCookieHeader(setCookieValue) {
  if (!setCookieValue) return "";
  return String(setCookieValue).split(";")[0] || "";
}

async function runCase(baseUrl, spec, sharedHeaders, timeoutMs) {
  const url = `${baseUrl}${spec.path}`;
  const method = spec.method || "GET";
  const headers = new Headers(sharedHeaders);
  const body = spec.body ? JSON.stringify(spec.body) : undefined;
  if (body) headers.set("content-type", "application/json");
  const { response, elapsedMs } = await fetchWithTimeout(
    url,
    {
      method,
      headers,
      body,
    },
    timeoutMs,
  );
  const text = await response.text().catch(() => "");
  return {
    name: spec.name,
    path: spec.path,
    method,
    status: response.status,
    ok: response.ok,
    elapsedMs,
    bytes: text.length,
    sample: text.slice(0, 160),
  };
}

async function loginPortal(baseUrl, email, password, timeoutMs) {
  if (!email || !password) return { cookie: "" };
  const { response } = await fetchWithTimeout(
    `${baseUrl}/api/portal-login`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    },
    timeoutMs,
  );
  const cookie = parseCookieHeader(response.headers.get("set-cookie"));
  return { cookie };
}

const baseUrl = pickBaseUrl();
const timeoutMs = getNumberArg("timeout-ms", 30000);
const concurrency = getNumberArg("concurrency", 4);
const rounds = getNumberArg("rounds", 2);
const portalEmail = getArg("portal-email") || String(process.env.PORTAL_EMAIL || "").trim();
const portalPassword = getArg("portal-password") || String(process.env.PORTAL_PASSWORD || "").trim();
const adminCookie = getArg("admin-cookie") || String(process.env.ADMIN_COOKIE || "").trim();
const adminAuthorization = getArg("admin-auth") || String(process.env.ADMIN_AUTH || "").trim();
const selectedModulesRaw = getArg("modules") || String(process.env.STRESS_MODULES || "").trim();
const selectedModules = selectedModulesRaw
  ? new Set(
      selectedModulesRaw
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    )
  : null;
const includeWarehouse =
  getArg("include-warehouse", "false") === "true" ||
  process.env.INCLUDE_WAREHOUSE === "true" ||
  (selectedModules ? selectedModules.has("warehouse") : false);
const warehouseApiKey = getArg("warehouse-api-key") || String(process.env.WAREHOUSE_API_KEY || "").trim();

const portalSession = await loginPortal(baseUrl, portalEmail, portalPassword, timeoutMs).catch((error) => {
  console.warn(JSON.stringify({ scope: "portal-login", status: "error", message: error instanceof Error ? error.message : String(error) }));
  return { cookie: "" };
});

const portalHeaders = new Headers();
if (portalSession.cookie) portalHeaders.set("cookie", portalSession.cookie);

const adminHeaders = new Headers();
if (adminCookie) adminHeaders.set("cookie", adminCookie);
if (adminAuthorization) adminHeaders.set("authorization", adminAuthorization.startsWith("Bearer ") ? adminAuthorization : `Bearer ${adminAuthorization}`);

const cases = [
  { module: "app", name: "app-root", method: "GET", path: "/", expectedStatuses: [200] },
  { module: "portal", name: "portal-route", method: "GET", path: "/portal", expectedStatuses: [200] },
  { module: "portal", name: "portal-branding", method: "POST", path: "/api/portal-branding", body: { email: portalEmail || "stress@example.com" }, expectedStatuses: portalEmail ? [200, 400, 401, 429] : [400, 401, 429] },
  { module: "portal", name: "portal-data", method: "POST", path: "/api/portal-data", body: { email: portalEmail || "stress@example.com" }, expectedStatuses: portalSession.cookie ? [200, 401, 429] : [400, 401, 429] },
  { module: "portal", name: "portal-price-list", method: "POST", path: "/api/portal-price-list", body: { email: portalEmail || "stress@example.com" }, expectedStatuses: portalSession.cookie ? [200, 400, 401, 429] : [400, 401, 429] },
  { module: "portal", name: "portal-order-prepare", method: "POST", path: "/api/portal-order-prepare", body: { email: portalEmail || "stress@example.com", rows: [{ code: "TEST", brand: "", qty: 1 }] }, expectedStatuses: portalSession.cookie ? [200, 400, 401, 429] : [400, 401, 429] },
  { module: "portal", name: "portal-order-submit", method: "POST", path: "/api/portal-order-submit", body: { email: portalEmail || "stress@example.com", rows: [], mode: "draft" }, expectedStatuses: portalSession.cookie ? [200, 400, 401, 429] : [400, 401, 429] },
  { module: "admin", name: "admin-session", method: "GET", path: "/api/app-session", expectedStatuses: adminAuthorization ? [200, 401, 403] : [401, 403] },
  { module: "admin", name: "admin-diagnostics", method: "POST", path: "/api/admin-diagnostics", body: { testEmail: "" }, expectedStatuses: adminAuthorization || adminCookie ? [200, 401, 403] : [401, 403] },
  { module: "admin", name: "admin-test-email", method: "POST", path: "/api/admin-test-email", body: { email: portalEmail || "stress@example.com" }, expectedStatuses: adminAuthorization || adminCookie ? [200, 400, 401, 403] : [401, 403] },
];

if (includeWarehouse) {
  cases.push(
    {
      module: "warehouse",
      name: "warehouse-stock-feed",
      method: "GET",
      path: "/api/warehouse-stock-feed",
      expectedStatuses: warehouseApiKey ? [200, 400, 401, 403] : [401, 403],
    },
    {
      module: "warehouse",
      name: "warehouse-order-submit",
      method: "POST",
      path: "/api/warehouse-order-submit",
      body: { external_order_id: `stress-${Date.now()}`, lines: [] },
      expectedStatuses: warehouseApiKey ? [200, 400, 401, 403] : [401, 403],
    },
  );
}

const filteredCases = selectedModules ? cases.filter((spec) => selectedModules.has(String(spec.module || "").trim())) : cases;

function headersForCase(spec) {
  if (spec.name === "app-root" || spec.name === "portal-route") return new Headers();
  if (spec.name.startsWith("portal-")) return portalHeaders;
  if (spec.name.startsWith("warehouse-")) {
    const headers = new Headers();
    if (warehouseApiKey) headers.set("x-api-key", warehouseApiKey);
    return headers;
  }
  if (spec.name.startsWith("admin-")) return adminHeaders;
  return new Headers();
}

const startedAt = new Date().toISOString();
const results = [];

for (let round = 1; round <= rounds; round += 1) {
  const queue = [...filteredCases];
  const active = new Set();
  const next = async () => {
    const spec = queue.shift();
    if (!spec) return;
    const task = runCase(baseUrl, spec, headersForCase(spec), timeoutMs)
      .then((result) => {
        const expectedStatuses = spec.expectedStatuses || [200];
        const securityExpected = expectedStatuses.includes(result.status);
        const routeFailure = result.status === 0 || result.status === 404 || result.status === 502 || result.status === 504;
        const enriched = { round, module: spec.module || "unknown", expected: securityExpected, routeFailure, ...result };
        results.push(enriched);
        console.log(JSON.stringify(enriched));
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        const failed = {
          round,
          name: spec.name,
          path: spec.path,
          method: spec.method || "GET",
          status: 0,
          ok: false,
          elapsedMs: timeoutMs,
          bytes: 0,
          sample: message.slice(0, 160),
        };
        const enriched = { module: spec.module || "unknown", expected: false, routeFailure: true, ...failed };
        results.push(enriched);
        console.log(JSON.stringify(enriched));
      })
      .finally(() => active.delete(task));
    active.add(task);
  };

  while (queue.length || active.size) {
    while (queue.length && active.size < concurrency) {
      await next();
    }
    if (active.size) {
      await Promise.race(active);
    }
  }
}

const finishedAt = new Date().toISOString();
const durations = results.map((item) => Number(item.elapsedMs || 0)).filter((value) => Number.isFinite(value) && value >= 0);
const sortedDurations = [...durations].sort((a, b) => a - b);
const p95Index = Math.max(0, Math.min(sortedDurations.length - 1, Math.ceil(sortedDurations.length * 0.95) - 1));
const report = {
  startedAt,
  finishedAt,
  baseUrl,
  rounds,
  concurrency,
  timeoutMs,
  totalRequests: results.length,
  okRequests: results.filter((item) => item.ok).length,
  errorRequests: results.filter((item) => !item.ok).length,
  expectedResponses: results.filter((item) => item.expected).length,
  routeFailures: results.filter((item) => item.routeFailure).length,
  byModule: results.reduce((accumulator, item) => {
    const key = item.module || "unknown";
    accumulator[key] ||= { total: 0, ok: 0, expected: 0, routeFailures: 0, maxMs: 0 };
    accumulator[key].total += 1;
    if (item.ok) accumulator[key].ok += 1;
    if (item.expected) accumulator[key].expected += 1;
    if (item.routeFailure) accumulator[key].routeFailures += 1;
    accumulator[key].maxMs = Math.max(accumulator[key].maxMs, Number(item.elapsedMs || 0));
    return accumulator;
  }, {}),
  averageMs: durations.length ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) : 0,
  maxMs: sortedDurations.length ? sortedDurations[sortedDurations.length - 1] : 0,
  p95Ms: sortedDurations.length ? sortedDurations[p95Index] : 0,
  results,
};

const outDir = path.join(repoRoot, "docs", "performance");
mkdirSync(outDir, { recursive: true });
const stamp = finishedAt.replaceAll(":", "-").replaceAll(".", "-");
const outPath = path.join(outDir, `portal-admin-stress-${stamp}.json`);
writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ report: outPath, totalRequests: report.totalRequests, okRequests: report.okRequests, errorRequests: report.errorRequests, expectedResponses: report.expectedResponses, routeFailures: report.routeFailures, averageMs: report.averageMs, p95Ms: report.p95Ms }));
if (report.routeFailures > 0) {
  process.exitCode = 1;
}
