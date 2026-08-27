import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

import {
  exactSearchCandidates,
  extractOfficialLifecycle,
  inspectBoschLifecycle,
  isDiscontinuedStatus,
} from "../catalog/sync-bosch-official-lifecycle.mjs";

test("extracts explicit discontinued status and replacement only from official detail fields", () => {
  const lifecycle = extractOfficialLifecycle({
    specificationTabData: [{ columnData: ["Makale durumu", "Üretimden kaldırıldı"] }],
    replacementsTabData: [{ columnData: ["0 986 628 646"] }],
  }, "0986628546");

  assert.equal(lifecycle.discontinued, true);
  assert.equal(lifecycle.replacement_code, "0986628646");
  assert.match(lifecycle.lifecycle_note, /Not in production/);
});

test("normal status is not discontinued", () => {
  assert.equal(isDiscontinuedStatus("Normal"), false);
  assert.equal(isDiscontinuedStatus("Article discontinued"), true);
});

test("search alternatives are not interpreted as directional replacement", async () => {
  const payload = {
    foundResults: 3,
    products: [
      { productNumber: "1987435057", name: "Filter" },
      { productNumber: "1987435562", name: "Carbon filter" },
      { productNumber: "0986628646", name: "Filter plus" },
    ],
  };
  const matches = exactSearchCandidates(payload, "0986628546");
  assert.equal(matches.exact, null);

  const fetchImpl = async (url) => new Response(
    String(url).includes("search-details") ? "<div>not found</div>" : JSON.stringify(payload),
    { status: 200 },
  );
  const result = await inspectBoschLifecycle("0986628546", {
    fetchImpl,
    requestTimeoutMs: 5000,
    includeSearchEvidence: true,
  });
  assert.equal(result.status, "unresolved");
  assert.equal(result.reason, "NO_EXACT_OFFICIAL_PRODUCT");
  assert.deepEqual(result.candidate_codes, ["1987435057", "1987435562", "0986628646"]);
  assert.match(result.guarantee, /not interpreted/);
});

test("production Bosch sync never falls back to the first search result", async () => {
  const sources = await Promise.all([
    fs.readFile(new URL("../../netlify/functions/_shared/catalog/bosch-aftermarket-sync.mts", import.meta.url), "utf8"),
    fs.readFile(new URL("../../netlify/functions/_shared/bosch-aftermarket-sync.mts", import.meta.url), "utf8"),
  ]);
  for (const source of sources) {
    assert.doesNotMatch(source, /searchItems\[0\]/);
    assert.match(source, /normalizeCode\(term\)/);
  }
});
