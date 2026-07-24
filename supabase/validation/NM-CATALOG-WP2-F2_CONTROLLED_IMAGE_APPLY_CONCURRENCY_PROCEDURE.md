# NM-CATALOG-WP2-F2 local concurrency proof

Scope: disposable local Supabase database only. This procedure is neither a
production runbook nor authority to expose the function through an API/UI.

1. Run `NM-CATALOG-WP2-F2_CONTROLLED_IMAGE_APPLY_CONCURRENCY_SETUP.sql`.
2. In two separate transactions, set the authenticated authorizer fixture as
   `request.jwt.claim.sub`, and call
   `apply_catalog_observation_review_image` once with the same fixed review
   item, accepted decision, expected fingerprints, and idempotency key.
3. Keep the first transaction open after its call so that the second races for
   the same target and idempotency lock.
4. Expected durable result: first response has `idempotency_replay=false`,
   second has `idempotency_replay=true`, both carry the same `apply_event_id`,
   and the ledger contains exactly one row for the fixture organization.
5. Run `NM-CATALOG-WP2-F2_CONTROLLED_IMAGE_APPLY_CONCURRENCY_CLEANUP.sql` and
   confirm zero fixture organizations, profiles, observations, decision events,
   and Apply events remain.

The cleanup contains fixed local UUIDs and temporarily uses
`session_replication_role = replica` solely to remove the append-only and
integrity-trigger fixture rows. It must never be used against a shared,
staging, or production database.
