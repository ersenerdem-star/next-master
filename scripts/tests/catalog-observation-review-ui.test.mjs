import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const route = "/catalog/observation-review";
const runId = "11581bfd-3a12-43d5-bb39-d6aa09e3bd96";

async function read(path) {
  return readFile(new URL(`../../${path}`, import.meta.url), "utf8");
}

test("Catalog observation review route and role guard are wired", async () => {
  const [app, appShell, roles] = await Promise.all([
    read("apps/web/src/app/App.tsx"),
    read("apps/web/src/presentation/layout/AppShell.tsx"),
    read("apps/web/src/shared/roles.ts"),
  ]);

  assert.match(app, new RegExp(`CATALOG_OBSERVATION_REVIEW_PATH = "${route}"`));
  assert.match(app, /canAccessCatalogReviewModules/);
  assert.match(app, /CatalogObservationReviewPage/);
  assert.match(app, /errors\.catalogReviewAccessDenied/);
  assert.match(appShell, /CatalogReview/);
  assert.match(roles, /export function canAccessCatalogReviewModules/);
  assert.match(roles, /return isAdminLikeRole\(role\)/);
});

test("Catalog observation review API client uses authenticated GET with organization and run context", async () => {
  const api = await read("apps/web/src/infrastructure/api/catalogObservationReviewApi.ts");

  assert.match(api, /getCurrentOrgId/);
  assert.match(api, /supabaseClient\.auth\.getSession/);
  assert.match(api, /\/api\/catalog\/observation-review/);
  assert.match(api, /url\.searchParams\.set\("organization_id", organizationId\)/);
  assert.match(api, /url\.searchParams\.set\("run_id", input\.runId\)/);
  assert.match(api, /method: "GET"/);
  assert.match(api, /AbortSignal/);
  assert.doesNotMatch(api, /method: "(POST|PUT|PATCH|DELETE)"/);
  assert.doesNotMatch(api, /\.from\(/);
});

test("Catalog observation review page preserves read-only URL-backed workspace state", async () => {
  const page = await read("apps/web/src/presentation/pages/CatalogObservationReviewPage.tsx");

  assert.match(page, new RegExp(runId));
  assert.match(page, /field_family/);
  assert.match(page, /comparison_result/);
  assert.match(page, /recommendation/);
  assert.match(page, /filters\.pageSize/);
  assert.match(page, /limit/);
  assert.match(page, /selected/);
  assert.match(page, /table\.statusPriority/);
  assert.match(page, /table\.details/);
  assert.match(page, /cursor/);
  assert.match(page, /window\.history\.replaceState/);
  assert.match(page, /requestAnimationFrame/);
  assert.match(page, /target="_blank"/);
  assert.match(page, /rel="noopener noreferrer"/);
  assert.doesNotMatch(page, /acceptReview|rejectReview|applyReview|publishReview/i);
  assert.doesNotMatch(page, /method: "(POST|PUT|PATCH|DELETE)"/);
  assert.doesNotMatch(page, /supabaseClient\.from/);
});

test("Catalog observation review translations include read-only and advisory labels", async () => {
  const [en, tr] = await Promise.all([
    read("apps/web/src/i18n/locales/en.ts"),
    read("apps/web/src/i18n/locales/tr.ts"),
  ]);

  for (const locale of [en, tr]) {
    assert.match(locale, /observationReview\.readOnlyNoticeBody/);
    assert.match(locale, /observationReview\.recommendations\.autoSafe/);
    assert.match(locale, /observationReview\.detail\.unassigned/);
    assert.match(locale, /observationReview\.detail\.notDecided/);
    assert.match(locale, /catalogReviewAccessDenied/);
  }
  assert.match(en, /High-confidence recommendation/);
  assert.match(tr, /Yüksek güvenli öneri/);
});
