import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("planner migration is tenant-scoped, review-only, and service-role-only", async () => {
  const sql = await read("supabase/migrations/20260815122145_mira_autonomous_catalog_planner.sql");
  assert.match(sql, /create or replace function public\.plan_mira_catalog_missions/);
  assert.match(sql, /security definer\s+set search_path = public, pg_temp/i);
  assert.match(sql, /revoke all on function public\.plan_mira_catalog_missions[\s\S]*from public, anon, authenticated/i);
  assert.match(sql, /grant execute on function public\.plan_mira_catalog_missions[\s\S]*to service_role/i);
  assert.match(sql, /alter table public\.mira_planner_runs enable row level security/i);
  assert.match(sql, /writeDisposition.*observation-staging-only/i);
  assert.doesNotMatch(sql, /(?:insert|update|delete)\s+into?\s+public\.catalog_products/i);
});

test("planner is pinned to the admitted PartsFinder image observation route", async () => {
  const sql = await read("supabase/migrations/20260815122145_mira_autonomous_catalog_planner.sql");
  assert.match(sql, /bilstein_group_partsfinder_observation/g);
  assert.match(sql, /image_reference/g);
  assert.match(sql, /sync_mode = 'observation_only'/g);
  assert.match(sql, /target_brand text/);
  assert.match(sql, /requested_fields text\[\]/);
  assert.match(sql, /max_items integer/);
});

test("online MIRA exposes an explicit planner action and surfaces planner context", async () => {
  const api = await read("apps/web/src/infrastructure/api/miraMissionsApi.ts");
  const page = await read("apps/web/src/presentation/pages/MiraMissionDeskPage.tsx");
  const fn = await read("netlify/functions/mira-missions.mts");
  assert.match(api, /planMiraMissions/);
  assert.match(api, /planner=run/);
  assert.match(page, /MIRA sıradaki işi seçsin/);
  assert.match(page, /planner_reason/);
  assert.match(fn, /searchParams\.get\("planner"\)/);
  assert.match(fn, /=== "run"/);
  assert.match(fn, /plan_mira_catalog_missions/);
});

test("MIRA planner can be paused and operator packages allow up to 1000 items", async () => {
  const migration = await read("supabase/migrations/20260901103000_mira_planner_pause_and_package_limit.sql");
  const fn = await read("netlify/functions/mira-missions.mts");
  const page = await read("apps/web/src/presentation/pages/MiraMissionDeskPage.tsx");
  assert.match(migration, /mira_planner_controls/);
  assert.match(migration, /febi_image_reference/);
  assert.match(migration, /status', 'disabled'/);
  assert.match(migration, /max_items between 1 and 1000/);
  assert.match(fn, /maxItems > 1000/);
  assert.match(page, /max=\"1000\"/);
});

test("MIRA results expose a human catalog review gate without automatic writes", async () => {
  const migration = await read("supabase/migrations/20260901120000_mira_mission_catalog_review_gate.sql");
  const api = await read("apps/web/src/infrastructure/api/miraMissionsApi.ts");
  const page = await read("apps/web/src/presentation/pages/MiraMissionDeskPage.tsx");
  const fn = await read("netlify/functions/mira-missions.mts");
  assert.match(migration, /catalog_review_status/);
  assert.match(migration, /pending.*approved.*rejected/s);
  assert.match(api, /reviewMiraMission/);
  assert.match(page, /İçeri almayı onayla/);
  assert.match(page, /Yüklenmeyen/);
  assert.match(fn, /review.*record/);
  assert.match(fn, /catalogWrite: false/);
});
