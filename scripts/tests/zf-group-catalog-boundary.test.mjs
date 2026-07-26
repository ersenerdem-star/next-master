import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { normalizeCatalogDisplayCode } from "../shared/catalog/catalog-standardization.mjs";
import { normalizeCatalogBrand } from "../_shared/spareto-catalog-enrichment.mjs";
import { resolveCatalogSyncPlan } from "../../netlify/functions/_shared/catalog/catalog-sync-provider.mts";

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
  assert.match(zfRuntime, /Organization scope is required/);
  assert.match(zfRuntime, /Tenant scope mismatch/);
});
