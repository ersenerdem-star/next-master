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

## V3 Staging Admin Export Verification — 2026-10-14

This dated evidence supplements the assessment above; it does not mark the generic Operations Engine slices complete. The verified environment is `https://next-master-v3-staging-20261006.netlify.app/`, Supabase project `kaxsqafdevabkxofwdod`, and the `codex/price-engine-integration` checkout. No production deployment is represented by this evidence.

Catalog, Master/Supplier Comparison, and supplier-plus-brand exports now use background jobs. The source RPCs use stable keyset cursors, verified complete counts, and source-version checks. JSON chunk RPCs carry up to 5,000 rows without silently inheriting the PostgREST 1,000-row response cap. A fenced lease and heartbeat prevent stale workers from publishing another attempt's result. Files are streamed to temporary storage and finalized only after complete artifact upload.

Published supplier-price pointers determine purchase-price sources and A/B sales prices. A legacy source is permitted only when the selected brand has no published pointer. Invalid pointers fail closed. Eligible published rows must have accepted status, a positive EUR price, an effective date, and matching punctuation-preserving product identity. New import validation rejects duplicate normalized identities before publication. Preview totals from accepted-row metadata are labelled estimates; export preparation independently verifies the exact count.

Artifacts over 40 MiB are stored as bounded private objects and signed together. The browser verifies each part and the total size before saving one complete file. Missing parts, stale sources, cursor gaps, and incomplete counts fail the export. The current browser download guard is 128 MiB; these admin XLSX exports enforce Excel's 1,048,575-data-row worksheet capacity explicitly.

### Browser and File Evidence

All filenames below refer to actual Chrome downloads under `/Users/ersen/Downloads`.

| Surface | File | Data rows | Bytes | Staging job |
| --- | --- | ---: | ---: | --- |
| Supplier + brand, published Clevite/Sood | `supplier-Sood-Clevite-20261014.csv` | 999,997 | 48,752,699 | `373a8860-7687-4e5b-af72-ef5b855a8169` |
| Supplier + brand, legacy Euroricambi/Sood | `supplier-Sood-Euroricambi-20261014.csv` | 542 | 26,282 | `d9f1b718-1ebf-4c04-84c3-8255a5a0a848` |
| Master / Supplier Comparison, priced Clevite | `master-Clevite-priced-20261014.xlsx` | 999,997 | 86,499,232 | `1dbf9ab3-1937-4c76-83b9-efca879872cc` |
| Catalog CSV, staging fixture data labelled Clevite | `catalog-Clevite-20261014.csv` | 145,050 | 18,422,895 | `f276efbb-b119-4066-94a1-0a92b9fc79aa` |
| Catalog XLSX, same staging fixture data | `catalog-Clevite-20261014.xlsx` | 145,050 | 10,157,203 | `6fe7ce9c-58dd-47d8-874c-85a0b869ca50` |

Full-file scans found no empty or duplicate product codes, malformed CSV rows, or unsafe formula text. The supplier CSV preserves 147,440 leading-zero codes and 165 punctuated codes. The catalog rows are staging fixtures, not verified commercial Clevite catalog content. The legacy supplier artifact also exercises cached paths with reserved characters through the batch signer.

The complete Master workbook has text product-code cells and numeric purchase/A/B price cells, with no formula or error cells. Its entire code-and-purchase-price fingerprint matches the supplier CSV: `2a144d7f52d1ff5bf62197dee78826131a474a6f7e7ce1f6cda680a3db1edd75`. Every row's A/B price matches 10%/15% markup with decimal half-up rounding. Example: `00-701615301C`, purchase EUR 76.59, A EUR 84.25, B EUR 88.08. The background worker finalized in 338.8 seconds; Storage part sizes were 41,943,040, 41,943,040, and 2,613,152 bytes, and the saved file matches their total exactly.

The catalog XLSX finalized in 46.7 seconds. Its complete code set and all 15-column record fingerprints match the catalog CSV, with no formula or error cells. Chrome's download history visibly confirms all five downloads; the browser proof was captured at `/tmp/nm-staging-export-downloads.png`.

### Regression Evidence

The export download guards, browser transport, lease, source-integrity, and actual multipart-worker suites passed 40/40 tests. The PostgreSQL fixture checks cover 150,001 catalog rows, eligibility and punctuation, bounded JSON chunks, exact source counts, service-only RPC execution, and A/B calculations. The embedded PostgreSQL execution passed; the separate Docker runner is available but is not claimed as executed. Frontend TypeScript/Vite and Netlify function builds passed. These are local and staging results, not production proof.

## Price Engine Production Promotion Preparation — 2026-10-14

Scope: supplier file ingestion, its explicit price-publication boundary, purchase/sales price consumers, customer/admin price exports, supplier-plus-brand exports, Master/Supplier Comparison exports, and catalog import/export. Preparation started from `adafb63d` in the existing `codex/price-engine-integration` worktree. This section does not expand the generic Operations Engine assessment into a platform rewrite. No production schema, environment, worker, data, or deployment change is authorized by this preparation package.

The production target is `https://portal.next-master.com`, Supabase project `zjgueqijumzlfioihnkt`. The reference remains the V3 staging project `kaxsqafdevabkxofwdod`; its fixture prices, catalog rows, job identifiers, and DBOS history must not be copied into production.

### Confirmed Production Differences

The production read-only metadata inspection reported a healthy PostgreSQL 17.6.1.104 project with an existing `app_export_jobs` table. The supplier release, release-row, batch/event, upload-session, validation, publication, and current-pointer foundation is absent. The catalog private-source and source-batch tables are also absent. Consequently, passing staging exports does not establish a deployable production schema baseline.

The private production `app-exports` bucket currently has a 100 MiB object limit and allows XLSX, CSV, and JSON MIME types. It does not allow `application/octet-stream`, which the bounded multipart writer uses. The supplier import and catalog import source buckets are absent. The preparation must reproduce the private-source buckets and policies, and add the binary artifact MIME capability before the new runtime can be opened; it must not alter subscription/global Storage limits without separate evidence that this is needed.

The supplier foundation was created outside the canonical repository migration chain. Minimal table shapes in the export PostgreSQL fixtures are test scaffolding, not a foundation migration. The production bootstrap is now prepared from the real staging PostgreSQL definitions, including their dependent helper functions, constraints, grants, RLS, and Storage seal policies. It includes twelve tables and twenty-nine functions, with 125 captured prerequisite columns and seven helper-function fingerprints. Unsafe direct browser table grants are excluded and the private schemas remain closed. `CREATE TABLE IF NOT EXISTS` for `app_export_jobs` alone does not prove the existing production table has all required columns/types, lease fields, constraints, indexes, or grants.

The production read-only profile inventory reports nine A, one B, one C, and three custom/Other profiles. The Ersen C account has the prior user's explicit A-profile instruction; its exact UUID/organization-scoped alignment is a separate controlled data operation, not an automatic schema migration. Juventa's effective embedded custom markup is 20%, even though the typed markup column is null. Preserve that effective custom value and its provenance rather than resetting the account to A/B.

The supplier verified-upload admission, browser TUS client, and strict Auth/session helper were present only in the dirty `f191e12e` source checkout, while the integration checkout still contained the legacy CSV importer. The eight selected feature modules have now been ported into the canonical integration worktree; source-file hashes and origin paths are recorded in `scripts/ops/evidence/supplier-verified-admission-source-20261014.json`. Only the verified branch and its progress/options wiring were inserted into `SuppliersPage`; its tested supplier-plus-brand background export handler was preserved byte-for-byte. No entire dirty page or unrelated source files were copied.

The prepared admission/options/status/finish routes require `SUPPLIER_PRICE_UPLOAD_VERIFIED_ADMISSION_ENABLED=true`. Production additionally requires `SUPPLIER_PRICE_UPLOAD_PRODUCTION_ENABLED=1`, the exact production `NM_PRODUCTION_TARGET` and Supabase URL, and the canonical portal request origin. The frontend requires its corresponding verified-upload/production/target flags and exact portal origin. A requested but misconfigured verified frontend fails before the legacy writer. The verified flow uploads CSV/XLSX to the same admitted private object, requests source verification, and reads status; it never invokes price publication. Browser pause aborts transfer with `abort(false)` and preserves the resumable object. Status and finish also need `SUPPLIER_PRICE_UPLOAD_VERIFICATION_ENABLED=true`; these Netlify `true` flags are distinct from the worker service's `1` opt-ins.

The browser checksum uses exact-pinned `@noble/hashes@2.4.0` pure JavaScript SHA-256, following its [incremental API](https://github.com/paulmillr/noble-hashes#implementations). The actual transfer hashes raw file bytes in 1 MiB slices, reports monotonic progress, yields between slices and honors cancellation before another read. It retains the admitted 1 GiB size cap without making a whole-file browser buffer. No WebAssembly, eval permission or CSP weakening is required. The existing TUS SDK remains pinned to 4.3.1. Embedded PostgreSQL verification is reproducible through the root dev dependency `@electric-sql/pglite@0.3.16`.

Verified supplier imports currently support complete **replace** snapshots only. A partial merge file cannot become the complete current-price source: doing so would silently drop prior rows absent from that file. The verified UI therefore hides merge, the actual client rejects it before hashing/Auth/admission, the authenticated server rejects it before a session RPC, and production publication independently checks `mode='replace'`. No layer silently converts a requested merge into replacement. The existing legacy importer retains its merge behavior when the verified feature is not requested. Supporting verified merge later requires materializing and validating the complete prior-plus-delta snapshot before moving the current pointer; it is outside this promotion.

### Saved Preparation Artifacts

| Artifact | Purpose |
| --- | --- |
| `scripts/ops/price-engine-production-manifest.json` | Fifty-nine explicitly ordered and hashed schema files, including the captured foundation, production publication/reversal and additive export bucket MIME capability. Customer alignment SQL is separately hashed and never auto-applied as a schema file. Includes target-specific runtime configuration and pending acceptance evidence slots. |
| `scripts/ops/price-engine-production-preflight.sql` | A single read-only metadata query. Reports required object presence, column types, RLS/grants, RPC signatures/body fingerprints, indexes, private buckets, job constraints, and relevant policies; executes no domain RPC or business query. |
| `scripts/ops/price-engine-production-preflight.mjs` | Offline analyzer. It has no provider/database/deploy client. Missing metadata, a wrong recorded target, incompatible grants/MIME/indexes, or runtime function drift fail closed. |
| `scripts/tests/price-engine-production-preflight.test.mjs` | Verifies missing-schema reporting without object creation, target and omitted-snapshot rejection, binary MIME/browser grant blockers, function-body drift, and migration hash/acceptance closure. |

Snapshot transport records the connector's actual project target in an envelope: `{ "project_ref": "<target>", "data": <price_engine_preflight SQL result> }`. The SQL database name alone cannot establish a Supabase project identity. Envelopes contain metadata, never service keys or database connection strings.

The baseline check tests the existing legacy prerequisites and reports absent feature foundation as preparation work. The runtime check requires all feature capabilities and the reviewed staging reference. It reports metadata compatibility separately from provider readiness and commercial canaries.

```sh
node scripts/ops/price-engine-production-preflight.mjs \
  --snapshot /absolute/path/production-metadata.json \
  --project-ref zjgueqijumzlfioihnkt --phase baseline

node scripts/ops/price-engine-production-preflight.mjs \
  --snapshot /absolute/path/production-metadata.json \
  --reference /absolute/path/v3-staging-metadata.json \
  --project-ref zjgueqijumzlfioihnkt --phase runtime
```

These commands analyze saved snapshots only. Neither command applies SQL, changes an environment variable, dispatches a worker, or deploys a site. Runtime `production_ready` also remains false while any required acceptance result is pending in the manifest.

### Ordered Promotion Contract

1. Record the exact current production Netlify deployment and Render image revisions. Capture baseline metadata and source definitions before any change; retain existing customer profiles, jobs, catalog, supplier prices, and publication provenance.
2. Replay the captured supplier foundation and its helper/policy dependencies first on a disposable production-shaped database. Add the separately reviewed exact-production publication interface; the two `publish_supplier_price_release_staging` migration files are explicitly excluded. Their function bodies contain no actual project guard, despite the staging-only comments.
3. Replay the supplier validation upgrades, published-price consumer bridges and their A/B/customer-identity guards, bounded export source/index/job contract upgrades, and catalog private-source/validation/finalization chain in the manifest's explicit dependency order. Do not run every branch migration or the automatic "apply all staged migrations" ship path.
4. Check the upgraded schema and grants against the runtime snapshot contract. Preserve the production authenticator timeout; only the three bounded JSON export chunk RPCs carry their reviewed 35-second budget. Confirm complete keyset counts and current-pointer fail-closed behavior before opening work admission.
5. Prepare distinct production supplier and catalog Render services and DBOS history databases using the reviewed production target/origin opt-ins. Staging service/history definitions and operator-recovery IDs are not production configuration. Netlify export DB credentials must target production with TLS certificate verification retained.
6. Activate the reviewed build and admissions only after schema/provider checks pass. Run the small authorized production canaries described below before declaring full integration complete. The preparation itself performs none of these production mutations.

Both production worker Blueprints keep service activation and history-confirmation values operator-owned with `sync: false`. At initial provisioning, enter `0` for activation and confirm history only after the dedicated database has been checked; change the activation values to `1` during the reviewed release. Later Blueprint synchronization must preserve these values rather than resetting an active catalog worker to `0`. Missing or disabled activation fails startup before DBOS; it is not a healthy idle mode. The Netlify admission gates can remain closed while an enabled worker is checked against an empty production queue. Render only prompts for `sync: false` values during initial Blueprint creation, so add or change these values manually on an existing service ([Render environment-variable behavior](https://render.com/docs/blueprint-spec#prompting-for-secret-values)).

Each production worker also declares a 1 GB disk at `/var/lib/next-master-deployment-guard`. Render stops the old disk-backed instance before starting its replacement, preventing two instances from sharing the same stable DBOS executor identity during deploy or restart. The mount is unused by application code; DBOS history remains in the separately named private PostgreSQL databases and upload sources remain in Supabase Storage. The conservative planned incremental monthly cost is **$91.50**: two `1c-2g` workers at $25 each, two `0.5c-1g` PostgreSQL instances at $19 each, 10 GB of PostgreSQL storage at $0.30/GB, and two 1 GB guard disks at $0.25/GB. This estimate counts all provisioned paid PostgreSQL storage; it does not assume the pricing page's 1 GB inclusion applies to these paid instances. Workspace fees, taxes, bandwidth/build overages and any account discounts are separate. Confirm the provider's resource-creation quote before purchase; these definitions do not establish provisioning or payment ([Render deploy behavior](https://render.com/docs/deploys), [pricing](https://render.com/pricing)).

### Commercial Acceptance

Acceptance must follow one scoped source file through bytes/hash/row sealing, persisted validation, explicit publication, the supplier current pointer, purchase-price lookup, A/B or customer explicit markup, quotation and linked sales/invoice identity, and the final exported file. Use leading-zero and punctuated product identities, one valid row, a duplicate normalized identity, and an ineligible currency/date/price case. Replayed admission/publication must not duplicate truth records. A validated release is distinct from a published release.

For a valid EUR purchase price, Master, supplier export and quotation must select the same published source. A and B use their active settings with decimal half-up rounding; a nonempty explicit customer markup overrides that customer's list profile. C must not be offered or silently selected. The existing Ersen-account A-profile instruction must be verified on the production account before customer acceptance; staging account state does not resolve production customer data.

The customer upload-for-price-query limit remains 200 lines with a visible warning. It is a separate bounded query workflow, not the million-row supplier import or export. Verify that the warning and splitting guidance remain available rather than increasing the query limit during this promotion.

Catalog acceptance uses an authorized scoped catalog CSV, source verification and a worker restart/resume, then exact single finalization. Its completed source must no longer be pollable. Export acceptance covers customer/admin A/B, supplier plus brand, Master/Supplier Comparison, and catalog CSV/XLSX through the authenticated browser. Confirm full counts, source versions, complete multipart byte totals, product-code identity, numeric prices, and the explicit XLSX row/browser-size guard; a successful API response alone is insufficient.

### Rollback Boundary

Before activation, record the prior Netlify deploy ID and production worker image revisions in the acceptance evidence. Stop new supplier/catalog admissions through their exact-production opt-ins, stop or drain the corresponding workers, and retain leases/history so an old process cannot publish a different attempt's result. Restore the prior reviewed Netlify/Render builds as needed.

The prepared catalog, Master and supplier export routes now require the exact production Supabase URL/`NM_PRODUCTION_TARGET`, no staging target, `NM_PRODUCTION_ADMIN_EXPORT_ENABLED=1`, and `NM_PRODUCTION_EXPORT_PAUSED=0`. Closing that gate blocks new starts, worker entry, retries, and newly signed downloads. An already-running background function and a previously issued five-minute signed URL can still complete; closing the gate does not revoke them mid-flight. Persisted finalized artifacts and completed operations remain available for trusted operational inspection.

The verified current production baseline is Netlify deployment `6ac57511d27a107c6c49cff3` (public version: branch `master`, git `local`, build time `2026-10-06T22:24:25Z`). Its export bridge is disabled (`NM_PRODUCTION_EXPORT_BRIDGE=0`) and paused (`NM_PRODUCTION_EXPORT_PAUSED=1`); catalog storage and supplier verified-admission/verification flags are unset. This records the prior production build and closed flags, not a promotion of the prepared code.

Rollback does not delete DBOS history, upload source evidence, completed export objects, supplier publications, finalized catalog data, or existing prices. The separately prepared production publication/reversal migration keeps both database controls disabled by default. Reviewed operator decisions bind actor, tenant/supplier/brand, review revision, target publication and expected current pointer, and persist immutable receipts. Historical publication replay does not move a newer pointer backward. Reversal is a separate audited domain operation; it does not rewrite historical sales orders, purchase orders or quotation snapshots. If additive migration changes introduce a defect, keep admissions closed and apply a reviewed forward repair.

### Preparation Verification

The local read-only preflight and offline gate suites passed 5/5 tests, including actual metadata SQL execution in embedded PostgreSQL against a database with none of the feature tables. It returned absent capabilities without creating an object. This verifies the preparation tooling only. Foundation and ordered-chain replay are recorded below; production worker readiness, authenticated production canaries and deployment remain separate pending evidence slots that prevent the manifest from reporting production ready.

The final metadata snapshot shape covers 32 tables, 36 required columns, 52 exact public/private function capabilities, nine performance/lease indexes, four private buckets and two private schema boundaries. Production-specific publication/reversal functions are checked independently of the staging function fingerprints, since they are intentionally absent from the staging contract.

The supplier admission target/Auth/session/object-scope tests, ported browser transport suites, replace-only guards and pure-JavaScript checksum suites passed 54/54 tests, including the actual TUS SDK resuming an interrupted PATCH with HEAD at the exact offset into the same object. Foreign hosts/receipts, revoked/expired sessions, unknown revocation state, tenant denials, missing production flags, and oversized finish bodies were rejected before the relevant mutation. The actual compiled client rejects merge without a file read, progress event, Auth lookup or network request; the server rejects authenticated merge before any session RPC. Checksum tests compare Node crypto across SHA block and 1 MiB chunk boundaries, non-UTF8 and zero bytes; empty or aborted inputs are rejected, and a timer can pause work before the second read. The verified-only TR/EN hint explicitly requires a complete supplier/brand snapshot and a separate publication step; the legacy hint is preserved. No fixture network request escaped the mocked transport; these are local contract tests, not real production Auth/browser evidence. Frontend TypeScript passed, and the existing complete-export regression suites still passed 40/40 after the scoped supplier upload port.

The captured foundation's migration/grant/type/tenant/lease/Storage fixture suites passed 5/5 tests, and its actual production publication integration with the captured cross-brand validator passed 3/3 tests. The exact Ersen customer alignment's compare-and-set fixtures passed 2/2. The additive export-bucket MIME SQL passed 3/3 embedded PostgreSQL tests: it preserves the existing private 100 MiB bucket and accepted types, touches no other bucket, leaves unrestricted MIME configuration unchanged, and performs no write on exact replay. Missing, public or undersized target buckets fail atomically.

The complete 58-entry ordered schema chain then passed twice in isolated PG17, using actual production metadata for 38 public tables, 88 public functions, seven Auth/Storage helper definitions, enums/extensions and Storage configuration. The fixture preserves actual generated columns, constraints, foreign keys, indexes, triggers, RLS and ACL; domain/Auth helper bodies are not replaced by synthetic implementations. An existing synthetic finalized job retained every original business field after both passes. The logical schema fingerprint was identical after the first and second pass. Production publication/reversal controls remained disabled, browser publication/control access stayed denied, and the private export bucket retained its original 100 MiB capacity and MIME types with only the required binary type added. A separate test-only permissive-policy challenge confirmed that the restrictive prepared-object fence still denies browser reads/writes while its nonprepared positive control remains accessible.

The executable test is `scripts/tests/price-engine-full-schema-replay.test.mjs`; its exact ordered hashes and results are saved in `scripts/ops/evidence/price-engine-full-schema-replay-local.json`. This closes the isolated ordered-chain acceptance only. Production schema application, actual Storage global capacity, Render worker/history readiness and authenticated production business canaries remain pending.

```sh
node --test --test-concurrency=1 scripts/tests/price-engine-full-schema-replay.test.mjs
```

### Fresh Staging Admission Proof

Preparation commit `2f5327b952de5f601c2fc40a70366ebda74e74e3` was deployed only to the dedicated V3 Netlify site, deploy `6acf6cbaba9f77e87bd2ddc6`. Production still reports the saved `6ac57511d27a107c6c49cff3` deployment. In an authenticated Chrome session, a generated 482-byte, three-row Sood/Clevite CSV followed the new browser SHA-256/TUS/admission/finish/status path. Source verification completed between `2026-10-14T11:55:04.700501Z` and `2026-10-14T11:55:15.063377Z`. The persisted release was subsequently `validated`, with three processed/accepted rows, zero conflicts/rejections, and three actual release rows.

The same-session browser status showed `Verification: verified. Release: validated. 3 source rows. This is not publication confirmation.` Brand identity comparison remains pending and this test deliberately did not publish. The existing Clevite 1M current pointer stayed on release `fed8b4fe-402e-40c5-967c-df587c91acdd`, publication `5f255b1f-63b0-49d8-8b2b-314bfab1a77b`, with its original update timestamp unchanged. The scoped evidence is `scripts/ops/evidence/supplier-verified-upload-staging-20261014.json`. This proves fresh staging ingress and worker validation, not production publication or commercial acceptance.

The verified-only publication hint was then deployed in commit `df39596f3c0de348b1c2bcbd05d209d13096eed1`, V3 deploy `6acf6e5151a47a749b1ae15f`. The authenticated browser displayed the corrected Turkish full-list/separate-publication wording after reload; its admin session remained signed in. Transfer and publication logic did not change after the upload proof. Production remained on its original deployment.

### Production continuation preflight — 2026-10-14

The user authorized continued production transition, then required lower-cost alternatives to be evaluated before incurring the new infrastructure cost, with no unproven capacity reduction. The actual Render workspace UI still reports Hobby as the current plan; Pro is a selectable $25/month workspace plan **plus compute**, not a compute bundle. This promotion does not require a Pro upgrade. Two unchanged 1c/2GB workers plus one 0.5c/1GB history instance would cost about $72.50/month but halve the aggregate history CPU/RAM and share its failure domain. One 1c/2GB history instance preserves the aggregate memory/CPU budget but costs $40/month, versus $38 for two smaller independent instances; the resulting plan is about $93.50/month. The original separated plan remains approximately $91.50/month, before taxes, overages or discounts. Provider checkout must confirm this estimate. The user's conditional approval applies after this comparison; no provider resource was created during the read-only preflight. No staging shutdown is included in this change.

Authenticated dashboard inventory found only three existing staging resources: supplier worker `srv-db1m4vvavr4c73cjm1b0`, catalog worker `srv-db7bt5dg1s2s739u744g`, and history instance `dpg-db1m49navr4c73cjitkg-a`. Production resources are absent. The production Supabase Storage settings UI reports a global file-size limit of **50 MB**, despite the future supplier/catalog bucket limits. The global limit must be aligned with the admitted 1 GiB capacity before opening those flows; current bucket access rules and all unrelated settings must be preserved. No global-limit change was made during this inspection.

The fresh production metadata check passed the 125 foundation column prerequisites and seven helper fingerprints, but revealed large existing supplier/catalog tables. Twelve missing indexes on `supplier_prices`, `supplier_price_rollups`, `catalog_products` and `catalog_import_stage` must be prebuilt without a long write-blocking ordinary index build. `scripts/ops/price-engine-production-index-prebuild.mjs` generates an offline plan from the exact reviewed migration bytes. It verifies target, TLS, dedicated direct/session connection, timeout settings, canonical PostgreSQL definitions and valid/ready/live indexes; it never connects, executes, drops or repairs an index. A collision, invalid remnant or definition drift stops execution. This local plan does not prove production build time, I/O capacity or successful concurrent execution.

The new forward migration `20261014123941_sales_order_historical_operational_edit.sql` closes a reproduced compatibility gap: a note-only edit to a historical unbound confirmed sales order used to bind its customer implicitly and trigger today's margin validation against its old prices. Notes/acknowledgement-only updates now preserve the stored identity and prices; commercial, customer, tenant and confirmation changes still pass the existing guards. Direct and upsert paths, ambiguous accounts, historical profiles, replay and private ACL passed seven actual local PostgreSQL regression tests. No historical production orders were updated. The exact Ersen C-to-A compare-and-set operation must precede the sales guard cutover, or share its controlled cutover transaction.

The manifest now has 59 entries, with this forward repair last. Both complete isolated PostgreSQL replays passed, preserving the existing job and stable logical schema. The seven concurrent-index plan tests and nine catalog target/configuration tests passed. Production schema application, provider checkout/readiness, authenticated business canaries and real rollback recording remain separate evidence gates.

### Runtime reliability follow-up before provisioning

The historical operational-edit repair was applied **only to V3 staging** (`kaxsqafdevabkxofwdod`). The precondition matched the reviewed previous function fingerprint `e8226d6fab104b1f8d10e50124ac9053`; the resulting fingerprint is `6ab00b66f29288abc7b66a21024bc5e2`, matching the local PostgreSQL replay. Its single trigger, empty search path and security-definer posture remain, with no browser schema usage or anon/authenticated/service-role direct execution privilege. This is remote schema/ACL verification, not an authenticated business-action test. Production orders and schema remain unchanged.

The separate execution helper `scripts/ops/run-price-engine-production-index-prebuild.mjs` defaults to inspection and requires explicit `--apply` for the reviewed concurrent indexes. It regenerates and compares the exact plan before constructing a client, verifies TLS and a stable dedicated PostgreSQL session, and journals each before/after verification without raw errors, credentials or remote definitions. Failure stops the run without automatic retries or index removal. Eight mocked-client tests passed; no production connection or index build has occurred. Direct connection credentials remain a required execution input; masked hosting secrets are not treated as usable credentials.

The actual staging catalog worker at commit `1598832` exited at 15:10:01 Istanbul on 2026-10-14 with `The operation was aborted due to timeout`, then Render restarted it at 15:10:03. The uncaught failure was traced to the idle queue-discovery GET path. The repair retries only tagged transient discovery reads, with capped exponential delay and jitter; authentication, schema and business errors retain their failure handling. Shutdown cancels idle reads/backoff and rejects a successful read that races with shutdown before it can start work. Seven focused tests cover actual worker wiring, no mutation during read retries, exact lease release after active-workflow timeouts and the successful-read/shutdown race. Real staging deployment and recovery observation remain pending; the PostgreSQL concurrent-query deprecation warning is separate from this observed exit.

A separate active-path audit found the supplier v4 scan step serializes all normalized rows into DBOS history. Re-parsing the existing 999,997-row Clevite supplier CSV with the current parser and DBOS 5.2.11 serializer produced **558,326,225 bytes (532.46 MiB)** of scan-step outputs over 1,000 batches, before other history records. This is a local payload measurement, not PostgreSQL disk/WAL usage. Separate history instances do not remove this accumulation. Production activation therefore also requires a compact-history workflow version, unchanged legacy replay behavior, and checkpoint/restart verification before its new path is admitted.

The compact v5 workflow (`0.9.0-compact-history`) now combines immutable partition scanning and idempotent SQL staging inside one durable step. Only allowlisted summaries and receipts, individually capped at 4 KiB, cross the successful DBOS step boundary. Legacy v2/v4 callbacks remain unchanged. A read-only DBOSClient check runs before launch and blocks activation while any v1–v4 execution is pending, enqueued or delayed; per-dispatch identity checks remain. Production requires `SUPPLIER_PRICE_COMPACT_HISTORY_ENABLED=1`; staging defaults to v4 until the operator explicitly enables that flag after draining. The real existing staging history was inspected without mutation: all four old workflow versions had zero active executions, at supplier commit `6a857e593e17402d703caf0b3a81720cd1b80e2c`.

The real Clevite CSV measurement gives 463,889 bytes for v5 scan/stage checkpoints and 1,592,358 bytes for all 6,003 successful step outputs, versus 558,326,225 bytes for v4 scan outputs alone. Actual DBOS 5.2.11 with isolated PostgreSQL 17 survived a forced kill after modeled SQL stage commit and before DBOS checkpoint: attempts inserted `[1000, 0]`, with one receipt. Nine durable outputs totaled 3,268 bytes; the scan/stage checkpoint was 462 bytes. Fresh-database drain inspection created no DBOS schema; old v4 pending/enqueued/delayed fixtures blocked; all DBOS table content hashes remained unchanged during those read-only checks. The source/contract suites passed 113 tests. This proves bounded checkpoint serialization and modeled idempotent replay, not real Supabase lease-expiry, Storage throughput or production readiness. The executable runtime harness is `scripts/tests/supplier-compact-dbos-runtime.test.mjs`; payload evidence is `scripts/ops/evidence/supplier-compact-history-local-20261014.json`.

Catalog worker commit `afcf81e5128b530fda01c7330ff8eb95a116a3f3` was deployed only to staging. Its first deployment correctly stopped with `CATALOG_IMPORT_TARGET_MISMATCH` because the existing environment lacked the newly required exact target. After confirming the staging Supabase URL, setting `NM_FULL_STAGING_TARGET=kaxsqafdevabkxofwdod` produced healthy deploy `dep-db7o1bgu01pc739g60ng`. An authenticated browser three-row catalog import (`983aac7e-ccaa-475e-9f7c-f98a6ea4f6f7`) finalized in approximately 12.1 seconds and all three products appeared in the catalog. The small-file test uses browser staging plus worker finalization; it does not prove the large-file Storage ingestion path.

That canary exposed a distinct finalizer defect: planned `insert_rows` was incremented again during actual insertion, yielding six for three inserted products. Isolated PostgreSQL reproduction also found trailing/all-skipped rows could leave the cursor stuck forever. The forward repair `20261014132434_catalog_finalize_preserve_validation_counts.sql` preserves validation-owned planned totals, advances bounded insert/update/skip batches, and only upserts insert/update rows. It does not rewrite historical runs. Seven SQL tests cover inserts, updates, mixed/trailing/all skips, timeout recovery, replay, ACL/wrapper preservation and definition drift. Its exact old fingerprint `b6c02073f9dd230457e1901e3598c2c9` was confirmed on V3, then the guarded migration applied there; the resulting fingerprint is `62438b8bbf47eeba619f9ec937ed64a2`. Fresh post-repair browser acceptance remains separate.

The promotion manifest now contains 60 ordered migrations. Full isolated PostgreSQL 17 replay passed twice with identical logical schema fingerprint `3d0ec16fa76c5fa34867697042880c0be1464f02e10d1ef9160d2c47a1ed7f69`; evidence was regenerated. The concurrent-index plan carries the updated manifest hash `d5c965bb7f975d91343d0fae6b844a908b31c8318514397ac24e8e5b590195ea`, with all twelve index operations unchanged. Manifest/plan/runner tests passed 20/20. No production migration, resource provisioning or deployment occurred during this follow-up.

The fresh post-repair authenticated catalog run `861832b1-438c-4d92-828a-281bff81e106` finalized in 9.31 seconds: three validated, processed and inserted products, planned inserts three, errors zero. All three products appeared in browser search. The preceding run remains unchanged with its original historical counter. Evidence is `scripts/ops/evidence/catalog-runtime-staging-20261014.json`.

The first v5 staging deploy (`26da7ebb`, `dep-db7odoqj9qps73d61e00`) exposed an image-packaging gap before any new supplier admission: the strict Docker context allowlist omitted the new compact/version modules and the production target guard. Render's Live label did not establish process health; startup failed with `ERR_MODULE_NOT_FOUND`. The repair adds exactly those three files. A new AST-based recursive closure test checks all 24 worker runtime modules, and an actual Docker build with network-disabled entrypoint execution reaches the expected missing-configuration guard without import failures (2/2 tests passed). Runtime activation and the large-file staging proof must follow the repaired image, not the failed deploy.

### Large-file runtime and index execution follow-up

Staging supplier deploy `dep-db7ohq2j9qps73d6dfr0` ran exact commit `6328495c0372b60acc87e31b24b15d9ebd01a401` with application version `0.9.0-compact-history`, one execution slot and batch size 1,000. The explicitly enabled compact-history flag is a manual staging override; the old service branch and Blueprint defaults must not silently replace this reviewed deployment. An authenticated browser upload of the existing 48,752,699-byte Clevite CSV created release `e9517ad0-3e11-4f52-a73f-71875a5b2d4a`, with 999,997 source rows and SHA-256 `f63f5e17d84ebff66f2c0d1465e5684e8c4bce7e4694379c1f304d0ac33b440d`. Source verification succeeded on its first attempt. At 14:14:22Z, 57,000 rows were persisted, 57 batches completed, no failed batches/checksum mismatches existed, and publication remained unset. Completion and restart acceptance remain pending.

This real run exposed serial prepared-part uploads as a separate bottleneck: 1,000 parts plus the final readiness manifest completed at 14:13:15Z, after verification at 13:55:25Z. The adapter now permits at most four part uploads at once, keeps exact immutable readback and writes readiness only after all parts succeed. Readback compares streamed bytes to the original part instead of accumulating another complete part buffer. An error stops assignment and waits for all inflight operations before local temporary-file cleanup. Five adapter tests cover bounded concurrency, partial restart/reuse, immutable conflicts, corrupt readback and ambiguous network acceptance; 111 focused workflow/service/production-guard tests passed. The local simulated-request timing is not a production throughput claim. Protocol, partition order, source identity and workflow application version remain unchanged.

Rollback-only V3 catalog checks also passed for all-skipped rows and mixed insert/update/trailing-skip rows. Planned and actual counts agreed, the cursor completed in bounded batches, unchanged products retained their complete record, and finalization replay had no additional effect. A separate query confirmed zero remaining canary products. Exact evidence is appended to `scripts/ops/evidence/catalog-runtime-staging-20261014.json`.

The operator-supplied production database credential authenticated successfully through the verified-TLS session endpoint. The first concurrent index attempt began at 13:56:10Z and stopped at 13:56:28Z with SQLSTATE `55P03`; only `idx_catalog_products_export_exact_code` was attempted. It left a nonvalid, ready/live index with OID `264797`; no other index operation started. Existing production rollup refresh transactions were observed during the wait. No other session was cancelled and no business rows were changed. Removal/rebuild of this exact owned remnant requires its original sanitized attempt journal, exact OID and definition, absent constraints and no active build; the normal runner continues to reject invalid indexes.
