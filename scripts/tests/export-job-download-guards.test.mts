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
      ? Response.json([{ path: "org-1/price-list.xlsx", error: null, signedURL: "/object/sign/app-exports/org-1/price-list.xlsx?token=test" }])
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
  const requests: Array<{ url: URL; authorization: string | null; body: { paths: string[]; expiresIn: number } }> = [];
  const storagePath = "org-1/supplier-price/2026-10-14T05-20-00.000+00:00/Supplier file.csv";
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    requests.push({ url, authorization: new Headers(init?.headers).get("authorization"), body: JSON.parse(String(init?.body)) });
    return Response.json([{
      path: storagePath, error: null,
      signedURL: "/object/sign/app-exports/org-1/supplier-price/2026-10-14T05-20-00.000%2B00%3A00/Supplier%20file.csv?token=signed-only-token",
    }]);
  };
  try {
    const signed = await createExportArtifactSignedDownload("https://example.invalid", "service-role-secret", job({
      audience: "admin",
      export_type: "supplier_price_list",
      file_name: "Supplier file.csv",
      storage_path: storagePath,
    }));
    const parsed = new URL(signed.signedUrl);
    assert.equal(parsed.pathname, "/storage/v1/object/sign/app-exports/org-1/supplier-price/2026-10-14T05-20-00.000%2B00%3A00/Supplier%20file.csv");
    assert.equal(parsed.searchParams.get("token"), "signed-only-token");
    assert.equal(parsed.searchParams.get("download"), "Supplier-file.csv");
    assert.doesNotMatch(parsed.pathname, /%25(?:2B|3A|20)/i);
    assert.doesNotMatch(signed.signedUrl, /service-role-secret|Bearer/i);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url.pathname, "/storage/v1/object/sign/app-exports");
    assert.deepEqual(requests[0].body, { expiresIn: 300, paths: [storagePath] });
    assert.equal(requests[0].authorization, "Bearer service-role-secret");
    assert.equal(signed.fileName, "Supplier-file.csv");
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("batch signing keeps reserved object characters equal to the download token claim", async () => {
  const previousFetch = globalThis.fetch;
  const storagePath = "org-1/supplier-price/2026-10-14T05-20-00.000+00:00/Supplier #1?latest%.csv";
  let tokenClaim = "";
  globalThis.fetch = async (input, init) => {
    assert.equal(new URL(String(input)).pathname, "/storage/v1/object/sign/app-exports");
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(body.paths, [storagePath]);
    // Supabase's batch signer uses the JSON path directly in its JWT claim.
    tokenClaim = `app-exports/${body.paths[0]}`;
    return Response.json([{ path: storagePath, error: null, signedURL: `/object/sign/${tokenClaim}?token=batch-token` }]);
  };
  try {
    const signed = await createExportArtifactSignedDownload("https://example.invalid", "secret", job({
      file_name: "Supplier #1?latest%.csv", storage_path: storagePath,
    }));
    const parsed = new URL(signed.signedUrl);
    const downloadObject = decodeURIComponent(parsed.pathname.slice("/storage/v1/object/sign/".length));
    assert.equal(downloadObject, tokenClaim);
    assert.equal(parsed.searchParams.get("token"), "batch-token");
    assert.equal(parsed.hash, "");
    assert.match(parsed.pathname, /%2B00%3A00\/Supplier%20%231%3Flatest%25\.csv$/);
    // The former single-object signer would leave '+' encoded in its claim.
    assert.notEqual(decodeURI(parsed.pathname.slice("/storage/v1/object/sign/".length)), tokenClaim);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("batch signing rejects per-object errors or a mismatched response path", async () => {
  const previousFetch = globalThis.fetch;
  try {
    for (const response of [
      [{ path: "org-1/price-list.xlsx", error: "Either the object does not exist or you do not have access to it", signedURL: null }],
      [{ path: "org-2/price-list.xlsx", error: null, signedURL: "/object/sign/app-exports/org-2/price-list.xlsx?token=test" }],
      [],
    ]) {
      globalThis.fetch = async () => Response.json(response);
      await assert.rejects(createExportArtifactSignedDownload("https://example.invalid", "secret", job()), /does not exist|invalid/);
    }
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("multipart artifacts batch-sign every part and preserve assembly order", async () => {
  const previousFetch = globalThis.fetch;
  const parts = [
    { path: "org-1/export/part-1", byteSize: 2 },
    { path: "org-1/export/part-2", byteSize: 3 },
    { path: "org-1/export/part-3", byteSize: 3 },
  ];
  const multipartJob = job({ storage_path: parts[0].path, byte_size: 8, scope: { artifactParts: parts } });
  globalThis.fetch = async (input, init) => {
    assert.equal(new URL(String(input)).pathname, "/storage/v1/object/sign/app-exports");
    assert.deepEqual(JSON.parse(String(init?.body)), { expiresIn: 300, paths: parts.map((part) => part.path) });
    return Response.json(parts.slice().reverse().map((part) => ({
      path: part.path, error: null, signedURL: `/object/sign/app-exports/${part.path}?token=${part.path.split("/").at(-1)}`,
    })));
  };
  try {
    const signed = await createExportArtifactSignedDownload("https://example.invalid", "secret", multipartJob);
    assert.equal(signed.byteSize, 8);
    assert.equal(signed.parts?.length, 3);
    assert.equal(signed.signedUrl, signed.parts?.[0].signedUrl);
    assert.deepEqual(signed.parts?.map((part) => part.byteSize), [2, 3, 3]);
    assert.deepEqual(signed.parts?.map((part) => new URL(part.signedUrl).searchParams.get("token")), ["part-1", "part-2", "part-3"]);
    await assert.rejects(downloadExportArtifact("https://example.invalid", "secret", multipartJob), /requires signed-part download/);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test("multipart signing rejects incomplete, duplicate or out-of-scope parts before Storage access", async () => {
  const previousFetch = globalThis.fetch;
  const first = { path: "org-1/export/part-1", byteSize: 4 };
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; throw new Error("Storage must not be called"); };
  try {
    for (const parts of [
      [first, { path: "org-1/export/part-2", byteSize: 3 }],
      [first, first],
      [first, { path: "org-2/export/part-2", byteSize: 4 }],
      [first, { path: "org-1/other-job/part-2", byteSize: 4 }],
      [first, { path: "org-1/export/../part-2", byteSize: 4 }],
      [first, { path: "org-1/export/part-2", byteSize: 0 }],
      [{ path: "org-1/export/part-2", byteSize: 4 }, first],
    ]) {
      await assert.rejects(createExportArtifactSignedDownload("https://example.invalid", "secret", job({
        storage_path: first.path, byte_size: 8, scope: { artifactParts: parts },
      })), /artifact parts/);
    }
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
