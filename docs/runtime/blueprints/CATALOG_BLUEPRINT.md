# Catalog Blueprint

Status: discovery draft for `DISC-002`.

Scope: runtime Catalog system only. This document is evidence-backed and intentionally avoids guesses.

## 1. Business Purpose

Observed purpose:

- Catalog is the canonical commercial identity layer for parts/products used by search, pricing, quoting, sales orders, purchase orders, portal views, reporting, media, and code-reference resolution.
- It also acts as a normalization surface for product code, brand, OEM, lifecycle, vehicle, origin, HS code, weight, and replacement mapping.
- Catalog supports both direct editing and staged import flows.

Evidence:

- App navigation exposes Catalog through the `Items` module and the `Catalog` sub-tab, plus `Code References` as the adjacent identity-mapping surface: `apps/web/src/app/App.tsx:215-240, 713-766`.
- Catalog page performs browse, edit, create, delete-guarded delete, media lookup, export, and staged import: `apps/web/src/presentation/pages/CatalogPage.tsx:730-830, 1077-1285, 1840-1909`.
- Catalog data is consumed by pricing, quote resolution, sales/purchase transfers, portal pricing, and reporting-style views through shared APIs and helpers: `apps/web/src/shared/salesOrderCatalogSync.ts:1-220`, `apps/web/src/infrastructure/api/priceListsApi.ts`, `apps/web/src/infrastructure/api/quoteResolverApi.ts`, `apps/web/src/infrastructure/api/reportingApi.ts`, `apps/web/src/infrastructure/api/masterApi.ts`.

## 2. Business Lifecycle

Observed lifecycle:

1. A supplier, marketplace, or official source produces product identity data.
2. Catalog is created or enriched through:
   - manual create/edit,
   - brand sync,
   - catalog CSV import,
   - supplier-price-driven catalog sync,
   - code-reference mapping,
   - media lookup.
3. Catalog rows feed pricing and quote resolution.
4. Pricing feeds customer price lists and C-price logic.
5. Quotes and sales orders carry catalog-derived identity forward.
6. Purchase orders and warehouse flows reuse the same identity.
7. Reporting and portal surfaces project the resulting commercial truth.

Evidence:

- Staged catalog import path: `apps/web/src/infrastructure/api/importApi.ts:327-520`.
- Manual create/update/delete path: `apps/web/src/infrastructure/api/catalogApi.ts:223-324`.
- Search and export paths: `apps/web/src/infrastructure/api/catalogApi.ts:187-220, 353-520`.
- Code-reference path: `apps/web/src/infrastructure/api/codeReferencesApi.ts:1-220, 370-440`.
- Catalog media path: `apps/web/src/infrastructure/api/catalogMediaApi.ts:1-23`.
- Brand/source policy defining catalog enrichment authority: `docs/catalog-source-policy.md:5-13, 36-62, 64-98, 99-166`.

## 3. Runtime Map

### UI

- `Apps` root routes into `ItemsPage` for Catalog and code references: `apps/web/src/app/App.tsx:713-766`.
- `ItemsPage` switches between `CatalogPage` and `CodeReferencesPage`: `apps/web/src/presentation/pages/ItemsPage.tsx:1-11`.
- `CatalogPage` contains search, import, export, create, edit, delete, media preview, code-reference inspection, and sales/purchase transfer actions: `apps/web/src/presentation/pages/CatalogPage.tsx:157-1910`.

### API

- `catalogApi.ts` is the main catalog CRUD/search/export API.
- `importApi.ts` owns staged catalog import execution and finalize flow.
- `codeReferencesApi.ts` owns code-reference creation and coverage/usage inspection.
- `catalogMediaApi.ts` owns media lookup.
- `brandsApi.ts` is a supporting lookup surface.

### Gateway / RPC

- `app-rpc.mts` allowlists catalog RPCs and proxies `cloud_catalog_page`, `search_catalog_products`, `delete_catalog_product_guarded`, `begin_catalog_import`, `stage_catalog_import_chunk`, `validate_catalog_import`, `finalize_catalog_import`, `fail_catalog_import`, `cancel_catalog_import`: `netlify/functions/app-rpc.mts:9-115, 1037-1115`.

### SQL / Tables

Observed catalog-related tables accessed directly by runtime code:

- `catalog_products`
- `brands`
- `item_code_references`
- `supplier_prices`

Observed catalog-related RPCs:

- `cloud_catalog_page`
- `search_catalog_products`
- `delete_catalog_product_guarded`
- `begin_catalog_import`
- `stage_catalog_import_chunk`
- `validate_catalog_import`
- `finalize_catalog_import`
- `fail_catalog_import`
- `cancel_catalog_import`
- `cloud_supplier_brand_summary`

### Consumers

- `PriceListsPage` and `priceListsApi` consume catalog and brand identity for customer price outputs.
- `QuotesPage` and `quoteResolverApi` consume catalog and code-reference data for resolution.
- `SalesPage` and `shared/salesOrderCatalogSync.ts` reuse catalog metadata when building commercial lines.
- `PurchasesPage` reuses catalog identity for purchase-side documents.
- `PortalPage` consumes catalog-derived pricing/visibility surfaces.
- `ReportsPage`, `CoreReportsPage`, `ProcurementDashboardPage`, `DashboardPage`, and `masterApi` use catalog-derived reporting/comparison data.

### Background jobs / operations

- Brand sync / catalog sync via admin function.
- Supplier price catalog sync queue through `queue_supplier_price_catalog_sync`.
- Catalog import finalize path through staged begin/stage/validate/finalize RPCs.

## 4. Source of Truth

Observed truth owners:

- `catalog_products` is the canonical row store for product identity and enrichment visible to the UI/API.
- `item_code_references` is the canonical row store for old/new code mappings and code-resolution continuity.
- `brands` is the canonical store for brand identity.

Observed update permissions:

- `CatalogPage` can update existing rows and create new rows directly through `catalogApi`.
- `CatalogPage` can also import staged rows and finalize them into `catalog_products`.
- `CatalogPage` can delete only through guarded delete RPC.
- `CodeReferencesPage` can create/update/delete code references.

Observed read-only / derived consumers:

- Search results, export rows, coverage counts, reference usage, media lookups, price lists, quote resolution, and reporting views are derived from catalog truth.

Observed protected identity behavior:

- Direct delete is guarded and returns a reference summary if blocked.
- Catalog import is staged and validated before finalize.
- Brand and code normalization are applied before writes.

Important caveat:

- The runtime code does not expose a separate immutable-field contract at the UI layer. Instead, protection is enforced through guarded operations, normalization helpers, and staged import boundaries.

Fields observed as operational/commercial in the UI/API:

- `product_code`
- `brand`
- `description`
- `oem_no`
- `vehicle`
- `hs_code`
- `origin`
- `market_segment`
- `weight_kg`
- `lifecycle_status`
- `lifecycle_note`
- `image_url`

## 5. Data Flow

### Supplier Import

Observed path:

- supplier import rows are staged/finalized in `importApi`
- supplier price finalization can queue catalog sync
- catalog sync updates catalog-facing truth indirectly

Evidence:

- `apps/web/src/infrastructure/api/importApi.ts:300-520`
- `netlify/functions/app-rpc.mts:1037-1087`

### Catalog Import

Observed path:

- CSV parse in `CatalogPage`
- normalize brand/segment/code/fields
- staged begin -> stage chunks -> validate -> finalize
- refresh brand list and rows after finalize

Evidence:

- `apps/web/src/presentation/pages/CatalogPage.tsx:1077-1227`
- `apps/web/src/infrastructure/api/importApi.ts:327-520`

### Manual Edit

Observed path:

- edit/create/delete from `CatalogPage`
- `updateCloudCatalogRow`, `createCloudCatalogRow`, `deleteCloudCatalogRow`

Evidence:

- `apps/web/src/presentation/pages/CatalogPage.tsx:730-830, 1840-1909`
- `apps/web/src/infrastructure/api/catalogApi.ts:223-324`

### Customer Pricing

Observed path:

- `priceListsApi` reads `catalog_products`, `supplier_prices`, and brand data to produce price-list outputs

Evidence:

- `apps/web/src/infrastructure/api/priceListsApi.ts`
- `apps/web/src/shared/salesOrderCatalogSync.ts:1-220`

### Reporting

Observed path:

- reporting/master/dashboard APIs consume catalog-derived read models

Evidence:

- `apps/web/src/infrastructure/api/reportingApi.ts`
- `apps/web/src/infrastructure/api/masterApi.ts`
- `apps/web/src/infrastructure/api/dashboardApi.ts`

### Portal

Observed path:

- portal page and portal APIs surface catalog-derived price visibility and order behavior

Evidence:

- `apps/web/src/presentation/pages/PortalPage.tsx`
- `apps/web/src/infrastructure/api/portalOrderApi.ts`
- `apps/web/src/infrastructure/api/portalAccessApi.ts`

### Search

Observed path:

- UI search in `CatalogPage`
- `fetchCloudCatalog` uses RPC-backed page search
- `fetchCatalogRowsByCodes` does direct row lookup

Evidence:

- `apps/web/src/presentation/pages/CatalogPage.tsx:300-393, 1040-1075`
- `apps/web/src/infrastructure/api/catalogApi.ts:187-220, 462-520`

### Media

Observed path:

- `CatalogPage` fetches product media for selected row preview

Evidence:

- `apps/web/src/presentation/pages/CatalogPage.tsx:620-643`
- `apps/web/src/infrastructure/api/catalogMediaApi.ts:1-23`

### Code References

Observed path:

- `CodeReferencesPage` and `codeReferencesApi` manage old/new code mappings and coverage

Evidence:

- `apps/web/src/infrastructure/api/codeReferencesApi.ts:1-220, 370-440`
- `apps/web/src/presentation/pages/CodeReferencesPage.tsx`

### Export

Observed path:

- Catalog export uses `fetchCatalogExportRows` and xlsx/csv helpers

Evidence:

- `apps/web/src/presentation/pages/CatalogPage.tsx:1251-1285`
- `apps/web/src/infrastructure/api/catalogApi.ts:353-460`
- `apps/web/src/shared/xlsx.ts`
- `apps/web/src/shared/csv.ts`

## 6. Semantic Map

Observed business meanings:

- **Catalog Product**: the canonical sellable part identity used across the operating system.
- **Supplier Price**: a supplier-sourced commercial buying offer for a product identity; it feeds pricing and can trigger catalog sync.
- **Canonical Product Code**: the normalized product identity string used to match, search, export, and transfer records.
- **OEM**: external original-equipment identity signal attached to a catalog item.
- **Brand**: the commercial lineage/category of the part and the main partition key for catalog browsing and imports.
- **Vehicle**: the fitment/application context attached to a part.
- **Cross Reference**: the old-to-new code mapping that preserves continuity when product identity changes.
- **Media**: the visual evidence used to help confirm and present the part.
- **Description**: the human-readable commercial name of the product.
- **Status / Lifecycle**: whether the product is active or discontinued, plus replacement/retirement note.
- **Relationship**: a commercial association between part identity and another record, such as code reference, supplier price, brand, or vehicle fitment.

Source policy evidence:

- `docs/catalog-source-policy.md:5-13, 36-62, 64-98, 99-166`

## 7. Performance Map

Observed heavy areas:

- `CatalogPage` is large and mixes multiple workflows in one component.
- `CatalogPage` search, import, export, media, and code-reference inspection each trigger distinct roundtrips.
- `catalogApi` does page search, export pagination, code lookups, row updates, row creation, and guarded delete in one file.
- `importApi` contains staged import, legacy bulk import, supplier import, and finalize/queue confirmation logic in one file.
- `app-rpc.mts` is a large gateway with allowlists plus special-case queue handlers.

Observed heavy queries / joins:

- `cloud_catalog_page`
- `search_catalog_products`
- `catalog_products` export pagination queries
- `item_code_references` coverage/usage lookups
- `brands` lookups for every catalog flow

Observed large pages from repo inventory:

- `QuotesPage.tsx`
- `PortalPage.tsx`
- `PurchasesPage.tsx`
- `CatalogPage.tsx`
- `SettingsPage.tsx`

Observed bottlenecks / risk points:

- catalog import still uses CSV parsing and batch splitting in the browser before RPC calls
- export loops page through all rows in batches of 1000
- reference coverage and media preview add additional requests per selection
- the gateway is centralized, so RPC churn affects all catalog paths

## 8. Extension Map

### Import Engine

Attach here:

- `apps/web/src/infrastructure/api/importApi.ts`
- `apps/web/src/presentation/pages/CatalogPage.tsx`
- `apps/web/src/shared/spreadsheetImport.ts`
- `apps/web/src/shared/csv.ts`
- `apps/web/src/shared/orderImport.ts`
- `apps/web/src/infrastructure/api/quoteImportApi.ts`
- staged import migrations for catalog and supplier flows

### Export Engine

Attach here:

- `apps/web/src/infrastructure/api/catalogApi.ts` export path
- `apps/web/src/infrastructure/api/priceListsApi.ts`
- `apps/web/src/shared/xlsx.ts`
- `apps/web/src/shared/csv.ts`
- `apps/web/src/shared/documentPrint.ts`

### Operations Engine

Attach here:

- `apps/web/src/presentation/pages/DashboardPage.tsx`
- `apps/web/src/infrastructure/api/suppliersApi.ts`
- `netlify/functions/app-rpc.mts`
- supplier import runs / rollup refresh / catalog sync status tables

### Commercial Rule Engine

Attach here:

- `apps/web/src/domain/shared/normalize.ts`
- `apps/web/src/domain/shared/lifecycle.ts`
- `apps/web/src/domain/shared/catalogFormatting.ts`
- `apps/web/src/domain/shared/catalogSegments.ts`
- `apps/web/src/infrastructure/api/quoteResolverApi.ts`
- `apps/web/src/infrastructure/api/priceListsApi.ts`
- `netlify/functions/_shared/pricing/pricing-policy.mts`
- `docs/catalog-source-policy.md`

### Future AI Advisory / Recommendation

Potential attachments:

- code-reference inspection
- catalog search relevance
- import conflict summaries
- lifecycle warnings
- supplier fallback / enrichment choice

## 9. Plug-and-Play Assessment

Can Catalog become plug-and-play?

- Partially yes.

What already supports it:

- catalog and code-reference flows are already separated into APIs
- catalog import is staged
- catalog delete is guarded
- app-rpc already centralizes gateway access
- shared normalization and formatting helpers exist
- the repo has an explicit ownership index already in place

What prevents it:

- `CatalogPage` is still a multi-workflow surface
- `catalogApi.ts` and `importApi.ts` are large, cross-cutting files
- `app-rpc.mts` still mixes auth, queueing, and catalog RPC proxy logic
- duplicate shared Netlify/script paths still exist
- i18n is global, not module-scoped

What must change:

- split shared engines before splitting the page
- keep catalog import/search/export as independent engines
- move duplicate helper paths to one canonical location
- stop mixing sales/purchase/portal concerns into catalog page behavior

## 10. Repository Assessment

Is filesystem ownership aligned with runtime ownership?

- Partially.

Observed alignment:

- `presentation/pages/CatalogPage.tsx` and `infrastructure/api/catalogApi.ts` are clearly catalog-owned.
- `codeReferencesApi.ts` and `catalogMediaApi.ts` are clearly catalog-owned.
- catalog-related migration names are mostly discoverable.

Observed misalignment:

- `importApi.ts` is shared across catalog, supplier, sales, and pricing.
- `ordersApi.ts` is finance-heavy and mixes sales/purchase/invoice/bill/payment behavior.
- `app-rpc.mts` is a broad gateway that owns more than one domain.
- duplicate `netlify/functions/_shared/...` paths exist for auth, portal, catalog, and warehouse.
- root scripts and categorized scripts overlap.
- Catalog-related UX is distributed across page files instead of one catalog module boundary.

Hidden coupling:

- Catalog truth drives pricing, sales, portal, reporting, and transfer flows.
- `CatalogPage` pushes items into sales/purchase flows through shared transfer storage.
- Brand identity resolution is shared by catalog, references, pricing, and supplier data.

## 11. Business Value Assessment

Does Catalog currently help the company:

- earn more money? **Yes.** It feeds pricing, quoting, sales, and portal visibility.
- save time? **Yes.** Search, code references, import, and export reduce manual lookup work.
- reduce operational risk? **Yes.** Guarded delete, staged import, and lifecycle/replacement handling protect truth.
- reduce cognitive load? **Partially.** The system has the right primitives, but large mixed files still force operators and engineers to mentally stitch together many concerns.

What is missing:

- a canonical Catalog engine split by responsibility
- clearer ownership boundaries between catalog, import, export, and rule logic
- cleaner runtime status/operations visibility for long-running jobs
- less file-level coupling between catalog and other domains
- more consistent filesystem structure for shared vs domain-specific logic

## 12. Future Vision

Final-form Catalog:

- a canonical product identity system with a single source of truth for commercial part records
- separate engines for import, export, search, media, code references, and rule evaluation
- fully safe staged updates for imports and destructive operations
- a stable authority pipeline for brand/supplier enrichment
- reusable across pricing, sales, purchasing, portal, reporting, and operations without forcing callers to know implementation details

## Appendix: Evidence Index

Primary runtime evidence used:

- `apps/web/src/app/App.tsx:215-240, 713-766`
- `apps/web/src/presentation/pages/ItemsPage.tsx:1-11`
- `apps/web/src/presentation/pages/CatalogPage.tsx:157-1909`
- `apps/web/src/infrastructure/api/catalogApi.ts:187-520`
- `apps/web/src/infrastructure/api/importApi.ts:327-520`
- `apps/web/src/infrastructure/api/codeReferencesApi.ts:370-440`
- `apps/web/src/infrastructure/api/catalogMediaApi.ts:1-23`
- `netlify/functions/app-rpc.mts:9-115, 1037-1115`
- `docs/catalog-source-policy.md:5-13, 36-62, 64-98, 99-166`

Unknowns intentionally left open:

- exact DB-level immutability contract for every catalog column
- exact production runtime cost of each query path
- whether every duplicate helper path is fully dead or still referenced elsewhere
- whether further catalog-facing Netlify shared files exist outside the current inventory
