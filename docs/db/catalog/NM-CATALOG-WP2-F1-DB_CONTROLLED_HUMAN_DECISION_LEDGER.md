# NM-CATALOG-WP2-F1-DB Controlled Human Decision Ledger

Status: Draft v1
Domain: DB / Catalog
Phase: Catalog Observation Platform
Work Package: NM-CATALOG-WP2-F1-DB - Controlled Human Decision Ledger
Architecture authority: `docs/architecture/catalog/NM-CATALOG-WP2-F_CONTROLLED_HUMAN_DECISION_WORKFLOW.md`

## Purpose

This DB package creates the controlled human decision boundary for Catalog Observation review items.

It records reviewer judgement as append-only decision events and exposes a derived current-state projection. It does not apply values to Catalog Product truth.

## Constitutional Separation

Recommendation != Decision != Apply != Canonical Product

WP2-F1 records decisions only. Product apply remains a future WP2-F2 boundary.

## Canonical Review Item Source

The existing Review Workspace read path defines the canonical review item identity.

Verified runtime chain:

Review Workspace UI -> `GET /api/catalog/observation-review` -> `netlify/functions/catalog-observation-review.mts` -> `netlify/functions/_shared/catalog/catalog-observation-review-api.mjs` -> `buildCatalogObservationReviewResponse()` -> `recommendReviewItem()` -> `review_queue_key`.

The canonical review item id is the existing `review_queue_id` returned by the read API. It is generated as:

`organization_id:catalog_product_id:observation_id:field_family`

WP2-F1 stores this exact value as `review_item_id` and does not create a parallel review-item source of truth.

## Ledger Table

`public.catalog_observation_review_decision_events`

The table is append-only and stores:

- event id
- organization scope
- canonical review item id
- observation id
- Product id
- field family
- event type
- decision type
- reason code
- reviewer note
- reviewer id and role snapshot
- recommendation fingerprint
- review item fingerprint
- observation fingerprint
- Product target fingerprint
- expected prior version
- resulting version
- idempotency key and payload hash
- reversal / supersession references
- derived apply eligibility and block reasons
- field-risk classification
- server-generated timestamp

## Event Model

Supported event types:

- `DECISION_RECORDED`
- `DECISION_REVERSED`
- `DECISION_SUPERSEDED`
- `DECISION_INVALIDATED`

The first implementation exposes command RPCs for decision recording and reversal. Supersession and invalidation are represented in the ledger model for server-reserved future use.

## Decision Model

Reviewer-entered decision types:

- `ACCEPT_RECOMMENDATION`
- `REJECT_RECOMMENDATION`
- `DEFER`
- `REQUEST_MORE_EVIDENCE`

Prior rows are never overwritten. Later events determine current state.

## Reason Codes

`ACCEPT_RECOMMENDATION`:

- `EVIDENCE_SUFFICIENT`
- `VERIFIED_AGAINST_CURRENT_PRODUCT`
- `TRUSTED_OFFICIAL_SOURCE`

`REJECT_RECOMMENDATION`:

- `INCORRECT_OBSERVATION`
- `INSUFFICIENT_EVIDENCE`
- `CONFLICTS_WITH_CANONICAL_DATA`
- `WRONG_PRODUCT_MATCH`
- `FIELD_NOT_APPLICABLE`

`DEFER`:

- `NEEDS_SECOND_REVIEW`
- `WAITING_FOR_SOURCE_CONFIRMATION`
- `TEMPORARY_REVIEW_HOLD`

`REQUEST_MORE_EVIDENCE`:

- `MISSING_PRIMARY_SOURCE`
- `CONFLICTING_SOURCES`
- `LOW_CONFIDENCE`
- `INCOMPLETE_PRODUCT_MATCH`

`DECISION_REVERSED`:

- `DECISION_ENTERED_IN_ERROR`
- `NEW_EVIDENCE_RECEIVED`
- `RECOMMENDATION_CHANGED`
- `PRODUCT_STATE_CHANGED`

A controlled reason code is required for every decision and reversal.

## Current-State Projection

`public.get_catalog_observation_review_decision_state(text, text, text, text)` derives current state from the append-only ledger.

It returns:

- current decision
- current event id
- reviewer id and role
- decision version
- stale / reversed / superseded / invalidated flags
- fingerprint-at-decision values
- current fingerprint values supplied by the caller
- apply eligibility
- apply block reasons

A mutable status column is not used as source of truth.

## Staleness Evaluation

The projection marks a decision stale when caller-supplied current fingerprints differ from the stored fingerprints:

- recommendation fingerprint
- review item fingerprint
- Product target fingerprint

Observation and Product target fingerprints are calculated in DB from current rows during command execution. Recommendation fingerprint is produced by the existing read/recommendation runtime and supplied to the command boundary.

## Field-Risk Policy

`LOW_RISK`:

- `image_reference`
- `supplemental_description`

`GUARDED`:

- `weight`
- `origin`
- `hs_code`

`HIGH_RISK_OR_PROHIBITED_FOR_APPLY`:

- all other field families, including identity and relationship fields

WP2-F1 may record decisions for any reviewable field family, but only low-risk accepted decisions can produce derived `apply_eligible = true`. No apply operation is executed.

## Optimistic Concurrency

Decision commands require `input_expected_decision_version`.

The DB serializes each decision stream with an advisory transaction lock scoped by organization and review item id.

If the expected version differs from current version, the command raises:

`CATALOG_REVIEW_DECISION_CONFLICT`

There is no last-write-wins behavior.

## Idempotency

Decision commands require an idempotency key.

Uniqueness is scoped by:

- organization
- review item id
- idempotency key

The payload hash includes command data and actor id. Repeating the same command returns the existing event. Reusing the same key with a different payload raises:

`CATALOG_REVIEW_DECISION_IDEMPOTENCY_MISMATCH`

## Authorization

The command boundary resolves identity from `auth.uid()` and organization from `current_profile_org_id()`.

Allowed current roles:

- `admin`
- `superadmin`

The caller profile must be active and in the same organization as the review item. Browser-supplied organization ids are not trusted.

## Tenant Isolation

The review item id is parsed and its organization segment must match the caller's active organization. The underlying observation and Product must also belong to that organization and match the parsed review item fields.

Cross-organization decisions fail at the DB boundary.

## RLS and Grants

The ledger table has RLS enabled.

Direct privileges:

- `anon`: none
- `authenticated`: `select` only, scoped by admin/superadmin organization RLS
- `service_role`: `select` only
- mutation: command RPC only

RPC grants are explicit.

## Append-Only Enforcement

`public.prevent_catalog_review_decision_event_mutation()` blocks direct UPDATE and DELETE through a trigger on `catalog_observation_review_decision_events`.

## RPC Contracts

`public.record_catalog_observation_review_decision(text, text, text, text, integer, text, text, text, text)`

Records one append-only `DECISION_RECORDED` event and returns the event plus derived current state.

`public.reverse_catalog_observation_review_decision(text, uuid, text, text, integer, text)`

Records one append-only `DECISION_REVERSED` event against the current decision event and returns the event plus derived current state.

`public.get_catalog_observation_review_decision_state(text, text, text, text)`

Returns the derived state projection.

## Stable Error Codes

Errors are raised with stable message prefixes:

- `CATALOG_REVIEW_DECISION_UNAUTHORIZED`
- `CATALOG_REVIEW_ITEM_MISSING`
- `CATALOG_REVIEW_DECISION_ORGANIZATION_MISMATCH`
- `CATALOG_REVIEW_DECISION_CONFLICT`
- `CATALOG_REVIEW_DECISION_RECOMMENDATION_MISMATCH`
- `CATALOG_REVIEW_DECISION_REVIEW_FINGERPRINT_MISMATCH`
- `CATALOG_REVIEW_DECISION_PRODUCT_TARGET_MISMATCH`
- `CATALOG_REVIEW_DECISION_INVALID_TRANSITION`
- `CATALOG_REVIEW_DECISION_INVALID_REASON`
- `CATALOG_REVIEW_DECISION_IDEMPOTENCY_MISMATCH`

## Apply Eligibility

WP2-F1 exposes only derived eligibility.

Eligibility requires:

- current decision is `ACCEPT_RECOMMENDATION`
- decision is not stale
- decision is not reversed, superseded, or invalidated
- field risk is `LOW_RISK`
- fingerprints are unchanged

Block reasons include:

- `NO_ACCEPT_DECISION`
- `RECOMMENDATION_CHANGED`
- `REVIEW_ITEM_CHANGED`
- `PRODUCT_TARGET_CHANGED`
- `DECISION_REVERSED`
- `DECISION_SUPERSEDED`
- `DECISION_INVALIDATED`
- `FIELD_POLICY_PROHIBITS_APPLY`

No Product apply occurs in this package.

## Migration

Migration file:

`supabase/migrations/20260719_001_catalog_review_decision_ledger.sql`

## Validation

Static DB contract tests:

`node --test scripts/tests/catalog-observation-decision-ledger-sql.test.mjs`

The tests verify that the migration defines the ledger, commands, constraints, idempotency, append-only enforcement, no Product/observation/recommendation mutation, and the canonical review item identity.

## Known Runtime Limitations

No local Supabase runtime was assumed or started. Runtime DB execution and production application are intentionally out of scope for this package.

Recommendation fingerprint freshness is supplied by the existing read/recommendation runtime. The DB stores and compares supplied fingerprints; it does not reimplement the JavaScript recommendation engine.

## Rollback

This package does not mutate Product truth. If the command boundary must be disabled, revoke execute privileges from the command RPCs and keep ledger history readable for audit.

## Non-Goals

- no Product mutation
- no observation mutation
- no recommendation mutation
- no canonical apply
- no HTTP API endpoint
- no UI controls
- no production migration
- no deployment

## Exact Next API Contract

Next domain: Next-Master API

Next work package: NM-CATALOG-WP2-F1-API - Controlled Human Decision Command Boundary

The API package should expose authenticated command endpoints that call the DB RPCs and pass the current fingerprints from the review workspace response.
