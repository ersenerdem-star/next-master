# NM-CATALOG-WP2-F1 Reversal Idempotency Concurrency Procedure

This procedure is intentionally not executed by Codex from this release worktree because no production-like DB integration connection is available here.

Run it only in a controlled database environment after applying:

`supabase/migrations/20260722_002_catalog_review_reversal_idempotency_order_fix.sql`

Do not run this procedure against production unless the selected review item is explicitly disposable.

## Required Setup

1. Use two independent database sessions.
2. Both sessions must authenticate as the same active admin or superadmin profile by setting the same JWT claims.
3. Select one controlled review item with a current `DECISION_RECORDED` event at version `1`.
4. Use the same reversal command payload in both sessions:
   - same `input_review_item_id`
   - same `input_reversal_target_event_id`
   - same `input_reason_code`
   - same `input_reviewer_note`
   - same `input_expected_decision_version`
   - same `input_idempotency_key`

## Session A

```sql
begin;

set local statement_timeout = '10min';
set local lock_timeout = '10s';
set local "request.jwt.claim.role" = 'authenticated';
set local "request.jwt.claim.sub" = '<admin_profile_id>';

select public.reverse_catalog_observation_review_decision(
  '<review_item_id>',
  '<target_decision_event_id>'::uuid,
  'DECISION_ENTERED_IN_ERROR',
  'controlled concurrent reversal validation',
  1,
  '<shared_idempotency_key>'
) as session_a_result;

select pg_sleep(10);

select
  public.catalog_review_current_version('<organization_id>'::uuid, '<review_item_id>') as current_version,
  count(*) filter (where event_type = 'DECISION_REVERSED') as reversal_events
from public.catalog_observation_review_decision_events
where organization_id = '<organization_id>'::uuid
  and review_item_id = '<review_item_id>';

rollback;
```

## Session B

Start this while Session A is sleeping.

```sql
begin;

set local statement_timeout = '10min';
set local lock_timeout = '10s';
set local "request.jwt.claim.role" = 'authenticated';
set local "request.jwt.claim.sub" = '<admin_profile_id>';

select public.reverse_catalog_observation_review_decision(
  '<review_item_id>',
  '<target_decision_event_id>'::uuid,
  'DECISION_ENTERED_IN_ERROR',
  'controlled concurrent reversal validation',
  1,
  '<shared_idempotency_key>'
) as session_b_result;

select
  public.catalog_review_current_version('<organization_id>'::uuid, '<review_item_id>') as current_version,
  count(*) filter (where event_type = 'DECISION_REVERSED') as reversal_events
from public.catalog_observation_review_decision_events
where organization_id = '<organization_id>'::uuid
  and review_item_id = '<review_item_id>';

rollback;
```

## Pass Conditions

- Exactly one session returns `idempotency_replay=false`.
- The other session returns `idempotency_replay=true`.
- Both results reference the same reversal `event_id`.
- Final current version is incremented exactly once.
- Exactly one `DECISION_REVERSED` event exists for the review item inside the controlled transaction scope.
- Neither session returns `CATALOG_REVIEW_DECISION_CONFLICT` for the identical replay.
