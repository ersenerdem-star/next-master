# NM-CATALOG-ZF-GROUP-STAGING-REVIEW-READ-API-PRODUCTION-EVIDENCE

## Status

`PASS — read-only production boundary deployed and live-proven`

Evidence date: `2026-07-27`

Evidence timestamp: `2026-07-27T07:59:15Z`

Owner: `Catalog Core / Catalog Core Human Review`

Environment: `Next-Master production`

This record contains no bearer token, API key, service-role value, password,
customer data, unrestricted tenant identifier, or credential-bearing material.

## 1. Exact production release

| Boundary | Value |
|---|---|
| Production source commit | `3848beeb1549fc14597e26779c67983c66b8385a` |
| Netlify production deploy | `6a670427289f7400085f93a1` |
| Production version commit | `3848beeb1549fc14597e26779c67983c66b8385a` |
| Version build timestamp | `2026-07-27T07:09:46.056Z` |
| Route | `GET /api/catalog/zf-group/staging-review` |
| Route registration | Handler receives all methods; handler permits GET only |
| Runtime source boundary | Caller bearer token + Supabase publishable key; no service-role key |

The method-guard release removes only the platform-level method filter so that
non-GET requests reach the handler and receive a deterministic `405`. The
handler remains GET-only, read-only, tenant-bound, and provider-free.

## 2. Production database evidence

The three accepted migrations are recorded in the production migration history:

| Migration | Source SHA-256 |
|---|---|
| `20260726203831_catalog_zf_group_durable_provenance_staging.sql` | `94ad3317117380aa9fc04de37f719825c70084854dc6d1e70af4f38c17332e9a` |
| `20260726213449_catalog_zf_group_staging_review_projection_compatibility.sql` | `cb5a5577cf2f4c6a7f30f3a215a91090d3002ed27e08e6014efa26ced42459f1` |
| `20260726215408_catalog_zf_group_staging_review_admin_rls_compatibility.sql` | `9e212be338d987d2f2385f17c3507b7d52bcb119e0f7fc602bb5dd99bfa22f86` |

Production read-only verification returned:

| Gate | Result |
|---|---|
| Review projection column count and order | `44/44 PASS` |
| `security_invoker=true` | `PASS` |
| View grant: authenticated SELECT only | `PASS` |
| Candidate/event RLS enabled | `PASS` |
| Admin/superadmin same-tenant SELECT policies | `PASS` |
| Durable write functions executable by service role only | `PASS` |
| Staging candidates/events/aliases/outcomes | `0` rows each |
| Canonical catalog products | `421,432` rows; read-only unchanged during release |
| Review decisions | `0` rows |
| Apply events | `0` rows |

No production migration in this release inserted, updated, deleted, or
rewrote canonical Products, review decisions, Guardian state, or Apply state.

## 3. Live HTTP evidence

The existing authenticated admin session was used only in memory for the
authorized read assertion. The Bearer token was not printed, persisted, or
included in this record.

| Runtime case | Expected | Observed |
|---|---:|---:|
| Tokenless GET | `401` | `401` — `Missing caller token` |
| Tokenless POST | `405` | `405` — `Method not allowed` |
| Authenticated session profile | `200` | `200`; role `superadmin` |
| Authenticated staging review GET | `200` | `200` |
| Response tenant binding | caller tenant | exact match; tenant identifiers withheld |
| Response schema | `catalog-zf-staging-review.v1` | exact match |
| Returned staging items | bounded list | `0` |
| `has_more` | `false` for empty staging | `false` |
| `organization_id` query selector | reject | `400` — unknown query field |
| `tenant` query selector | reject | `400` — unknown query field |
| `limit=0` | reject | `400` — positive integer required |

The authorized response was an empty tenant-scoped page, so no staging record
was read beyond the caller's organization and no write path was exercised.

## 4. Source and release validation

| Gate | Result |
|---|---|
| Read API, projection, durable SQL, and method-guard tests | `33 PASS`, `1 SKIP` (local Supabase evidence variables absent) |
| Production application build | `PASS` |
| Core Guardian audit | `0 critical`, `0 warning` |
| Secret-surface audit | `0 critical` |
| `git diff --check` and clean release worktree | `PASS` |
| Netlify production secret scan | `0 matches` |

The skipped local test is an opt-in local Supabase runtime test and does not
represent a production failure. Production HTTP and database evidence above
was collected independently.

Post-migration advisory scans reported no package-related security finding.
Performance advisories for empty append-only helper indexes and two existing
RLS init-plan policies are non-blocking and outside the method-guard scope.

## 5. Explicit non-actions

This release:

- did not add or rotate credentials;
- did not expose a token or secret;
- did not add a provider invocation or connector;
- did not add UI;
- did not create staging data;
- did not create a human review decision;
- did not invoke Guardian;
- did not create or mutate a canonical Product; and
- did not invoke Apply.

## 6. Gate conclusion

The read-only ZF staging review API is production-deployed and live-proven for
authentication, method rejection, tenant binding, bounded empty reads, and
fail-closed tenant selectors. The boundary remains read-only and Catalog-owned.

Any UI consumer, staging-data population, review decision, Guardian action,
Product creation, Apply operation, provider invocation, or bulk enrichment
requires a separately named and accepted work package.
