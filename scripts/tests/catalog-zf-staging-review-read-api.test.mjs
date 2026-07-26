import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildCatalogZfStagingReviewResponse,
  buildCatalogZfStagingReviewRestParams,
  CatalogZfStagingReviewDbError,
  CatalogZfStagingReviewError,
  createCatalogZfStagingReviewReadDb,
  decodeCatalogZfStagingReviewCursor,
  encodeCatalogZfStagingReviewCursor,
  parseCatalogZfStagingReviewQuery,
  ZF_STAGING_REVIEW_COLUMNS,
  ZF_STAGING_REVIEW_DEFAULT_LIMIT,
  ZF_STAGING_REVIEW_MAX_LIMIT,
  ZF_STAGING_REVIEW_SCHEMA_VERSION,
  ZF_STAGING_REVIEW_VIEW,
} from "../../netlify/functions/_shared/catalog/catalog-zf-staging-review-read-api.mjs";
import {
  config,
  handleCatalogZfStagingReviewRequest,
} from "../../netlify/functions/catalog-zf-group-staging-review.mts";

const routeSource = await readFile(
  new URL(
    "../../netlify/functions/catalog-zf-group-staging-review.mts",
    import.meta.url,
  ),
  "utf8",
);
const readSource = await readFile(
  new URL(
    "../../netlify/functions/_shared/catalog/catalog-zf-staging-review-read-api.mjs",
    import.meta.url,
  ),
  "utf8",
);

const IDS = Object.freeze({
  organizationId: "11111111-1111-4111-8111-111111111111",
  otherOrganizationId: "22222222-2222-4222-8222-222222222222",
  candidateId: "33333333-3333-4333-8333-333333333333",
  secondCandidateId: "44444444-4444-4444-8444-444444444444",
  brandId: "55555555-5555-4555-8555-555555555555",
  runId: "66666666-6666-4666-8666-666666666666",
  jobId: "77777777-7777-4777-8777-777777777777",
  sourceId: "88888888-8888-4888-8888-888888888888",
});

function baseQuery(overrides = {}) {
  return {
    candidate_id: "",
    run_id: "",
    brand: "",
    latest_event_type: "",
    quarantine: "all",
    cursor: "",
    limit: 25,
    ...overrides,
  };
}

function stagingRow(overrides = {}) {
  return {
    id: IDS.candidateId,
    organization_id: IDS.organizationId,
    brand_id: IDS.brandId,
    brand: "ZF",
    proposed_display_code: "0071.315.002",
    normalized_code: "0071.315.002",
    official_source_display_code: "0071.315.002",
    official_comparison_key: "0071315002",
    description: "Official ZF staging candidate",
    ean: "4028977900001",
    hs_code: "8708.99",
    origin: "DE",
    weight_kg: 1.25,
    oem_references: ["OE-001"],
    vehicle_applications: [{ make: "Example", model: "Model A" }],
    fitment_facts: ["front"],
    engine_facts: ["diesel"],
    lifecycle_status: "active",
    lifecycle_note: null,
    replacement_candidates: [],
    supersession_candidates: [],
    official_image_candidate_url:
      "https://aftermarket.zf.com/catalog/images/0071315002.webp",
    official_image_evidence_reference: "zf-image:0071315002",
    official_source_url:
      "https://aftermarket.zf.com/catalog/products/0071315002",
    observed_at: "2026-07-27T08:30:00.000Z",
    evidence_hash: "a".repeat(64),
    payload_fingerprint: "b".repeat(64),
    observation_fingerprint: "c".repeat(64),
    candidate_version: 1,
    supersedes_candidate_id: null,
    quarantine_class: null,
    limitation_flags: ["fixture-only"],
    source_schema_version: "zf-official-observation.v1",
    runtime_commit: "6b634a232021d01df45bbd7370b7790fa8acf8e3",
    deploy_id: null,
    created_at: "2026-07-27T08:31:00.000Z",
    latest_event_type: "STAGED",
    latest_event_version: 1,
    latest_event_reason_code: "NEW_OFFICIAL_PRODUCT",
    latest_event_at: "2026-07-27T08:31:01.000Z",
    run_id: IDS.runId,
    job_id: IDS.jobId,
    source_id: IDS.sourceId,
    contract_version: "1.0.0",
    ...overrides,
  };
}

function assertCatalogError(status) {
  return (error) =>
    error instanceof CatalogZfStagingReviewError && error.status === status;
}

async function responseBody(response) {
  return JSON.parse(await response.text());
}

function handlerDeps(overrides = {}) {
  return {
    env: {
      get(name) {
        if (name === "SUPABASE_URL") return "https://example.supabase.co";
        if (name === "SUPABASE_ANON_KEY") return "publishable-anon-key";
        return undefined;
      },
    },
    requireCallerProfile: async () => ({
      profile: {
        id: "99999999-9999-4999-8999-999999999999",
        organization_id: IDS.organizationId,
        role: "admin",
      },
    }),
    createCatalogZfStagingReviewReadDb: () => ({
      list: async () => [stagingRow()],
    }),
    ...overrides,
  };
}

test("query parser defaults to a bounded read-only page", () => {
  const query = parseCatalogZfStagingReviewQuery(
    "https://portal.next-master.com/api/catalog/zf-group/staging-review",
  );

  assert.deepEqual(query, baseQuery());
  assert.equal(query.limit, ZF_STAGING_REVIEW_DEFAULT_LIMIT);
  assert.equal(ZF_STAGING_REVIEW_MAX_LIMIT, 50);
});

test("query parser accepts only the canonical filter set", () => {
  const query = parseCatalogZfStagingReviewQuery(
    `https://portal.next-master.com/api/catalog/zf-group/staging-review?` +
      `candidate_id=${IDS.candidateId}&run_id=${IDS.runId}&brand=TRW&` +
      "latest_event_type=QUARANTINED&quarantine=quarantined&limit=50",
  );

  assert.deepEqual(
    query,
    baseQuery({
      candidate_id: IDS.candidateId,
      run_id: IDS.runId,
      brand: "TRW",
      latest_event_type: "QUARANTINED",
      quarantine: "quarantined",
      limit: 50,
    }),
  );
});

test("tenant selectors, unknown fields, duplicates, empty values, and malformed filters fail closed", () => {
  const invalidUrls = [
    "?organization_id=11111111-1111-4111-8111-111111111111",
    "?tenant=other",
    "?limit=10&limit=20",
    "?brand=",
    "?brand=TRW%20Engine%20Components",
    "?brand=zf",
    "?candidate_id=not-a-uuid",
    "?run_id=not-a-uuid",
    "?latest_event_type=APPLIED",
    "?quarantine=unknown",
    "?limit=0",
    "?limit=51",
    "?limit=1.5",
    "?cursor=%2B%2F%3D",
  ];

  for (const suffix of invalidUrls) {
    assert.throws(
      () =>
        parseCatalogZfStagingReviewQuery(
          `https://portal.next-master.com/api/catalog/zf-group/staging-review${suffix}`,
        ),
      assertCatalogError(400),
      suffix,
    );
  }
});

test("cursor is tenant-bound, filter-bound, versioned, and tamper evident", () => {
  const query = baseQuery({ brand: "Sachs", limit: 1 });
  const cursor = encodeCatalogZfStagingReviewCursor({
    organizationId: IDS.organizationId,
    query,
    createdAt: "2026-07-27T08:31:00.000Z",
    id: IDS.candidateId,
  });

  assert.deepEqual(
    decodeCatalogZfStagingReviewCursor({
      cursor,
      organizationId: IDS.organizationId,
      query,
    }),
    {
      createdAt: "2026-07-27T08:31:00.000Z",
      id: IDS.candidateId,
    },
  );
  assert.throws(
    () =>
      decodeCatalogZfStagingReviewCursor({
        cursor,
        organizationId: IDS.otherOrganizationId,
        query,
      }),
    assertCatalogError(400),
  );
  assert.throws(
    () =>
      decodeCatalogZfStagingReviewCursor({
        cursor,
        organizationId: IDS.organizationId,
        query: { ...query, brand: "ZF" },
      }),
    assertCatalogError(400),
  );

  const decoded = JSON.parse(
    Buffer.from(cursor, "base64url").toString("utf8"),
  );
  decoded.p.v = 2;
  const wrongVersion = Buffer.from(JSON.stringify(decoded)).toString(
    "base64url",
  );
  assert.throws(
    () =>
      decodeCatalogZfStagingReviewCursor({
        cursor: wrongVersion,
        organizationId: IDS.organizationId,
        query,
      }),
    assertCatalogError(400),
  );
  assert.throws(
    () =>
      decodeCatalogZfStagingReviewCursor({
        cursor: `${cursor.slice(0, -1)}A`,
        organizationId: IDS.organizationId,
        query,
      }),
    assertCatalogError(400),
  );
});

test("REST query is tenant-scoped, keyset-paginated, exact-column, and limit-plus-one", () => {
  const query = baseQuery({
    candidate_id: IDS.candidateId,
    run_id: IDS.runId,
    brand: "Lemforder",
    latest_event_type: "STAGED",
    quarantine: "eligible",
    limit: 10,
  });
  const params = buildCatalogZfStagingReviewRestParams({
    organizationId: IDS.organizationId,
    query,
    cursorPosition: {
      createdAt: "2026-07-27T08:31:00.000Z",
      id: IDS.candidateId,
    },
    fetchLimit: 11,
  });

  assert.equal(params.select, ZF_STAGING_REVIEW_COLUMNS.join(","));
  assert.equal(params.organization_id, `eq.${IDS.organizationId}`);
  assert.equal(params.id, `eq.${IDS.candidateId}`);
  assert.equal(params.run_id, `eq.${IDS.runId}`);
  assert.equal(params.brand, "eq.Lemforder");
  assert.equal(params.latest_event_type, "eq.STAGED");
  assert.equal(params.quarantine_class, "is.null");
  assert.equal(params.order, "created_at.desc,id.desc");
  assert.equal(params.limit, "11");
  assert.equal(
    params.or,
    `(created_at.lt.2026-07-27T08:31:00.000Z,` +
      `and(created_at.eq.2026-07-27T08:31:00.000Z,id.lt.${IDS.candidateId}))`,
  );
});

test("response exposes the exact allowlist and deterministic page envelope", async () => {
  const rows = [
    stagingRow(),
    stagingRow({
      id: IDS.secondCandidateId,
      created_at: "2026-07-27T08:30:00.000Z",
    }),
  ];
  const query = baseQuery({ limit: 1 });
  const calls = [];

  const result = await buildCatalogZfStagingReviewResponse({
    db: {
      async list(input) {
        calls.push(input);
        return rows;
      },
    },
    organizationId: IDS.organizationId,
    query,
  });

  assert.deepEqual(Object.keys(result), [
    "schema_version",
    "organization_id",
    "items",
    "page",
  ]);
  assert.equal(result.schema_version, ZF_STAGING_REVIEW_SCHEMA_VERSION);
  assert.equal(result.organization_id, IDS.organizationId);
  assert.deepEqual(Object.keys(result.items[0]), [...ZF_STAGING_REVIEW_COLUMNS]);
  assert.equal(result.items.length, 1);
  assert.deepEqual(Object.keys(result.page), [
    "limit",
    "cursor",
    "next_cursor",
    "has_more",
    "returned_count",
  ]);
  assert.equal(result.page.limit, 1);
  assert.equal(result.page.cursor, null);
  assert.equal(result.page.has_more, true);
  assert.equal(result.page.returned_count, 1);
  assert.equal(typeof result.page.next_cursor, "string");
  assert.equal("count" in result.page, false);
  assert.equal(calls[0].organizationId, IDS.organizationId);
  assert.equal(calls[0].fetchLimit, 2);

  const position = decodeCatalogZfStagingReviewCursor({
    cursor: result.page.next_cursor,
    organizationId: IDS.organizationId,
    query,
  });
  assert.deepEqual(position, {
    createdAt: rows[0].created_at,
    id: rows[0].id,
  });
});

test("candidate lookup returns 404 only when the tenant-scoped projection is empty", async () => {
  await assert.rejects(
    buildCatalogZfStagingReviewResponse({
      db: { list: async () => [] },
      organizationId: IDS.organizationId,
      query: baseQuery({ candidate_id: IDS.candidateId }),
    }),
    assertCatalogError(404),
  );
});

test("wrong tenant, unknown columns, unsafe provenance, and malformed rows are contract mismatches", async () => {
  const invalidRows = [
    stagingRow({ organization_id: IDS.otherOrganizationId }),
    { ...stagingRow(), unexpected_secret: "should-never-be-exposed" },
    Object.fromEntries(
      Object.entries(stagingRow()).filter(([key]) => key !== "run_id"),
    ),
    stagingRow({
      official_source_url:
        "https://aftermarket.zf.com/product?access_token=redacted",
    }),
    stagingRow({
      official_image_candidate_url:
        "https://aftermarket.zf.com/product?x-amz-credential=redacted",
    }),
    stagingRow({
      vehicle_applications: [
        { make: "Example", model: "Model A", authorization: "redacted" },
      ],
    }),
    stagingRow({ brand: "TRW Engine Components" }),
    stagingRow({ contract_version: "0.9.0" }),
    stagingRow({ latest_event_type: null }),
  ];

  for (const row of invalidRows) {
    await assert.rejects(
      buildCatalogZfStagingReviewResponse({
        db: { list: async () => [row] },
        organizationId: IDS.organizationId,
        query: baseQuery(),
      }),
      assertCatalogError(409),
    );
  }
});

test("database contract mismatch maps to 409 and database unavailability maps to 503", async () => {
  await assert.rejects(
    buildCatalogZfStagingReviewResponse({
      db: {
        list: async () => {
          throw new CatalogZfStagingReviewDbError("CONTRACT_MISMATCH");
        },
      },
      organizationId: IDS.organizationId,
      query: baseQuery(),
    }),
    assertCatalogError(409),
  );
  await assert.rejects(
    buildCatalogZfStagingReviewResponse({
      db: {
        list: async () => {
          throw new CatalogZfStagingReviewDbError("UNAVAILABLE");
        },
      },
      organizationId: IDS.organizationId,
      query: baseQuery(),
    }),
    assertCatalogError(503),
  );
});

test("default database reader uses only GET, caller bearer token, and publishable key", async () => {
  const calls = [];
  const db = createCatalogZfStagingReviewReadDb({
    supabaseUrl: "https://example.supabase.co",
    supabaseAnonKey: "publishable-anon-key",
    accessToken: "caller-access-token",
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify([stagingRow()]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  const rows = await db.list({
    organizationId: IDS.organizationId,
    query: baseQuery(),
    cursorPosition: null,
    fetchLimit: 26,
  });

  assert.equal(rows.length, 1);
  assert.equal(calls.length, 1);
  assert.match(
    calls[0].url,
    new RegExp(`/rest/v1/${ZF_STAGING_REVIEW_VIEW}\\?`),
  );
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.headers.apikey, "publishable-anon-key");
  assert.equal(
    calls[0].init.headers.Authorization,
    "Bearer caller-access-token",
  );
  assert.equal(
    JSON.stringify(calls[0]).includes("SUPABASE_SERVICE_ROLE_KEY"),
    false,
  );
});

test("default database reader classifies missing projection columns and malformed payloads", async () => {
  const missingColumnDb = createCatalogZfStagingReviewReadDb({
    supabaseUrl: "https://example.supabase.co",
    supabaseAnonKey: "publishable-anon-key",
    accessToken: "caller-access-token",
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          code: "42703",
          message: "column run_id does not exist",
        }),
        { status: 400 },
      ),
  });
  await assert.rejects(
    missingColumnDb.list({
      organizationId: IDS.organizationId,
      query: baseQuery(),
      cursorPosition: null,
      fetchLimit: 26,
    }),
    (error) =>
      error instanceof CatalogZfStagingReviewDbError &&
      error.kind === "CONTRACT_MISMATCH",
  );

  const malformedDb = createCatalogZfStagingReviewReadDb({
    supabaseUrl: "https://example.supabase.co",
    supabaseAnonKey: "publishable-anon-key",
    accessToken: "caller-access-token",
    fetchImpl: async () => new Response(JSON.stringify({ data: [] })),
  });
  await assert.rejects(
    malformedDb.list({
      organizationId: IDS.organizationId,
      query: baseQuery(),
      cursorPosition: null,
      fetchLimit: 26,
    }),
    (error) =>
      error instanceof CatalogZfStagingReviewDbError &&
      error.kind === "CONTRACT_MISMATCH",
  );
});

test("handler guards method and authentication before projection access", async () => {
  let authCalls = 0;
  let dbCalls = 0;
  const deps = handlerDeps({
    requireCallerProfile: async () => {
      authCalls += 1;
      return {
        profile: {
          organization_id: IDS.organizationId,
          role: "admin",
        },
      };
    },
    createCatalogZfStagingReviewReadDb: () => {
      dbCalls += 1;
      return { list: async () => [stagingRow()] };
    },
  });

  const postResponse = await handleCatalogZfStagingReviewRequest(
    new Request(
      "https://portal.next-master.com/api/catalog/zf-group/staging-review",
      { method: "POST" },
    ),
    {},
    deps,
  );
  assert.equal(postResponse.status, 405);

  const anonymousResponse = await handleCatalogZfStagingReviewRequest(
    new Request(
      "https://portal.next-master.com/api/catalog/zf-group/staging-review",
    ),
    {},
    deps,
  );
  assert.equal(anonymousResponse.status, 401);
  assert.equal(authCalls, 0);
  assert.equal(dbCalls, 0);
});

test("handler preserves 401, 403, and unavailable authentication outcomes", async () => {
  const request = new Request(
    "https://portal.next-master.com/api/catalog/zf-group/staging-review",
    { headers: { authorization: "Bearer caller-token" } },
  );

  for (const [status, error] of [
    [401, "Unauthorized"],
    [403, "Forbidden"],
  ]) {
    const response = await handleCatalogZfStagingReviewRequest(
      request.clone(),
      {},
      handlerDeps({
        requireCallerProfile: async () => ({ status, error }),
      }),
    );
    assert.equal(response.status, status);
  }

  const expired = await handleCatalogZfStagingReviewRequest(
    request.clone(),
    {},
    handlerDeps({
      requireCallerProfile: async () => {
        throw new Error("JWT expired");
      },
    }),
  );
  assert.equal(expired.status, 401);

  const unavailable = await handleCatalogZfStagingReviewRequest(
    request.clone(),
    {},
    handlerDeps({
      requireCallerProfile: async () => {
        throw new Error("database unavailable");
      },
    }),
  );
  assert.equal(unavailable.status, 503);
});

test("handler derives organization only from the caller profile and maps read outcomes", async () => {
  const captured = [];
  const requestFor = (suffix = "") =>
    new Request(
      `https://portal.next-master.com/api/catalog/zf-group/staging-review${suffix}`,
      { headers: { authorization: "Bearer caller-token" } },
    );
  const success = await handleCatalogZfStagingReviewRequest(
    requestFor("?brand=ZF&limit=1"),
    {},
    handlerDeps({
      createCatalogZfStagingReviewReadDb: (input) => {
        captured.push(input);
        return {
          list: async (listInput) => {
            captured.push(listInput);
            return [stagingRow()];
          },
        };
      },
    }),
  );

  assert.equal(success.status, 200);
  const successBody = await responseBody(success);
  assert.equal(successBody.organization_id, IDS.organizationId);
  assert.equal(captured[0].accessToken, "caller-token");
  assert.equal(captured[0].supabaseAnonKey, "publishable-anon-key");
  assert.equal(captured[0].serviceRoleKey, undefined);
  assert.equal(captured[1].organizationId, IDS.organizationId);
  assert.equal(captured[1].query.brand, "ZF");

  const invalid = await handleCatalogZfStagingReviewRequest(
    requestFor(`?organization_id=${IDS.otherOrganizationId}`),
    {},
    handlerDeps(),
  );
  assert.equal(invalid.status, 400);

  const notFound = await handleCatalogZfStagingReviewRequest(
    requestFor(`?candidate_id=${IDS.candidateId}`),
    {},
    handlerDeps({
      createCatalogZfStagingReviewReadDb: () => ({ list: async () => [] }),
    }),
  );
  assert.equal(notFound.status, 404);

  for (const [kind, status] of [
    ["CONTRACT_MISMATCH", 409],
    ["UNAVAILABLE", 503],
  ]) {
    const response = await handleCatalogZfStagingReviewRequest(
      requestFor(),
      {},
      handlerDeps({
        createCatalogZfStagingReviewReadDb: () => ({
          list: async () => {
            throw new CatalogZfStagingReviewDbError(kind);
          },
        }),
      }),
    );
    assert.equal(response.status, status);
  }
});

test("route requires environment configuration without exposing its values", async () => {
  const response = await handleCatalogZfStagingReviewRequest(
    new Request(
      "https://portal.next-master.com/api/catalog/zf-group/staging-review",
      { headers: { authorization: "Bearer caller-token" } },
    ),
    {},
    handlerDeps({
      env: { get: () => undefined },
    }),
  );

  assert.equal(response.status, 503);
  assert.deepEqual(await responseBody(response), {
    error: "Staging review is temporarily unavailable.",
  });
});

test("source remains an exact GET-only, zero-write, zero-provider review boundary", () => {
  assert.deepEqual(config, {
    path: "/api/catalog/zf-group/staging-review",
    method: "GET",
  });
  assert.match(routeSource, /requireCallerProfile\(req, \["admin", "superadmin"\]\)/);
  assert.match(routeSource, /caller\.profile\.organization_id/);
  assert.match(routeSource, /SUPABASE_ANON_KEY/);
  assert.doesNotMatch(routeSource, /SUPABASE_SERVICE_ROLE_KEY|serviceRoleKey|serviceRoleHeaders/);
  assert.doesNotMatch(readSource, /SUPABASE_SERVICE_ROLE_KEY|serviceRoleKey|serviceRoleHeaders/);
  assert.doesNotMatch(readSource, /\/rpc\/|\.rpc\s*\(/);
  assert.doesNotMatch(
    `${routeSource}\n${readSource}`,
    /method:\s*["'](?:POST|PUT|PATCH|DELETE)["']/,
  );
  assert.doesNotMatch(
    `${routeSource}\n${readSource}`,
    /admin-sync-zf-group|zf-aftermarket-sync|collectOfficialObservation/,
  );
  assert.doesNotMatch(
    `${routeSource}\n${readSource}`,
    /catalog_products|guardian|apply_catalog|review_decision/i,
  );
  assert.match(readSource, /method:\s*"GET"/);
  assert.match(readSource, /Authorization:\s*`Bearer \$\{accessToken\}`/);
  assert.equal(
    readSource.includes(`"${ZF_STAGING_REVIEW_VIEW}"`),
    true,
  );
});
