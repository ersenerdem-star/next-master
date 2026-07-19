# NM-CATALOG-WP2-F1-API Controlled Human Decision Command Boundary

Status: Draft v1
Domain: API / Catalog
Phase: Catalog Observation Platform
Work Package: NM-CATALOG-WP2-F1-API - Controlled Human Decision Command Boundary

## Purpose

This package exposes the controlled human decision command boundary for Catalog Observation review items.

The API records a human decision. It does not apply the recommendation to the canonical Product.

Constitutional separation:

Recommendation != Decision != Apply != Canonical Product

## Authorities

Architecture authority:

`docs/architecture/catalog/NM-CATALOG-WP2-F_CONTROLLED_HUMAN_DECISION_WORKFLOW.md`

DB authority:

`docs/db/catalog/NM-CATALOG-WP2-F1-DB_CONTROLLED_HUMAN_DECISION_LEDGER.md`

Integrated DB commit:

`c6529212eea5bc1e6e753718ed7fc2cd5fd5791d`

Migration:

`supabase/migrations/20260719_001_catalog_review_decision_ledger.sql`

## Existing Read Path

The existing read path remains:

Review Workspace UI -> `GET /api/catalog/observation-review` -> Netlify function -> shared review handler -> comparison runtime -> recommendation runtime -> read-only review response.

The read API remains GET-only and does not mutate Product, observations, recommendations, or decisions.

This package enriches each read item with the minimum current-state metadata required for safe decision submission:

- `review_item_fingerprint`
- `product_target_fingerprint`
- `decision_state`

The recommendation fingerprint remains produced by the deterministic recommendation runtime.

## Command Endpoints

Decision recording:

`POST /api/catalog/observation-review/decision`

Decision reversal:

`POST /api/catalog/observation-review/decision/reverse`

No generic mutable PATCH endpoint is introduced.

No Product apply endpoint is introduced.

## RPC Mapping

Decision recording calls only:

`public.record_catalog_observation_review_decision(text, text, text, text, integer, text, text, text, text)`

Arguments:

- `input_review_item_id`
- `input_decision_type`
- `input_reason_code`
- `input_reviewer_note`
- `input_expected_decision_version`
- `input_expected_recommendation_fingerprint`
- `input_expected_review_item_fingerprint`
- `input_expected_product_target_fingerprint`
- `input_idempotency_key`

Decision reversal calls only:

`public.reverse_catalog_observation_review_decision(text, uuid, text, text, integer, text)`

Arguments:

- `input_review_item_id`
- `input_reversal_target_event_id`
- `input_reason_code`
- `input_reviewer_note`
- `input_expected_decision_version`
- `input_idempotency_key`

Current-state read enrichment calls:

`public.get_catalog_observation_review_decision_state(text, text, text, text)`

Arguments:

- `input_review_item_id`
- `input_current_recommendation_fingerprint`
- `input_current_review_item_fingerprint`
- `input_current_product_target_fingerprint`

## Decision Request Schema

The decision command accepts only:

- `reviewItemId`
- `decisionType`
- `reasonCode`
- `reviewerNote`
- `expectedDecisionVersion`
- `expectedRecommendationFingerprint`
- `expectedReviewItemFingerprint`
- `expectedProductTargetFingerprint`
- `idempotencyKey`

The API rejects unknown fields.

The API does not accept organization id, reviewer user id, reviewer role, created timestamp, resulting decision version, apply eligibility, event id, or server correlation identity from the browser.

## Reversal Request Schema

The reversal command accepts only:

- `reviewItemId`
- `targetDecisionEventId`
- `reasonCode`
- `reviewerNote`
- `expectedDecisionVersion`
- `idempotencyKey`

The API passes reversal intent to the DB RPC. The DB enforces ownership, current-event validity, version, transition, and idempotency.

## Decision and Reason Codes

Decision values:

- `ACCEPT_RECOMMENDATION`
- `REJECT_RECOMMENDATION`
- `DEFER`
- `REQUEST_MORE_EVIDENCE`

Allowed reason codes are derived from the DB authority.

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

Reversal:

- `DECISION_ENTERED_IN_ERROR`
- `NEW_EVIDENCE_RECEIVED`
- `RECOMMENDATION_CHANGED`
- `PRODUCT_STATE_CHANGED`

## Authentication and Authorization

The API requires a caller bearer token through the existing profile auth helper.

Allowed roles:

- `admin`
- `superadmin`

The API does not broaden the DB authorization contract.

The command RPC is called with the caller bearer token and anon key so that `auth.uid()` and `current_profile_org_id()` remain DB-authoritative.

The service-role key is not used to fabricate reviewer identity for command RPCs.

## Tenant Isolation

Browser-supplied organization id is not accepted by the command endpoints.

The canonical review item id is validated as:

`organization_id:catalog_product_id:observation_id:field_family`

The API validates shape only. The DB remains the authority for same-organization access, observation/Product linkage, and stream ownership.

Cross-tenant existence is not exposed by direct table access.

## Idempotency

The API requires a client-generated `idempotencyKey`.

One logical user action must reuse one stable key across retries.

The API passes the key unchanged to the DB.

The API does not generate replacement keys, cache command results, or implement in-memory idempotency.

The DB returns the original result for safe replay and rejects mismatched payload reuse.

## Optimistic Concurrency

The API requires:

- expected current decision version
- expected recommendation fingerprint
- expected review item fingerprint
- expected Product target fingerprint

Omitted expected state is rejected.

There is no last-write-wins fallback.

DB conflict and fingerprint drift map to stable HTTP conflict responses.

## Response Schema

Successful command responses include:

- `schema_version`
- `success`
- `action`
- `replayed`
- `event`
- `current_state`

The serialized event includes only UI-safe fields:

- decision event id
- review item id
- event type
- decision type
- reason code
- decision version
- reviewer id and role
- decided timestamp
- reversal target id when applicable

The current state includes:

- current decision
- current event id
- decision version
- stale / reversed / superseded / invalidated flags
- requires re-review
- apply eligibility
- apply block reasons

No response marks Product as applied.

## Error Mapping

The API returns stable JSON error codes and does not expose SQL internals, stack traces, schema names, service credentials, or raw DB connection details.

HTTP 400:

- invalid content type
- invalid JSON
- missing required field
- invalid UUID or review item id
- unsupported decision value
- unsupported reason code
- invalid idempotency key
- oversized body or reviewer note
- unknown field

HTTP 401:

- missing caller token
- invalid or expired authentication from the existing auth helper

HTTP 403:

- unauthorized role
- DB authorization failure
- organization mismatch

HTTP 404:

- review item missing within authorized scope

HTTP 409:

- stale decision version
- recommendation changed
- review item changed
- Product target changed
- idempotency payload mismatch
- invalid current-state transition
- reversal target no longer current

HTTP 500:

- unexpected server failure only

## Logging and Redaction

Routine command handling does not log request bodies.

Reviewer notes, auth tokens, evidence payloads, service-role keys, and raw DB connection information must not be logged.

Stable error codes are safe for operational diagnostics.

## Routing

The endpoint paths are implemented through Netlify function `config.path` declarations.

No Netlify configuration change is required.

Existing API routes and SPA fallback behavior are preserved.

## Tests

API tests cover:

- strict decision validation
- strict reversal validation
- method allowlist
- missing token response
- record RPC-only invocation
- reversal RPC-only invocation
- success serialization
- idempotent replay serialization
- DB conflict mapping
- idempotency mismatch mapping
- sanitized unexpected failure
- existing read API compatibility

DB static contract tests remain in:

`scripts/tests/catalog-observation-decision-ledger-sql.test.mjs`

## Runtime Limitations

Local tests mock command RPC responses.

No local Supabase runtime was assumed.

Production migration application is out of scope for this API package.

Production endpoint smoke must occur only after the DB migration is applied and the API branch is intentionally released.

## Rollback

Rollback can disable the two command functions while preserving the read-only review workspace.

Because WP2-F1 does not mutate Product truth, rollback does not require Product repair.

Decision ledger history remains append-only audit evidence.

## UI Integration Contract

The UI must submit a deliberate command using the current item metadata from the GET response:

- `review_queue_id` as `reviewItemId`
- `decision_state.decision_version` as `expectedDecisionVersion`
- `recommendation_fingerprint`
- `review_item_fingerprint`
- `product_target_fingerprint`
- one stable idempotency key per logical user action

The UI must not say Product was applied or published.

Allowed UI language:

- Decision recorded
- Recommendation accepted by reviewer
- Recommendation rejected by reviewer
- Deferred
- More evidence requested
- Eligible for future apply review

## Explicit Non-Goals

- no Product mutation
- no observation mutation
- no recommendation mutation
- no canonical apply
- no direct ledger-table write
- no browser organization trust
- no caller-forged reviewer identity
- no UI decision controls
- no production migration
- no merge to main
- no deployment
