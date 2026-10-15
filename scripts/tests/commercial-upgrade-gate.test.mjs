import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { build } from "esbuild";

test("commercial capability is closed unless explicitly accepted in the build", async () => {
  for (const [value, expected] of [[undefined, false], ["false", false], ["1", false], ["true", true]]) {
    const result = await build({ entryPoints: ["apps/web/src/shared/commercialUpgrade.ts"], bundle: true, write: false, format: "esm", define: { "import.meta.env": JSON.stringify(value ? { VITE_COMMERCIAL_DOCUMENT_UPGRADE_ENABLED: value } : {}) } });
    const module = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].contents).toString("base64")}`);
    assert.equal(module.commercialUpgradeEnabled(), expected);
  }
});

test("legacy SQL review package is immutable and excluded from automatic migration directories", async () => {
  const manifest = JSON.parse(await readFile("scripts/ops/legacy-ui-integration/manifest.json", "utf8"));
  assert.equal(manifest.remote_mutation_allowed, false);
  assert.equal(manifest.deployment_ready, false);
  const production = JSON.parse(await readFile("scripts/ops/price-engine-production-manifest.json", "utf8"));
  for (const row of manifest.sql_review_package) {
    assert.ok(row.review_file.startsWith("scripts/ops/legacy-ui-integration/sql/"));
    assert.equal(createHash("sha256").update(await readFile(row.review_file)).digest("hex"), row.sha256);
    assert.equal(row.target_application, "NOT_EXECUTED");
    assert.equal(production.migration_order.some((step) => step.file === row.review_file || step.file === row.source), false);
  }
});
