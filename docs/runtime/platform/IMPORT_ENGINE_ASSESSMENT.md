# Import Engine Assessment

## Executive conclusion

A canonical Import Engine **should exist** in Next-Master, but only for **persisted, staged import workflows**.

The runtime already has a proto-engine split across `apps/web/src/infrastructure/api/importApi.ts`, `apps/web/src/infrastructure/api/suppliersApi.ts`, `apps/web/src/shared/csv.ts`, `apps/web/src/shared/spreadsheetImport.ts`, `apps/web/src/shared/importTemplates.ts`, and the import surfaces in Catalog / Supplier / Dashboard UI. The common pattern is real: upload, parse, normalize, chunk, stage, validate, finalize, then expose progress and retry through Operations status.

What should **not** be forced into the same engine is every import-like flow:

- `QuotesPage` and `PortalPage` use file import as an input-to-pricing / input-to-basket step, not a persisted staged import session.
- `CodeReferencesPage` uses a direct upsert import.
- `priceListsApi.ts` currently uses direct replace/upsert for C-price import.

So the right decision is:

1. **Yes**, create a canonical Import Engine.
2. **Scope it to persisted import sessions** first.
3. Use adapters for domain-specific flows that only partially match the engine.

---

## 1. Business comparison

| Workflow | Purpose | Business owner | Business outcome | Frequency | Risk |
|---|---|---|---|---|---|
| Catalog Import | Load / update catalog identity and enrichment | Catalog / operations | `catalog_products` staged then finalized | Batch / periodic | High |
| Supplier Price Import | Load supplier price lists and trigger downstream catalog sync / rollup refresh | Supplier / pricing operations | `supplier_prices` updated, catalog sync queued, rollups refreshed | Batch / recurring | Very high |
| Code Reference Import | Map old code to new code for identity resolution | Catalog / operations | `item_code_references` upserted | Ad hoc / operator-led | Medium |
| C-Price Import | Maintain customer-facing C price list | Pricing / sales operations | `customer_price_list_items` replaced or merged | Ad hoc / recurring | High |
| Quote Import | Turn customer file into priced quote lines | Sales | Quote builder lines / sales order draft | Sales-led / frequent | Medium |
| Portal Order Import | Turn customer file into basket / order lines | Portal / sales | In-memory basket lines, then sales order save | Customer-led / frequent | Medium |
| Customer Import | Not observed as a dedicated import workflow | Unknown | Not observed | Unknown | Unknown |
| Inventory Import | Not observed as a dedicated import workflow | Unknown | Not observed | Unknown | Unknown |

Observed import workflows are not all equal. Only Catalog and Supplier currently behave like true staged import sessions.

---

## 2. Runtime lifecycle

Canonical lifecycle:

`Upload -> Parse -> Normalize -> Stage -> Validate -> Preview -> Finalize -> Background Jobs -> Operations Status -> Business Ready`

| Workflow | Runtime shape |
|---|---|
| Catalog Import | Full staged lifecycle. `bulkImportCatalog()` begins a run, stages chunks, validates, finalizes, then refreshes UI. |
| Supplier Price Import | Full staged lifecycle plus background catalog sync and rollup refresh. Supports resumable finalize batches. |
| Code Reference Import | Upload -> Parse -> Normalize -> Validate -> Upsert. No staged run model. |
| C-Price Import | Upload -> Parse -> Normalize -> Replace/Merge -> Upsert. No staged run model. |
| Quote Import | Upload -> Parse -> Normalize -> Resolve pricing / catalog / supplier data -> Preview / quote builder. No persisted import run. |
| Portal Order Import | Upload -> Parse -> Normalize -> Resolve / price -> Basket. No persisted import run. |

Shared runtime evidence is concentrated in `apps/web/src/infrastructure/api/importApi.ts`, but the lifecycle is only fully staged for Catalog and Supplier today.

---

## 3. Shared components

| Component | Role | Evidence |
|---|---|---|
| `apps/web/src/shared/csv.ts` | CSV parsing / serialization / delimiter detection | Shared parser used by import UIs |
| `apps/web/src/shared/spreadsheetImport.ts` | Spreadsheet file validation and read matrix | Used by portal and import flows |
| `apps/web/src/shared/importTemplates.ts` | Canonical downloadable templates | Catalog, supplier, code reference, C-price, quote templates |
| `apps/web/src/infrastructure/api/importApi.ts` | Shared staged import orchestration | Catalog and supplier staged imports, chunking, retry, validation, finalize |
| `apps/web/src/infrastructure/api/suppliersApi.ts` | Supplier import status projection and retry actions | Operations status model, catalog sync queue, rollup refresh queue |
| `apps/web/src/infrastructure/api/codeReferencesApi.ts` | Direct code reference import | Upsert-based import workflow |
| `apps/web/src/infrastructure/api/quoteImportApi.ts` | Quote import resolver / pricing hydrator | Resolve pricing from catalog, supplier prices, C prices |
| `apps/web/src/infrastructure/api/priceListsApi.ts` | C-price import | Direct replace / merge into customer price list items |
| `apps/web/src/shared/orderImport.ts` | Portal order file parser | In-memory order import parsing |
| `apps/web/src/presentation/pages/CatalogPage.tsx` | Catalog import UI | Full staged catalog import surface |
| `apps/web/src/presentation/pages/SuppliersPage.tsx` | Supplier import UI | Full staged supplier import surface |
| `apps/web/src/presentation/pages/CodeReferencesPage.tsx` | Code reference import UI | Direct import dialog |
| `apps/web/src/presentation/pages/QuotesPage.tsx` | Quote import UI | File import into quote builder |
| `apps/web/src/presentation/pages/PortalPage.tsx` | Portal order import UI | File import into basket/order drafting |
| `apps/web/src/presentation/pages/DashboardPage.tsx` | Operations status center | Supplier import, catalog sync, rollup refresh, customer price readiness |
| `netlify/functions/app-rpc.mts` | Gateway allowlist / operations routing | Import RPCs and status queues |

The engine candidate already exists in pieces. The missing step is consolidation.

---

## 4. Differences

| Step | Catalog | Supplier | Code references | C-Price | Quote | Portal |
|---|---|---|---|---|---|---|
| Upload | CSV import dialog | CSV import dialog | CSV import dialog | CSV import dialog | CSV / TSV / XLSX file | CSV / TSV / XLSX file |
| Parse | CSV parsed client-side | CSV parsed client-side | Spreadsheet / CSV parsed client-side | Parsed client-side | Parsed client-side | Parsed client-side |
| Normalize | Product code, brand, segment, lifecycle, weight | Supplier code, brand, pricing fields | Brand + old/new code normalization | Product code + price normalization | Part code + brand normalization | Part code + brand + qty normalization |
| Stage | Yes | Yes | No | No | No | No |
| Validate | Yes, before finalize | Yes, before finalize / finalize batch | Minimal upsert validation | Minimal direct validation | Resolve-time validation | Resolve-time validation |
| Preview | Import summary / fetched rows | Operations status / progress | Direct result only | Direct result only | Quoted line preview | Basket preview |
| Finalize | Atomic finalize into catalog truth | Atomic finalize batch plus background follow-ups | Direct upsert | Direct upsert / replace | Quote builder acceptance, not DB finalize | Basket save / confirm, not import finalize |
| Background jobs | None required for core import | Catalog sync + rollup refresh | None | None | None | None |
| Status surface | Import summary | Operations status + dashboard retry | Basic success / error | Basic success / error | Builder status | Basket status |

Domain-specific behavior remains important. A canonical engine should absorb the common lifecycle, not flatten business semantics.

---

## 5. Operations

Standard operations model observed or implied by runtime:

- `queued`
- `uploading`
- `parsing`
- `staging`
- `validating`
- `ready`
- `finalizing`
- `completed`
- `failed`
- `cancelled`
- `retrying`

The strongest current operations surface is supplier-driven:

- `apps/web/src/infrastructure/api/suppliersApi.ts` projects `supplier_import_status`
- `catalog_sync_status`
- `rollup_refresh_status`
- `customer_price_status`
- `last_successful_refresh_at`
- `last_successful_refresh_source`

`apps/web/src/presentation/pages/DashboardPage.tsx` renders the status center and exposes retry actions for failed supplier import, catalog sync, and rollup refresh.

This is already a platform pattern, not a one-off page feature.

---

## 6. UX standard

The canonical import UX should be:

1. Choose file
2. Show required template / columns
3. Show progress while parsing / staging
4. Show validation summary
5. Block finalize on errors
6. Show final counts
7. Surface retry / resume where safe
8. Expose operations status when background work continues

Current evidence:

- `CatalogPage.tsx` already shows import summary, blocks finalize if validation fails, refreshes catalog after finalize.
- `SuppliersPage.tsx` already shows progress, completion, catalog sync warnings, and refreshes supplier / brand views.
- `DashboardPage.tsx` already gives an operator-facing status panel with retry and last refresh information.

The UX target should be one shared import experience with domain-specific labels, not separate bespoke dialogs that hide final state.

---

## 7. Data integrity

| Property | Catalog | Supplier | Code references | C-Price | Quote / Portal |
|---|---|---|---|---|---|
| Atomicity | Strong staged finalize | Strong staged finalize, plus resumable batches | Weak / direct upsert | Weak / direct delete-upsert | Not a persisted import transaction |
| Transactions | Finalize boundary is transactional | Finalize batches are transactional | Single upsert path | Direct writes to price list items | In-memory resolution / later save |
| Append-only | Not primary model | Not primary model | No | No | Not applicable |
| Replace / Merge | Supported through staged import | Supported | Upsert-based | Replace / merge modes | Not applicable |
| Versioning | Run-based import history | Run-based import history | No run history | No run history | No run history |
| Idempotency | Run finalize should block double-apply | Batch retry and confirmed run state exist | Upsert idempotency by key | Upsert / delete-first behavior | Re-run parsing / resolution only |
| Recovery | Fail / cancel run and re-run | Fail / retry finalize / queued background sync | Re-import | Re-import | Re-open file |

The main gap is obvious: some imports are protected by staged sessions, some are not. A canonical engine would standardize that boundary.

---

## 8. Performance

| Concern | Current pattern |
|---|---|
| Chunking | Catalog and Supplier imports batch rows and adaptively split on timeout-like errors |
| Streaming | Not a true stream pipeline; current behavior is chunked client-side payloads |
| Background processing | Supplier import continues with catalog sync and rollup refresh queues |
| Statement timeout | Known concern for large supplier finalize workloads |
| Memory | Large payloads are held in the client before batch submission |
| Large file strategy | Batch size / byte target heuristics in `importApi.ts` |

Observed tuning:

- Catalog import batches by row count and byte target.
- Supplier import batches similarly and supports resumable finalize batches.
- Dashboard refresh is interval-based, not high-frequency polling.

This is already a platform concern. Import performance should not be re-solved in every domain.

---

## 9. Extension points

Likely future import plugins:

- AI validation
- Duplicate detection
- Supplier scoring
- Forecast enrichment
- Commercial rules
- Catalog enrichment suggestions
- Background reconciliation

These belong as validators / enrichers / post-finalize jobs, not as per-page custom code.

---

## 10. Import Engine candidate

Proposed engine modules:

| Module | Responsibility |
|---|---|
| `ImportSession` | Own run identity, mode, organization scope, and status |
| `Parser` | CSV / XLSX / TXT ingestion and row extraction |
| `Normalizer` | Canonical field and code normalization |
| `StageManager` | Persist staged rows and batch metadata |
| `Validator` | Row-level and run-level validation |
| `PreviewBuilder` | Summaries, conflicts, proposed actions |
| `FinalizeExecutor` | Atomic commit or controlled batch finalize |
| `OperationsTracker` | Background job status and retry state |
| `BackgroundDispatcher` | Queue post-finalize work such as sync / rollup |
| `RecoveryManager` | Retry, resume, fail, cancel, and rehydrate state |

These modules are already implied by the runtime; they are just not centralized yet.

---

## 11. Readiness

### Can an Import Engine be created now?

**Yes**, if the first version is scoped to persisted staged import workflows:

- Catalog Import
- Supplier Price Import

### What blocks a universal engine today?

1. Quote Import is a resolver / pricing workflow, not a persisted import session.
2. Portal Order Import is an in-memory order capture flow, not a backend import run.
3. Code Reference Import is a direct upsert flow with different integrity rules.
4. C-Price Import is still direct replace / merge, not the staged model.
5. Import status and recovery are not yet normalized across all flows.

### Recommended scope

Build the engine as a platform boundary for staged imports, then attach adapters:

- `CatalogImportAdapter`
- `SupplierPriceImportAdapter`
- `CodeReferenceImportAdapter`
- `CPriceImportAdapter`
- `QuoteImportAdapter`
- `PortalOrderImportAdapter`

Only the first two should be true staged-session implementations at the start.

---

## Evidence references

- `apps/web/src/infrastructure/api/importApi.ts`
  - staged catalog import orchestration: `bulkImportCatalog`, `beginCatalogImport`, `validateCatalogImport`, `finalizeCatalogImport`
  - staged supplier import orchestration: `bulkImportSupplierPrices`, `beginSupplierPriceImport`, `finalizeSupplierPriceImport`, `finalizeSupplierPriceImportBatch`
  - shared batching / retry helpers
- `apps/web/src/presentation/pages/CatalogPage.tsx`
  - catalog import dialog and finalization flow
- `apps/web/src/presentation/pages/SuppliersPage.tsx`
  - supplier import dialog, progress, completion messaging
- `apps/web/src/infrastructure/api/suppliersApi.ts`
  - supplier import run status projection, catalog sync status, rollup refresh status, retry actions
- `apps/web/src/presentation/pages/DashboardPage.tsx`
  - canonical operations status center and retry UX
- `apps/web/src/infrastructure/api/codeReferencesApi.ts`
  - direct code reference import upsert
- `apps/web/src/infrastructure/api/priceListsApi.ts`
  - direct C-price import replace / merge
- `apps/web/src/infrastructure/api/quoteImportApi.ts`
  - quote import resolution and pricing hydration
- `apps/web/src/shared/orderImport.ts`
  - portal order file parsing
- `apps/web/src/shared/importTemplates.ts`
  - import templates for catalog, supplier, code references, C-price, quote
- `apps/web/src/shared/csv.ts`
  - CSV parsing / writing
- `apps/web/src/shared/spreadsheetImport.ts`
  - spreadsheet ingestion
- `netlify/functions/app-rpc.mts`
  - import RPC allowlist and operations routing

