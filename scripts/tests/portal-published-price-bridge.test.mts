import test from "node:test";
import assert from "node:assert/strict";
import { buildPortalPriceListRows, preparePortalOrderLines, resolvePortalPriceListExportContext, searchPortalCatalog, submitPortalSalesOrder } from "../../netlify/functions/_shared/portal-orders.mts";

test("portal keeps published SKUs separate and prices exact order/search requests", async () => {
  const originalFetch = globalThis.fetch;
  const requestedCodes: string[] = [];
  let orderWrites = 0;
  let accountMargin = 10;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/sales_orders") && init?.method !== "GET") orderWrites += 1;
    let data: unknown = [];
    if (url.pathname.endsWith("/customers")) {
      data = [{ id: "customer-1", display_name: "Customer", company_name: "Customer", currency: "EUR", payment_terms: "", contract_nr: "", custom_fields: "", seller_company_profile_id: null, price_list_type: "Other", price_list_margin_percent: accountMargin }];
    } else if (url.pathname.endsWith("/company_profiles")) {
      data = [{ company_name: "Seller" }];
    } else if (url.pathname.endsWith("/brands")) {
      data = [{ id: "brand-1", name: "Clevite" }];
    } else if (url.pathname.endsWith("/supplier_current_price_pointers")) {
      data = [{ release_id: "published-release-1" }];
    } else if (url.pathname.endsWith("/cloud_current_supplier_price_options_service")) {
      const body = JSON.parse(String(init?.body || "{}")) as Record<string, string>;
      assert.equal(body.input_organization_id, "org-1");
      assert.equal(body.input_brand, "Clevite");
      requestedCodes.push(body.input_code);
      // Even if a looser RPC ever returns a different SKU, the caller must
      // reject it instead of pricing 61-1 from 611's published row.
      const productCode = body.input_code === "61-1" ? "611" : body.input_code;
      const price = productCode === "61/1" ? 8.34 : productCode === "611" ? 405.72 : null;
      data = price == null ? [] : [{ supplier_id: "supplier-1", supplier_name: "Supplier", brand_id: "brand-1", brand: "Clevite", product_code: productCode, description: "Part", buy_price: price, price_date: "2026-10-13", notes: "" }];
    }
    return new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  const invite = {
    id: "invite-1", organization_id: "org-1", party_type: "customer" as const,
    party_name: "Customer", customer_id: "customer-1", vendor_id: null,
    seller_company_profile_id: null, email: "customer@example.invalid", contact_name: "Customer",
    status: "active" as const, access_can_view_account: true, access_can_view_invoices: true,
    access_can_view_payments: true, access_can_view_orders: true, allowed_brand_ids: [],
  };
  try {
    const prepared = await preparePortalOrderLines("https://supabase.example.invalid", "service-key", invite, [
      { code: "61/1", brand: "Clevite", qty: 1 },
      { code: "611", brand: "Clevite", qty: 2 },
      { code: "61-1", brand: "Clevite", qty: 1 },
    ]);
    assert.equal(prepared.lines.length, 3);
    assert.deepEqual(prepared.lines.map((line) => line.requestedCode), ["61/1", "611", "61-1"]);
    assert.deepEqual(prepared.lines.map((line) => line.buy_price), [8.34, 405.72, null]);
    assert.deepEqual(prepared.lines.map((line) => line.sell_price), [9.17, 446.29, null]);
    assert.deepEqual(prepared.lines.map((line) => line.resolvedCode), ["61/1", "611", "61-1"]);

    const search = await searchPortalCatalog("https://supabase.example.invalid", "service-key", invite, "61/1", "Clevite");
    assert.deepEqual(search.items.map((item) => item.code), ["61/1"]);
    assert.equal(search.items[0]?.sell_price, 9.17);
    assert.ok(requestedCodes.includes("61/1") && requestedCodes.includes("611"));

    accountMargin = 20;
    const currentExportContext = await resolvePortalPriceListExportContext(
      "https://supabase.example.invalid", "service-key", invite, "Clevite",
    );
    assert.equal(currentExportContext.effectiveMarginA, 20);

    await assert.rejects(
      submitPortalSalesOrder("https://supabase.example.invalid", "service-key", invite, {
        mode: "confirm", rows: [{ code: "61-1", brand: "Clevite", qty: 1 }],
      }),
      /live supplier and customer price is required/,
    );
    assert.equal(orderWrites, 0);

    await assert.rejects(
      buildPortalPriceListRows("https://supabase.example.invalid", "service-key", invite, "Clevite"),
      /asynchronous price-list export/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
