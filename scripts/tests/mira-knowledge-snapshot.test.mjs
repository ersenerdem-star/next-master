import assert from "node:assert/strict";
import test from "node:test";

import { buildMiraKnowledgeSnapshot } from "../../netlify/functions/_shared/catalog/mira-knowledge-snapshot.mts";

test("builds a tenant-scoped read-only MIRA knowledge snapshot", async () => {
  const requested = [];
  const rows = {
    catalog_operations_brand_summary: [{ brand_id: "b1", total_products: 10, missing_ean_count: 7, missing_oem_count: 0 }],
    brands: [{ id: "b1", name: "Bosch" }],
    catalog_external_sources: [{ id: "s1", source_key: "bosch-official", source_type: "official", base_url: "https://example.com", license_posture: "allowed", robots_posture: "allowed", rate_limit_posture: "bounded", credential_boundary: "none", is_active: true, metadata: { automated_read_only_approved: true, internal_observation_allowed: true } }],
    catalog_external_source_trust_profiles: [{ id: "t1", source_id: "s1", allowed_field_families: ["ean_reference", "oem_reference"], auto_enrichment_allowed_fields: [], human_review_required: true, evidence_required: true, is_active: true }],
    catalog_observation_jobs: [{ id: "j1", source_id: "s1", trust_profile_id: "t1", brand_id: "b1", job_key: "bosch-ean", status: "active", allowed_field_families: ["ean_reference"], updated_at: null }],
    catalog_observation_runs: [{ id: "r1", job_id: "j1", source_id: "s1", brand_id: "b1", status: "succeeded", observed_count: 3, deduped_count: 0, error_message: null, started_at: null, finished_at: "2026-08-18T00:00:00Z" }],
    mira_missions: [],
  };
  const snapshot = await buildMiraKnowledgeSnapshot({
    supabaseUrl: "https://project.supabase.co",
    serviceRoleKey: "server-only-key",
    organizationId: "org-1",
    fetchRows: async (url) => {
      const table = new URL(url).pathname.split("/").pop();
      requested.push(new URL(url));
      return structuredClone(rows[table] ?? []);
    },
  });

  assert.equal(snapshot.organizationId, "org-1");
  assert.deepEqual(snapshot.catalog.gaps[0].missingFields, [{ field: "ean", missingCount: 7, priority: 7 }]);
  assert.deepEqual(snapshot.channels[0].supportedFields, ["ean"]);
  assert.equal(snapshot.channels[0].admitted, true);
  assert.equal(snapshot.guarantees.catalogWrite, false);
  assert.equal(snapshot.guarantees.customerDataIncluded, false);
  assert.equal(snapshot.guarantees.supplierPriceDataIncluded, false);
  assert.ok(requested.every((url) => url.searchParams.get("organization_id") === "eq.org-1"));
  assert.equal(JSON.stringify(snapshot).includes("server-only-key"), false);
});
