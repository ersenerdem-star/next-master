# NM-CATALOG-WP2-E1 Review Workspace Read API Release Record

Status: RELEASE_RECORDED

Domain: API / Catalog

Phase: Observation Comparison and Human Review

Work Package: NM-CATALOG-WP2-E1

Feature Commit: final branch tip

Production Observation Run: 11581bfd-3a12-43d5-bb39-d6aa09e3bd96

Artifact Directory: local read-only production validation via the linked Netlify project and live Supabase client

## Purpose And Scope

This release adds a bounded read-only Catalog observation review API for the future Human Review UI.

The endpoint is read-only.

It reads existing observation/comparison/recommendation data.

It does not create review decisions, mutate Product, publish canonical values, or run acquisition.

## Runtime Call Chain

The runtime call chain is:

1. `netlify/functions/catalog-observation-review.mts`
2. authenticated caller profile resolution
3. organization-bound query validation
4. read-only Supabase GETs for observations, Products, sources, trust profiles, and runs
5. deterministic comparison via `compareObservationToProduct`
6. deterministic queue building and recommendation via `recommendReviewItem`
7. stable sort and cursor pagination
8. JSON response with `schema_version`, `organization_id`, `run_id`, `items`, `page`, and `summary`

## Contract

Response schema version:

- `catalog-observation-review.v1`

Required query parameters:

- `organization_id`
- `run_id`

Optional bounded filters:

- `product_id`
- `field_family`
- `comparison_result`
- `recommendation`
- `cursor`
- `limit`

Limit is defaulted to 25 and capped at 50.

Only admin-like callers can use the route.

The caller organization must match the requested organization.

## Deterministic Output Rules

Sort order is stable and fixed:

1. `MANUAL_REQUIRED`
2. `LIKELY_REJECT`
3. `INSUFFICIENT_EVIDENCE`
4. `LIKELY_ACCEPT`
5. `AUTO_SAFE`
6. `product_code`
7. `field_family`
8. `observation_id`

Cursor pagination is stable and repeatable.

The cursor encodes the full sort tuple plus the active filters.

## Production Validation

Live production Supabase validation returned:

- review items processed: 6
- `MANUAL_REQUIRED`: 1
- `LIKELY_ACCEPT`: 5
- `LIKELY_REJECT`: 0
- `INSUFFICIENT_EVIDENCE`: 0
- `AUTO_SAFE`: 0
- comparison totals:
  - total observations: 9
  - `NO_CHANGE`: 3
  - `ENRICHMENT_CANDIDATE`: 5
  - `CONFLICT`: 1
  - review queue count: 6
- deterministic repeatability: true
- item fingerprint repeatability: true

Returned items were reviewer-null and decision-null.

## Immutability Proof

The read helper used only read operations.

No insert, update, delete, RPC mutation, review decision write, Product mutation, apply, publication, migration, or backfill occurred.

The live production data proof re-read the same input twice and produced identical output.

## Validation

Validation commands:

- `node --check netlify/functions/_shared/catalog/catalog-observation-review-api.mjs`: passed
- `node --check scripts/tests/catalog-observation-review-api.test.mjs`: passed
- `node --test scripts/tests/catalog-observation-review-api.test.mjs`: passed
- `node --test scripts/tests/*.test.mjs`: passed, 53 tests
- `git diff --check`: passed
- `npm --workspace apps/web run build`: passed

## Explicit Non-Actions

This release did not:

- create review decisions
- mutate Product
- mutate observations
- apply canonical values
- publish anything
- rerun acquisition
- run a migration
- deploy Netlify
