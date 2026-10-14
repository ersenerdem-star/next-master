import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parse } from "yaml";
import appRpc from "../../netlify/functions/app-rpc.mts";
import { catalogStorageImportTargetEnabled } from "../../netlify/functions/_shared/catalog-import-target.mts";
import { catalogStorageImportBrowserEnabled } from "../../apps/web/src/infrastructure/api/catalogImportTargetGate.ts";
import { requireCatalogWorkerTarget } from "../../apps/engine/catalog-import/src/catalog-target-config.mjs";

const stagingTarget = "kaxsqafdevabkxofwdod";
const productionTarget = "zjgueqijumzlfioihnkt";
const stagingOrigin = "https://next-master-v3-staging-20261006.netlify.app";
const productionOrigin = "https://portal.next-master.com";
const stagingUrl = `https://${stagingTarget}.supabase.co`;
const productionUrl = `https://${productionTarget}.supabase.co`;
const stage = {
  supabaseUrl: stagingUrl, storageImportEnabled: "1", stagingTarget,
  productionTarget: undefined, productionPortalOrigin: undefined,
  productionImportEnabled: undefined, requestUrl: `${stagingOrigin}/api/app-rpc`,
};
const production = {
  supabaseUrl: productionUrl, storageImportEnabled: "1", stagingTarget: undefined,
  productionTarget, productionPortalOrigin: productionOrigin,
  productionImportEnabled: "1", requestUrl: `${productionOrigin}/api/app-rpc`,
};
const productionWorker = {
  SUPABASE_URL: productionUrl, SUPABASE_SERVICE_ROLE_KEY: "test-service-key",
  NM_PRODUCTION_TARGET: productionTarget, NM_PRODUCTION_PORTAL_ORIGIN: productionOrigin,
  CATALOG_IMPORT_SERVICE_ENABLED: "1", CATALOG_STORAGE_IMPORT_PRODUCTION_ENABLED: "1",
  CATALOG_IMPORT_SERVICE_HISTORY_CONFIRMED: "1",
  DBOS_SYSTEM_DATABASE_URL: "postgresql://test:test@private-render-history/nm_catalog_production_history", // synthetic placeholder
};

test("existing V3 staging accepts its declared and actual target without a production flag", () => {
  assert.equal(catalogStorageImportTargetEnabled(stage), true);
  assert.equal(catalogStorageImportBrowserEnabled({
    enabled: "1", supabaseUrl: stagingUrl, browserOrigin: stagingOrigin,
    productionEnabled: undefined, productionTarget: undefined,
  }), true);
  assert.equal(requireCatalogWorkerTarget({
    SUPABASE_URL: stagingUrl, NM_FULL_STAGING_TARGET: stagingTarget,
    SUPABASE_SERVICE_ROLE_KEY: "test-service-key", DBOS_SYSTEM_DATABASE_URL: "postgresql://private/staging_history", // synthetic placeholder
  }), "staging");
});

test("production requires exact target, canonical portal and separate opt-in at every layer", () => {
  assert.equal(catalogStorageImportTargetEnabled(production), true);
  assert.equal(catalogStorageImportBrowserEnabled({
    enabled: "1", productionEnabled: "1", productionTarget,
    supabaseUrl: productionUrl, browserOrigin: productionOrigin,
  }), true);
  assert.equal(requireCatalogWorkerTarget(productionWorker), "production");
  for (const patch of [
    { storageImportEnabled: undefined }, { productionImportEnabled: undefined },
    { productionImportEnabled: "0" }, { productionTarget: undefined },
    { productionTarget: "another-project" }, { stagingTarget },
    { productionPortalOrigin: undefined }, { productionPortalOrigin: stagingOrigin },
    { requestUrl: `${stagingOrigin}/api/app-rpc` },
    { requestUrl: "https://portal.next-master.com.evil.invalid/api/app-rpc" },
    { requestUrl: "http://portal.next-master.com/api/app-rpc" },
    { requestUrl: "https://portal.next-master.com:444/api/app-rpc" },
    { supabaseUrl: stagingUrl },
  ]) assert.equal(catalogStorageImportTargetEnabled({ ...production, ...patch }), false, JSON.stringify(patch));
});

test("staging declarations cannot authorize a different actual Supabase target", () => {
  for (const patch of [
    { stagingTarget: undefined }, { stagingTarget: "another-project" },
    { productionTarget }, { supabaseUrl: productionUrl },
    { storageImportEnabled: "0" }, { supabaseUrl: "https://unrelated.supabase.co" },
  ]) assert.equal(catalogStorageImportTargetEnabled({ ...stage, ...patch }), false);
});

test("Supabase target URLs reject lookalike hosts, credentials, ports, paths and queries", () => {
  for (const supabaseUrl of [
    `http://${productionTarget}.supabase.co`,
    `https://${productionTarget}.supabase.co.evil.invalid`,
    `https://${productionTarget}.supabase.co@evil.invalid`,
    `https://user:secret@${productionTarget}.supabase.co`,
    `https://${productionTarget}.supabase.co:444`,
    `${productionUrl}/rest/v1`, `${productionUrl}?proxy=staging`, `${productionUrl}#staging`,
  ]) {
    assert.equal(catalogStorageImportTargetEnabled({ ...production, supabaseUrl }), false);
    assert.equal(catalogStorageImportBrowserEnabled({
      enabled: "1", productionEnabled: "1", productionTarget,
      supabaseUrl, browserOrigin: productionOrigin,
    }), false);
    assert.throws(() => requireCatalogWorkerTarget({ ...productionWorker, SUPABASE_URL: supabaseUrl }), /TARGET_MISMATCH/);
  }
});

test("browser gate stays closed on mixed targets, preview hosts and missing production flags", () => {
  const base = { enabled: "1", productionEnabled: "1", productionTarget, supabaseUrl: productionUrl, browserOrigin: productionOrigin };
  for (const patch of [
    { enabled: undefined }, { productionEnabled: undefined }, { productionEnabled: "0" },
    { productionTarget: undefined }, { productionTarget: stagingTarget },
    { supabaseUrl: stagingUrl }, { browserOrigin: stagingOrigin },
    { browserOrigin: undefined }, { browserOrigin: "https://preview.netlify.app" },
  ]) assert.equal(catalogStorageImportBrowserEnabled({ ...base, ...patch }), false);
});

test("worker ignores old allow-any-production flag and rejects mixed declarations before DBOS", () => {
  assert.throws(() => requireCatalogWorkerTarget({
    SUPABASE_URL: "https://another.supabase.co", CATALOG_IMPORT_ALLOW_PRODUCTION: "1",
      SUPABASE_SERVICE_ROLE_KEY: "test-service-key", DBOS_SYSTEM_DATABASE_URL: "postgres://private/history", // synthetic placeholder
  }), /TARGET_MISMATCH/);
  for (const patch of [
    { CATALOG_IMPORT_SERVICE_ENABLED: undefined },
    { CATALOG_STORAGE_IMPORT_PRODUCTION_ENABLED: undefined },
    { NM_FULL_STAGING_TARGET: stagingTarget }, { NM_PRODUCTION_TARGET: stagingTarget },
    { SUPABASE_URL: stagingUrl }, { NM_PRODUCTION_PORTAL_ORIGIN: stagingOrigin },
    { NM_PRODUCTION_TARGET: undefined },
  ]) assert.throws(() => requireCatalogWorkerTarget({ ...productionWorker, ...patch }));
});

test("production worker requires its own confirmed DBOS history and never accepts staging history", () => {
  for (const patch of [
    { CATALOG_IMPORT_SERVICE_HISTORY_CONFIRMED: undefined },
    { DBOS_SYSTEM_DATABASE_URL: "postgresql://test:test@private-render-history/nm_catalog_staging_history" }, // synthetic placeholder
    { DBOS_SYSTEM_DATABASE_URL: "https://private-render-history/nm_catalog_production_history" },
    { DBOS_SYSTEM_DATABASE_URL: undefined },
  ]) assert.throws(() => requireCatalogWorkerTarget({ ...productionWorker, ...patch }), /HISTORY|SYSTEM_DATABASE/);
});

async function invokeGateway(env: Record<string, string | undefined>, requestOrigin: string, name: string) {
  const previousFetch = globalThis.fetch;
  const previousNetlify = (globalThis as any).Netlify;
  let writes = 0;
  (globalThis as any).Netlify = { env: { get: (key: string) => env[key] } };
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/auth/v1/user") return Response.json({ id: "admin-1", email: "test@example.invalid" });
    if (url.pathname === "/rest/v1/profiles") return Response.json([{
      organization_id: "org-1", role: "superadmin", is_active: true,
      permissions: {}, session_revoked_at: null,
    }]);
    assert.equal(url.pathname, `/rest/v1/rpc/${name}`);
    assert.equal(init?.method, "POST");
    writes += 1;
    return Response.json({ run_id: "run-1", status: "created", cleanup_required: false });
  };
  try {
    const response = await appRpc(new Request(`${requestOrigin}/api/app-rpc`, {
      method: "POST", headers: { Authorization: "Bearer test-access-token", "Content-Type": "application/json" },
      body: JSON.stringify({ name, args: {} }),
    }), {} as any);
    return { status: response.status, writes };
  } finally {
    globalThis.fetch = previousFetch;
    (globalThis as any).Netlify = previousNetlify;
  }
}

test("authenticated gateway refuses begin/seal/fail writes for mixed or unenabled production", async () => {
  const env = {
    SUPABASE_URL: productionUrl, SUPABASE_ANON_KEY: "test-anon-key", SUPABASE_SERVICE_ROLE_KEY: "test-service-key",
    CATALOG_STORAGE_IMPORT_ENABLED: "1", NM_PRODUCTION_TARGET: productionTarget,
    NM_PRODUCTION_PORTAL_ORIGIN: productionOrigin, CATALOG_STORAGE_IMPORT_PRODUCTION_ENABLED: "1",
  };
  for (const name of ["begin_catalog_import_storage", "complete_catalog_import_storage_upload", "fail_catalog_import_storage_upload"]) {
    for (const patch of [
      { CATALOG_STORAGE_IMPORT_PRODUCTION_ENABLED: "0" },
      { NM_FULL_STAGING_TARGET: stagingTarget }, { SUPABASE_URL: stagingUrl },
    ]) assert.deepEqual(await invokeGateway({ ...env, ...patch }, productionOrigin, name), { status: 409, writes: 0 });
    assert.deepEqual(await invokeGateway(env, stagingOrigin, name), { status: 409, writes: 0 });
    assert.deepEqual(await invokeGateway(env, productionOrigin, name), { status: 200, writes: 1 });
  }
});

test("production Blueprint keeps activation operator-owned and history isolated across synchronization", async () => {
  const blueprint = parse(await readFile(new URL("../../apps/engine/catalog-import/render.production.yaml", import.meta.url), "utf8"));
  assert.equal(blueprint.previews.generation, "off");
  assert.equal(blueprint.services.length, 1);
  const worker = blueprint.services[0];
  assert.equal(worker.type, "worker");
  assert.equal(worker.autoDeployTrigger, "off");
  assert.equal(worker.numInstances, 1);
  assert.equal(worker.repo, "https://github.com/ersenerdem-star/next-master");
  assert.deepEqual(worker.disk, {
    name: "production-single-instance-guard",
    mountPath: "/var/lib/next-master-deployment-guard",
    sizeGB: 1,
  });
  const env = Object.fromEntries(worker.envVars.map((item: any) => [item.key, item]));
  assert.equal(env.SUPABASE_URL.value, productionUrl);
  assert.equal(env.NM_PRODUCTION_TARGET.value, productionTarget);
  assert.equal(env.NM_PRODUCTION_PORTAL_ORIGIN.value, productionOrigin);
  for (const name of ["CATALOG_IMPORT_SERVICE_ENABLED", "CATALOG_STORAGE_IMPORT_PRODUCTION_ENABLED"]) {
    assert.deepEqual(env[name], { key: name, sync: false });
  }
  assert.equal(env.SUPABASE_SERVICE_ROLE_KEY.sync, false);
  assert.equal(env.CATALOG_IMPORT_SERVICE_HISTORY_CONFIRMED.sync, false);
  assert.equal(env.DBOS_SYSTEM_DATABASE_URL.fromDatabase.name, blueprint.databases[0].name);
  assert.equal(env.DBOS_SYSTEM_DATABASE_URL.fromDatabase.property, "connectionString");
  assert.equal(blueprint.databases[0].databaseName, "nm_catalog_production_history");
  assert.equal(blueprint.databases[0].user, "nm_catalog_production_worker");
  assert.deepEqual(blueprint.databases[0].ipAllowList, []);
  assert.equal(env.NM_FULL_STAGING_TARGET, undefined);
  assert.equal(env.CATALOG_IMPORT_ALLOW_PRODUCTION, undefined);
});
