import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  classifyAlternative,
  parseAlternativeRows,
  parseProductDetail,
  parseSearchResults,
  runReview,
} from "../catalog/run-genckaya-bosch-replacement-review.mjs";

test("search parser keeps row identity and ignores price fields", () => {
  const html = `<table id="element_3"><tbody>
    <tr><td>1</td><td></td><td>0 986 4B7 000</td><td>Oil filter</td><td></td><td>BOSCH FILTER</td><td></td><td></td><td></td><td></td><td>99 EUR</td><td></td><td></td><td></td><td><a href="?sayfa=urun_detay&amp;ref=298127">Detail</a></td></tr>
  </tbody></table>`;
  assert.deepEqual(parseSearchResults(html), [{
    source_product_ref: "298127",
    product_code: "0 986 4B7 000",
    normalized_code: "09864B7000",
    description: "Oil filter",
    group: "BOSCH FILTER",
  }]);
});

test("detail parser reads product identity without price", () => {
  const html = `<table id="element_3"><tbody>
    <tr><td><strong>Ürün&nbsp;Kodu</strong></td><td>0451103004</td></tr>
    <tr><td><strong>Açıklama</strong></td><td>Yağ filtresi</td></tr>
    <tr><td><strong>Marka</strong></td><td>BOSCH</td></tr>
    <tr><td><strong>Net Fiyat</strong></td><td>100 TL</td></tr>
  </tbody></table>`;
  assert.deepEqual(parseProductDetail(html), {
    product_code: "0451103004",
    normalized_code: "0451103004",
    description: "Yağ filtresi",
    brand: "BOSCH",
  });
});

test("alternative parser and classification never assert replacement", () => {
  const html = `<table id="element_1"><tbody>
    <tr><td>1</td><td>0451103004</td><td>Oil filter</td><td><a href="?sayfa=urun_detay&amp;ref=250512">Detail</a></td></tr>
  </tbody></table>`;
  assert.deepEqual(parseAlternativeRows(html), [{
    source_product_ref: "250512",
    displayed_code: "0451103004",
    description: "Oil filter",
  }]);
  const relation = classifyAlternative({ brand: "BOSCH" }, { brand: "BOSCH" });
  assert.equal(relation.observed_relation, "same_brand_alternative");
  assert.equal(relation.replacement_asserted, false);
  assert.equal(relation.apply_eligible, false);
});

test("cross-brand candidate is an equivalent, not replacement", () => {
  const relation = classifyAlternative({ brand: "BOSCH" }, { brand: "MANN" });
  assert.equal(relation.observed_relation, "cross_brand_equivalent");
  assert.equal(relation.replacement_asserted, false);
});

test("review flow authenticates in memory and persists no credentials or price", async () => {
  const searchHtml = `<table id="element_3"><tbody><tr><td>1</td><td></td><td>09864B7000</td><td>Oil filter</td><td></td><td>BOSCH FILTER</td><td></td><td></td><td></td><td></td><td>99 EUR</td><td></td><td></td><td></td><td><a href="?sayfa=urun_detay&amp;ref=298127">Detail</a></td></tr></tbody></table>`;
  const sourceDetail = `<table id="element_3"><tbody><tr><td>Ürün Kodu</td><td>09864B7000</td></tr><tr><td>Açıklama</td><td>Oil filter</td></tr><tr><td>Marka</td><td>BOSCH</td></tr><tr><td>Net Fiyat</td><td>99 EUR</td></tr></tbody></table>`;
  const alternatives = `<table id="element_1"><tbody><tr><td>1</td><td>0451103004</td><td>Oil filter</td><td><a href="?sayfa=urun_detay&amp;ref=250512">Detail</a></td></tr></tbody></table>`;
  const candidateDetail = `<table id="element_3"><tbody><tr><td>Ürün Kodu</td><td>0451103004</td></tr><tr><td>Açıklama</td><td>Oil filter</td></tr><tr><td>Marka</td><td>BOSCH</td></tr></tbody></table>`;
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url: String(url), method: init.method || "GET", cookie: init.headers.get("cookie") || "" });
    if (init.method === "POST") return new Response('<a href="?sayfa=logout">Çıkış</a>', { headers: { "set-cookie": "PHPSESSID=test-session; Path=/" } });
    const href = String(url);
    if (href.includes("sayfa=arama2")) return new Response(searchHtml);
    if (href.includes("detay=alternatif2")) return new Response(alternatives);
    if (href.includes("ref=298127")) return new Response(sourceDetail);
    if (href.includes("ref=250512")) return new Response(candidateDetail);
    throw new Error(`Unexpected request: ${href}`);
  };

  const previous = {
    customer: process.env.GENCKAYA_CUSTOMER_CODE,
    username: process.env.GENCKAYA_USERNAME,
    password: process.env.GENCKAYA_PASSWORD,
  };
  process.env.GENCKAYA_CUSTOMER_CODE = "test-customer-secret";
  process.env.GENCKAYA_USERNAME = "test-user-secret";
  process.env.GENCKAYA_PASSWORD = "test-password-secret";
  const artifactDir = await fs.mkdtemp(path.join(os.tmpdir(), "genckaya-review-test-"));
  try {
    const report = await runReview({ codes: ["09864B7000"], artifactDir, requestDelayMs: 500, fetchImpl });
    assert.equal(report.relation_count, 1);
    assert.equal(report.guarantees.item_code_reference_write, false);
    assert.match(requests[1].cookie, /PHPSESSID=test-session/);
    const persisted = `${await fs.readFile(path.join(artifactDir, "review.json"), "utf8")}\n${await fs.readFile(path.join(artifactDir, "review.csv"), "utf8")}`;
    assert.doesNotMatch(persisted, /test-(customer|user|password)-secret|99 EUR|PHPSESSID/);
  } finally {
    if (previous.customer == null) delete process.env.GENCKAYA_CUSTOMER_CODE; else process.env.GENCKAYA_CUSTOMER_CODE = previous.customer;
    if (previous.username == null) delete process.env.GENCKAYA_USERNAME; else process.env.GENCKAYA_USERNAME = previous.username;
    if (previous.password == null) delete process.env.GENCKAYA_PASSWORD; else process.env.GENCKAYA_PASSWORD = previous.password;
  }
});
