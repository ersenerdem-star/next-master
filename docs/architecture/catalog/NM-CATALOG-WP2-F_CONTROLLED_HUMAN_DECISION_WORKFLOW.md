# NM-CATALOG-WP2-F Controlled Human Decision Workflow

Status: Draft v1
Authority: Next-Master Architecture
Domain: Architecture / Catalog
Phase: Catalog Observation Platform
Work Package: NM-CATALOG-WP2-F - Controlled Human Decision Workflow
Decision: DESIGN AND AUTHORIZE ONLY

This document authorizes the architecture for controlled human review decisions in the Catalog Observation Platform.

It does not implement DB, API, UI, Product mutation, observation mutation, review mutation, canonical apply, migration, deployment, fetcher behavior, scraping, or background orchestration.

## 1. Purpose

WP2-F introduces human decisions for the first time in the Catalog Observation Platform.

The production-complete chain before this work package is:

Observation -> Comparison -> Recommendation -> Review Workspace Read API -> Human Review Workspace UI

The current workspace is deliberately read-only:

- recommendations are advisory
- review items are visible
- reviewers are unassigned
- decisions are undecided
- no Product mutation exists
- no review mutation exists
- no canonical apply exists

The purpose of WP2-F is to define the first controlled decision boundary without collapsing recommendation, decision, apply eligibility, or canonical Product truth.

## 2. Scope

WP2-F is split into two separate work packages.

### WP2-F1: Controlled Human Review Decision

WP2-F1 records human review decisions only.

It may create an append-only decision ledger, decision state projection, authorization rules, concurrency rules, idempotency rules, and decision history.

It must not apply values to Product.

### WP2-F2: Controlled Canonical Apply

WP2-F2 is a later, separate work package.

It may design and implement the transactional Product apply boundary for decisions that are eligible for apply.

It must prove Product mutation safety, existing Product overwrite guard preservation, transaction boundary, rollback behavior, and ledger-to-Product traceability separately.

## 3. Non-Goals

WP2-F1 does not:

- mutate `catalog_products`
- mutate external observations
- mutate comparison results
- mutate recommendation output
- apply canonical Product values
- publish accepted values
- rerun acquisition
- run a backfill
- merge multiple sources
- create autonomous approval
- create autonomous apply
- create Product apply controls in UI
- execute migration in this architecture task
- deploy any runtime change

## 4. Constitutional Boundaries

The core constitutional rule is:

Recommendation != Decision != Apply != Canonical Truth

The following concepts must remain separate:

1. Observation
2. Comparison result
3. Machine recommendation
4. Human review decision
5. Apply eligibility
6. Canonical Product update

Boundary rules:

- Observation is append-only evidence.
- Comparison classifies observation against current Product state.
- Recommendation is advisory and deterministic.
- Human decision records reviewer judgement.
- Apply eligibility states whether a separate apply workflow may proceed later.
- Canonical Product update belongs only to the controlled apply boundary.

No layer may silently collapse into another.

## 5. WP2-F1 / WP2-F2 Split Decision

Architecture decision:

WP2-F1 and WP2-F2 must be separate.

Rationale:

- a human decision is not a Product mutation
- the current UI and API are proven read-only
- the first write path should be limited to decision recording
- Product apply requires its own transactional proof
- Product apply must preserve existing overwrite guards
- Product apply must handle stale Product target values separately
- rollback semantics differ between a decision event and Product mutation

WP2-F1 may create apply eligibility.
It must not perform apply.

WP2-F2 may consume apply eligibility.
It must independently verify eligibility before Product mutation.

## 6. Domain Model

| Concept | Meaning | Owner |
|---|---|---|
| Observation | Append-only external evidence | Catalog observation DB foundation |
| Comparison Result | Deterministic current-vs-observed classification | Comparison runtime |
| Recommendation | Advisory machine recommendation with fingerprint | Recommendation engine |
| Review Item | Human-facing unit combining Product, observation, comparison, and recommendation context | Review workspace |
| Decision Event | Append-only human decision ledger entry | WP2-F1 decision boundary |
| Current Decision State | Derived latest valid decision state | DB/API projection |
| Apply Eligibility | Derived permission for future apply workflow consideration | WP2-F1 output, WP2-F2 input |
| Canonical Apply Event | Future transactional Product apply record | WP2-F2 |
| Product Truth | Accepted `catalog_products` value | Catalog Product |

## 7. State Machine

WP2-F1 decision state is derived from append-only decision events.

Canonical current decision states:

- UNDECIDED
- ACCEPT_RECOMMENDATION
- REJECT_RECOMMENDATION
- DEFER
- REQUEST_MORE_EVIDENCE
- REVERSED
- SUPERSEDED
- STALE
- INVALIDATED

Only the first four decision values are reviewer-entered decision outcomes.
The remaining states are system-derived or event-derived lifecycle states.

State progression:

UNDECIDED
-> ACCEPT_RECOMMENDATION
-> APPLY_ELIGIBLE if eligibility conditions remain true

UNDECIDED
-> REJECT_RECOMMENDATION
-> CLOSED_NO_APPLY

UNDECIDED
-> DEFER
-> OPEN_DEFERRED

UNDECIDED
-> REQUEST_MORE_EVIDENCE
-> OPEN_EVIDENCE_REQUIRED

Any active decision
-> REVERSED
-> UNDECIDED or later new decision

Any active decision
-> SUPERSEDED
-> latest valid later decision controls

Any active decision
-> STALE or INVALIDATED
-> requires re-review before apply eligibility

## 8. Decision Transition Table

| Current State | Event | Next State | Allowed? | Notes |
|---|---|---|---|---|
| UNDECIDED | DECISION_RECORDED: ACCEPT_RECOMMENDATION | ACCEPT_RECOMMENDATION | Yes | Creates apply eligibility only if eligibility contract passes |
| UNDECIDED | DECISION_RECORDED: REJECT_RECOMMENDATION | REJECT_RECOMMENDATION | Yes | Closes item for apply |
| UNDECIDED | DECISION_RECORDED: DEFER | DEFER | Yes | Keeps item open |
| UNDECIDED | DECISION_RECORDED: REQUEST_MORE_EVIDENCE | REQUEST_MORE_EVIDENCE | Yes | Keeps item open and evidence-required |
| Any active decision | DECISION_REVERSED | REVERSED | Conditional | Requires authority and reason |
| Any active decision | DECISION_SUPERSEDED | SUPERSEDED | System or authorized reviewer | Later valid decision controls |
| Any active decision | DECISION_INVALIDATED | INVALIDATED | System | Triggered by stale supporting context |
| STALE / INVALIDATED | DECISION_RECORDED | New active decision | Yes | Requires latest context and expected version |

No silent last-write-wins transition is allowed.

## 9. Decision State Semantics

### ACCEPT_RECOMMENDATION

Meaning:

The reviewer accepts the advisory recommendation for the current review item context.

Requirements:

- reviewer required
- reason code required when policy requires it
- notes optional
- recommendation fingerprint required
- expected current decision version required
- creates apply eligibility only when all eligibility conditions pass
- closes the review item for decision purposes
- may be reversed by authorized role
- may be superseded by a later valid decision
- becomes stale if supporting context changes materially

### REJECT_RECOMMENDATION

Meaning:

The reviewer rejects the advisory recommendation for the current context.

Requirements:

- reviewer required
- reason code required
- notes optional but recommended
- recommendation fingerprint required
- closes the review item for apply
- may be reversed by authorized role
- may be superseded by a later valid decision
- future recommendation changes may require re-review

### DEFER

Meaning:

The reviewer intentionally postpones a decision without requesting evidence as the primary blocker.

Requirements:

- reviewer required
- reason code required
- notes optional
- does not create apply eligibility
- does not close the review item permanently
- may be changed by authorized reviewer with expected version
- may be superseded

### REQUEST_MORE_EVIDENCE

Meaning:

The reviewer determines that available evidence is insufficient for a decision.

Requirements:

- reviewer required
- reason code required
- notes required when evidence gap must be explained
- does not create apply eligibility
- keeps the review item open
- may be superseded after evidence changes
- recommendation changes do not auto-resolve the request

## 10. Append-Only Audit Model

Decision history must be append-only.

Do not use a single mutable status column as the sole audit source of truth.

Required event types:

- DECISION_RECORDED
- DECISION_REVERSED
- DECISION_SUPERSEDED
- DECISION_INVALIDATED
- DECISION_REPLAYED_BY_IDEMPOTENCY
- DECISION_REJECTED_BY_CONFLICT
- DECISION_REJECTED_BY_AUTHORIZATION

Each decision event must preserve:

- organization id
- review item identity
- observation id
- Product id
- field family
- reviewer actor
- reviewer role
- decision value where applicable
- reason code
- reviewer note where supplied
- recommendation fingerprint
- recommendation value
- comparison result
- expected current decision version
- resulting decision version
- evidence reference summary
- Product target value fingerprint
- observation value fingerprint
- created timestamp generated by server or DB boundary
- idempotency key
- audit reference

Current decision state is derived from the latest valid ledger entry and staleness checks.

## 11. Staleness Model

A prior decision must not remain silently valid when its supporting context changes materially.

Staleness inputs:

- observation value changes
- evidence changes
- recommendation changes
- recommendation fingerprint changes
- Product current value changes
- Product target value fingerprint changes
- another source supersedes the observation
- review item is regenerated
- field policy changes
- source trust profile changes

Canonical staleness states:

- decision_valid
- decision_stale
- decision_superseded
- requires_re_review

Rules:

- apply eligibility requires `decision_valid`
- stale decisions remain visible in history
- stale decisions cannot authorize apply
- superseded decisions remain visible in history
- stale state must explain which fingerprint or version changed
- re-review must use latest review item context

## 12. Authorization Matrix

Authorization must distinguish read, decision, reversal, apply eligibility, Product apply, and history.

| Capability | admin | superadmin | future reviewer | future catalog manager |
|---|---|---|---|---|
| View review items | Yes | Yes | Yes, scoped | Yes |
| View decision history | Yes | Yes | Yes, scoped | Yes |
| Record decision | Yes | Yes | Yes, scoped | Yes |
| Reverse own decision | Conditional | Yes | Conditional | Yes |
| Reverse another reviewer's decision | No by default | Yes | No | Conditional |
| Approve apply eligibility | Derived by policy, not manual authority | Derived by policy, not manual authority | Derived by policy, not manual authority | Derived by policy, not manual authority |
| Apply to Product | No in WP2-F1 | No in WP2-F1 | No in WP2-F1 | No in WP2-F1 |
| Future WP2-F2 Product apply | To be decided | To be decided | No by default | Likely yes if authorized |

Tenant and organization rules:

- caller organization must match review item organization
- decision event organization must match observation, Product, source, run, and review context
- service role may execute server-side command boundaries only with authenticated actor context
- customer and portal roles are not decision actors

Do not assume all admins should have unrestricted apply authority.

## 13. Concurrency Model

Concurrency must use optimistic control.

Required protections:

- expected current decision version
- recommendation fingerprint
- Product target value fingerprint
- observation value fingerprint
- idempotency key
- duplicate submission detection
- deterministic conflict response
- append-only conflict event or audit record where appropriate

No last-write-wins silent overwrite is allowed.

User-visible conflict:

"This review item changed while you were reviewing it. Reload the latest state before deciding."

Conflict response must preserve the user's context.

## 14. Idempotency Model

Decision submission must be idempotent.

Idempotency identity should include:

- organization id
- review item id
- actor id
- decision command type
- idempotency key

If a network timeout occurs after server commit, a retry with the same idempotency key must return the committed decision event and audit reference.

Duplicate submission must not create duplicate active decisions.

If the payload differs for the same idempotency key, the server must reject deterministically.

## 15. Apply Eligibility Contract

Apply eligibility is not apply.

Apply eligibility is a derived state indicating that a later WP2-F2 apply workflow may consider the item.

Eligibility conditions:

- latest decision is ACCEPT_RECOMMENDATION
- decision is not stale
- decision has not been reversed
- decision has not been superseded
- observation is still active
- recommendation fingerprint is unchanged
- Product target value is unchanged since review
- evidence remains available
- reviewer was authorized at decision time
- field is allowed for controlled apply
- no conflicting active decision exists
- no concurrent apply is in progress
- source and organization scope remain valid

Eligibility output:

- eligible
- not_eligible
- blocked
- requires_re_review

WP2-F1 may expose eligibility.
WP2-F1 must not execute apply.

## 16. Field-Risk Policy

Field families must not share one universal decision policy.

### Low-Risk Text / Media Enrichment

Examples:

- image reference
- supplemental description

WP2-F1 policy:

- eligible for human acceptance
- eligible for future WP2-F2 controlled apply only after separate apply design
- no autonomous apply
- one reviewer may be sufficient for pilot

### Guarded Descriptive Attributes

Examples:

- weight
- origin
- HS code

WP2-F1 policy:

- eligible for human acceptance only if evidence is strong
- may require stronger source trust
- may require explicit reason
- may require later dual review before apply depending on field and customer visibility

### High-Risk Identity and Relationship Truth

Examples:

- OEM/reference code
- vehicle/fitment relationship
- compatibility relationship
- replacement
- supersession
- discontinued status

WP2-F1 policy:

- human acceptance may be recorded only as review judgement
- future apply is prohibited in WP2-F1
- future WP2-F2 apply requires stronger evidence, relationship-specific architecture, and likely dual review
- must not be treated as ordinary text enrichment

### WP2-F1 Prohibited Apply Fields

WP2-F1 prohibits apply for:

- OEM/reference code
- vehicle/fitment relationship
- compatibility relationship
- replacement
- supersession
- discontinued state
- Product identity
- canonical product code
- brand ownership
- supplier linkage

## 17. API Contract Outline

This is a future API responsibility outline only.
It is not implementation.

Preferred command shape:

- `GET /api/catalog/observation-review/:reviewItemId`
- `GET /api/catalog/observation-review/:reviewItemId/decisions`
- `POST /api/catalog/observation-review/:reviewItemId/decisions`
- `POST /api/catalog/observation-review/:reviewItemId/decision-reversal`

Avoid generic mutable PATCH endpoints unless a later API design proves they preserve ledger semantics.

Decision request must include:

- organization_id resolved from authenticated context
- review_item_id
- decision
- reason_code
- reviewer_note
- expected_version
- recommendation_fingerprint
- idempotency_key

Decision response must include:

- decision event
- current decision state
- reviewer
- decided_at
- decision version
- stale status
- apply eligibility
- audit reference

API must not:

- mutate Product
- mutate observations
- recalculate recommendation as a hidden side effect
- apply canonical values
- hide stale conflicts
- perform last-write-wins update

## 18. UI Behavior Contract

This is a future UI behavior contract only.
It is not implementation.

Required UI behavior:

- recommendation remains visually distinct from human decision
- decision control requires deliberate confirmation
- no one-click accidental acceptance
- reason required where policy demands it
- decision history visible
- stale decision clearly visible
- concurrent-change conflict handled without losing context
- post-action context preserved
- filter, scroll, selected row, and focus preserved
- success state does not remove the user from the workspace unexpectedly

WP2-F1 UI must not include Product apply controls.

Forbidden UI language for WP2-F1:

- Applied
- Published
- Product updated
- Canonical truth updated
- Auto accepted

Allowed language:

- Decision recorded
- Recommendation accepted by reviewer
- Recommendation rejected by reviewer
- Deferred
- More evidence requested
- Eligible for future apply review

## 19. Failure Handling

Expected behavior:

| Failure | Required Behavior |
|---|---|
| Duplicate submission | Return original event for same idempotency key or reject mismatched payload |
| Network timeout after commit | Retry returns committed event and audit reference |
| Stale version | Reject with deterministic stale conflict |
| Unauthorized reviewer | Reject, audit authorization failure |
| Organization mismatch | Reject fail-closed |
| Invalid transition | Reject with transition reason |
| Missing evidence | Reject or route to REQUEST_MORE_EVIDENCE |
| Changed recommendation | Mark stale and require re-review |
| Already superseded review item | Reject or require latest context |
| Reversed decision | Preserve history and derive current state |
| API retry | Idempotent replay, no duplicate decision |

Timeout must never create uncertain duplicate decisions.

## 20. Observability

Required operational and audit events:

- decision_attempt
- decision_success
- decision_rejected
- stale_conflict
- authorization_failure
- duplicate_idempotency_replay
- reversal
- supersession
- invalidation
- apply_eligibility_change

Do not log sensitive evidence payloads unnecessarily.

Observability must expose:

- decision count
- undecided count
- stale decision count
- decision conflict count
- idempotency replay count
- authorization failure count
- apply-eligible count
- apply-blocked count

## 21. Rollout Sequence

1. Architecture authorization
2. DB decision ledger and invariants
3. API decision command boundary
4. UI controlled decision interaction
5. Production reality check
6. Separate WP2-F2 canonical apply design
7. DB transactional apply boundary
8. API apply command
9. UI apply confirmation
10. Full ledger-to-Product proof

Each package must be independently testable and releasable.

## 22. Rollback Strategy

WP2-F1 rollback must not require Product data repair because WP2-F1 does not mutate Product.

Rollback options:

- disable decision command API
- hide decision controls
- keep read-only review workspace active
- preserve decision ledger history
- mark decision events inactive only through append-only reversal or invalidation
- do not delete audit evidence as the primary rollback path

If DB migration rollback is required later, it must preserve or explicitly export decision audit records before destructive schema removal.

## 23. DB Implementation Work Package

Next work package:

NM-CATALOG-WP2-F1-DB - Controlled Human Decision Ledger

DB scope:

- append-only decision ledger
- derived current decision view or projection
- decision enum/check constraints
- event type enum/check constraints
- reason code constraints
- organization isolation
- reviewer identity preservation
- recommendation fingerprint storage
- Product target value fingerprint storage
- observation value fingerprint storage
- expected version enforcement support
- idempotency uniqueness
- stale state support
- RLS/service-role boundary

DB non-goals:

- no Product apply
- no `catalog_products` mutation
- no observation mutation
- no backfill
- no UI/API implementation

## 24. API Implementation Work Package

Next API work package:

NM-CATALOG-WP2-F1-API - Controlled Decision Command Boundary

API scope:

- authenticated command endpoint
- organization resolution
- decision validation
- expected version validation
- idempotency handling
- audit reference response
- deterministic conflict responses
- decision history read endpoint

API non-goals:

- no Product apply endpoint
- no generic mutable PATCH
- no recommendation persistence side effect
- no acquisition or fetcher orchestration

## 25. UI Implementation Work Package

Next UI work package:

NM-CATALOG-WP2-F1-UI - Deliberate Human Decision Controls

UI scope:

- decision panel
- deliberate confirmation
- reason entry
- optional reviewer note
- decision history
- stale warning
- conflict response handling
- context preservation after decision

UI non-goals:

- no Product apply button
- no publish button
- no hidden auto-accept
- no one-click acceptance

## 26. Production Reality Check

After WP2-F1 implementation, production validation must prove:

- six review items still exist unless explicitly changed by later data
- decision count changes only through controlled command
- Product snapshots remain unchanged
- observation snapshots remain unchanged
- recommendation fingerprints are preserved
- duplicate retry does not duplicate decisions
- stale expected version is rejected
- unauthorized role is rejected
- organization mismatch is rejected
- decision history is visible
- no canonical apply occurred

## 27. Architecture Decision

WP2-F controlled human decision workflow is authorized with the safe split:

- WP2-F1 records controlled human decisions only
- WP2-F2 designs and implements canonical Product apply later

The recommendation engine remains advisory.

Human decision is recorded as append-only audit evidence.

Apply eligibility is explicit and separate.

Canonical Product truth remains unchanged until a later WP2-F2 apply boundary is designed, implemented, and validated.
