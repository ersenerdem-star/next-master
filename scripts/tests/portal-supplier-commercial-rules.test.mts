import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { prepareCustomerPortalOrderLines, searchPortalCatalog, submitPortalSalesOrder, type PortalInviteRow } from "../../netlify/functions/_shared/portal-orders.mts";

const invite: PortalInviteRow = {
  id: "commercial-invite", organization_id: "commercial-org", customer_id: "commercial-customer",
  party_type: "customer", party_name: "Customer", vendor_id: null, email: "test@example.invalid", contact_name: "Customer",
  status: "active", access_can_view_account: true, access_can_view_invoices: true,
  access_can_view_payments: true, access_can_view_orders: true, allowed_brand_ids: [],
};
const source = "https://commercial-portal.example.invalid";
async function fixture(check: (state: { terms: Record<string, unknown>; writes: string[]; expired: boolean }) => Promise<void>) {
  const previous = globalThis.fetch;
  const state = { terms: { moq: 5, order_multiple: 4, stock_qty: 0, valid_to: "2026-12-31" } as Record<string, unknown>, writes: [] as string[], expired: false };
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, source);
    if (init?.method && !["GET", "POST"].includes(init.method)) state.writes.push(url.pathname);
    if (url.pathname.endsWith("/sales_orders") && init?.method === "POST") state.writes.push(url.pathname);
    let data: unknown = [];
    if (url.pathname.endsWith("/customers")) data = [{ id: invite.customer_id, display_name: "Customer", currency: "EUR", custom_fields: "", price_list_type: "Other", price_list_margin_percent: 20 }];
    else if (url.pathname.endsWith("/brands")) data = [{ id: "commercial-brand", name: "Geba" }];
    else if (url.pathname.endsWith("/company_profiles")) data = [{ company_name: "Seller" }];
    else if (url.pathname.endsWith("/catalog_products")) data = [{ id: "product-1", product_code: "10131", description: "Pump", brand_id: "commercial-brand", normalized_code: "10131" }];
    else if (url.pathname.endsWith("/warehouse_stock_snapshots")) data = [];
    else if (url.pathname.endsWith("/cloud_current_supplier_commercial_options_service")) {
      const body = JSON.parse(String(init?.body));
      assert.deepEqual(body, { input_organization_id: invite.organization_id, input_code: "10131", input_brand: "Geba" });
      data = state.expired ? [] : [{ supplier_id: "supplier-geba", supplier_name: "GEBA", brand_id: "commercial-brand", brand: "Geba", product_code: "10131", description: "Pump", buy_price: 10, price_date: "2026-10-14", notes: "private", ...state.terms }];
    } else if (url.pathname.includes("supplier_price_options") || url.pathname.endsWith("/supplier_prices")) throw new Error("Legacy price fallback is forbidden");
    return Response.json(data);
  };
  try { await check(state); } finally { globalThis.fetch = previous; }
}
const row = (qty: number) => ({ code: "10131", brand: "Geba", qty });

test("portal preparation exposes accepted MOQ/multiple quantity and keeps supplier stock private", async () => {
  await fixture(async (state) => {
    const { lines } = await prepareCustomerPortalOrderLines(source, "test-key", invite, [row(1)]);
    assert.equal(lines[0].qty, 8);
    assert.equal(lines[0].requested_qty, 1);
    assert.equal(lines[0].moq, 5);
    assert.equal(lines[0].order_multiple, 4);
    assert.equal(lines[0].quantity_adjusted, true);
    assert.match(lines[0].quantity_adjustment_note!, /Requested 1 pcs; prepared 8 pcs/);
    assert.equal(lines[0].sell_price, 12);
    for (const privateKey of ["stock_qty", "supplier_name", "buy_price", "supplierOptions", "notes"]) assert.equal(Object.hasOwn(lines[0], privateKey), false);
    state.terms.stock_qty = null;
    const unchanged = await prepareCustomerPortalOrderLines(source, "test-key", invite, [row(8)]);
    assert.equal(unchanged.lines[0].qty, 8);
    assert.equal(unchanged.lines[0].quantity_adjusted, false);
    state.terms.stock_qty = 2147483647;
    const search = await searchPortalCatalog(source, "test-key", invite, "10131", "Geba");
    assert.ok(search.items[0].available_qty == null, "supplier stock must never populate owned warehouse availability");
    assert.equal(Object.hasOwn(search.items[0], "stock_qty"), false);
  });
});

test("direct draft and confirm submission both enforce current quantity rules before any write", async () => {
  await fixture(async (state) => {
    for (const mode of ["draft", "confirm"] as const) {
      await assert.rejects(submitPortalSalesOrder(source, "test-key", invite, { mode, rows: [row(1)] }), /requested 1, required 8/);
    }
    // A valid preparation does not authorize stale quantities after a rule change.
    const prepared = await prepareCustomerPortalOrderLines(source, "test-key", invite, [row(8)]);
    assert.equal(prepared.lines[0].quantity_adjusted, false);
    state.terms.order_multiple = 5;
    await assert.rejects(submitPortalSalesOrder(source, "test-key", invite, { mode: "confirm", rows: [row(8)] }), /requested 8, required 10/);
    assert.deepEqual(state.writes, []);
  });
});

test("expired/no-current source and malformed terms fail closed without writes or legacy fallback", async () => {
  await fixture(async (state) => {
    state.expired = true; // SQL's inclusive-date eligibility is proved by its real database suite.
    await assert.rejects(submitPortalSalesOrder(source, "test-key", invite, { mode: "confirm", rows: [row(8)] }), /live supplier and customer price/);
    state.expired = false;
    state.terms.order_multiple = 0;
    await assert.rejects(prepareCustomerPortalOrderLines(source, "test-key", invite, [row(8)]), /commercial rules could not be verified/);
    for (const qty of [0, -1, 1.5, 2147483648, NaN]) {
      await assert.rejects(prepareCustomerPortalOrderLines(source, "test-key", invite, [row(qty)]), /whole number/);
    }
    assert.deepEqual(state.writes, []);
  });
});


function loadHandler(name: "prepare" | "submit") {
  const sourceText = readFileSync(new URL(`../../netlify/functions/portal-order-${name}.mts`, import.meta.url), "utf8");
  const compiled = ts.transpileModule(sourceText, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const dependencies: Record<string, unknown> = {
    "./_shared/http.mts": { json: (value: unknown, status: number, headers: HeadersInit) => Response.json(value, { status, headers }) },
    "./_shared/portal-access.mts": { resolvePortalInvite: async () => ({ invite, sessionToken: "fixture-session" }) },
    "./_shared/portal-audit.mts": { writePortalAuditEvent: async () => {} },
    "./_shared/portal-orders.mts": { prepareCustomerPortalOrderLines, submitPortalSalesOrder },
    "./_shared/portal-rate-limit.mts": { enforcePortalRateLimit: async () => ({ allowed: true }) },
    "./_shared/portal-security.mts": { readPortalSessionCookie: () => "fixture-session", buildPortalSessionCookie: () => "fixture=1", buildExpiredPortalSessionCookie: () => "fixture=; Max-Age=0" },
    "./_shared/user-message.mts": { sanitizeUserFacingError: (e: Error) => e.message },
    "./_shared/portal-tenant.mts": { getPortalRequestHostname: () => "portal.example.invalid" },
  };
  return new Function("require", "Netlify", `const exports = {}; ${compiled}; return exports.default;`)(
    (name: string) => { assert.ok(Object.hasOwn(dependencies, name), name); return dependencies[name]; },
    { env: { get: (key: string) => key === "SUPABASE_URL" ? source : "test-key" } },
  );
}

test("actual customer prepare handler uses the safe projection rather than internal supplier/cost fields", async () => {
  await fixture(async () => {
    const response = await loadHandler("prepare")(new Request("https://portal.example.invalid/api/portal-order-prepare", { method: "POST", body: JSON.stringify({ rows: [row(1)] }) }), {});
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.lines[0].qty, 8);
    assert.match(result.lines[0].quantity_adjustment_note, /Review this quantity/);
    for (const key of ["stock_qty", "supplierOptions", "supplier_name", "buy_price", "selectedSupplierKey", "notes"]) assert.equal(Object.hasOwn(result.lines[0], key), false);
  });
});

test("actual Netlify submission handler rejects a crafted out-of-rule request before any order mutation", async () => {
  await fixture(async (state) => {
    const handler = loadHandler("submit");
    for (const mode of ["draft", "confirm"]) {
      for (const qty of [1, 1.5, 2147483648]) {
        const response = await handler(new Request("https://portal.example.invalid/api/portal-order-submit", { method: "POST", body: JSON.stringify({ mode, rows: [row(qty)], moq: 1, order_multiple: 1 }) }), {});
        assert.equal(response.status, 400);
        const result = await response.json();
        assert.match(result.error, qty === 1 ? /requested 1, required 8/ : /whole number/);
      }
    }
    assert.deepEqual(state.writes, []);
  });
});
