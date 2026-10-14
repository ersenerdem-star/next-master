import test from "node:test";
import assert from "node:assert/strict";
import {
  assertExportArtifactReady,
  assertPortalExportJobCurrentContext,
  assertPortalExportJobForInvite,
  assertPortalExportJobPricingContext,
  createExportArtifactSignedDownload,
  downloadExportArtifact,
  toPublicExportJobStatus,
  type ExportJobRow,
} from "../../netlify/functions/_shared/export-jobs.mts";
import type { PortalInviteRow } from "../../netlify/functions/_shared/portal-orders.mts";

function job(patch: Partial<ExportJobRow> = {}): ExportJobRow {
  const now = new Date().toISOString();
  return {
    id: "job-1", organization_id: "org-1", requested_by: null,
    audience: "portal", export_type: "portal_price_list", status: "finalized",
    scope: { inviteId: "invite-1", customerId: "customer-1", brandId: "brand-1" },
    cache_key: "cache-1", data_version: "version-1", file_name: "price-list.xlsx",
    content_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    storage_bucket: "app-exports", storage_path: "org-1/price-list.xlsx",
    row_count: 999_998, byte_size: 25_000_000, progress_total: 999_998,
    progress_done: 999_998, progress_message: "Export file is ready.", error_message: null,
    started_at: now, finalized_at: now, failed_at: null,
    expires_at: new Date(Date.now() + 60_000).toISOString(), created_at: now, updated_at: now,
    ...patch,
  };
}

function invite(patch: Partial<PortalInviteRow & { expires_at: string | null }> = {}): PortalInviteRow & { expires_at: string | null } {
  return {
    id: "invite-1", organization_id: "org-1", party_type: "customer",
    party_name: "Customer", customer_id: "customer-1", vendor_id: null,
    email: "customer@example.invalid", contact_name: "Customer", status: "active",
    access_can_view_account: true, access_can_view_invoices: true,
    access_can_view_payments: true, access_can_view_orders: true,
    allowed_brand_ids: ["brand-1"], expires_at: new Date(Date.now() + 60_000).toISOString(),
    ...patch,
  };
}

test("portal export checks current invite order, customer, organization, brand and expiry", () => {
  assert.doesNotThrow(() => assertPortalExportJobForInvite(job(), invite()));
  for (const changed of [
    { access_can_view_orders: false },
    { allowed_brand_ids: ["brand-2"] },
    { status: "disabled" as const },
    { expires_at: new Date(Date.now() - 60_000).toISOString() },
    { expires_at: "not-a-date" },
    { customer_id: "customer-2" },
    { organization_id: "org-2" },
  ]) {
    assert.throws(() => assertPortalExportJobForInvite(job(), invite(changed)), /Export job not found/);
  }
});

test("legacy portal exports cannot bypass the current price contract", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new Error("Current context must not be fetched"); };
  try {
    for (const legacyScope of [
      { priceListType: "C", schemaVersion: 3 },
      { priceListType: "A", schemaVersion: 3 },
      { priceListType: "B", schemaVersion: "invalid" },
    ]) {
      await assert.rejects(assertPortalExportJobCurrentContext("https://example.invalid", "secret", job({ scope: {
        inviteId: "invite-1", customerId: "customer-1", brandId: "brand-1", ...legacyScope,
      } }), invite()), /outdated.*new export/);
    }
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("new portal downloads preserve Other margin and reject currency or account changes", () => {
  const currentJob = job({ scope: {
    inviteId: "invite-1", customerId: "customer-1", brandId: "brand-1", brandName: "Clevite",
    priceListType: "Other", marginPercent: 12.5, currency: "EUR", schemaVersion: 4,
  } });
  const context = {
    organizationId: "org-1", inviteId: "invite-1", customerId: "customer-1",
    brandId: "brand-1", brandName: "Clevite", priceListType: "Other" as const,
    currency: "EUR", effectiveMarginA: 12.5, effectiveMarginB: 15, cPriceListIds: [],
  };
  assert.doesNotThrow(() => assertPortalExportJobPricingContext(currentJob, invite(), context));
  assert.throws(() => assertPortalExportJobPricingContext(currentJob, invite(), { ...context, currency: "USD" }), /EUR account/);
  assert.throws(() => assertPortalExportJobPricingContext(currentJob, invite(), { ...context, effectiveMarginA: 13 }), /price settings changed/);
  assert.throws(() => assertPortalExportJobPricingContext(currentJob, invite(), { ...context, priceListType: "A" }), /price settings changed/);
});

test("current portal pricing rejects an artifact after its source data version changes", async () => {
  const originalFetch = globalThis.fetch;
  const requested: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    requested.push(url);
    if (url.includes("/rest/v1/customers?")) return Response.json([{
      id: "customer-source", organization_id: "org-source", currency: "EUR",
      price_list_type: "A", price_list_margin_percent: null,
    }]);
    if (url.includes("/rest/v1/company_profiles?")) return Response.json([]);
    if (url.includes("/rest/v1/customer_price_lists?")) return Response.json([
      { list_type: "A", margin_percent: 10 }, { list_type: "B", margin_percent: 15 },
    ]);
    if (url.includes("/rest/v1/brands?")) return Response.json([{ id: "brand-source", name: "Clevite" }]);
    if (url.includes("/rest/v1/rpc/get_admin_price_list_export_version")) return Response.json("new-source-version");
    throw new Error(`Unexpected request: ${url}`);
  };
  try {
    const sourceInvite = invite({
      id: "invite-source", organization_id: "org-source", customer_id: "customer-source",
      allowed_brand_ids: ["brand-source"],
    });
    const sourceJob = job({
      organization_id: "org-source", data_version: "old-source-version",
      scope: {
        inviteId: "invite-source", customerId: "customer-source", brandId: "brand-source",
        brandName: "Clevite", priceListType: "A", marginPercent: 10, currency: "EUR", schemaVersion: 4,
      },
    });
    await assert.rejects(
      assertPortalExportJobCurrentContext("https://example.invalid", "secret", sourceJob, sourceInvite),
      /Customer prices changed.*new export/,
    );
    assert.ok(requested.some((url) => url.includes("get_admin_price_list_export_version")));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("finalized job must be unexpired, complete and backed by an artifact", () => {
  assert.doesNotThrow(() => assertExportArtifactReady(job()));
  assert.doesNotThrow(() => assertExportArtifactReady(job({ row_count: 1_100_000, progress_total: 1_100_000, progress_done: 1_100_000 })));
  for (const changed of [
    { expires_at: new Date(Date.now() - 60_000).toISOString() },
    { row_count: 100_000 },
    { progress_total: null },
    { byte_size: 0 },
    { storage_path: null },
    { progress_message: "Export limited to 100,000 rows." },
  ]) {
    const invalid = job(changed);
    assert.throws(() => assertExportArtifactReady(invalid));
    assert.notEqual(toPublicExportJobStatus(invalid).status, "finalized");
  }
});

test("signed and fallback download reject stale or partial files before Storage access", async () => {
  const previousFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new Error("Storage must not be called"); };
  try {
    for (const invalid of [job({ expires_at: new Date(Date.now() - 60_000).toISOString() }), job({ row_count: 100_000 })]) {
      await assert.rejects(createExportArtifactSignedDownload("https://example.invalid", "secret", invalid));
      await assert.rejects(downloadExportArtifact("https://example.invalid", "secret", invalid));
    }
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("complete export signs a short-lived URL and fallback streams the stored file", async () => {
  const previousFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = async (input) => {
    const url = String(input);
    requests.push(url);
    return url.includes("/object/sign/")
      ? Response.json({ signedURL: "/object/sign/app-exports/org-1/price-list.xlsx?token=test" })
      : new Response("workbook-content", { status: 200 });
  };
  try {
    const signed = await createExportArtifactSignedDownload("https://example.invalid", "secret", job());
    assert.match(signed.signedUrl, /token=test/);
    assert.equal(signed.expiresIn, 300);
    const fallback = await downloadExportArtifact("https://example.invalid", "secret", job());
    assert.equal(fallback.headers.get("X-Export-Row-Count"), "999998");
    assert.equal(await fallback.text(), "workbook-content");
    assert.equal(requests.length, 2);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("signed download preserves escaped path octets and safely attaches the download name", async () => {
  const previousFetch = globalThis.fetch;
  const requests: Array<{ url: URL; authorization: string | null }> = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    requests.push({ url, authorization: new Headers(init?.headers).get("authorization") });
    return Response.json({
      signedURL: "/object/sign/app-exports/org-1/supplier-price/2026-10-14T05-20-00.000%2B00%3A00/Supplier%20file.csv?token=signed-only-token",
    });
  };
  try {
    const signed = await createExportArtifactSignedDownload("https://example.invalid", "service-role-secret", job({
      audience: "admin",
      export_type: "supplier_price_list",
      file_name: "Supplier file.csv",
      storage_path: "org-1/supplier-price/2026-10-14T05-20-00.000+00:00/Supplier file.csv",
    }));
    const parsed = new URL(signed.signedUrl);
    assert.equal(parsed.pathname, "/storage/v1/object/sign/app-exports/org-1/supplier-price/2026-10-14T05-20-00.000%2B00%3A00/Supplier%20file.csv");
    assert.equal(parsed.searchParams.get("token"), "signed-only-token");
    assert.equal(parsed.searchParams.get("download"), "Supplier-file.csv");
    assert.doesNotMatch(parsed.pathname, /%25(?:2B|3A|20)/i);
    assert.doesNotMatch(signed.signedUrl, /service-role-secret|Bearer/i);
    assert.equal(requests.length, 1);
    assert.match(requests[0].url.pathname, /2026-10-14T05-20-00\.000%2B00%3A00\/Supplier%20file\.csv$/);
    assert.equal(requests[0].authorization, "Bearer service-role-secret");
    assert.equal(signed.fileName, "Supplier-file.csv");
  } finally {
    globalThis.fetch = previousFetch;
  }
});
