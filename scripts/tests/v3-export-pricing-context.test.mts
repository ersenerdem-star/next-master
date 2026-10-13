import test from "node:test";
import assert from "node:assert/strict";
import { deriveCustomerPriceListSettings } from "../../netlify/functions/_shared/pricing/customer-pricing-context.mts";
import { resolvePortalPriceListExportContextFromDb } from "../../netlify/functions/_shared/v3-export-pricing-context.mts";

const organizationId = "11111111-1111-4111-8111-111111111111";
const customerId = "22222222-2222-4222-8222-222222222222";
const brandId = "33333333-3333-4333-8333-333333333333";
const invite = {
  id: "44444444-4444-4444-8444-444444444444", organization_id: organizationId,
  customer_id: customerId, party_type: "customer", status: "active",
  access_can_view_orders: true, allowed_brand_ids: [brandId], seller_company_profile_id: null,
};
const customer = {
  id: customerId, organization_id: organizationId, seller_company_profile_id: null,
  custom_fields: "", price_list_type: "A", price_list_margin_percent: null, currency: "EUR",
};
const priceLists = [
  { list_type: "A", margin_percent: 11 },
  { list_type: "B", margin_percent: 17 },
  { list_type: "A", margin_percent: 9 }, // Older card must not override newest-first value.
];

function db(rows = priceLists) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  return {
    calls,
    client: {
      async query(sql: string, params: unknown[]) {
        calls.push({ sql, params });
        return { rows };
      },
    },
  };
}

test("shared portal pricing resolves A, B, Other and legacy account overrides", () => {
  const a = deriveCustomerPriceListSettings(customer, priceLists);
  assert.deepEqual([a.customerType, a.effectiveMarginA, a.effectiveMarginB, a.currency], ["A", 11, 17, "EUR"]);
  const b = deriveCustomerPriceListSettings({ ...customer, price_list_type: "B", price_list_margin_percent: 21 }, priceLists);
  assert.deepEqual([b.customerType, b.effectiveMarginA, b.effectiveMarginB], ["B", 11, 21]);
  const other = deriveCustomerPriceListSettings({ ...customer, price_list_type: "Other", price_list_margin_percent: 12.5 }, priceLists);
  assert.deepEqual([other.customerType, other.effectiveMarginA, other.effectiveMarginB], ["Other", 12.5, 17]);
  const legacy = deriveCustomerPriceListSettings({ ...customer, price_list_type: "", custom_fields: 'note [[NEXT_MASTER_META]]{"price_list_type":"Other","price_list_margin_percent":8.5}' }, priceLists);
  assert.deepEqual([legacy.customerType, legacy.effectiveMarginA], ["Other", 8.5]);
  assert.throws(() => deriveCustomerPriceListSettings({ ...customer, price_list_type: "C" }, priceLists), /retired C price list/);
  assert.throws(() => deriveCustomerPriceListSettings({ ...customer, price_list_type: "Other" }, priceLists), /custom margin/);
});

test("worker uses one tenant-scoped DB read for the same A/B account pricing", async () => {
  const { client, calls } = db();
  const result = await resolvePortalPriceListExportContextFromDb({
    client, invite, customer, brandId, brandName: "Clevite",
  });
  assert.deepEqual({
    organizationId: result.organizationId, inviteId: result.inviteId, customerId: result.customerId,
    brandId: result.brandId, priceListType: result.priceListType,
    effectiveMarginA: result.effectiveMarginA, effectiveMarginB: result.effectiveMarginB,
  }, {
    organizationId, inviteId: invite.id, customerId, brandId, priceListType: "A",
    effectiveMarginA: 11, effectiveMarginB: 17,
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].params, [organizationId]);
  assert.match(calls[0].sql, /organization_id=\$1 and is_active=true/);
});

test("worker denies revoked, foreign-tenant and wrong-brand context before reading lists", async () => {
  for (const bad of [
    { invite: { ...invite, status: "disabled" }, customer },
    { invite: { ...invite, access_can_view_orders: false }, customer },
    { invite, customer: { ...customer, organization_id: "foreign" } },
    { invite: { ...invite, allowed_brand_ids: ["foreign"] }, customer },
  ]) {
    const { client, calls } = db();
    await assert.rejects(resolvePortalPriceListExportContextFromDb({
      client, ...bad, brandId, brandName: "Clevite",
    }), /EXPORT_SNAPSHOT_INVITE_DENIED/);
    assert.equal(calls.length, 0);
  }
});

test("worker honors a legacy embedded seller profile but rejects a conflicting seller", async () => {
  const sellerId = "55555555-5555-4555-8555-555555555555";
  const legacyCustomer = {
    ...customer,
    custom_fields: `note [[NEXT_MASTER_META]]{"seller_company_profile_id":"${sellerId}"}`,
  };
  const { client } = db();
  const context = await resolvePortalPriceListExportContextFromDb({
    client, invite: { ...invite, seller_company_profile_id: sellerId },
    customer: legacyCustomer, brandId, brandName: "Clevite",
  });
  assert.equal(context.customerId, customerId);
  const denied = db();
  await assert.rejects(resolvePortalPriceListExportContextFromDb({
    client: denied.client, invite: { ...invite, seller_company_profile_id: "wrong" },
    customer: legacyCustomer, brandId, brandName: "Clevite",
  }), /EXPORT_SNAPSHOT_INVITE_DENIED/);
  assert.equal(denied.calls.length, 0);
});

test("worker accepts an enabled secondary seller but rejects an unrelated seller", async () => {
  const primarySellerId = "55555555-5555-4555-8555-555555555555";
  const secondarySellerId = "66666666-6666-4666-8666-666666666666";
  const multiSellerCustomer = {
    ...customer,
    seller_company_profile_id: primarySellerId,
    seller_company_profile_ids: [primarySellerId, secondarySellerId],
    custom_fields: 'note [[NEXT_MASTER_META]]{"seller_company_profile_id":"stale-legacy-seller"}',
  };
  const { client } = db();
  const context = await resolvePortalPriceListExportContextFromDb({
    client, invite: { ...invite, seller_company_profile_id: secondarySellerId },
    customer: multiSellerCustomer, brandId, brandName: "Clevite",
  });
  assert.equal(context.customerId, customerId);

  const denied = db();
  await assert.rejects(resolvePortalPriceListExportContextFromDb({
    client: denied.client, invite: { ...invite, seller_company_profile_id: "stale-legacy-seller" },
    customer: multiSellerCustomer, brandId, brandName: "Clevite",
  }), /EXPORT_SNAPSHOT_INVITE_DENIED/);
  assert.equal(denied.calls.length, 0);
});
