# Import Engine Blueprint

Status: Phase 5 canonical platform blueprint.

Foundation:

- [Import Engine Assessment](./IMPORT_ENGINE_ASSESSMENT.md)
- [Next-Master Implementation Standards](../NEXT_MASTER_IMPLEMENTATION_STANDARDS.md)
- [Runtime Domain Ownership Index](../DOMAIN_OWNERSHIP_INDEX.md)
- [Catalog Blueprint](../blueprints/CATALOG_BLUEPRINT.md)

## 1. Purpose

### Why Import Engine exists

Import Engine exists to provide one canonical platform boundary for **staged, persisted import workflows** that must safely turn external files or payloads into commercial truth.

The platform problem it solves is repeated across Catalog and Supplier today:

- large file ingestion
- row normalization
- staged persistence
- validation before commit
- preview of proposed changes
- atomic finalize
- resumable retry / recovery
- visible operations status

### What business problem it solves

It protects commercial truth while allowing operators to load large datasets safely and to understand whether work is still running.

Business outcomes:

- catalog identity can be updated without silent overwrite risk
- supplier prices can be replaced / merged without losing staged data
- operators can see whether finalize / background work is done
- retries can continue from staged runs rather than restarting the file

### What it must not solve

Import Engine must **not** become a catch-all for every file-driven workflow.

It must not directly absorb:

- Quote Import
- Portal Import
- C-Price Replace
- Code Reference Import

Those remain adapter or adjacent flow types unless they later adopt the staged import contract.

It must also not own:

- generic export logic
- one-off document generation
- direct CRUD pages that are not import sessions
- background jobs that have no staged import origin

---

## 2. Supported Import Lifecycle

Canonical lifecycle:

`begin -> upload/parse -> normalize -> stage -> validate -> preview -> finalize -> background jobs -> operations status -> retry/cancel/fail`

### Stage meanings

- **begin**: create a run, bind scope, mode, owner, and status
- **upload/parse**: accept file or payload chunks and extract rows
- **normalize**: canonicalize codes, names, values, and source-specific fields
- **stage**: persist rows into run-scoped staging tables
- **validate**: detect duplicates, conflicts, missing required data, and unsafe mutations
- **preview**: expose proposed actions, counts, warnings, and conflicts before finalize
- **finalize**: atomically apply accepted staged rows to truth
- **background jobs**: queue non-blocking follow-up work such as sync or rollup refresh
- **operations status**: surface progress, completion, and failure state to operators
- **retry/cancel/fail**: provide safe recovery paths and explicit operator control

### Canonical lifecycle contract

An import session is not complete until:

- its truth mutation is finalized, and
- its required background work is either completed or explicitly visible as pending / failed

---

## 3. Engine Modules

### ImportSession

Owns:

- run identity
- organization scope
- owner domain
- import mode
- status
- timestamps
- created/finalized by

### ImportSourceAdapter

Converts a source-specific import into the canonical engine contract.

Examples:

- Supplier adapter
- Catalog adapter

### Parser

Reads CSV / XLSX / TSV / TXT payloads into normalized rows.

### Normalizer

Canonicalizes:

- codes
- brand names
- quantities
- numbers
- dates
- lifecycle / status values
- source-specific aliases

### StageManager

Persists staged rows, batch boundaries, and per-row metadata.

### Validator

Checks:

- required columns
- duplicate rows
- organization scope
- row conflicts
- mutation safety
- domain-specific business rules

### PreviewBuilder

Builds:

- insert / update / skip / error counts
- conflict summaries
- blocked-row summaries
- progress summaries

### FinalizeExecutor

Applies validated staged rows to truth with transactional safety.

Supports:

- full finalize
- batch finalize for large runs

### BackgroundJobDispatcher

Queues any non-blocking post-finalize jobs.

Examples:

- supplier catalog sync
- supplier rollup refresh

### OperationsTracker

Maintains user-visible state for:

- queued
- running
- pending
- failed
- completed
- retrying

### RecoveryManager

Provides:

- retry
- resume
- cancel
- fail
- rehydrate
- duplicate-finalize protection

### AuditTrail

Records:

- source
- run identity
- actor
- validation summary
- finalize outcome
- background status

---

## 4. Domain Adapter Contract

### Supplier adapter must provide

- source metadata
- supplier identity scope
- brand scope
- import mode
- row parser / normalizer
- staged row schema
- validation rules
- finalize semantics
- post-finalize background job mapping
- operations status mapping

Supplier-specific follow-up behavior may include:

- catalog sync
- rollup refresh
- retryable finalize batches

### Catalog adapter must provide

- source metadata
- brand scope
- market segment scope
- row parser / normalizer
- staged row schema
- validation rules
- finalize semantics
- run-failure handling
- status mapping

Catalog-specific follow-up behavior must remain limited to catalog truth update and any clearly defined catalog-facing refresh.

### Future adapters must provide

Every future adapter must implement:

- run begin
- chunk staging
- validation
- finalize
- fail / cancel
- status projection
- safe retry model

Adapters must not bypass engine rules.

---

## 5. Data Contract

Canonical fields:

- `run_id`
- `organization_id`
- `owner_domain`
- `source_type`
- `status`
- `staged_rows`
- `processed_rows`
- `error_count`
- `warning_count`
- `started_at`
- `finished_at`
- `created_by`
- `finalized_by`
- `background_status`
- `error_message`
- `conflict_summary`

Recommended supporting fields:

- `mode`
- `source_name`
- `input_scope`
- `batch_size`
- `batch_count`
- `validation_summary`
- `retry_count`

The engine should keep these fields in the run table or a view derived from run + stage metadata.

---

## 6. Status Model

Canonical statuses:

- `idle`
- `started`
- `staging`
- `staged`
- `validating`
- `validated`
- `validation_failed`
- `finalizing`
- `finalized`
- `background_processing`
- `completed`
- `failed`
- `cancelled`

### Status semantics

- `idle`: run not yet started or session not initialized
- `started`: run created, upload in progress
- `staging`: chunks are being written
- `staged`: all rows staged, awaiting validation
- `validating`: validation is running
- `validated`: validation passed, finalize may proceed
- `validation_failed`: validation blocked finalize
- `finalizing`: truth mutation is in progress
- `finalized`: truth mutation committed
- `background_processing`: follow-up jobs are running
- `completed`: all required work finished
- `failed`: run failed and needs retry / inspection
- `cancelled`: operator or system cancelled safely

Status transitions must be monotonic where possible and protected against double-finalize.

---

## 7. Operations UX Contract

Default view must be decision-first:

- Ready
- Waiting
- Failed
- Processing

Rules:

- no row noise by default
- details on demand
- show counts and high-level outcome first
- retry only when safe
- surface the last successful refresh / finalization point
- background work must be visible if it is business relevant

The operator should never have to ask whether the import finished.

---

## 8. Transaction / Safety Rules

- no truth mutation before finalize
- old truth remains visible until finalize succeeds
- failed finalize must not leave partial truth
- resumable finalize is required for large imports
- background jobs must not block business readiness unless the business rule explicitly says they do
- stage tables must preserve retry data
- validation must not silently rewrite truth
- cancel / fail must leave truth unchanged
- duplicate finalize must be rejected or no-op safely

Persisted import truth should always be reversible by rerunning the import, not by silently editing the historical run.

---

## 9. Performance Rules

- chunking is mandatory for large payloads
- batch finalize is required for high-volume imports
- timeout awareness must be built in
- memory safety beats loading the entire file into one transaction
- large-file strategy must favor stage-first, commit-later behavior
- progress updates must be lightweight and not overload the UI

Suggested performance posture:

- batch by row count and byte target
- split adaptively on timeout-like failures
- keep finalize work resumable
- use status polling / refresh only at human-meaningful intervals

---

## 10. Plug-and-Play Rules

To add a new staged import domain:

1. Define adapter contract for the domain.
2. Add run and stage tables or equivalent run-scoped storage.
3. Implement begin, stage chunk, validate, finalize, fail, cancel.
4. Add status projection.
5. Add retry / recovery semantics.
6. Add UI import entry that uses the engine contract.
7. Add operations status visibility.

### Required files or surfaces

At minimum, a staged import domain should add or wire:

- an adapter file in `apps/web/src/infrastructure/api/`
- engine orchestration in `apps/web/src/infrastructure/api/importApi.ts` or a future split module
- template support in `apps/web/src/shared/importTemplates.ts`
- status projection in a domain API such as `suppliersApi.ts` or a future engine status API
- an import surface in the relevant page
- app-rpc allowlist entries
- migrations for run / stage / finalize / recovery

### Must not be duplicated

- CSV parsing logic
- timeout retry logic
- run status vocabulary
- validation summary construction
- preview/progress patterns
- finalize safety semantics

---

## 11. Migration / DB Pattern

Canonical DB pattern for staged imports:

- run table
- stage table
- begin RPC
- stage chunk RPC
- validate RPC
- finalize batch RPC
- cancel/fail RPC
- status read RPC / view

Expected table pattern:

- `*_import_runs`
- `*_import_stage`

Expected RPC pattern:

- `begin_*_import`
- `stage_*_import_chunk`
- `validate_*_import`
- `finalize_*_import`
- `finalize_*_import_batch` for resumable large imports
- `fail_*_import`
- `cancel_*_import`

The engine should prefer one run row plus many stage rows, not direct truth mutation from the client.

---

## 12. Migration Path

### Supplier Import

Current runtime already shows the closest model to the intended engine:

- begin run
- stage rows
- finalize
- background catalog sync
- background rollup refresh
- operations status surface

Migration path:

1. Preserve current supplier behavior.
2. Move supplier-specific orchestration behind Import Engine interfaces.
3. Keep catalog sync and rollup refresh as adapter-managed background jobs.
4. Keep resumable finalize batch support.

### Catalog Import

Current runtime already has staged begin/stage/validate/finalize.

Migration path:

1. Preserve current run / stage tables and finalize boundary.
2. Move shared lifecycle and status vocabulary into the engine.
3. Make catalog a first-class adapter rather than a special-case implementation.

### Safe migration rule

The engine must absorb behavior by adapter, not by rewriting truth logic in a single breaking step.

---

## 13. Non-goals

Import Engine will not:

- replace quote pricing logic
- replace portal order capture
- replace C-price direct business policy until that domain adopts the staged boundary
- replace code-reference semantics unless they move to staged imports
- become a generic job scheduler
- own export generation
- own reporting read models
- own auth / role policy
- own domain-specific commercial rules
- own spreadsheet export formatting

---

## 14. Open Questions

- Should code-reference import remain a direct upsert or later become an Import Engine adapter?
- Should C-price import adopt the staged lifecycle or remain a separate pricing mutation flow?
- Should portal and quote file imports get a lighter pre-commit adapter API instead of full import sessions?
- Where should shared status projection live: a platform API or domain-specific projection APIs?
- Should finalized runs retain full staged payloads indefinitely or via retention policy?
- Should operations status be normalized into a dedicated shared engine after the import engine lands?

---

## 15. Implementation Roadmap

Recommended safe slices:

### PLAT-001C — Interface / types only

- define canonical import session types
- define lifecycle and status enums
- define adapter interface
- define data contract

### PLAT-001D — Shared status model

- define canonical run status projection
- define shared operations summary
- define retry / cancel / fail response shape

### PLAT-001E — Supplier adapter pilot

- move supplier import orchestration onto engine interfaces
- preserve current finalize / background status behavior

### PLAT-001F — Catalog adapter pilot

- move catalog import orchestration onto engine interfaces
- preserve staged finalize safety and validation behavior

### Later slices

- adapter cleanup
- legacy helper consolidation
- operations dashboard harmonization
- other import-like flows as adapters only if they truly need staged persistence

---

## 16. Summary

Import Engine is a platform boundary for staged, persisted imports.

It should be the canonical home for:

- import runs
- staged rows
- validation
- finalize safety
- resumable large imports
- operations status

It should start with:

- Supplier Import
- Catalog Import

And it should explicitly leave adjacent flows as adapters until they can prove they need the staged import contract.

