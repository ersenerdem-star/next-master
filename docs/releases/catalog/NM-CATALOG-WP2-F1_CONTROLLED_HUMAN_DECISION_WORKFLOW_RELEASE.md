# NM-CATALOG-WP2-F1 Controlled Human Decision Workflow Release Record

## Status
PRODUCTION_DB_VERIFIED

## Purpose
This release records the controlled human decision workflow integration for WP2-F1.

Scope is limited to decision recording and reversal for Catalog observation review items.
It does not include canonical Product apply.

## Authorities
- Architecture: `docs/architecture/catalog/NM-CATALOG-WP2-F_CONTROLLED_HUMAN_DECISION_WORKFLOW.md`
- DB: `docs/db/catalog/NM-CATALOG-WP2-F1-DB_CONTROLLED_HUMAN_DECISION_LEDGER.md`
- API: `docs/api/catalog/NM-CATALOG-WP2-F1-API_CONTROLLED_HUMAN_DECISION_COMMAND_BOUNDARY.md`
- UI: `docs/ui/catalog/NM-CATALOG-WP2-F1-UI_CONTROLLED_HUMAN_DECISION_INTERACTION.md`

## Workspace And Branch Verification
- Release workspace: `/Users/ersen/Developer/NextMaster/worktrees/release-catalog-wp2f1`
- Release branch: `codex/nm-catalog-wp2f1-release`
- Base commit: `03a8ed3ea6ea3a9c1a836ddf5fd4f582c340d978`
- DB commit: `c6529212eea5bc1e6e753718ed7fc2cd5fd5791d`
- API commit: `2b9bde5fd1651bcb01ba6835514e4cabdb10f12a`
- UI commit: `0aa1352a6a02c99ad0f506c93bc14d2058b4bc2d`

## Integrated Commit Ancestry
- `c6529212eea5bc1e6e753718ed7fc2cd5fd5791d` is an ancestor of `0aa1352a6a02c99ad0f506c93bc14d2058b4bc2d`
- `2b9bde5fd1651bcb01ba6835514e4cabdb10f12a` is an ancestor of `0aa1352a6a02c99ad0f506c93bc14d2058b4bc2d`
- release branch currently fast-forwards to `0aa1352a6a02c99ad0f506c93bc14d2058b4bc2d`

## Validated Change Set
- `docs/architecture/catalog/NM-CATALOG-WP2-F_CONTROLLED_HUMAN_DECISION_WORKFLOW.md`
- `docs/db/catalog/NM-CATALOG-WP2-F1-DB_CONTROLLED_HUMAN_DECISION_LEDGER.md`
- `docs/api/catalog/NM-CATALOG-WP2-F1-API_CONTROLLED_HUMAN_DECISION_COMMAND_BOUNDARY.md`
- `docs/ui/catalog/NM-CATALOG-WP2-F1-UI_CONTROLLED_HUMAN_DECISION_INTERACTION.md`
- `apps/web/src/i18n/locales/en.ts`
- `apps/web/src/i18n/locales/tr.ts`
- `apps/web/src/infrastructure/api/catalogObservationReviewApi.ts`
- `apps/web/src/presentation/components/common/Select.tsx`
- `apps/web/src/presentation/pages/CatalogObservationReviewPage.tsx`
- `apps/web/src/types/catalogObservationReview.ts`
- `netlify/functions/_shared/catalog/catalog-observation-review-api.mjs`
- `netlify/functions/catalog-observation-review-decision.mts`
- `netlify/functions/catalog-observation-review-decision-reverse.mts`
- `netlify/functions/catalog-observation-review.mts`
- `scripts/tests/catalog-observation-decision-ledger-sql.test.mjs`
- `scripts/tests/catalog-observation-review-api.test.mjs`
- `scripts/tests/catalog-observation-review-decision-api.test.mjs`
- `scripts/tests/catalog-observation-review-ui.test.mjs`
- `supabase/migrations/20260719_001_catalog_review_decision_ledger.sql`

## Validation Summary
- targeted DB test: passed
- targeted API test: passed
- targeted UI test: passed
- full `node --test scripts/tests/*.test.mjs`: passed, 75/75
- web build: passed
- `npm run audit:secrets`: passed
- `npm run audit:core`: passed after dependency install
- `npm run audit:hygiene:strict`: passed after dependency install
- `git diff --check`: passed

## Migration Review
Migration file reviewed for:
- append-only decision ledger
- row-level security
- authenticated admin/superadmin access
- optimistic concurrency
- idempotency
- tenant isolation
- no Product mutation
- no observation mutation
- no recommendation mutation
- no hidden apply path

## Production Migration Application
- Migration: `supabase/migrations/20260719_001_catalog_review_decision_ledger.sql`
- Application method: manually applied once through Supabase Dashboard SQL Editor
- Supabase SQL Editor result: Success
- Production verification result: `WP2F1_PRODUCTION_DB_OBJECTS_VERIFIED`
- Verification method: read-only SQL gate after manual migration application
- Re-run policy: do not apply or rerun this migration again
- Migration-history reconciliation risk: because this migration was manually applied outside the normal CLI migration runner, future CLI-based deployments must reconcile migration history before attempting automated migration application. The migration must be treated as already applied in production.

Production DB verification covered:
- `public.catalog_observation_review_decision_events` exists
- expected columns, constraints, indexes and structural foreign keys exist
- row level security is enabled
- admin/organization SELECT policy exists
- PUBLIC and anon have no unsafe direct table access
- authenticated and service_role have SELECT only on the ledger table
- direct INSERT/UPDATE/DELETE is unavailable through table privileges
- append-only UPDATE/DELETE trigger exists
- `record_catalog_observation_review_decision(...)` exists
- `reverse_catalog_observation_review_decision(...)` exists
- `get_catalog_observation_review_decision_state(...)` exists
- function EXECUTE privileges match the migration
- caller identity and organization resolution exist
- optimistic concurrency exists
- persistent idempotency exists
- reversal appends a new event
- no canonical Product mutation or apply path exists

## Runtime Boundary Summary
The release records controlled human decisions only.
It exposes decision recording, decision reversal, and current-state projection.
It does not apply recommendations to canonical Product truth.

## Production Evidence
Production DB object verification passed.
Application, deployment, runtime API, authenticated decision, idempotency, concurrency, authorization, reversal, UI context, and Product immutability proofs remain pending.

## Reversal Idempotency Hotfix
- Migration: `supabase/migrations/20260722_002_catalog_review_reversal_idempotency_order_fix.sql`
- Production application method: manually applied once through Supabase Dashboard SQL Editor
- Production migration result: Success
- Production behavior validation result: `REVERSAL_IDEMPOTENCY_BEHAVIOR_VERIFIED`
- Production post-migration verification result: `WP2F1_REVERSAL_IDEMPOTENCY_DB_VERIFIED`
- Root cause: exact replay of a previously accepted reversal command was evaluated after current-version conflict checks, so an idempotent replay could incorrectly return `CATALOG_REVIEW_DECISION_CONFLICT`.
- Correction: reversal idempotency lookup now resolves an existing same-key, same-payload event before evaluating expected-version conflict for genuinely new reversal commands.
- Preserved boundaries: no Product mutation, no observation mutation, no recommendation mutation, no canonical Apply path, and no WP2-F2 behavior.
- Re-run policy: do not apply or rerun `20260722_002` again in production.

## Accepted Residual Risk
- Open item: `NM-CATALOG-WP2-F1-HARDENING-001` - Reversal Idempotency Concurrent Replay Proof
- Status: accepted residual risk for this hotfix release.
- Rationale: production SQL behavior gates verified deterministic replay behavior, but the two-session concurrent replay proof remains deferred.
- Closure constraint: WP2-F1 must not be called fully closed until live production replay proof succeeds and the hardening item remains explicitly tracked.

## Rollback Posture
Migration rollback must be handled as a production DBA decision because the migration has already been manually applied successfully.
Application rollback remains pending production deployment and verification.

## Final Closure Token
Pending.
