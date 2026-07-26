import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { normalizeCatalogDisplayCode } from "../shared/catalog/catalog-standardization.mjs";
import { normalizeCatalogBrand } from "../_shared/spareto-catalog-enrichment.mjs";
import { resolveCatalogSyncPlan } from "../../netlify/functions/_shared/catalog/catalog-sync-provider.mts";
import { boundZfCandidateItems } from "../../netlify/functions/_shared/catalog/zf-aftermarket-sync.mts";

const migration = await readFile(
  new URL("../../supabase/migrations/20260726150117_zf_group_catalog_boundary.sql", import.meta.url),
  "utf8",
);
const zfRuntime = await readFile(
  new URL("../../netlify/functions/_shared/catalog/zf-aftermarket-sync.mts", import.meta.url),
  "utf8",
);
const adminRoute = await readFile(
  new URL("../../netlify/functions/admin-sync-brand-catalog.mts", import.meta.url),
  "utf8",
);
const boundedAdminRoute = await readFile(
  new URL("../../netlify/functions/admin-sync-zf-group-catalog.mts", import.meta.url),
  "utf8",
);

test("all six ZF Group brands resolve to the official ZF Aftermarket connector", () => {
  for (const brand of ["ZF", "Sachs", "Lemforder", "TRW", "Wabco", "Boge"]) {
    const plan = resolveCatalogSyncPlan(brand);
    assert.equal(plan.preferredProviderKey, "zf_aftermarket", brand);
    assert.equal(plan.executionProviderKey, "zf_aftermarket", brand);
    assert.equal(plan.preferredSourceType, "official", brand);
  }
});

test("Motorservice TRW Engine Components never resolves as ZF TRW", () => {
  const motorservicePlan = resolveCatalogSyncPlan("TRW Engine Components");
  const zfPlan = resolveCatalogSyncPlan("TRW");

  assert.equal(motorservicePlan.brandName, "TRW Engine Components");
  assert.equal(motorservicePlan.preferredProviderKey, "motorservice_msicd");
  assert.equal(zfPlan.brandName, "TRW");
  assert.equal(zfPlan.preferredProviderKey, "zf_aftermarket");
  assert.notEqual(normalizeCatalogBrand("TRW Engine Components"), normalizeCatalogBrand("TRW"));
});

test("ZF Group product codes remove whitespace and preserve punctuation", () => {
  for (const brand of ["ZF", "Sachs", "Lemforder", "TRW", "Wabco", "Boge"]) {
    assert.equal(normalizeCatalogDisplayCode(" 12. 34-5 / A ", brand), "12.34-5/A", brand);
  }

  assert.match(migration, /'ZF', 'ZF', 'compact_space'/);
  assert.match(migration, /'TRW', 'TRW', 'compact_space'/);
  assert.match(migration, /TRW Engine Components identities must remain distinct/);
});

test("ZF runtime target resolution is bound to the authenticated organization", () => {
  assert.match(adminRoute, /organizationId:\s*caller\.profile\.organization_id/);
  assert.match(zfRuntime, /organization_id=eq\.\$\{encodeURIComponent\(requestedOrganizationId\)\}/);
  assert.match(zfRuntime, /organization_id=eq\.\$\{encodeURIComponent\(target\.organization_id\)\}/);
  assert.match(zfRuntime, /order=normalized_code\.asc/);
  assert.match(zfRuntime, /Organization scope is required/);
  assert.match(zfRuntime, /Tenant scope mismatch/);
});

test("ZF candidate limit bounds primary and related work together", () => {
  const primary = ["one", "two", "three"];
  const related = ["four", "five"];

  assert.deepEqual(boundZfCandidateItems(primary, 1), ["one"]);
  assert.deepEqual(boundZfCandidateItems(primary, 4), primary);
  assert.deepEqual(boundZfCandidateItems(related, 4, primary.length), ["four"]);
  assert.deepEqual(boundZfCandidateItems(related, 3, primary.length), []);
  assert.deepEqual(boundZfCandidateItems(primary), primary);
});

test("bounded ZF route is tenant-derived, allowlisted, and official-only", () => {
  assert.match(boundedAdminRoute, /organizationId:\s*caller\.profile\.organization_id/);
  assert.match(boundedAdminRoute, /ALLOWED_CANDIDATE_LIMITS = new Set\(\[1, 50, 100, 500, 1000, 2000, 3000\]\)/);
  assert.match(boundedAdminRoute, /skipCompletion:\s*true/);
  assert.match(boundedAdminRoute, /skipDiscovery:\s*true/);
  assert.match(boundedAdminRoute, /sourceMode:\s*"zf_aftermarket_official_only"/);
  assert.match(boundedAdminRoute, /\["trw", "TRW"\]/);
  assert.doesNotMatch(boundedAdminRoute, /TRW Engine Components/);
});
