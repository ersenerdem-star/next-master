import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { resolveCatalogSyncPlan } from "../../netlify/functions/_shared/catalog/catalog-sync-provider.mts";
import { resolveTecAllianceBrandEntry } from "../../netlify/functions/_shared/catalog/tecalliance-brand-registry.mts";

const syncSource = readFileSync(
  new URL("../../netlify/functions/_shared/catalog/tecalliance-sync.mts", import.meta.url),
  "utf8",
);
const providerSource = readFileSync(
  new URL("../../netlify/functions/_shared/catalog/catalog-sync-provider.mts", import.meta.url),
  "utf8",
);

test("Corteco resolves to its official TecAlliance catalog identity", () => {
  const entry = resolveTecAllianceBrandEntry("Corteco");

  assert.ok(entry);
  assert.equal(entry.preferredProviderKey, "tecalliance_corteco");
  assert.equal(entry.preferredSourceUrl, "https://web.tecalliance.net/ecatcorteco/en/home");
  assert.equal(entry.sync.providerId, 25647);
  assert.equal(entry.sync.dataSupplierId, 140);
  assert.deepEqual(entry.sync.manufacturerNames, ["CORTECO"]);
});

test("Corteco uses the official provider without marketplace fallback", () => {
  const plan = resolveCatalogSyncPlan("corteco");

  assert.equal(plan.brandName, "Corteco");
  assert.equal(plan.preferredProviderKey, "tecalliance_corteco");
  assert.equal(plan.executionProviderKey, "tecalliance_corteco");
  assert.equal(plan.preferredSourceType, "official");
  assert.equal(plan.executionSourceType, "official");
  assert.equal(plan.fallbackUsed, false);
  assert.deepEqual(plan.completionProviders, []);
});

test("TecAlliance catalog reads are tenant and brand scoped", () => {
  assert.match(
    syncSource,
    /catalog_products\?select=\$\{selectColumns\}&organization_id=eq\.\$\{encodeURIComponent\(target\.organizationId\)\}&brand_id=eq\.\$\{encodeURIComponent\(target\.brandId\)\}/,
  );
  assert.match(
    syncSource,
    /supplier_prices\?select=product_code,normalized_code&organization_id=eq\.\$\{encodeURIComponent\(target\.organizationId\)\}&brand_id=eq\.\$\{encodeURIComponent\(target\.brandId\)\}/,
  );
});

test("explicit prefixes disable the unbounded blank-root crawl", () => {
  assert.match(providerSource, /includeBlankDiscoveryRoot: !tecallianceSeedPrefixes\?\.length/);
});

test("only-new packages never requeue existing Corteco products", () => {
  assert.match(syncSource, /const onlyNew = input\.onlyNew === true/);
  assert.match(syncSource, /if \(onlyNew && existingByCode\.has\(normalizedCode\)\) continue/);
});
