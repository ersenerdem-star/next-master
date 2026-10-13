import test from "node:test";
import assert from "node:assert/strict";
import { searchPortalCatalog, type PortalInviteRow } from "../../netlify/functions/_shared/portal-orders.mts";

test("catalogless published brand supports bounded SKU browse and prefix search without changing catalog brands", async () => {
  const originalFetch = globalThis.fetch;
  const releaseRequests: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    let data: unknown = [];
    if (url.pathname.endsWith("/brands")) {
      data = [{ id: "brand-clevite", name: "Clevite" }, { id: "brand-bosch", name: "Bosch" }];
    } else if (url.pathname.endsWith("/customers")) {
      data = [{
        id: "customer-1", display_name: "Customer", company_name: "Customer",
        currency: "EUR", payment_terms: "", contract_nr: "", custom_fields: "",
        seller_company_profile_id: null, price_list_type: "A", price_list_margin_percent: null,
      }];
    } else if (url.pathname.endsWith("/company_profiles")) {
      data = [{ company_name: "Seller" }];
    } else if (url.pathname.endsWith("/customer_price_lists")) {
      data = [{ id: "list-a", list_type: "A", margin_percent: 10, is_active: true }];
    } else if (url.pathname.endsWith("/catalog_products")) {
      // The Bosch query has no matches, but the brand does have a governed
      // catalog product and therefore must not read through a price release.
      data = url.searchParams.get("brand_id") === "eq.brand-bosch" && url.searchParams.get("select") === "id"
        ? [{ id: "bosch-product" }]
        : [];
    } else if (url.pathname.endsWith("/cloud_current_supplier_price_options_service")) {
      data = [];
    } else if (url.pathname.endsWith("/cloud_portal_published_price_search_page_v3")) {
      const request = JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
      releaseRequests.push(request);
      data = [
        { product_code: "61/1", normalized_code: "61/1", description: "Seal", buy_price: 8.34, price_date: "2026-10-13" },
        { product_code: "611", normalized_code: "611", description: "Bearing", buy_price: 405.72, price_date: "2026-10-13" },
        { product_code: "61-1", normalized_code: "611", description: "Wrong identity", buy_price: 1, price_date: "2026-10-13" },
        { product_code: "61X", normalized_code: "61X", description: "Invalid price", buy_price: -1, price_date: "2026-10-13" },
      ];
    }
    return new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  const invite: PortalInviteRow = {
    id: "invite-1", organization_id: "org-1", party_type: "customer",
    party_name: "Customer", customer_id: "customer-1", vendor_id: null,
    email: "customer@example.invalid", contact_name: "Customer", status: "active",
    access_can_view_account: true, access_can_view_invoices: true,
    access_can_view_payments: true, access_can_view_orders: true,
    allowed_brand_ids: [],
  };
  try {
    const prefix = await searchPortalCatalog("https://supabase.example.invalid", "service-key", invite, "61", "Clevite");
    assert.deepEqual(prefix.items.map((item) => [item.code, item.sell_price]), [["61/1", 9.17], ["611", 446.29]]);
    assert.deepEqual(prefix.items.map((item) => item.available_qty), [null, null]);
    assert.equal(prefix.items[0]?.lifecycle_status, null);
    assert.deepEqual(releaseRequests[0], {
      input_organization_id: "org-1", input_brand_id: "brand-clevite", input_code_prefix: "61", input_limit: 24,
    });

    const browse = await searchPortalCatalog("https://supabase.example.invalid", "service-key", invite, "", "Clevite");
    assert.deepEqual(browse.items.map((item) => item.code), ["61/1", "611"]);

    const normalCatalogBrand = await searchPortalCatalog("https://supabase.example.invalid", "service-key", invite, "NOPE", "Bosch");
    assert.deepEqual(normalCatalogBrand.items, []);
    assert.equal(releaseRequests.length, 2);

    await assert.rejects(
      searchPortalCatalog("https://supabase.example.invalid", "service-key", { ...invite, allowed_brand_ids: ["brand-clevite"] }, "", "Bosch"),
      /outside this portal scope/,
    );
    assert.equal(releaseRequests.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
