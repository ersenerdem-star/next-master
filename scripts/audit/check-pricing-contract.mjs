import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), "../..");

const files = {
  frontendPolicy: "apps/web/src/shared/catalog/pricingPolicy.ts",
  serverPolicy: "netlify/functions/_shared/pricing/pricing-policy.mts",
  portalOrders: "netlify/functions/_shared/portal/portal-orders.mts",
  appRpc: "netlify/functions/app-rpc.mts",
  supplierImportApi: "apps/web/src/infrastructure/api/importApi.ts",
  supplierImportSql: "supabase/migrations/20260608_51_dedupe_supplier_price_import.sql",
};

function read(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

const source = Object.fromEntries(Object.entries(files).map(([key, file]) => [key, read(file)]));
const findings = [];

function requireToken(fileKey, token, message) {
  if (!source[fileKey].includes(token)) {
    findings.push({
      severity: "critical",
      file: files[fileKey],
      message,
      missing: token,
    });
  }
}

function forbidToken(fileKey, token, message) {
  if (source[fileKey].includes(token)) {
    findings.push({
      severity: "critical",
      file: files[fileKey],
      message,
      forbidden: token,
    });
  }
}

requireToken("frontendPolicy", "shouldUseCPriceForCustomer", "Frontend sales-order pricing must use the shared C-price policy.");
requireToken("frontendPolicy", "normalizeQuoteCustomerTypeForRpc", "Frontend quote resolver must normalize customer type before RPC.");
requireToken("frontendPolicy", "normalizeSupplierQuoteCustomerType", "Frontend supplier fallback must be explicit for A/B pricing.");

requireToken("serverPolicy", "shouldUseCPriceForCustomer", "Server pricing policy must expose the same C-price decision.");
requireToken("serverPolicy", "normalizeCustomerPricingType", "Server RPC and portal paths must normalize customer type.");
requireToken("serverPolicy", "getSupplierFallbackCustomerType", "Server supplier fallback must be explicit for A/B pricing.");

requireToken("portalOrders", "../pricing/pricing-policy.mts", "Portal order and price-list logic must import the shared server pricing policy.");
requireToken("portalOrders", "shouldOverlayCPriceWhereAvailable", "Portal price-list overlay must use a named C-price availability gate.");
requireToken("portalOrders", "shouldUsePortalCPrice", "Portal order preparation must use a named C-price availability gate.");
forbidToken("portalOrders", "function normalizePortalCustomerType", "Portal orders must not redefine customer type normalization.");
forbidToken("portalOrders", "function prefersCPriceWhereAvailable", "Portal orders must not redefine C-price preference logic.");
forbidToken("portalOrders", "function portalSupplierFallbackCustomerType", "Portal orders must not redefine supplier fallback pricing.");

requireToken("appRpc", "./_shared/pricing/pricing-policy.mts", "Quote import RPC must import the shared server pricing policy.");
requireToken("appRpc", "normalizeCustomerPricingType(String(args.input_customer_type", "Quote import RPC must normalize input customer type.");
requireToken("appRpc", "shouldUseCPriceForCustomer(customerType, \"standard\")", "Quote import RPC must use the shared C-price decision.");
requireToken("appRpc", "getSupplierFallbackCustomerType(customerType)", "Quote import RPC must use shared supplier fallback pricing.");

requireToken("supplierImportApi", "dedupeSupplierImportRows", "Supplier price imports must dedupe client-side chunks before RPC.");
requireToken("supplierImportApi", "byConflictKey", "Supplier price imports must dedupe by supplier and row identity.");
requireToken("supplierImportSql", "on conflict (organization_id, supplier_id, brand_id, normalized_code, valid_from) do update", "Supplier import SQL must be idempotent.");
requireToken("supplierImportSql", "'deduped_rows'", "Supplier import SQL must report deduped row counts.");

const summary = {
  checkedAt: new Date().toISOString(),
  gate: "pricing-contract",
  critical: findings.filter((item) => item.severity === "critical").length,
  warning: findings.filter((item) => item.severity === "warning").length,
  findings,
};

const outDir = path.join(repoRoot, "docs", "security");
mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, `pricing-contract-audit-${summary.checkedAt.replaceAll(":", "-").replaceAll(".", "-")}.json`);
writeFileSync(outPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ ...summary, report: outPath }, null, 2));
if (summary.critical > 0) process.exitCode = 1;
