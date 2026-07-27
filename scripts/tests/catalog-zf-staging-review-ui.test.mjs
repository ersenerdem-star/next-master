import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function read(path) {
  return readFile(new URL(`../../${path}`, import.meta.url), "utf8");
}

test("ZF staging review source route is a separate read-only Catalog Review surface", async () => {
  const app = await read("apps/web/src/app/App.tsx");
  assert.match(app, /CATALOG_ZF_STAGING_REVIEW_PATH = "\/catalog\/zf-group\/staging-review"/);
  assert.match(app, /CatalogZfStagingReviewPage/);
  assert.match(app, /ZF Staging Evidence/);
  assert.match(app, /isCatalogReadRoute/);
  assert.match(app, /canAccessCatalogReviewModules/);
});

test("ZF staging review API client uses only the authenticated GET boundary", async () => {
  const api = await read("apps/web/src/infrastructure/api/catalogZfStagingReviewApi.ts");
  assert.match(api, /supabaseClient\.auth\.getSession/);
  assert.match(api, /\/api\/catalog\/zf-group\/staging-review/);
  assert.match(api, /method: "GET"/);
  assert.match(api, /Authorization: `Bearer \$\{accessToken\}`/);
  assert.doesNotMatch(api, /method: "(POST|PUT|PATCH|DELETE)"/);
  assert.doesNotMatch(api, /service[-_ ]role|serviceRole|\.from\(|\.rpc\(/i);
  assert.doesNotMatch(api, /organization_id.*searchParams|organizationId.*searchParams/);
});

test("ZF staging review page exposes projection evidence without decision or Apply controls", async () => {
  const page = await read("apps/web/src/presentation/pages/CatalogZfStagingReviewPage.tsx");
  assert.match(page, /catalog\.zfStagingReview/);
  assert.match(page, /official_source_display_code/);
  assert.match(page, /vehicle_applications/);
  assert.match(page, /replacement_candidates/);
  assert.match(page, /supersession_candidates/);
  assert.match(page, /payload_fingerprint/);
  assert.match(page, /tenantBound/);
  assert.match(page, /noWriteBody/);
  assert.match(page, /target="_blank"/);
  assert.doesNotMatch(page, /method: "(POST|PUT|PATCH|DELETE)"/);
  assert.doesNotMatch(page, /submitCatalog|reverseCatalog|applyCatalog|Guardian|Apply/i);
  assert.doesNotMatch(page, /supabaseClient\.from|supabaseClient\.rpc/);
});

test("ZF staging review translations and CSS are present", async () => {
  const [en, tr, css] = await Promise.all([
    read("apps/web/src/i18n/locales/en.ts"),
    read("apps/web/src/i18n/locales/tr.ts"),
    read("apps/web/src/styles.css"),
  ]);
  for (const locale of [en, tr]) {
    assert.match(locale, /zfStagingEvidence/);
    assert.match(locale, /zfStagingReview\.readOnlyNoticeBody/);
    assert.match(locale, /zfStagingReview\.detail\.fingerprint/);
  }
  assert.match(css, /\.catalog-zf-staging-review-page/);
  assert.match(css, /\.catalog-zf-staging-review-detail/);
  assert.match(css, /@media \(max-width: 1180px\)/);
});
