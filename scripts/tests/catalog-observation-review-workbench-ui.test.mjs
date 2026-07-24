import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const pageSource = readFileSync(
  new URL("../../apps/web/src/presentation/pages/CatalogObservationReviewPage.tsx", import.meta.url),
  "utf8",
);
const stylesSource = readFileSync(
  new URL("../../apps/web/src/styles.css", import.meta.url),
  "utf8",
);

test("Review queue keeps only scan-critical fields and defers dense evidence to the detail panel", () => {
  const queueMarkup = pageSource.slice(
    pageSource.indexOf('<table className="data-table catalog-observation-review-table">'),
    pageSource.indexOf("</table>", pageSource.indexOf('<table className="data-table catalog-observation-review-table">')),
  );

  assert.match(queueMarkup, /table\.statusPriority/);
  assert.match(queueMarkup, /table\.product/);
  assert.match(queueMarkup, /table\.fieldFamily/);
  assert.match(queueMarkup, /table\.observedValue/);
  assert.match(queueMarkup, /decision\.title/);
  assert.match(queueMarkup, /table\.details/);
  assert.doesNotMatch(queueMarkup, /table\.sourceEvidence/);
  assert.doesNotMatch(queueMarkup, /table\.createdAt/);
  assert.doesNotMatch(queueMarkup, /table\.currentValue/);
  assert.match(queueMarkup, /catalog-review-decision-cell/);
  assert.match(pageSource, /catalog-observation-review-detail/);
});

test("Review queue no longer requires the 1960px horizontal-scan layout", () => {
  assert.match(stylesSource, /\.catalog-observation-review-table\s*\{\s*min-width: 900px;/);
  assert.doesNotMatch(stylesSource, /\.catalog-observation-review-table\s*\{\s*min-width: 1960px;/);
  assert.match(stylesSource, /@media \(max-width: 1440px\)[\s\S]*?\.catalog-observation-review-table\s*\{\s*min-width: 760px;/);
  assert.match(stylesSource, /\.catalog-review-candidate-cell/);
  assert.match(stylesSource, /\.catalog-review-decision-cell/);
});
