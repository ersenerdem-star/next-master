import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  isMiraQuarantineEligibleError,
  normalizeMiraDiscoveryQuarantineBatch,
  quarantineReasonForResultIntake,
  stageMiraDiscoveryQuarantine,
} from "../../netlify/functions/_shared/catalog/mira-discovery-quarantine.mjs";
import { MiraObservationIntakeError } from "../../netlify/functions/_shared/catalog/mira-observation-intake.mjs";

const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
const MISSION_ID = "22222222-2222-4222-8222-222222222222";

function batch(overrides = {}) {
  return {
    protocolVersion: "mira-observation-intake.v1",
    sourceKey: "unresolved",
    brand: "Euroricambi",
    observations: [{
      product_code: "95534301",
      normalized_code: "95534301",
      field_family: "supplemental_description",
      field_name: "description",
      raw_value: "Gearbox component",
      normalized_value: "Gearbox component",
      evidence_reference: "Official public product page",
      evidence_url: "https://example.com/products/95534301",
      evidence_payload: { source_type: "official_public_page" },
      confidence: 0.86,
      observed_at: "2026-08-15T09:00:00.000Z",
      writeDisposition: "observation-staging-only",
    }],
    ...overrides,
  };
}

test("routes unresolved source, brand, and product identities to deterministic review reasons", () => {
  assert.equal(quarantineReasonForResultIntake(batch()), "SOURCE_MAPPING_MISSING");
  assert.equal(quarantineReasonForResultIntake(batch({ sourceKey: "official_source", brand: "unresolved" })), "BRAND_MAPPING_MISSING");
  assert.equal(quarantineReasonForResultIntake(batch({
    sourceKey: "official_source",
    observations: [{ ...batch().observations[0], product_code: undefined }],
  })), "PRODUCT_IDENTITY_MISSING");
  assert.equal(quarantineReasonForResultIntake(batch({ sourceKey: "official_source" })), null);
});

test("accepts bounded public evidence and rejects private or secret-tainted evidence", () => {
  const normalized = normalizeMiraDiscoveryQuarantineBatch(batch());
  assert.equal(normalized.observations.length, 1);
  assert.equal(normalized.observations[0].field_family, "supplemental_description");
  assert.throws(() => normalizeMiraDiscoveryQuarantineBatch(batch({
    observations: [{ ...batch().observations[0], evidence_url: "https://127.0.0.1/admin" }],
  })), { code: "INVALID_EVIDENCE_URL" });
  assert.throws(() => normalizeMiraDiscoveryQuarantineBatch(batch({
    observations: [{ ...batch().observations[0], evidence_payload: { authorization: "Bearer hidden" } }],
  })), { code: "UNSAFE_EVIDENCE" });
});

test("stages only to the discovery quarantine RPC and reports no Product mutation", async () => {
  let called = false;
  const result = await stageMiraDiscoveryQuarantine({
    supabaseUrl: "https://example.supabase.co",
    serviceRoleKey: "service-role",
    organizationId: ORGANIZATION_ID,
    missionId: MISSION_ID,
    resultIntake: batch(),
    reason: "SOURCE_MAPPING_MISSING",
    fetchImpl: async (url, init) => {
      assert.match(new URL(url).pathname, /ingest_mira_catalog_discovery_batch$/);
      const body = JSON.parse(init.body);
      assert.equal(body.input_organization_id, ORGANIZATION_ID);
      assert.equal(body.input_mission_id, MISSION_ID);
      assert.equal(body.input_quarantine_reason, "SOURCE_MAPPING_MISSING");
      assert.equal(body.input_observations.length, 1);
      called = true;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          status: "completed_with_warnings",
          quarantined_count: 1,
          deduped_count: 0,
          review_status: "pending_source_review",
          quarantine_reason: "SOURCE_MAPPING_MISSING",
          catalog_products_written: 0,
          apply_performed: false,
        }),
      };
    },
  });
  assert.equal(called, true);
  assert.equal(result.status, "quarantined");
  assert.equal(result.quarantinedCount, 1);
  assert.equal(result.catalogProductsWritten, 0);
  assert.equal(result.applyPerformed, false);
});

test("only approved mapping and scope failures are eligible for quarantine", () => {
  assert.equal(isMiraQuarantineEligibleError(new MiraObservationIntakeError("SOURCE_MAPPING_MISSING", "missing")), true);
  assert.equal(isMiraQuarantineEligibleError(new MiraObservationIntakeError("UNSAFE_EVIDENCE", "unsafe")), false);
});

test("migration is service-role only and contains no canonical Product mutation", async () => {
  const sql = await readFile(new URL("../../supabase/migrations/20260815130000_mira_catalog_discovery_quarantine.sql", import.meta.url), "utf8");
  assert.match(sql, /enable row level security/i);
  assert.match(sql, /require_catalog_observation_service_role\(\)/i);
  assert.match(sql, /grant execute on function public\.ingest_mira_catalog_discovery_batch[\s\S]*to service_role/i);
  assert.doesNotMatch(sql, /(insert\s+into|update|delete\s+from)\s+public\.catalog_products/i);
});
