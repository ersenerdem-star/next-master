# Supplier Import Adapter Assessment

Status: PLAT-001E assessment only. The original runtime description below is
legacy; see the 2026-10-19 verified-upload review before applying it to V3.

## 2026-10-19 verified upload and catalog enrichment review

Read-only production checks used project `zjgueqijumzlfioihnkt`; runtime was
reviewed in `codex/price-engine-integration`, baseline `b547666` with the ongoing
origin-offer candidate still uncommitted. No catalog or price was modified by
this review. Canonical policy is §4.1.3 of
`/Users/ersen/Documents/Next-Master/docs/architecture/NEXT_MASTER_SYSTEM_DEFINITION.md`.

### Findings

1. **P1 — V3 publication does not schedule catalog enrichment.** The deployed
   `publish_supplier_price_release_production` writes the publication, current
   pointer, decision and events; it does not call the legacy catalog sync.
   Production trigger inventory confirms the pointer triggers only notify the
   portal. Worker source likewise has no catalog consumer. Price availability
   and catalog existence/freshness therefore diverge.
2. **P1 — existing catalog fields do not refresh in the legacy supplier sync.**
   Deployed `sync_supplier_price_catalog_batch` fills description, origin,
   weight, vehicle and model only when existing values are blank. It does not
   carry source `tariff` to catalog `hs_code` or source dimensions to the catalog.
   Full field preservation in verified release rows does not fix this missing
   projection.
3. **P1 — stable identifiers have inconsistent merge rules.** Legacy sync keeps
   a nonempty OEM/vehicle/model unchanged, losing additional identifiers. The
   modular ZF merge instead chooses nonempty incoming OEM/vehicle over existing
   values. Neither behavior is an additive, deduplicated merge.
4. **P1 — origin/tariff require source and offer context.** A single global
   catalog field cannot identify two manufacturing origins of the same product.
   The 2026-10-19 Sachs audit found 349 ambiguous second origins; reusing the
   global catalog origin for each offer would not resolve them. Conflicting
   suppliers, older source dates and manual corrections need explicit precedence
   and evidence, rather than a last-writer-wins merge.
5. **P2 — upload guidance omits usable fields.** Streaming CSV/XLSX normalization
   and V2 staging preserve tariff, origin, dimensions and other product fields,
   but the verified template omits most of them. Its UI hint omits tariff and
   dimensions. `Product_Name_TR` is also not the same recognized alias as
   `Description_TR`; parser alias changes must be versioned so durable replay
   does not reinterpret an already sealed source.
6. **P2 — refresh is not a uniform provider contract.** Modular Spareto prefers
   existing nonempty origin, tariff and weight even when refresh is enabled.
   Modular ZF prefers nonempty incoming values. Root and modular provider entry
   points coexist. A provider refresh button cannot establish consistent field
   ownership or automatic upload completion.
7. **P2 — enrichment progress and field history are not part of V3 upload status.**
   Current admin release review reports import/publication, without a separate
   durable catalog job, per-field before/after evidence, or source-conflict report.
   A whole-catalog provider scan inside a short web request is not an acceptable
   replacement for a resumable job limited to the uploaded exact product codes.

### Production sample (not whole-brand totals)

For the five newest current publications, at most 500 accepted rows per release
were checked against exact catalog code identity in the same organization/brand.
All 2,417 sampled source rows lacked origin, tariff, OEM and vehicle/model data.
They cannot supply those fields without another source. Missing exact catalog
matches were FAG 5/500, INA 0/500, Lemforder 1/500, LUK 0/500, Vitesco 417/417.
Vitesco's current publication contains 417 rows, so that sample covers its full
release. This is evidence of a missing catalog projection, not a claim that all
brands have the same missing-data rates.

### Required implementation and acceptance

- Publication transaction records one persistent catalog job bound to publication,
  release, source checksum and tenant. Heavy processing stays outside publication.
- The consumer rechecks current publication on every bounded transaction, skips
  superseded work, and persists changes plus cursor atomically. Retry is idempotent.
- Blank cells preserve data; OEM/vehicle/model merge additively; fresh authoritative
  variable fields carry before/after provenance and conflict handling. Supplier
  commercial notes and images do not enter this field projection.
- File enrichment and optional official-source completion are separate, observable
  phases. A price-only file can create an exact product shell, but cannot invent
  origin/tariff. Unknown and conflicting fields remain explicit.
- Admin details show pending/running/completed/review-required/failed catalog
  status, changed/unchanged/unmatched/conflict counts and actionable row details.
- Verify changed origin/tariff, empty values, additive OEM/model, older uploads,
  two suppliers, origin variants, exact-code collisions, retry/timeout, concurrent
  publication, authorization and a representative large-file run. Source tests
  alone do not prove the deployed worker or production catalog outcome.

Evidence: `artifacts/catalog-enrichment-review-20261019/` contains deployed function
snapshots; no production migration or catalog backfill was run.

### Changes made during this review

The user selected file fields plus official-source completion on 2026-10-19.
The implementation candidate now includes publication-bound SQL jobs, cursor and
lease fencing, one active catalog consumer, ingestion priority, atomic field
patch/history commits, and a scheduled dispatcher for signed background work.
No whole-brand scrape or marketplace fallback is started. Read-only exact-SKU
adapters reuse ZF, Bosch, MANN and registered TecAlliance extraction logic.
Unsupported brands are visible as `OFFICIAL_SOURCE_NOT_CONFIGURED`; unavailable
official fields remain unknown. The live ZF read-only check for Sachs `317851`
matched the exact article but supplied no origin/tariff; neither was inferred.

File fields refresh variable metadata with provenance; official observations
complete blanks and cannot replace file-supplied values. Identifier sets merge
additively. Newer publication, expired lease, conflicting sources, older evidence
and concurrent catalog edits are fenced. Missing optional Turkish description or
dimensions does not falsely block completion; missing core metadata has a distinct
`completed_missing` status. User-facing details show missing fields and row-level
reasons. Network failures retain source row/provider and resume checkpoints.

Thirteen tests pass against real isolated PostgreSQL 17, including the actual
publication trigger and background consumer. A 1,000-row source completes with
exact origin/tariff values in 100-row commits (local timing only). The existing
template checks and web/Netlify build passed. Production activation and the first
same-session file projection are now evidenced below; whole-source official
completion is still in progress and is not claimed complete.

The verified upload template now includes existing parser-supported `HS_Code`,
`EAN`, `Vehicle`, `Vehicle_Model`, `Market_Segment`, `Weight_kg`, `Description_TR`
and `Dimensions` columns. TR/EN guidance names tariff/dimensions and warns against
inferring missing values. A template-to-real-parser check preserves leading-zero
tariff and EAN text, origin, weight, dimensions and Turkish text. The template change itself only
makes existing source-capture support visible; live projection/provider evidence
is recorded separately below. Historical parser aliases/hashes were not
changed. The template metadata cells stay blank, avoiding invented defaults.

### First production publication evidence — 2026-10-19

GroupAuto / Sachs, release `f282d252-ee93-4fd8-b0a3-acb25cf0f896`, publication
`43438ef4-177c-4494-b784-155681684daa`, queued catalog job
`bb5c625e-4122-42fc-9ee6-ff0114382851` automatically. All 12,669 source rows are
accepted and active; there are no rejected/conflicting/warning price rows. Source
fields include 12,608 origins and 12,662 tariffs. Every source row matches a real
catalog product; nonblank source origins/tariffs have zero catalog mismatches.
The file phase completed at 12,669 / 12,669 without re-uploading or moving prices.

Production PostgREST inherited the authenticator's 8-second statement timeout.
Metadata writes intermittently reached that boundary. Failed transactions kept
atomic checkpoints (2,000, 4,500, then 10,400) and resumed automatically. The
follow-up reduces file commits from 500 to 100 rows and gives only the service-only
catalog write RPC a bounded 20-second timeout, below the worker's 25-second
request deadline. Global role limits and client write denial remain unchanged.
SQLSTATE 57014 now becomes an actionable catalog timeout reason; lock contention
and serialization conflicts have their own safe reason. No raw database details
are exposed. Both migration changes were tested locally and applied/verified on
staging before production. The production application is `47b3c90c`; the scoped
DB exception is recorded in migration `20261019171104`.

The same job entered the official phase and persisted actual ZF observations:
`000331`, `000366`, and `000369` received exact-brand/SKU EAN/OEM/vehicle fields.
Missing vehicle-model information remains explicit. This proves the official
adapter executed for this publication; it does not prove all 12,669 official
lookups completed. Evidence is in `artifacts/catalog-enrichment-release/` in the
isolated release worktree and the local test logs under
`artifacts/catalog-enrichment-review-20261019/` in the implementation worktree.

### Impact and boundaries

- Operations/UX: price publication and catalog completion need distinct status;
  users should see exactly which fields failed or need review, without re-uploading
  an entire file to resume an already accepted job.
- Architecture: immutable release rows remain source evidence; Catalog owns product
  truth, while supplier-origin choices remain offer evidence. A field provenance
  record is required before replacing the current blank-only projection.
- Pricing/Purchasing/Supply Chain: catalogue enrichment must not reprice existing
  orders or substitute a selected origin. Later order/invoice changes must consume
  an explicitly selected, source-bound origin/tariff snapshot.
- Dimbax/Mira: official-source observations stay behind the existing trust and
  versioned consumer boundaries. Upload completion does not authorize an external
  observer to write canonical products directly.
- Technical debt/platform/DX: consolidate merge policy and provider entry points;
  do not add another whole-brand scraper or a second hidden sync loop. Durable
  jobs need bounded transactions, measurable progress and a kill switch. Large-file
  timing and failure recovery require runtime evidence before activation.

Foundation:

- [Import Engine Assessment](./IMPORT_ENGINE_ASSESSMENT.md)
- [Import Engine Blueprint](./IMPORT_ENGINE_BLUEPRINT.md)
- `apps/web/src/shared/importEngine.ts`
- [Next-Master Implementation Standards](../NEXT_MASTER_IMPLEMENTATION_STANDARDS.md)
- [Runtime Domain Ownership Index](../DOMAIN_OWNERSHIP_INDEX.md)

### Boge decimal-weight incident and actionable source diagnostics — 2026-10-19

The failed GroupAuto/Boge release `68989a27-d36f-4175-8739-c852db368d97`
contains 509 unique price rows. The exact uploaded SHA-256
`720ffd50c1bfdc1482139e3f7b47383b29a6429370c4f2c1ca3770bb4aba9f83`
matches the local source. Legacy measurement parsing rejected 21 valid comma
decimal weights, including record 6, part `89-183-0`, `Weight_kg=0,355`.
No code, price, currency, date or duplicate error was found. The corrected
measurement parser validates the same bytes with 509 rows and zero warnings;
the separate buy-price ambiguity policy is unchanged.

Normalization now uses durable commercial workflow v7; pending v1–v6 history
blocks startup rather than replaying old hashes with new parsing. Local pinned
DBOS/PostgreSQL crash-recovery tests passed for legacy v5 and commercial v7.
The container allowlist includes both new parser/report modules. A staging
deployment caught the initially missing image entries before production;
the rebuilt image passed an actual container import and DuckDB validation.
Runtime commit `05b6d7f` was deployed on the existing staging and production Render
workers, with correct separate Supabase targets and `/readyz` reporting healthy.
Both deployed runtimes validated `0,355` and `2,228` correctly.

Source validation reports are private and bound to release, handoff and exact
source hash. Reports retain total counts and at most 500 bounded diagnostic
samples. Service-only writes and tenant/admin-only reads passed real PostgreSQL
authorization tests. The latest failed Boge record now retains its 21 original
diagnostics, labeled as a legacy result; no price or release state was changed
by restoring those details. Admin review displays record, product, column,
original cell and correction, with a formula-safe CSV download. Browser
preflight shares the same weight parser. Original supplier files are unchanged.

Evidence: `artifacts/catalog-enrichment-release/boge-*.log` and validation JSON.
Successful upload preparation remains separate from explicit price publication.

The authenticated production retry used identical bytes under
`Boge_TR_19102026_verified.csv` to preserve the closed failed upload and its
diagnostics. Release `5a28c5ba-7da9-4f48-aa9a-9fba2e7c77a2` completed source
verification and handoff at attempt 1, then persisted and validated all 509 rows
with zero rejected/warning rows and no error. Database samples retain weights
`0.355` and `2.228`; the authenticated review confirms publication readiness.
The agent left the approval checkbox unchecked and did not request publication.
The new row report and ready review were verified in deployed web `05b6d7f`.

Post-upload history inspection caught a hardcoded v6 registration despite the
v7 application/version contract. The worker now derives registration from the
same factory as dispatch and observation (`8f3fe51`); the validated Boge result
is retained without replay or deletion. The initial Boge execution used the v6
registration with application `0.11.0-measurement-diagnostics`, not a v7 name.
This distinction prevents treating readiness as proof of a workflow identity.
Registration fix `8f3fe51` subsequently deployed successfully in staging and
production. The live worker reports healthy idle readiness, the v7 contract,
and registration derived from that contract. The exact Boge history is SUCCESS.

While final verification continued, an interactive publication approval was
submitted at 21:32:31 Istanbul. Publication
`9207fbdf-e218-4569-873e-fbe6bc99dea4` is published and has the active current
pointer for all 509 accepted rows. The admin modal independently shows
"Güncel aktif sürüm" and "Yayında". File enrichment has processed and changed
509 catalog products. Official-source completion is separate: it remains
queued at 0/509 with `OFFICIAL_SOURCE_TIMEOUT`; it is not claimed complete.

## Executive conclusion

Supplier Import is the correct first adapter candidate for the future canonical Import Engine.

It already has the required platform shape:

- run table
- stage table
- chunk staging
- resumable batch finalize
- supplier-price truth commit
- background catalog sync
- rollup refresh queue
- Operations Status Center projection
- retry path for failed finalize / sync / rollup

The migration should be an adapter extraction, not a rewrite. Supplier price commit, batch finalize, catalog sync, rollup refresh, and authorization must remain untouched until an adapter facade proves identical behavior.

---

## 1. Current Supplier Import Runtime

### Current executable chain

```text
SuppliersPage
  -> handleSupplierImport(file)
  -> parseCsv(file.text())
  -> validate required supplier CSV headers
  -> normalize rows
  -> bulkImportSupplierPrices(payload, mode, supplierName, brandName)
  -> beginSupplierPriceImport()
  -> callAppRpc("begin_supplier_price_import")
  -> /api/app-rpc
  -> ALLOWED_RPCS / OPERATIONS_RPCS
  -> begin_supplier_price_import
  -> supplier_price_import_runs
  -> buildAdaptiveSupplierImportBatches()
  -> stage_supplier_price_import_chunk per batch
  -> supplier_price_import_stage
  -> finalize_supplier_price_import_batch loop
  -> supplier_prices
  -> queue_supplier_price_catalog_sync
  -> sync_supplier_price_catalog_from_import
  -> queue_supplier_price_rollups_refresh
  -> refresh_supplier_price_rollups_logged
  -> fetchCloudSupplierOperationsStatusAll()
  -> DashboardPage Operations Status Center
```

### UI entry point

`apps/web/src/presentation/pages/SuppliersPage.tsx`

Observed behavior:

- Operator opens Supplier CSV Import.
- Operator selects supplier, brand, mode, and file.
- Runtime requires supplier and brand before import.
- Runtime validates required headers.
- Runtime parses rows with `parseCsv`.
- Runtime maps rows into supplier price payload.
- Runtime calls `bulkImportSupplierPrices`.
- Runtime shows progress as row and batch counts.
- Runtime refreshes suppliers, brands, and supplier rows after completion.
- Runtime shows catalog sync / rollup warnings if background work remains.

### API path

`apps/web/src/infrastructure/api/importApi.ts`

Supplier Import uses:

- `buildAdaptiveSupplierImportBatches`
- `beginSupplierPriceImport`
- `importSupplierPriceChunkWithAdaptiveRetry`
- `finalizeSupplierPriceImport`
- `failSupplierPriceImport`
- `queueSupplierPriceCatalogSync`
- `queueAndCheckSupplierPriceRollupRefresh`

### Gateway path

`netlify/functions/app-rpc.mts`

Supplier import RPCs are allowed through:

- `ALLOWED_RPCS`
- `OPERATIONS_RPCS`

Relevant RPCs:

- `begin_supplier_price_import`
- `stage_supplier_price_import_chunk`
- `finalize_supplier_price_import`
- `finalize_supplier_price_import_batch`
- `fail_supplier_price_import`
- `bulk_import_supplier_prices`
- `queue_supplier_price_catalog_sync`
- `queue_supplier_price_rollups_refresh`
- `get_latest_supplier_price_rollup_refresh_run`

The gateway also uses `context.waitUntil` for:

- `sync_supplier_price_catalog_from_import`
- `refresh_supplier_price_rollups_logged`

### DB / RPC path

Relevant migrations:

- `supabase/migrations/20260701_84_supplier_price_staged_import_finalize.sql`
- `supabase/migrations/20260701_85_supplier_price_import_concurrent_guard.sql`
- `supabase/migrations/20260707_999_supplier_price_import_admin_authorization.sql`
- `supabase/migrations/20260708_00_supplier_price_catalog_sync_background.sql`
- `supabase/migrations/20260708_01_supplier_price_finalize_batches.sql`

Primary tables:

- `supplier_price_import_runs`
- `supplier_price_import_stage`
- `supplier_prices`
- `supplier_price_rollup_refresh_runs`

Primary RPCs / functions:

- `begin_supplier_price_import`
- `stage_supplier_price_import_chunk`
- `finalize_supplier_price_import`
- `finalize_supplier_price_import_batch`
- `fail_supplier_price_import`
- `sync_supplier_price_catalog_from_import`
- `refresh_supplier_price_rollups_logged`

### Operations status path

`apps/web/src/infrastructure/api/suppliersApi.ts`

Reads:

- latest supplier import runs
- latest rollup refresh run
- supplier brand summary
- brand rows

Projects:

- `supplier_import_status`
- `catalog_sync_status`
- `rollup_refresh_status`
- `customer_price_status`
- `last_successful_refresh_at`
- `last_successful_refresh_source`

`apps/web/src/presentation/pages/DashboardPage.tsx`

Displays:

- import started / finished / duration
- staged / processed rows
- supplier import status
- catalog sync status
- rollup refresh status
- customer price readiness
- retry buttons for failed import, catalog sync, and rollup refresh

---

## 2. Current Supplier Import Data Model

### Run table

`supplier_price_import_runs`

Observed fields:

- `id`
- `organization_id`
- `supplier_id`
- `brand_id`
- `mode`
- `status`
- `started_at`
- `finished_at`
- `error_message`
- `staged_rows`
- `processed_rows`
- `catalog_synced`
- `created_by`
- `catalog_sync_status`
- `catalog_sync_started_at`
- `catalog_sync_finished_at`
- `catalog_sync_error_message`
- `finalize_phase`
- `finalize_cursor`
- `finalize_started_at`
- `finalized_at`
- `finalize_error_message`

### Stage table

`supplier_price_import_stage`

Observed fields:

- `id`
- `run_id`
- `organization_id`
- `supplier_id`
- `brand_id`
- `product_code`
- `description`
- `oem_no`
- `buy_price`
- `currency`
- `moq`
- `lead_time_days`
- `notes`
- `valid_from`
- `normalized_code`
- `created_at`

### Truth table

`supplier_prices`

Finalize merges staged rows into this table and marks rows active. Replace mode also deactivates stale active rows during cleanup.

### Catalog sync fields

On `supplier_price_import_runs`:

- `catalog_sync_status`
- `catalog_sync_started_at`
- `catalog_sync_finished_at`
- `catalog_sync_error_message`
- `catalog_synced`

### Rollup refresh fields / jobs

Runtime reads `supplier_price_rollup_refresh_runs` through `get_latest_supplier_price_rollup_refresh_run`.

Observed projected fields:

- `id`
- `organization_id`
- `started_at`
- `finished_at`
- `duration_ms`
- `status`
- `error_message`
- `supplier_price_rollups_count`

### Status fields

Supplier DB statuses:

- `running`
- `finalizing`
- `finalized`
- `succeeded`
- `failed`

Supplier operations projection statuses:

- `idle`
- `pending`
- `running`
- `failed`
- `completed`

Catalog sync statuses:

- `pending`
- `running`
- `succeeded`
- `failed`

### Count fields

- `staged_rows`
- `processed_rows`
- `catalog_synced`
- `batch_processed`
- `source_total`
- `supplier_price_rollups_count`

### Error fields

- `error_message`
- `catalog_sync_error_message`
- `finalize_error_message`
- rollup `error_message`

---

## 3. Current Lifecycle vs Import Engine Lifecycle

| Canonical lifecycle | Current Supplier Import | Fit |
|---|---|---|
| begin | `begin_supplier_price_import` creates run, resolves supplier/brand/mode | Strong |
| parse | `SuppliersPage` reads file and `parseCsv` parses CSV client-side | Strong, but UI-owned |
| normalize | UI maps fields; DB normalizes `normalized_code` during stage | Strong, split across UI/DB |
| stage | `stage_supplier_price_import_chunk` writes `supplier_price_import_stage` | Strong |
| validate | Current validation is distributed across UI required headers, stage filtering, DB checks, and finalize constraints | Partial |
| finalize | `finalize_supplier_price_import_batch` applies staged rows to `supplier_prices` | Strong |
| batch finalize | `finalize_supplier_price_import_batch` loops through bounded batches | Strong |
| background sync | `queue_supplier_price_catalog_sync` and `sync_supplier_price_catalog_from_import` | Strong |
| status | `supplier_price_import_runs` + `suppliersApi` projection + Dashboard | Strong |
| retry | Dashboard calls `retrySupplierPriceImportFinalize`; catalog sync / rollup retries exist | Strong |
| cancel | No current supplier cancel RPC observed | Gap |
| fail | `fail_supplier_price_import` records failure | Strong |

Supplier Import matches the Import Engine model more closely than any other current import workflow.

---

## 4. Adapter Contract

The Supplier Import Adapter must provide the following engine-facing units.

### Source adapter

Owns:

- supplier name / ID scope
- brand name / ID scope
- import mode: `replace` or `merge`
- source type: `supplier_price_csv`

### Row normalizer

Owns:

- product code
- brand
- product name / description
- OEM
- buy price
- currency
- MOQ
- lead time days
- notes
- valid-from date
- normalized code

### Validator

Must preserve current behavior while making it explicit:

- supplier required
- brand required
- file required
- required headers required
- product code required
- buy price required
- run belongs to current organization
- run status accepts stage/finalize
- staged rows exist before finalize
- batch size bounded

### Stage writer

Owns:

- chunk write
- staged row count
- duplicate row policy inherited from current DB logic
- timeout-aware retry and adaptive split

### Finalize executor

Owns:

- `finalize_supplier_price_import_batch`
- bounded merge into `supplier_prices`
- replace cleanup deactivation
- advisory lock behavior
- finalize phase / cursor
- idempotent finalized response

### Background dispatcher

Owns:

- catalog sync queue
- rollup refresh queue
- non-blocking follow-up status

### Operations status mapper

Maps DB / runtime statuses into Import Engine status and readiness:

- supplier run status
- catalog sync status
- rollup refresh status
- customer price readiness

### Recovery hooks

Owns:

- retry finalize
- retry catalog sync
- retry rollup refresh
- fail run
- future cancel hook if introduced

---

## 5. Gaps

### Missing canonical status fields

Supplier runs do not yet expose exactly the Import Engine canonical shape:

- `owner_domain`
- `source_type`
- `warning_count`
- `conflict_summary`
- canonical `background_status` object
- canonical `finalized_by`

### Naming mismatches

Current Supplier naming differs from Import Engine naming:

- `succeeded` vs `completed`
- `finalized` vs `completed`
- `running` vs `started` / `staging`
- `catalog_sync_status` as a domain-specific background status
- `rollup_refresh_status` as a separate status source

### Domain-specific coupling

Supplier import combines:

- supplier identity
- brand identity
- supplier price truth
- catalog enrichment
- rollup refresh
- customer price readiness

This is legitimate business coupling, but an adapter must isolate it from the platform engine.

### App-rpc coupling

`app-rpc.mts` directly allowlists import RPC names and owns special queue handling for supplier catalog sync and rollup refresh.

Adapter extraction should not move these paths first.

### UI coupling

`SuppliersPage.tsx` owns:

- parse
- required-header validation
- row mapping
- progress text
- completion/warning text

Adapter extraction should start behind API facades, not by redesigning the UI.

### DB/RPC coupling

Supplier logic is deeply embedded in DB functions:

- stage write
- finalize batch
- replace cleanup
- catalog sync
- authorization checks

These should remain DB-owned while TypeScript adapter boundaries are introduced.

### Background job coupling

Catalog sync and rollup refresh are queued through gateway special cases and surfaced through supplier operations status.

This should become a background-dispatch contract later, but not in the first extraction slice.

### Cancel gap

No current `cancel_supplier_price_import` RPC was observed in the runtime allowlist or migration evidence. The adapter should model cancellation as a future optional capability, not claim it exists.

---

## 6. Safe Migration Strategy

### Step 1: No behavior change first

Freeze the current runtime path as the baseline.

Do not change:

- UI flow
- RPC names
- DB finalize
- catalog sync
- rollup refresh
- authorization

### Step 2: Shared type alignment

Create mapping from current Supplier statuses to Import Engine status/readiness.

This should be pure TypeScript only.

### Step 3: Status mapper

Introduce a Supplier Import status mapper that converts:

- DB run status
- catalog sync status
- rollup status
- customer readiness

into the Import Engine status model.

### Step 4: API facade

Wrap current `bulkImportSupplierPrices` behavior in a Supplier adapter facade while still calling the exact same functions.

### Step 5: Adapter skeleton

Introduce a Supplier adapter object with methods for:

- begin
- stage chunk
- finalize batch
- queue background
- fail
- retry
- status

Each method initially delegates to current runtime functions.

### Step 6: Engine call path

Only after facade parity is proven, allow the Import Engine orchestration to call Supplier adapter methods.

---

## 7. Do Not Touch List

Do not change these paths during adapter extraction unless a separate approved work package explicitly authorizes it:

- `finalize_supplier_price_import_batch`
- `finalize_supplier_price_import`
- supplier_prices commit / merge behavior
- replace cleanup deactivation
- supplier import run/stage tables
- admin + superadmin supplier import authorization
- app-rpc allowlist / operations authorization
- `queue_supplier_price_catalog_sync`
- `sync_supplier_price_catalog_from_import`
- `queue_supplier_price_rollups_refresh`
- `refresh_supplier_price_rollups_logged`
- Dashboard retry behavior
- Operations Status Center visible labels
- supplier CSV required headers
- staged data retention required for retry

The production incident history makes these paths protected until parity tests exist.

---

## 8. Recommended Slices

### PLAT-001F — Supplier status mapper

Document and implement a pure mapper:

- DB status -> Import Engine status
- catalog sync status -> background status
- rollup status -> background status
- combined readiness

No runtime behavior change.

### PLAT-001G — Supplier API facade

Create an adapter-facing facade around current supplier import functions.

No UI changes.
No RPC changes.
No DB changes.

### PLAT-001H — Supplier adapter skeleton

Create a Supplier adapter object that delegates to the facade.

No engine orchestration yet.

### PLAT-001I — Supplier operations projection alignment

Use the status mapper inside `suppliersApi.ts` without changing visible Dashboard output.

### PLAT-001J — Engine orchestration dry path

Introduce an Import Engine orchestrator that can run Supplier Import through the adapter behind a feature flag or internal-only path.

No production switch yet.

### PLAT-001K — Production switch

Switch Supplier Import to the engine orchestrator only after parity validation passes.

---

## 9. Assessment Decision

Supplier Import is ready to become the first Import Engine adapter, but not by moving DB or gateway behavior first.

The safe path is:

1. status mapper
2. API facade
3. adapter skeleton
4. operations projection alignment
5. engine orchestration dry path
6. production switch after parity validation

No production truth path should change until Supplier adapter parity is proven.

