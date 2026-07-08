# PLAT-002 Operations Engine Assessment

Status: Assessment only
Program: Phase 5 - System Mastery / Platformization
Decision: Operations Engine should exist

## Executive Conclusion

Next-Master needs a canonical Operations Engine for long-running and background processes.

The current system already has operational jobs with run tables, status fields, retry actions, background dispatch, and a dashboard status panel. The pattern is real, but it is implemented separately per workflow. Supplier Import is the strongest current example. Catalog Import, Reporting Refresh, Customer Price Replace, and supplier background jobs each expose parts of the same operational lifecycle without a shared contract.

The Operations Engine should not own commercial truth. Domain RPCs must continue to own truth changes. The engine should standardize operational visibility, status projection, readiness, retry/cancel/fail behavior, progress, audit, and user-facing status across long-running work.

## Evidence Reviewed

| Area | Evidence |
| --- | --- |
| Supplier Import status | `supplier_price_import_runs` fields read in `apps/web/src/infrastructure/api/suppliersApi.ts` |
| Supplier Import batch finalize | `finalize_supplier_price_import_batch` in `supabase/migrations/20260708_01_supplier_price_finalize_batches.sql` |
| Supplier Catalog Sync | `sync_supplier_price_catalog_from_import` and `catalog_sync_status` in `supabase/migrations/20260708_00_supplier_price_catalog_sync_background.sql` |
| Supplier Rollup Refresh | `supplier_price_rollup_refresh_runs` and `refresh_supplier_price_rollups_logged` in `supabase/migrations/20260628_80_supplier_price_rollup_ledger_health.sql` |
| Catalog Import | `catalog_import_runs`, `catalog_import_stage`, begin/stage/validate/finalize/fail/cancel RPCs in `supabase/migrations/20260707_97_catalog_import_staged_boundary_slice1.sql` through `20260707_zz_catalog_import_finalize.sql` |
| Reporting Refresh | `reporting_core_refresh_runs` and `refresh_reporting_core_logged` in `supabase/migrations/20260625_69_master_supplier_comparison_rollups.sql` |
| Background dispatch | `context.waitUntil` handling for supplier catalog sync and rollup refresh in `netlify/functions/app-rpc.mts` |
| Current UI visibility | Operations Status Center in `apps/web/src/presentation/pages/DashboardPage.tsx` |
| Shared status foundation | `apps/web/src/shared/importEngine.ts` and `apps/web/src/shared/supplierImportStatusMapper.ts` |

## Current Operational Flows

### Supplier Import

Purpose: Load supplier price rows, finalize them into `supplier_prices`, then make downstream pricing operations ready.

Current lifecycle:

1. UI parses and stages supplier file batches.
2. API calls `begin_supplier_price_import`.
3. API stages chunks through `stage_supplier_price_import_chunk`.
4. Finalize runs through `finalize_supplier_price_import_batch`.
5. `supplier_prices` is committed in resumable DB batches.
6. Catalog sync is queued separately through `queue_supplier_price_catalog_sync`.
7. Rollup refresh is queued through `queue_supplier_price_rollups_refresh`.
8. Dashboard status is projected through `fetchCloudSupplierOperationsStatusAll`.

Current status fields:

| Field | Meaning |
| --- | --- |
| `status` | Import run state: `running`, `finalizing`, `finalized`, `succeeded`, `failed` |
| `staged_rows` | Rows accepted into stage |
| `processed_rows` | Rows processed during finalize |
| `finalize_phase` | Batch finalize phase: `merge`, `cleanup`, `done` |
| `finalize_cursor` | Batch progress cursor |
| `error_message` / `finalize_error_message` | Finalize failure detail |
| `catalog_sync_status` | Background catalog sync state: `pending`, `running`, `succeeded`, `failed` |
| `catalog_synced` | Catalog rows affected by sync |
| `catalog_sync_error_message` | Catalog sync failure detail |

Current UI visibility: High. The dashboard shows supplier import status, started/finished/duration, staged/processed rows, errors, catalog sync, rollup refresh, customer price readiness, manual refresh, CSV export, and retry buttons for failed stages.

Retry/cancel/fail behavior: Retry exists for finalize, catalog sync, and rollup refresh. Fail exists for supplier import. No current supplier cancel path was observed.

### Supplier Catalog Sync

Purpose: Enrich or create catalog products from successfully finalized supplier import rows.

Current lifecycle:

1. Finalized supplier import leaves `catalog_sync_status = 'pending'`.
2. API/gateway queues `queue_supplier_price_catalog_sync`.
3. `app-rpc` dispatches `sync_supplier_price_catalog_from_import` with `context.waitUntil`.
4. DB updates `catalog_sync_status` to `running`, then `succeeded` or `failed`.

Current UI visibility: High inside the supplier operations row.

Current readiness rule: Catalog sync is operationally important, but supplier price finalize is the commercial gate for customer pricing. A pending or failed catalog sync should be shown as an operations warning unless a specific downstream flow requires enriched catalog data.

### Supplier Rollup Refresh

Purpose: Rebuild supplier price rollups used by downstream pricing/search/customer price generation readiness.

Current lifecycle:

1. API queues `queue_supplier_price_rollups_refresh`.
2. `app-rpc` dispatches `refresh_supplier_price_rollups_logged` with `context.waitUntil`.
3. DB records `supplier_price_rollup_refresh_runs`.
4. Dashboard projects status into every supplier/brand row.

Current statuses: `running`, `succeeded`, `failed`.

Current UI visibility: High inside the supplier operations row.

Retry behavior: Retry exists through dashboard action and `queueSupplierPriceRollupRefresh`.

### Catalog Import

Purpose: Stage, validate, and finalize catalog CSV rows into catalog truth.

Current lifecycle:

1. `begin_catalog_import`
2. `stage_catalog_import_chunk`
3. `validate_catalog_import`
4. `finalize_catalog_import`
5. `fail_catalog_import` or `cancel_catalog_import`

Current status fields:

| Field | Meaning |
| --- | --- |
| `status` | `running`, `validating`, `validated`, `validation_failed`, `finalizing`, `finalized`, `finalize_failed`, `failed`, `cancelled` |
| `staged_rows` | Rows staged |
| `valid_rows` / `error_rows` / `duplicate_rows` | Validation counts |
| `insert_rows` / `update_rows` / `skip_rows` | Proposed actions |
| `processed_rows` | Finalize progress/summary |
| `inserted_count` / `updated_count` / `skipped_count` | Finalize result |
| `error_message` | Failure detail |

Current UI visibility: Medium. The import path surfaces validation/finalize summaries during the workflow, but it is not integrated into a reusable Operations Status Center.

Retry/cancel/fail behavior: DB supports fail and cancel. Central retry/recovery UI was not observed.

### Reporting Refresh

Purpose: Refresh reporting projections and rollups.

Current lifecycle:

1. API calls `refresh_reporting_core` or `refresh_reporting_core_logged`.
2. DB writes `reporting_core_refresh_runs`.
3. Logged refresh records status, duration, counts, and error.

Current status fields: `status`, `started_at`, `finished_at`, `duration_ms`, count columns, `error_message`.

Current UI visibility: Partial. Reporting APIs can fetch refresh runs, but reporting refresh is not surfaced through the same Operations Status Center contract.

Retry/cancel/fail behavior: Retry is possible by re-invoking refresh. No shared retry/cancel contract was observed.

### Customer Price Replace

Purpose: Replace C-price/customer price list rows through a staged atomic boundary.

Current lifecycle evidence:

1. Gateway allowlists `begin_customer_price_list_replace`.
2. Gateway allowlists `stage_customer_price_list_replace_chunk`.
3. Gateway allowlists `finalize_customer_price_list_replace`.
4. Gateway allowlists `fail_customer_price_list_replace`.
5. Gateway allowlists `cancel_customer_price_list_replace`.

Current UI visibility: Not centralized in Operations Status Center.

Retry/cancel/fail behavior: DB/API names indicate fail and cancel support. A shared operations surface for this workflow was not observed.

### Existing Background / Queued Jobs

The clearest current background jobs are implemented as gateway special cases:

| Job | Dispatch |
| --- | --- |
| Supplier catalog sync | `queue_supplier_price_catalog_sync` returns queued response and uses `context.waitUntil` to call `sync_supplier_price_catalog_from_import` |
| Supplier rollup refresh | `queue_supplier_price_rollups_refresh` returns queued response and uses `context.waitUntil` to call `refresh_supplier_price_rollups_logged` |

This proves the need for a background operation abstraction, but the current implementation is still job-specific and embedded in `app-rpc`.

## Current Gap Analysis

| Gap | Current Impact |
| --- | --- |
| No canonical operation record | Each domain invents its own run table/status shape |
| Status vocabulary drift | `succeeded`, `completed`, `finalized`, `validation_failed`, `finalize_failed`, and `failed` require per-domain mapping |
| Readiness is mixed with completion | Supplier price finalize, catalog sync, and rollup refresh do not have the same business blocking meaning |
| Queue behavior is special-cased | `app-rpc` embeds specific `context.waitUntil` branches |
| Retry semantics are inconsistent | Supplier retry exists; catalog/reporting/customer replace are not centrally represented |
| Cancel support is uneven | Catalog supports cancel; supplier cancel was not observed |
| Visibility is supplier-centered | Operations Status Center does not yet generalize to Catalog Import, Reporting Refresh, or Customer Price Replace |
| Background failure does not share a standard user model | Errors are surfaced by workflow-specific fields |
| No common operations facade | UI and APIs compose status directly from domain tables and RPCs |
| No common audit trail | Run tables retain useful evidence, but there is no shared operational audit model |

## Recommended Engine Scope

The Operations Engine should own:

- Canonical operation status projection.
- Readiness calculation.
- Progress display.
- Duration and last-success metadata.
- Retry/cancel/fail action descriptors.
- Background job dispatch metadata.
- Error normalization for user-facing operations panels.
- Cross-domain Operations Status Center feed.
- Historical operation visibility.

The Operations Engine must not own:

- Supplier price truth mutation.
- Catalog truth mutation.
- Customer price replace transaction logic.
- Reporting projection SQL.
- Domain authorization rules.
- Domain-specific validation rules.
- Commercial decision logic.

Domain boundaries remain responsible for truth. Operations Engine observes, coordinates, and exposes operational state.

## Supported Job Types

Initial supported types should be:

| Job Type | Current Source |
| --- | --- |
| Supplier import finalize | `supplier_price_import_runs` |
| Supplier catalog sync | `supplier_price_import_runs.catalog_sync_status` |
| Supplier rollup refresh | `supplier_price_rollup_refresh_runs` |
| Catalog import | `catalog_import_runs` |
| Reporting core refresh | `reporting_core_refresh_runs` |
| Customer price replace | Customer price replace run/stage RPC boundary |

Future supported types:

- Inventory rebuild.
- Portal sync.
- AI indexing.
- Customer price generation.
- Export package generation.
- Any future long-running import, replace, rebuild, or projection refresh.

## Common Status Model

Operations Engine should define a canonical status model separate from domain-native statuses:

| Canonical Status | Meaning |
| --- | --- |
| `idle` | No active or recent operation exists |
| `queued` | Work has been accepted but not started |
| `running` | Work is executing |
| `waiting` | Work is blocked on another operation or external condition |
| `retrying` | A retry was requested or is in progress |
| `completed` | Operation completed successfully |
| `failed` | Operation failed and needs attention |
| `cancelled` | Operation was intentionally cancelled |
| `blocked` | Operation cannot continue without human or upstream action |

Domain-native status values should be mapped into this model through adapters.

## Readiness Model

Operations Engine should expose user-facing readiness separately from status:

| Readiness | Meaning |
| --- | --- |
| `ready` | Business can continue |
| `waiting` | Business should wait for required work |
| `processing` | Work is actively running |
| `failed` | Business is blocked or degraded until failure is handled |
| `warning` | Business can continue, but follow-up work is needed |

Supplier Import proves why readiness must be separate. Supplier price finalize can make customer pricing ready while catalog sync is still pending or failed as a warning.

## User-Facing Rules

Default Operations UX must answer: Can I continue?

Rules:

1. Show decision-first status: Ready, Waiting, Processing, Failed, Warning.
2. Hide row-level detail until the operator asks for it.
3. Always show started, finished, duration, current progress, and last successful completion when known.
4. Surface the exact failed stage and reason.
5. Show retry only when retry is safe.
6. Show cancel only when cancellation is implemented and safe.
7. Do not make operators ask Engineering whether a process finished.
8. Do not require page-specific knowledge to understand operational readiness.
9. Distinguish business blockers from non-blocking background warnings.
10. Keep manual refresh and a lightweight interval; no high-frequency polling.

## Technical Risks

| Risk | Impact |
| --- | --- |
| Over-centralizing truth mutation | Could violate domain ownership and transactional boundaries |
| Treating all completion as business readiness | Could block work unnecessarily or allow unsafe work too early |
| Hiding domain-specific failure detail | Could make incident diagnosis harder |
| Standardizing statuses before adapters are proven | Could break current working flows |
| Moving queue execution too early | Could destabilize supplier import and rollup refresh incident fixes |
| Generic retry without domain safety checks | Could repeat destructive or expensive operations |
| UI overload | Could turn Operations into a noisy dashboard instead of a decision surface |

## Should an Operations Engine Exist?

Yes.

The repository already contains enough repeated operational behavior to justify a canonical engine:

- Multiple run tables.
- Multiple lifecycle status columns.
- Multiple retry/fail/cancel patterns.
- Multiple background jobs.
- Multiple long-running flows.
- Current dashboard status composition.
- Current status helper platformization work.

The correct next move is not a rewrite. The safe path is adapter-first platformization.

## Implementation Slices

| Slice | Decision | Scope |
| --- | --- | --- |
| PLAT-002A | Blueprint | Define canonical Operations Engine contract, modules, adapters, and non-goals |
| PLAT-002B | Shared types | Add shared operation status/readiness/types/helpers only |
| PLAT-002C | Supplier operations adapter | Map supplier import/catalog sync/rollup refresh into canonical operation summaries |
| PLAT-002D | Catalog import adapter | Map `catalog_import_runs` into canonical operation summaries |
| PLAT-002E | Reporting refresh adapter | Map `reporting_core_refresh_runs` and supplier rollup refresh runs consistently |
| PLAT-002F | Customer price replace adapter | Map staged replace runs into canonical operation summaries |
| PLAT-002G | Operations facade | Create read-only API facade that aggregates operation summaries without changing domain behavior |
| PLAT-002H | Dashboard integration | Replace supplier-specific status composition with canonical summaries while preserving current UX |
| PLAT-002I | Retry/cancel descriptors | Standardize safe action metadata without executing generic retries blindly |
| PLAT-002J | Background dispatcher assessment | Decide whether `app-rpc` queue special cases should become a shared dispatcher |

## Immediate Recommendation

Proceed to PLAT-002A Operations Engine Blueprint.

Do not build generic execution first. Start with a read-only contract and adapter model. Supplier operations should remain the pilot because they already contain the richest status, retry, and readiness behavior.
