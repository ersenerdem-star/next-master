# NM-CATALOG-ZF-GROUP-STAGING-REVIEW-READ-API-NON-PRODUCTION-EVIDENCE

## Status

`PASS — local/non-production evidence only; deployment and production remain unauthorized and unproven`

Evidence date: `2026-07-27`

Owner: `Catalog Core / Catalog Core Human Review`

Environment: local Supabase on loopback, Supabase CLI `2.109.1`,
PostgreSQL `17.6`

This record contains no bearer token, API key, service-role value, password,
credential, provider payload, customer data, or production identifier.

## 1. Exact source and database baselines

| Boundary | Commit |
|---|---|
| Inert durable staging orchestration source | `6b634a232021d01df45bbd7370b7790fa8acf8e3` |
| Read API source | `92f622a14168f0c0223e72300ed731501d146862` |
| Durable provenance/staging DB source | `a57f635eb4710ac7a9c37179136002354bd5d4de` |
| Projection compatibility DB source | `ba50b1df60f1b59de487cc84f712633a34ded988` |
| Admin/superadmin RLS compatibility DB source | `d70498029fad005764d9ebde351d5ff9cfa8fcfc` |

The evidence branch combines only the accepted API and DB prerequisites.
Cherry-picked integration commits are `08f4d85` and `49a8192`. No production
branch was changed or pushed.

## 2. Database compatibility evidence

The three accepted DB migrations were applied only to the local Supabase
database. The rollback-safe validator then returned:

| Gate | Result |
|---|---|
| Exact 44-column projection; four accepted identities appended | `PASS` |
| `security_invoker=true`; authenticated SELECT only; no write grant | `PASS` |
| Exact admin/superadmin tenant SELECT policies | `PASS` |
| Superadmin same-tenant visibility and cross-tenant isolation | `PASS` |
| Admin same-tenant visibility | `PASS` |
| Non-admin zero rows | `PASS` |
| Other-tenant isolation | `PASS` |
| Anonymous projection read denied | `PASS` |
| Service-role projection read denied | `PASS` |
| Bounded candidate/run/filter/cursor query plans | `PASS` |
| Zero Product, review-decision, Guardian, or Apply mutation | `PASS` |

Database validator result: `11/11 PASS`, followed by `ROLLBACK`.

## 3. Real caller-token API evidence

The opt-in non-production test uses local Supabase Auth, PostgREST, the real
`requireCallerProfile` helper, the real API handler, and temporary two-tenant
fixtures. The test harness uses a privileged local setup/cleanup boundary, but
the staging projection request itself always uses the caller bearer token and
the publishable/anonymous API key.

| Runtime case | Expected and observed result |
|---|---|
| Tenant A admin list | `200`; only two Tenant A candidates |
| Tenant B superadmin list | `200`; only one Tenant B candidate |
| Tenant A token requesting Tenant B candidate | `404`; no existence leak |
| Tenant A cursor reused by Tenant B | `400` |
| Query-string `organization_id` selector | `400` |
| Viewer profile | `403` |
| Missing bearer token | `401` |
| `POST` to the GET-only boundary | `405` |
| Anonymous direct projection read | denied |
| Service-role direct projection read | denied |
| Bounded keyset pagination | deterministic first and second pages |
| Product/review/Apply state after reads | zero rows |
| Candidate/event count after reads | unchanged at `3/3` |

Real local Auth/PostgREST/API result: `8/8 PASS`.

## 4. Source, regression, and build evidence

| Gate | Result |
|---|---|
| API, projection SQL, durable staging, and ZF brand-boundary tests | `53/53 PASS` |
| Application production build | `PASS` |
| Core Guardian audit | `0 critical`, `0 warning` |
| Secret-surface audit | `0 critical` |
| `git diff --check` | `PASS` |

The repository-wide module-boundary audit still reports the same 27 existing
frontend findings. None names this API, its shared reader, the DB
compatibility migrations, the non-production test, or this evidence record.
This package does not claim that unrelated baseline gate as resolved.

Installing the already pinned workspace dependencies reported the existing
lockfile audit posture of two low and four high dependency advisories. This
package added no dependency and changed neither `package.json` nor the
lockfile.

## 5. Cleanup and zero-state-change proof

The temporary evidence data was removed after the read assertions:

- evidence Auth users: `0`;
- evidence profiles: `0`;
- evidence staging candidates: `0`;
- evidence staging events: `0`;
- evidence Products: `0`;
- evidence review decisions: `0`; and
- evidence Apply events: `0`.

Cleanup uses a privileged local-only harness because staging evidence is
append-only by design. This harness is not imported by the route, is not a
runtime fallback, and is unavailable in production.

## 6. Reproduction

Database gate:

```sh
docker exec -i supabase_db_runtime psql -U postgres -d postgres -X \
  -v ON_ERROR_STOP=1 \
  < supabase/validation/NM-CATALOG-ZF-GROUP-STAGING-REVIEW-PROJECTION-COMPATIBILITY-VALIDATE.sql
```

Caller-token API gate:

```sh
NM_LOCAL_SUPABASE_PROJECT_DIR=/path/to/local/runtime \
NM_LOCAL_SUPABASE_DB_CONTAINER=supabase_db_runtime \
node --test \
  scripts/tests/catalog-zf-staging-review-read-api.nonprod.test.mjs
```

The test refuses non-loopback API URLs and accepts only a named local Supabase
DB container.

## 7. Explicit non-actions

This evidence:

- did not push or merge any branch;
- did not apply a production migration;
- did not deploy or enable a live route;
- did not issue or change a production credential;
- did not call ZF or any provider;
- did not add UI;
- did not create a human review decision;
- did not invoke Guardian;
- did not create or mutate a canonical Product; and
- did not invoke Apply.

## 8. Gate conclusion

The local/non-production evidence gate is satisfied for the accepted read
boundary. It proves source compatibility and local runtime behavior only.

Any production migration, route deployment, live read, or release claim
requires a separately named and explicitly accepted
`NM-CATALOG-ZF-GROUP-STAGING-REVIEW-READ-API-PRODUCTION-CHANGE-AUTHORIZATION`
package.
