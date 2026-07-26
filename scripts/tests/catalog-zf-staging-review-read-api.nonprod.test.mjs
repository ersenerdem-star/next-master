import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import test from "node:test";

const localProjectDir = process.env.NM_LOCAL_SUPABASE_PROJECT_DIR;
const localDbContainer = process.env.NM_LOCAL_SUPABASE_DB_CONTAINER;
const enabled = Boolean(localProjectDir && localDbContainer);

test(
  "local Supabase proves the ZF staging review caller-token and tenant boundary",
  { skip: enabled ? false : "set the two NM_LOCAL_SUPABASE_* evidence variables" },
  async (t) => {
    assert.match(
      localDbContainer,
      /^supabase_db_[a-z0-9_-]+$/,
      "only a named local Supabase DB container is allowed",
    );

    const local = loadLocalSupabaseStatus(localProjectDir);
    assert.match(
      local.API_URL,
      /^http:\/\/(127\.0\.0\.1|localhost):[0-9]+$/,
      "evidence may run only against a loopback Supabase API",
    );
    for (const key of ["ANON_KEY", "SERVICE_ROLE_KEY"]) {
      assert.equal(typeof local[key], "string");
      assert.ok(local[key].length > 20);
    }

    const ids = fixtureIds();
    const users = [];
    let fixtureInstalled = false;

    try {
      users.push(
        await createLocalUser(local, "admin-a"),
        await createLocalUser(local, "superadmin-b"),
        await createLocalUser(local, "viewer-a"),
      );
      const [adminA, superadminB, viewerA] = users;

      runSql(buildFixtureSql(ids, { adminA, superadminB, viewerA }));
      fixtureInstalled = true;

      const [adminAToken, superadminBToken, viewerAToken] = await Promise.all([
        signInLocalUser(local, adminA),
        signInLocalUser(local, superadminB),
        signInLocalUser(local, viewerA),
      ]);

      globalThis.Netlify = {
        env: {
          get(name) {
            if (name === "SUPABASE_URL") return local.API_URL;
            if (name === "SUPABASE_ANON_KEY") return local.ANON_KEY;
            if (name === "SUPABASE_SERVICE_ROLE_KEY") {
              return local.SERVICE_ROLE_KEY;
            }
            return undefined;
          },
        },
      };
      const { handleCatalogZfStagingReviewRequest } = await import(
        "../../netlify/functions/catalog-zf-group-staging-review.mts"
      );

      await t.test("authenticated admin sees only the caller tenant", async () => {
        const direct = await dataApiRead(
          local,
          adminAToken,
          "select=id,organization_id&order=created_at.desc,id.desc",
        );
        assert.equal(direct.response.status, 200);
        assert.equal(direct.body.length, 2);
        assert.deepEqual(
          new Set(direct.body.map((row) => row.organization_id)),
          new Set([ids.organizationA]),
        );

        const response = await callRoute(
          handleCatalogZfStagingReviewRequest,
          adminAToken,
          "?brand=ZF&limit=1",
        );
        const body = await readJson(response);
        assert.equal(response.status, 200);
        assert.equal(body.organization_id, ids.organizationA);
        assert.equal(body.items.length, 1);
        assert.equal(body.items[0].id, ids.candidateA1);
        assert.equal(body.items[0].organization_id, ids.organizationA);
        assert.equal(body.page.has_more, true);
        assert.equal(typeof body.page.next_cursor, "string");

        const next = await callRoute(
          handleCatalogZfStagingReviewRequest,
          adminAToken,
          `?brand=ZF&limit=1&cursor=${encodeURIComponent(
            body.page.next_cursor,
          )}`,
        );
        const nextBody = await readJson(next);
        assert.equal(next.status, 200);
        assert.equal(nextBody.items.length, 1);
        assert.equal(nextBody.items[0].id, ids.candidateA2);
        assert.equal(nextBody.page.has_more, false);
      });

      await t.test(
        "superadmin remains bound to its own immutable profile organization",
        async () => {
          const response = await callRoute(
            handleCatalogZfStagingReviewRequest,
            superadminBToken,
          );
          const body = await readJson(response);
          assert.equal(response.status, 200);
          assert.equal(body.organization_id, ids.organizationB);
          assert.equal(body.items.length, 1);
          assert.equal(body.items[0].id, ids.candidateB1);
          assert.equal(body.items[0].organization_id, ids.organizationB);
        },
      );

      await t.test(
        "cross-tenant candidate and cursor reuse disclose no foreign row",
        async () => {
          const candidateResponse = await callRoute(
            handleCatalogZfStagingReviewRequest,
            adminAToken,
            `?candidate_id=${ids.candidateB1}`,
          );
          assert.equal(candidateResponse.status, 404);

          const firstPage = await callRoute(
            handleCatalogZfStagingReviewRequest,
            adminAToken,
            "?limit=1",
          );
          const firstBody = await readJson(firstPage);
          assert.equal(firstPage.status, 200);

          const reusedCursor = await callRoute(
            handleCatalogZfStagingReviewRequest,
            superadminBToken,
            `?limit=1&cursor=${encodeURIComponent(
              firstBody.page.next_cursor,
            )}`,
          );
          assert.equal(reusedCursor.status, 400);
        },
      );

      await t.test(
        "tenant selectors and unaccepted roles fail before staging projection access",
        async () => {
          const selector = await callRoute(
            handleCatalogZfStagingReviewRequest,
            adminAToken,
            `?organization_id=${ids.organizationB}`,
          );
          assert.equal(selector.status, 400);

          const viewer = await callRoute(
            handleCatalogZfStagingReviewRequest,
            viewerAToken,
          );
          assert.equal(viewer.status, 403);
        },
      );

      await t.test("anonymous and unsupported methods are rejected", async () => {
        const anonymous = await callRoute(
          handleCatalogZfStagingReviewRequest,
          "",
        );
        assert.equal(anonymous.status, 401);

        const post = await callRoute(
          handleCatalogZfStagingReviewRequest,
          adminAToken,
          "",
          "POST",
        );
        assert.equal(post.status, 405);
      });

      await t.test(
        "anon and service-role cannot read the projection directly",
        async () => {
          const anon = await dataApiRead(local, "", "select=id");
          assert.ok([401, 403].includes(anon.response.status));
          assert.equal(Array.isArray(anon.body) && anon.body.length > 0, false);

          const privileged = await dataApiRead(
            local,
            local.SERVICE_ROLE_KEY,
            "select=id",
            local.SERVICE_ROLE_KEY,
          );
          assert.ok([401, 403].includes(privileged.response.status));
          assert.equal(
            Array.isArray(privileged.body) && privileged.body.length > 0,
            false,
          );
        },
      );

      await t.test(
        "read calls create no Product, review, Guardian, Apply, or staging mutation",
        () => {
          const counts = readBoundaryCounts(ids);
          assert.deepEqual(counts, {
            candidates: 3,
            events: 3,
            products: 0,
            reviewDecisions: 0,
            applyEvents: 0,
          });
        },
      );
    } finally {
      if (fixtureInstalled) {
        cleanupFixture(ids);
      }
      for (const user of users.reverse()) {
        await deleteLocalUser(local, user.id);
      }
      if (fixtureInstalled) {
        assert.deepEqual(readBoundaryCounts(ids), {
          candidates: 0,
          events: 0,
          products: 0,
          reviewDecisions: 0,
          applyEvents: 0,
        });
      }
      delete globalThis.Netlify;
    }
  },
);

function loadLocalSupabaseStatus(projectDir) {
  const result = spawnSync(
    "npx",
    ["supabase", "status", "--output", "json"],
    {
      cwd: projectDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.status !== 0) {
    throw new Error("Local Supabase status is unavailable");
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error("Local Supabase status was not valid JSON");
  }
}

function fixtureIds() {
  return {
    organizationA: randomUUID(),
    organizationB: randomUUID(),
    brandA: randomUUID(),
    brandB: randomUUID(),
    sourceA: randomUUID(),
    sourceB: randomUUID(),
    trustA: randomUUID(),
    trustB: randomUUID(),
    jobA: randomUUID(),
    jobB: randomUUID(),
    runA: randomUUID(),
    runB: randomUUID(),
    candidateA1: randomUUID(),
    candidateA2: randomUUID(),
    candidateB1: randomUUID(),
  };
}

async function createLocalUser(local, label) {
  const suffix = randomUUID().replaceAll("-", "");
  const user = {
    email: `zf-read-evidence-${label}-${suffix}@example.invalid`,
    password: `Local-${randomUUID()}!`,
  };
  const response = await fetch(`${local.API_URL}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      apikey: local.SERVICE_ROLE_KEY,
      Authorization: `Bearer ${local.SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email: user.email,
      password: user.password,
      email_confirm: true,
    }),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.id) {
    throw new Error("Local evidence user provisioning failed");
  }
  return { ...user, id: body.id };
}

async function signInLocalUser(local, user) {
  const response = await fetch(
    `${local.API_URL}/auth/v1/token?grant_type=password`,
    {
      method: "POST",
      headers: {
        apikey: local.ANON_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email: user.email,
        password: user.password,
      }),
    },
  );
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.access_token) {
    throw new Error("Local evidence sign-in failed");
  }
  return body.access_token;
}

async function deleteLocalUser(local, userId) {
  await fetch(`${local.API_URL}/auth/v1/admin/users/${userId}`, {
    method: "DELETE",
    headers: {
      apikey: local.SERVICE_ROLE_KEY,
      Authorization: `Bearer ${local.SERVICE_ROLE_KEY}`,
    },
  }).catch(() => null);
}

async function callRoute(handler, token, query = "", method = "GET") {
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  return handler(
    new Request(
      `http://127.0.0.1/api/catalog/zf-group/staging-review${query}`,
      { method, headers },
    ),
    {},
  );
}

async function dataApiRead(local, token, query, apiKey = local.ANON_KEY) {
  const headers = { apikey: apiKey };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(
    `${local.API_URL}/rest/v1/catalog_zf_new_product_staging_review_v?${query}`,
    { method: "GET", headers },
  );
  return {
    response,
    body: await response.json().catch(() => null),
  };
}

async function readJson(response) {
  return response.json().catch(() => null);
}

function runSql(sql) {
  const result = spawnSync(
    "docker",
    [
      "exec",
      "-i",
      localDbContainer,
      "psql",
      "-U",
      "postgres",
      "-d",
      "postgres",
      "-X",
      "-v",
      "ON_ERROR_STOP=1",
      "-q",
    ],
    {
      input: sql,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  if (result.status !== 0) {
    throw new Error("Local evidence SQL failed");
  }
  return result.stdout.trim();
}

function buildFixtureSql(ids, users) {
  return `
begin;

insert into public.organizations (id, name)
values
  ('${ids.organizationA}', 'ZF Read Evidence Tenant A'),
  ('${ids.organizationB}', 'ZF Read Evidence Tenant B');

insert into public.profiles (
  id, organization_id, email, full_name, role, is_active
)
values
  (
    '${users.adminA.id}',
    '${ids.organizationA}',
    '${users.adminA.email}',
    'ZF Evidence Admin A',
    'admin',
    true
  ),
  (
    '${users.superadminB.id}',
    '${ids.organizationB}',
    '${users.superadminB.email}',
    'ZF Evidence Superadmin B',
    'superadmin',
    true
  ),
  (
    '${users.viewerA.id}',
    '${ids.organizationA}',
    '${users.viewerA.email}',
    'ZF Evidence Viewer A',
    'viewer',
    true
  );

insert into public.brands (id, organization_id, name)
values
  ('${ids.brandA}', '${ids.organizationA}', 'ZF'),
  ('${ids.brandB}', '${ids.organizationB}', 'ZF');

insert into public.catalog_external_sources (
  id,
  organization_id,
  source_key,
  display_name,
  source_type,
  base_url,
  license_posture,
  robots_posture,
  rate_limit_posture,
  credential_boundary
)
values
  (
    '${ids.sourceA}',
    '${ids.organizationA}',
    'zf_read_evidence',
    'ZF Read Evidence',
    'manufacturer',
    'https://aftermarket.zf.com',
    'allowed',
    'allowed',
    'bounded',
    'no provider credential'
  ),
  (
    '${ids.sourceB}',
    '${ids.organizationB}',
    'zf_read_evidence',
    'ZF Read Evidence',
    'manufacturer',
    'https://aftermarket.zf.com',
    'allowed',
    'allowed',
    'bounded',
    'no provider credential'
  );

insert into public.catalog_external_source_trust_profiles (
  id, organization_id, source_id, trust_level
)
values
  ('${ids.trustA}', '${ids.organizationA}', '${ids.sourceA}', 'T2'),
  ('${ids.trustB}', '${ids.organizationB}', '${ids.sourceB}', 'T2');

insert into public.catalog_observation_jobs (
  id,
  organization_id,
  source_id,
  trust_profile_id,
  brand_id,
  job_key,
  status
)
values
  (
    '${ids.jobA}',
    '${ids.organizationA}',
    '${ids.sourceA}',
    '${ids.trustA}',
    '${ids.brandA}',
    'zf-read-evidence',
    'active'
  ),
  (
    '${ids.jobB}',
    '${ids.organizationB}',
    '${ids.sourceB}',
    '${ids.trustB}',
    '${ids.brandB}',
    'zf-read-evidence',
    'active'
  );

insert into public.catalog_observation_runs (
  id,
  organization_id,
  job_id,
  source_id,
  brand_id,
  status,
  finished_at,
  contract_version,
  idempotency_key,
  request_fingerprint,
  provider_key,
  runtime_commit,
  requested_candidate_limit,
  effective_candidate_limit,
  redaction_profile_version,
  runtime_policy_version,
  completion_class
)
values
  (
    '${ids.runA}',
    '${ids.organizationA}',
    '${ids.jobA}',
    '${ids.sourceA}',
    '${ids.brandA}',
    'succeeded',
    now(),
    '1.0.0',
    'zf-read-evidence-a',
    repeat('1', 64),
    'zf_aftermarket',
    '6b634a232021d01df45bbd7370b7790fa8acf8e3',
    1,
    1,
    'catalog-source-evidence-redaction.v1',
    'zf-staging-runtime-ingestion.v1',
    'SUCCEEDED'
  ),
  (
    '${ids.runB}',
    '${ids.organizationB}',
    '${ids.jobB}',
    '${ids.sourceB}',
    '${ids.brandB}',
    'succeeded',
    now(),
    '1.0.0',
    'zf-read-evidence-b',
    repeat('2', 64),
    'zf_aftermarket',
    '6b634a232021d01df45bbd7370b7790fa8acf8e3',
    1,
    1,
    'catalog-source-evidence-redaction.v1',
    'zf-staging-runtime-ingestion.v1',
    'SUCCEEDED'
  );

insert into public.catalog_new_product_staging_candidates (
  id,
  organization_id,
  source_id,
  brand_id,
  job_id,
  run_id,
  sequence_no,
  contract_version,
  candidate_version,
  proposed_display_code,
  normalized_code,
  official_source_display_code,
  official_comparison_key,
  official_source_reference,
  description,
  ean,
  origin,
  weight_kg,
  oem_references,
  vehicle_applications,
  fitment_facts,
  engine_facts,
  lifecycle_status,
  replacement_candidates,
  supersession_candidates,
  official_image_candidate_url,
  official_image_evidence_reference,
  official_source_url,
  observed_at,
  evidence_hash,
  payload_fingerprint,
  observation_fingerprint,
  limitation_flags,
  source_schema_version,
  runtime_commit,
  redaction_profile_version,
  created_at
)
values
  (
    '${ids.candidateA1}',
    '${ids.organizationA}',
    '${ids.sourceA}',
    '${ids.brandA}',
    '${ids.jobA}',
    '${ids.runA}',
    1,
    '1.0.0',
    1,
    'ZF-EVIDENCE-A1',
    'ZF-EVIDENCE-A1',
    'ZF-EVIDENCE-A1',
    'ZFEVIDENCEA1',
    'zf-evidence-a1',
    'Local non-production evidence candidate A1',
    '4000000000001',
    'DE',
    1.2500,
    '["OE-A1"]'::jsonb,
    '[{"make":"Fixture","model":"A1"}]'::jsonb,
    '["front"]'::jsonb,
    '["diesel"]'::jsonb,
    'active',
    '[]'::jsonb,
    '[]'::jsonb,
    'https://aftermarket.zf.com/fixture/a1.webp',
    'zf-image-evidence-a1',
    'https://aftermarket.zf.com/fixture/a1',
    now() - interval '1 minute',
    repeat('a', 64),
    repeat('b', 64),
    repeat('c', 64),
    array['local-non-production'],
    'zf-read-evidence.v1',
    '6b634a232021d01df45bbd7370b7790fa8acf8e3',
    'catalog-source-evidence-redaction.v1',
    now() - interval '1 minute'
  ),
  (
    '${ids.candidateA2}',
    '${ids.organizationA}',
    '${ids.sourceA}',
    '${ids.brandA}',
    '${ids.jobA}',
    '${ids.runA}',
    2,
    '1.0.0',
    1,
    'ZF-EVIDENCE-A2',
    'ZF-EVIDENCE-A2',
    'ZF-EVIDENCE-A2',
    'ZFEVIDENCEA2',
    'zf-evidence-a2',
    'Local non-production evidence candidate A2',
    '4000000000002',
    'DE',
    2.5000,
    '["OE-A2"]'::jsonb,
    '[{"make":"Fixture","model":"A2"}]'::jsonb,
    '["rear"]'::jsonb,
    '["petrol"]'::jsonb,
    'active',
    '[]'::jsonb,
    '[]'::jsonb,
    'https://aftermarket.zf.com/fixture/a2.webp',
    'zf-image-evidence-a2',
    'https://aftermarket.zf.com/fixture/a2',
    now() - interval '2 minutes',
    repeat('d', 64),
    repeat('e', 64),
    repeat('f', 64),
    array['local-non-production'],
    'zf-read-evidence.v1',
    '6b634a232021d01df45bbd7370b7790fa8acf8e3',
    'catalog-source-evidence-redaction.v1',
    now() - interval '2 minutes'
  ),
  (
    '${ids.candidateB1}',
    '${ids.organizationB}',
    '${ids.sourceB}',
    '${ids.brandB}',
    '${ids.jobB}',
    '${ids.runB}',
    1,
    '1.0.0',
    1,
    'ZF-EVIDENCE-B1',
    'ZF-EVIDENCE-B1',
    'ZF-EVIDENCE-B1',
    'ZFEVIDENCEB1',
    'zf-evidence-b1',
    'Local non-production evidence candidate B1',
    '4000000000003',
    'DE',
    3.7500,
    '["OE-B1"]'::jsonb,
    '[{"make":"Fixture","model":"B1"}]'::jsonb,
    '["front"]'::jsonb,
    '["diesel"]'::jsonb,
    'active',
    '[]'::jsonb,
    '[]'::jsonb,
    'https://aftermarket.zf.com/fixture/b1.webp',
    'zf-image-evidence-b1',
    'https://aftermarket.zf.com/fixture/b1',
    now(),
    repeat('7', 64),
    repeat('8', 64),
    repeat('9', 64),
    array['local-non-production'],
    'zf-read-evidence.v1',
    '6b634a232021d01df45bbd7370b7790fa8acf8e3',
    'catalog-source-evidence-redaction.v1',
    now()
  );

insert into public.catalog_new_product_staging_events (
  organization_id,
  candidate_id,
  event_version,
  expected_prior_version,
  event_type,
  reason_code,
  idempotency_key,
  event_fingerprint
)
values
  (
    '${ids.organizationA}',
    '${ids.candidateA1}',
    1,
    0,
    'STAGED',
    'LOCAL_NON_PRODUCTION_EVIDENCE',
    'zf-read-evidence-a1',
    repeat('3', 64)
  ),
  (
    '${ids.organizationA}',
    '${ids.candidateA2}',
    1,
    0,
    'STAGED',
    'LOCAL_NON_PRODUCTION_EVIDENCE',
    'zf-read-evidence-a2',
    repeat('4', 64)
  ),
  (
    '${ids.organizationB}',
    '${ids.candidateB1}',
    1,
    0,
    'STAGED',
    'LOCAL_NON_PRODUCTION_EVIDENCE',
    'zf-read-evidence-b1',
    repeat('5', 64)
  );

commit;
`;
}

function cleanupFixture(ids) {
  runSql(`
begin;
set local session_replication_role = replica;
delete from public.catalog_new_product_staging_events
where organization_id in ('${ids.organizationA}', '${ids.organizationB}');
delete from public.catalog_new_product_staging_candidates
where organization_id in ('${ids.organizationA}', '${ids.organizationB}');
delete from public.catalog_observation_runs
where organization_id in ('${ids.organizationA}', '${ids.organizationB}');
delete from public.catalog_observation_jobs
where organization_id in ('${ids.organizationA}', '${ids.organizationB}');
delete from public.catalog_external_source_trust_profiles
where organization_id in ('${ids.organizationA}', '${ids.organizationB}');
delete from public.catalog_external_sources
where organization_id in ('${ids.organizationA}', '${ids.organizationB}');
delete from public.brands
where organization_id in ('${ids.organizationA}', '${ids.organizationB}');
delete from public.profiles
where organization_id in ('${ids.organizationA}', '${ids.organizationB}');
delete from public.organizations
where id in ('${ids.organizationA}', '${ids.organizationB}');
commit;
`);
}

function readBoundaryCounts(ids) {
  const output = runSql(`
select json_build_object(
  'candidates',
  (
    select count(*)
    from public.catalog_new_product_staging_candidates
    where organization_id in ('${ids.organizationA}', '${ids.organizationB}')
  ),
  'events',
  (
    select count(*)
    from public.catalog_new_product_staging_events
    where organization_id in ('${ids.organizationA}', '${ids.organizationB}')
  ),
  'products',
  (
    select count(*)
    from public.catalog_products
    where organization_id in ('${ids.organizationA}', '${ids.organizationB}')
  ),
  'reviewDecisions',
  (
    select count(*)
    from public.catalog_observation_review_decisions
    where organization_id in ('${ids.organizationA}', '${ids.organizationB}')
  ),
  'applyEvents',
  (
    select count(*)
    from public.catalog_apply_events
    where organization_id in ('${ids.organizationA}', '${ids.organizationB}')
  )
);
`);
  const jsonLine = output
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("{"));
  if (!jsonLine) throw new Error("Local evidence count query failed");
  const parsed = JSON.parse(jsonLine);
  return Object.fromEntries(
    Object.entries(parsed).map(([key, value]) => [key, Number(value)]),
  );
}
