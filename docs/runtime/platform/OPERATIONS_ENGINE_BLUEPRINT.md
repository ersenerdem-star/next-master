# PLAT-002B Operations Engine Blueprint

Status: Blueprint only
Program: Phase 5 - System Mastery / Platformization
Decision: Design approved for future sliced implementation

## 1. Purpose

Operations Engine exists because Next-Master already runs long-running commercial and technical processes that operators must trust without asking Engineering whether work finished.

The current runtime has supplier imports, catalog sync, rollup refresh, catalog imports, reporting refreshes, and customer price replace workflows. Each exposes status in a different way. The Operations Engine creates one canonical status, readiness, progress, retry, audit, and observability model across those processes.

### Business Value

- Operators know whether they can continue.
- Failed background work becomes visible before customers are affected.
- Retryable failures are handled from the product instead of chat or SQL.
- Long-running work can be trusted because progress and last outcome are visible.
- New staged/background workflows get status by default instead of custom UI.
- Business readiness is separated from technical completion.

### Non-goals

Operations Engine must never:

- Own business truth.
- Replace domain RPCs.
- Execute business logic.
- Mutate domain data.
- Decide commercial outcomes.
- Bypass domain authorization.
- Rewrite ledgers, snapshots, imports, prices, catalog rows, or reporting facts.
- Turn every domain table into a generic job table.

Domain boundaries still own truth. Operations Engine owns operational visibility around domain-owned work.

## 2. Supported Operations

Initial supported operations:

| Operation | Domain Owner | Current Evidence | Operations Role |
| --- | --- | --- | --- |
| Supplier Import | Supplier | `supplier_price_import_runs`, `finalize_supplier_price_import_batch` | Track import/finalize progress and readiness |
| Supplier Catalog Sync | Supplier / Catalog | `catalog_sync_status`, `sync_supplier_price_catalog_from_import` | Track non-blocking enrichment warning/completion |
| Supplier Rollup Refresh | Supplier / Reporting | `supplier_price_rollup_refresh_runs`, `refresh_supplier_price_rollups_logged` | Track rollup rebuild status and retry |
| Catalog Import | Catalog | `catalog_import_runs`, `catalog_import_stage`, staged import RPCs | Track staged import lifecycle and validation/finalize outcome |
| Reporting Refresh | Reporting | `reporting_core_refresh_runs`, `refresh_reporting_core_logged` | Track projection refresh status and last success |
| Customer Price Replace | Pricing | customer price replace begin/stage/finalize/fail/cancel RPC boundary | Track staged replace status and customer-pricing readiness |

Future supported operations:

- Inventory rebuild.
- Portal sync.
- AI indexing.
- Export package generation.
- Customer price generation.
- Supplier scoring refresh.
- Commercial rule refresh.
- Any future long-running import, replace, rebuild, projection, or indexing job.

## 3. Canonical Operation Lifecycle

Operations Engine lifecycle values are product-facing states. Domain-native statuses are mapped into them by adapters.

| Status | Meaning |
| --- | --- |
| `queued` | Work has been accepted but has not started executing |
| `started` | Work has created an operation record and started setup |
| `processing` | Work is actively running |
| `waiting` | Work is waiting for another step, dependency, or manual condition |
| `retrying` | A safe retry has been requested or is running |
| `completed` | The operation finished successfully |
| `warning` | Business may continue, but a non-blocking follow-up failed or remains pending |
| `failed` | The operation failed and needs attention |
| `cancelled` | The operation was intentionally cancelled before completion |

### Domain Status Mapping Examples

| Domain Status | Canonical Status |
| --- | --- |
| Supplier `running` | `processing` |
| Supplier `finalizing` | `processing` |
| Supplier `finalized` / `succeeded` | `completed` |
| Supplier catalog sync `pending` | `warning` or `waiting`, depending on business readiness |
| Supplier catalog sync `running` | `processing` |
| Supplier catalog sync `failed` | `warning` if supplier prices are ready; `failed` only if the target workflow requires catalog sync |
| Rollup `running` | `processing` |
| Rollup `succeeded` | `completed` |
| Catalog import `validated` | `waiting` |
| Catalog import `validation_failed` | `failed` |
| Catalog import `finalized` | `completed` |
| Catalog import `finalize_failed` | `failed` |

## 4. Readiness Model

Readiness answers a business question: can the operator continue?

Technical completion answers an execution question: did this job finish?

They are related but not identical.

| Readiness | Meaning |
| --- | --- |
| `ready` | The business process can continue |
| `processing` | Required work is still executing |
| `waiting` | Required work has not completed or an upstream dependency is missing |
| `warning` | Business can continue, but an operational follow-up needs attention |
| `failed` | Business should not continue until the failure is handled |
| `blocked` | A human decision or external dependency is required |

Example:

- Supplier Import finalized = `ready` for customer price generation.
- Supplier Catalog Sync pending = `warning` only if customer price generation depends on supplier prices, not catalog enrichment.
- Supplier Catalog Sync failed = `warning` when prices are ready, `failed` only for workflows that require catalog enrichment.
- Catalog Import validation failed = `failed` because no catalog truth should be changed.
- Reporting Refresh failed = `warning` for transaction capture, but `failed` for a reporting delivery workflow.

Readiness must always be evaluated by the domain adapter because the same technical status may have different commercial meaning in different contexts.

## 5. Engine Modules

### OperationsRegistry

Defines known operation types, domain owner, adapter, retry policy, visibility rules, and supported actions.

Responsibilities:

- Register operation types.
- Prevent unknown ad hoc operation status surfaces.
- Map each operation to its owning domain.
- Declare allowed actions: retry, cancel, fail, view details.

### StatusTracker

Maps domain-native statuses into canonical lifecycle statuses.

Responsibilities:

- Normalize status vocabulary.
- Preserve domain-native status for diagnostics.
- Keep mapping behavior pure and testable.

### ProgressTracker

Calculates progress from available counters.

Responsibilities:

- Compute `progress_percent` when safe.
- Report staged/processed rows.
- Avoid false precision when total work is unknown.
- Support last-known progress for background jobs.

### ReadinessEvaluator

Determines whether the business can continue.

Responsibilities:

- Separate technical completion from business readiness.
- Classify non-blocking warnings.
- Mark true blockers explicitly.
- Expose one clear user-facing answer.

### RetryCoordinator

Describes and invokes safe retries through domain-owned APIs.

Responsibilities:

- Show retry only when safe.
- Call domain retry RPC/API, not generic mutation logic.
- Track retry count where available.
- Avoid retrying protected or destructive work without explicit domain support.

### WarningCollector

Collects non-blocking operational warnings.

Responsibilities:

- Surface catalog sync pending/failed after supplier import finalize.
- Surface stale reporting refresh.
- Surface background projection failures.
- Keep warnings visible without blocking unrelated work.

### AuditRecorder

Defines the audit data required for operations.

Responsibilities:

- Preserve operation id, owner, status, actor, timestamps, retry attempts, and last error.
- Use existing domain run tables first.
- Avoid inventing duplicate historical truth when domain run tables already hold evidence.

### OperationsProjection

Builds user-facing operation summaries from domain adapters.

Responsibilities:

- Produce decision-first rows for Operations Status UI.
- Provide filtering/sorting by severity.
- Hide implementation details until requested.
- Support a future central Operations panel without requiring every domain page to duplicate status logic.

## 6. Shared Data Contract

Canonical operation summary:

| Field | Meaning |
| --- | --- |
| `operation_id` | Stable id for this operation/run |
| `operation_type` | Registered operation type, for example `supplier_import` |
| `domain` | Canonical domain owner |
| `owner` | Business or runtime owner label |
| `status` | Canonical lifecycle status |
| `readiness` | Business readiness result |
| `progress_percent` | Optional progress percentage |
| `staged_rows` | Optional staged row count |
| `processed_rows` | Optional processed row count |
| `warning_count` | Number of non-blocking warnings |
| `error_count` | Number of blocking errors |
| `started_at` | Operation start timestamp |
| `updated_at` | Last known update timestamp |
| `finished_at` | Completion/failure/cancel timestamp |
| `retry_count` | Retry attempts if tracked |
| `last_error` | Last safe user-facing error |

Additional adapter-only fields may exist, but they must remain details and must not be required by the generic UI.

## 7. UX Contract

The default Operations screen must answer:

- Can I continue?
- Do I need action?
- Is something blocked?
- Is retry available?

Rules:

1. Decision-first summary appears before technical detail.
2. Status and readiness are shown separately when they differ.
3. Failed operations show the failed stage and safe next action.
4. Retry is visible only when the adapter declares it safe.
5. Cancel is visible only when the adapter declares it safe.
6. Detail rows are progressive disclosure.
7. No row noise by default.
8. Manual refresh is always available.
9. Lightweight refresh intervals may be used, but no high-frequency polling.
10. The UI must not imply business blocking when only a warning exists.

Recommended top-level labels:

- Ready
- Processing
- Waiting
- Warning
- Failed
- Blocked

## 8. Operations Projection

Domains expose operational state through adapters, not by exposing table internals directly to the UI.

Adapter responsibilities:

1. Read current domain operation state.
2. Preserve domain-native evidence for diagnostics.
3. Map domain-native state to canonical status.
4. Evaluate readiness.
5. Describe progress.
6. Identify retry/cancel/fail capabilities.
7. Return a canonical operation summary.

Projection must not:

- Perform domain mutations.
- Decide domain business rules.
- Construct SQL writes.
- Hide domain failure evidence.
- Override domain authorization.

Current projection pilot:

- Supplier operations already compose supplier import, catalog sync, rollup refresh, customer price readiness, last success, progress, and retry in `fetchCloudSupplierOperationsStatusAll`.
- This behavior should become an adapter-backed projection instead of supplier-specific dashboard logic.

## 9. Plug-and-Play Contract

To add a new operation type, a domain must provide:

1. Operation type name.
2. Domain owner.
3. Source of operational truth.
4. Native status values.
5. Native readiness rules.
6. Progress fields.
7. Error fields.
8. Started/updated/finished timestamps.
9. Retry/cancel/fail actions, if safe.
10. Visibility rules.
11. Authorization requirements.
12. Detail view fields.

Minimum adapter interface:

```ts
type OperationAdapter = {
  operationType: string;
  domain: string;
  loadSummaries(input: OperationQuery): Promise<OperationSummary[]>;
  mapStatus(nativeStatus: string | null): OperationStatus;
  evaluateReadiness(input: unknown): OperationReadiness;
  getActions(input: unknown): OperationAction[];
};
```

Plug-and-play rules:

- Every adapter must be read-only by default.
- Mutating actions must call domain-owned APIs/RPCs.
- Domain adapters must be independently testable.
- Generic UI must work without domain-specific branching for basic status/readiness/progress.
- Domain-specific details must be optional.

## 10. Implementation Roadmap

Recommended slices:

| Slice | Scope | Rule |
| --- | --- | --- |
| PLAT-002C | Shared operations types | Types/helpers only; no runtime behavior change |
| PLAT-002D | Operations mapper | Pure mapping helpers for canonical status/readiness |
| PLAT-002E | Operations registry | Static registry of supported operation types and owners |
| PLAT-002F | Supplier pilot | Adapter for supplier import/catalog sync/rollup refresh using existing data |
| PLAT-002G | Catalog import adapter | Adapter for `catalog_import_runs` |
| PLAT-002H | Reporting refresh adapter | Adapter for `reporting_core_refresh_runs` |
| PLAT-002I | Customer price replace adapter | Adapter for customer price replace run state |
| PLAT-002J | Operations projection facade | Read-only facade that aggregates operation summaries |
| PLAT-002K | Dashboard adoption | Replace supplier-specific composition with canonical summaries without UX redesign |
| PLAT-002L | Retry/cancel action descriptors | Standardize action metadata while keeping execution domain-owned |

Do not implement a generic background executor until the adapter/projection model is proven.

## Final Boundary

Operations Engine is the canonical answer to: what is happening, can business continue, what needs attention, and what safe action is available?

It is not the answer to: what is true, what should be written, what commercial decision should be made, or how a domain transaction should execute.
