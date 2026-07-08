# Runtime Domain Ownership Index

Status: Phase 5A filesystem governance index.

Purpose: define canonical ownership for major runtime files before any cleanup, extraction, or refactor work. This document is an ownership map only. It does not approve moving files, changing behavior, or deleting legacy paths.

## Domain Model

Canonical runtime domains:

- Catalog
- Supplier
- Pricing
- Sales
- Purchasing
- Warehouse
- Finance
- Reporting
- Portal
- Settings/Admin
- Users/Auth
- Operations
- Shared Platform

## UI Page Ownership

| File | Canonical Owner | Secondary Domains | Notes |
|---|---|---|---|
| `apps/web/src/presentation/pages/CatalogPage.tsx` | Catalog | Supplier, Pricing, Operations | Catalog browse, edit, import, media, delete protection. Large mixed page. |
| `apps/web/src/presentation/pages/ItemsPage.tsx` | Catalog | Supplier, Pricing | Master item/catalog operations. |
| `apps/web/src/presentation/pages/CodeReferencesPage.tsx` | Catalog | Sales, Supplier | Item code reference identity resolver. |
| `apps/web/src/presentation/pages/SuppliersPage.tsx` | Supplier | Catalog, Pricing, Operations | Supplier price import and supplier price visibility. |
| `apps/web/src/presentation/pages/PriceListsPage.tsx` | Pricing | Supplier, Catalog, Sales | Customer price list and margin price outputs. |
| `apps/web/src/presentation/pages/SalesPage.tsx` | Sales | Catalog, Pricing, Purchasing, Finance | Sales order workbench. |
| `apps/web/src/presentation/pages/QuotesPage.tsx` | Sales | Catalog, Pricing, Supplier, Export | Quote/import resolution and outputs. Large mixed page. |
| `apps/web/src/presentation/pages/CustomersPage.tsx` | Sales | Finance, Portal, Settings/Admin | Customer records and account statement behavior. |
| `apps/web/src/presentation/pages/PurchasesPage.tsx` | Purchasing | Warehouse, Finance, Supplier | Purchase orders, bills, receive workflows. Large mixed page. |
| `apps/web/src/presentation/pages/VendorsPage.tsx` | Purchasing | Finance | Vendor records. |
| `apps/web/src/presentation/pages/InventoryPage.tsx` | Warehouse | Purchasing, Reporting | Stock, transfers, locations, movements. Large mixed page. |
| `apps/web/src/presentation/pages/InventoryAnalyticsPage.tsx` | Warehouse | Reporting | Warehouse analytics/read model view. |
| `apps/web/src/presentation/pages/ItemTransactionsPage.tsx` | Warehouse | Catalog, Finance | Inventory transaction history. |
| `apps/web/src/presentation/pages/ReportsPage.tsx` | Reporting | Sales, Finance, Warehouse | Operational reporting page. |
| `apps/web/src/presentation/pages/CoreReportsPage.tsx` | Reporting | Finance | Core reporting view. |
| `apps/web/src/presentation/pages/ProcurementDashboardPage.tsx` | Reporting | Purchasing, Supplier, Pricing | Procurement dashboard/read model. |
| `apps/web/src/presentation/pages/DashboardPage.tsx` | Operations | Reporting, Supplier, Warehouse, Sales | Operations status and executive dashboard. |
| `apps/web/src/presentation/pages/PortalPage.tsx` | Portal | Sales, Pricing, Catalog | Customer portal. Large mixed page. |
| `apps/web/src/presentation/pages/PortalLoginPage.tsx` | Portal | Users/Auth | Portal auth entry. |
| `apps/web/src/presentation/pages/SettingsPage.tsx` | Settings/Admin | Users/Auth, Portal, Supplier, Catalog | Users, company profiles, email, admin configuration. Large mixed page. |
| `apps/web/src/presentation/pages/LoginPage.tsx` | Users/Auth | Shared Platform | App login entry. |
| `apps/web/src/presentation/pages/MasterPage.tsx` | Reporting | Catalog, Supplier, Pricing | Master comparison/intelligence view. |

## API File Ownership

| File | Canonical Owner | Secondary Domains | Notes |
|---|---|---|---|
| `apps/web/src/infrastructure/api/catalogApi.ts` | Catalog | Operations | Catalog product mutation/read API. |
| `apps/web/src/infrastructure/api/catalogMediaApi.ts` | Catalog | Shared Platform | Catalog media function wrapper. |
| `apps/web/src/infrastructure/api/brandsApi.ts` | Catalog | Supplier, Pricing | Brand reference API. |
| `apps/web/src/infrastructure/api/codeReferencesApi.ts` | Catalog | Sales | Item code references. |
| `apps/web/src/infrastructure/api/suppliersApi.ts` | Supplier | Operations, Pricing, Catalog | Supplier data, supplier import status, rollup operations. |
| `apps/web/src/infrastructure/api/importApi.ts` | Shared Platform | Catalog, Supplier, Sales, Pricing | Import behavior is cross-domain and should become Import Engine. |
| `apps/web/src/infrastructure/api/priceListsApi.ts` | Pricing | Supplier, Catalog | Customer price lists, C-price replace, exports. |
| `apps/web/src/infrastructure/api/cPriceApi.ts` | Pricing | Sales | C-price access. |
| `apps/web/src/infrastructure/api/ordersApi.ts` | Finance | Sales, Purchasing, Warehouse | Orders, invoices, bills, payments. Must be split by boundary. |
| `apps/web/src/infrastructure/api/quotesApi.ts` | Sales | Pricing | Quote API. |
| `apps/web/src/infrastructure/api/quoteImportApi.ts` | Sales | Import Engine, Catalog, Pricing | Sales import. |
| `apps/web/src/infrastructure/api/quoteResolverApi.ts` | Sales | Catalog, Supplier, Pricing, Rule Engine | Commercial line resolution. |
| `apps/web/src/infrastructure/api/customersApi.ts` | Sales | Portal, Finance | Customer master records. |
| `apps/web/src/infrastructure/api/vendorsApi.ts` | Purchasing | Finance | Vendor master records. |
| `apps/web/src/infrastructure/api/inventoryApi.ts` | Warehouse | Purchasing, Finance | Inventory movement/stock API. |
| `apps/web/src/infrastructure/api/warehousesApi.ts` | Warehouse | Settings/Admin | Warehouse records. |
| `apps/web/src/infrastructure/api/reportingApi.ts` | Reporting | Finance, Sales, Warehouse | Reporting read models. |
| `apps/web/src/infrastructure/api/dashboardApi.ts` | Reporting | Operations | Dashboard metrics. |
| `apps/web/src/infrastructure/api/masterApi.ts` | Reporting | Supplier, Pricing, Catalog | Master supplier comparison/read models. |
| `apps/web/src/infrastructure/api/portalAccessApi.ts` | Portal | Users/Auth | Portal access. |
| `apps/web/src/infrastructure/api/portalInvitesApi.ts` | Portal | Settings/Admin, Users/Auth | Portal invite configuration. |
| `apps/web/src/infrastructure/api/portalOrderApi.ts` | Portal | Sales | Portal order workflow. |
| `apps/web/src/infrastructure/api/adminApi.ts` | Settings/Admin | Users/Auth, Catalog, Warehouse | Admin Netlify function wrappers. |
| `apps/web/src/infrastructure/api/appAdminRecordsApi.ts` | Settings/Admin | Shared Platform | Admin record proxy. |
| `apps/web/src/infrastructure/api/companyProfilesApi.ts` | Settings/Admin | Sales, Purchasing, Warehouse | Company profile records. |
| `apps/web/src/infrastructure/api/emailTemplatesApi.ts` | Settings/Admin | Portal, Purchasing | Email templates and outbound queue. |
| `apps/web/src/infrastructure/api/usersApi.ts` | Users/Auth | Settings/Admin | User records and presence. |
| `apps/web/src/infrastructure/api/appSessionApi.ts` | Users/Auth | Shared Platform | Session snapshot/cache. |
| `apps/web/src/infrastructure/api/appRpcApi.ts` | Shared Platform | All domains | App RPC gateway client. |
| `apps/web/src/infrastructure/api/organizationApi.ts` | Shared Platform | Users/Auth | Current organization resolver. |
| `apps/web/src/infrastructure/api/supabaseClient.ts` | Shared Platform | All domains | Supabase client. |

## Netlify Function Ownership

| Path | Canonical Owner | Notes |
|---|---|---|
| `netlify/functions/app-rpc.mts` | Shared Platform | Gateway for DB RPCs. Mixed authorization and operations special cases; future split candidate. |
| `netlify/functions/app-session.mts` | Users/Auth | App session endpoint. |
| `netlify/functions/app-admin-records.mts` | Settings/Admin | Admin record proxy. |
| `netlify/functions/admin-*.mts` | Settings/Admin | Admin user, diagnostics, email, sync functions. |
| `netlify/functions/catalog-product-media.mts` | Catalog | Catalog media endpoint. |
| `netlify/functions/portal-*.mts` | Portal | Portal login, data, order, password reset, price list functions. |
| `netlify/functions/send-portal-invite.mts` | Portal | Portal invite mail. |
| `netlify/functions/send-queued-emails.mts` | Settings/Admin | Outbound email delivery. |
| `netlify/functions/warehouse-*.mts` | Warehouse | Warehouse partner order/stock endpoints. |
| `netlify/functions/_shared/auth/*` | Users/Auth | Canonical auth shared folder candidate. |
| `netlify/functions/_shared/core/*` | Shared Platform | Canonical core shared folder candidate. |
| `netlify/functions/_shared/catalog/*` | Catalog | Canonical catalog shared folder candidate. |
| `netlify/functions/_shared/portal/*` | Portal | Canonical portal shared folder candidate. |
| `netlify/functions/_shared/warehouse/*` | Warehouse | Canonical warehouse shared folder candidate. |
| `netlify/functions/_shared/pricing/*` | Pricing | Pricing policy shared code. |
| `netlify/functions/_modules/admin/*` | Settings/Admin | Module boundary placeholder. |
| `netlify/functions/_modules/portal/*` | Portal | Module boundary placeholder. |
| `netlify/functions/_modules/warehouse/*` | Warehouse | Module boundary placeholder. |

## Migration Ownership By Domain

| Domain | Migration Groups |
|---|---|
| Catalog | `20260511_item_code_references.sql`, `20260513_03_cloud_catalog_rpc.sql`, `20260519_23_catalog_lifecycle.sql`, `20260523_24_catalog_images.sql`, `20260607_39_catalog_vehicle.sql`, `20260604_42_catalog_brand_browse_index.sql`, `20260607_43_catalog_ean.sql`, `20260607_45_catalog_market_segment.sql`, `20260607_46_catalog_vehicle_model.sql`, `20260608_53_catalog_vehicle_model_import.sql`, `20260619_57_*`, `58_*`, `59_*`, `60_*`, `20260621_61_*`, `20260622_62_*`, `63_*`, `20260626_74_*`, `75_*`, `76_*`, `20260627_77_*`, `78_*`, `20260706_91_*`, `20260707_97_*`, `98_*`, `99_*`, `zz_*`. |
| Supplier | `20260513_04_cloud_suppliers_rpc.sql`, `20260608_51_dedupe_supplier_price_import.sql`, `20260627_79_supplier_price_rollup_refresh_runs.sql`, `20260628_80_supplier_price_rollup_ledger_health.sql`, `20260701_84_supplier_price_staged_import_finalize.sql`, `20260701_85_supplier_price_import_concurrent_guard.sql`, `20260707_999_supplier_price_import_admin_authorization.sql`, `20260708_00_supplier_price_catalog_sync_background.sql`, `20260708_01_supplier_price_finalize_batches.sql`. |
| Pricing | `20260513_16_customer_margin.sql`, `20260529_32_customer_portal_c_price_mode.sql`, `20260625_69_master_supplier_comparison_rollups.sql`, `20260626_70_*`, `71_*`, `20260630_81_customer_price_list_export_fast_page.sql`, `20260705_90_customer_price_list_replace_atomic_boundary.sql`. |
| Sales | `20260513_06_cloud_quote_rpc.sql`, `20260513_07_cloud_quotes_rpc.sql`, `20260513_09_cloud_save_quote_rpc.sql`, `20260513_10_business_records_phase1.sql`, `20260513_11_orders_phase2.sql`, `20260529_31_customer_primary_seller_profile.sql`, `20260618_55_invoice_sales_order_ids.sql`, `20260707_96_sales_purchase_order_guarded_boundary.sql`. |
| Purchasing | `20260513_14_vendors_phase4.sql`, `20260707_92_purchase_receive_atomic_boundary.sql`, `20260707_95_invoice_bill_guarded_boundary.sql`, `20260707_96_sales_purchase_order_guarded_boundary.sql`. |
| Warehouse | `20260513_17_inventory_phase1.sql`, `20260513_19_inventory_phase2.sql`, `20260518_22_inventory_transfers.sql`, `20260530_35_*`, `36_*`, `37_*`, `38_*`, `20260607_44_*`, `47_*`, `48_*`, `49_*`, `50_*`, `20260608_52_profiles_warehouse_role.sql`, `20260618_56_invoice_stock_sync_default_warehouse.sql`, `20260707_92_*`, `93_*`. |
| Finance | `20260513_12_documents_phase3.sql`, `20260513_15_payments_phase5.sql`, `20260707_93_inventory_append_only_reversal_ledger.sql`, `20260707_94_payment_atomic_status_boundary.sql`, `20260707_95_invoice_bill_guarded_boundary.sql`. |
| Reporting | `20260626_70_reporting_core_report_filters.sql`, `20260626_72_procurement_dashboard_summary.sql`, `20260626_73_fix_procurement_dashboard_summary_filters.sql`, `20260627_79_supplier_price_rollup_refresh_runs.sql`, `20260628_80_supplier_price_rollup_ledger_health.sql`. |
| Portal | `20260517_20_portal_sales_orders.sql`, `20260518_21_portal_security_hardening.sql`, `20260529_30_portal_request_rate_limits.sql`, `20260601_40_portal_audit_logs.sql`, `20260601_41_portal_brand_scope.sql`. |
| Settings/Admin | `20260513_02_cloud_admin_rpc.sql`, `20260513_13_email_templates.sql`, `20260529_33_superadmin_role_and_system_access.sql`, `20260529_34_admin_operations_access.sql`. |
| Users/Auth | `20260609_54_profiles_session_revocation.sql`, auth-related parts of `20260529_33_*`, `20260608_52_*`. |
| Shared Platform | `20260513_01_performance_indexes.sql`, `20260513_18_public_schema_data_api_grants.sql`, `20260529_26_*`, `27_*`, `28_*`, `29_*`. |

## Types Ownership

| Type File | Owner |
|---|---|
| `types/catalog.ts`, `types/brand.ts`, `types/codeReferences.ts` | Catalog |
| `types/suppliers.ts` | Supplier, Operations |
| `types/orders.ts` | Sales, Purchasing, Finance |
| `types/inventory.ts`, `types/warehouses.ts` | Warehouse |
| `types/reporting.ts`, `types/master.ts` | Reporting |
| `types/portal.ts`, `types/portalSession.ts` | Portal |
| `types/company.ts`, `types/emailTemplates.ts` | Settings/Admin |
| `types/users.ts` | Users/Auth |
| `types/customers.ts`, `types/vendors.ts` | Sales, Purchasing |
| `types/quoteBuilder.ts`, `types/quotes.ts` | Sales |

## Shared Utilities Ownership

| File | Owner | Notes |
|---|---|---|
| `domain/shared/normalize.ts` | Shared Platform | Product/code normalization. Candidate for Commercial Rule Engine dependency. |
| `domain/shared/lifecycle.ts` | Catalog | Lifecycle semantics. |
| `domain/shared/catalogFormatting.ts` | Catalog | Catalog display/formatting. |
| `domain/shared/catalogSegments.ts` | Catalog | Catalog market segments. |
| `shared/spreadsheetImport.ts`, `shared/csv.ts`, `shared/xlsx.ts` | Shared Platform | Import/Export Engine candidates. |
| `shared/productCodeDisplay.ts` | Shared Platform | Display formatting across Catalog/Pricing/Sales. |
| `shared/orderImport.ts` | Sales | Sales import candidate for Import Engine. |
| `shared/catalogTransfer.ts` | Catalog | Catalog transfer/import helper. |
| `shared/salesOrderCatalogSync.ts` | Sales | Sales order catalog sync. |
| `shared/documentPrint.ts`, `shared/quotePrint.ts`, `shared/accountStatementPrint.ts` | Export Engine | Document/export generation. |
| `shared/roles.ts`, `shared/userMessage.ts` | Users/Auth, Shared Platform | Authorization/user-facing message helpers. |
| `presentation/components/common/*` | Shared Platform | UI primitives. |

## i18n Ownership

Current files:

- `apps/web/src/i18n/locales/en.ts`
- `apps/web/src/i18n/locales/tr.ts`

Canonical owner: Shared Platform.

Risk: i18n strings are global and not domain-scoped. Future extraction should group keys by domain prefix, then optionally split per domain only after page/module split is stable.

## Scripts Ownership

| Path | Owner | Notes |
|---|---|---|
| `scripts/audit/*` | Shared Platform | Repository and operational audit scripts. |
| `scripts/sync/*` | Catalog | Brand/catalog sync and enrichment. |
| `scripts/maintenance/*` | Catalog, Shared Platform | Cleanup, normalization, rollback scripts. |
| `scripts/mobile/*` | Shared Platform | Mobile build/icon tasks. |
| `scripts/ops/*` | Operations | Deploy/runtime repair operations. |
| root `scripts/*.mjs` | Legacy / Deprecated Candidate | Many duplicate categorized scripts. Keep until canonical categorized path is proven. |
| `scripts/shared/*` | Shared Platform | Canonical shared script helper candidate. |
| `scripts/_shared/*` | Legacy / Deprecated Candidate | Duplicate of `scripts/shared/*` candidate. |

## Mixed Responsibility Files

| File | Primary Owner | Mixed Responsibilities |
|---|---|---|
| `apps/web/src/presentation/pages/QuotesPage.tsx` | Sales | Import, pricing, catalog resolution, customer/internal outputs. |
| `apps/web/src/presentation/pages/PortalPage.tsx` | Portal | Portal UX, pricing visibility, sales order behavior. |
| `apps/web/src/presentation/pages/PurchasesPage.tsx` | Purchasing | Purchase orders, bills, receive, vendor flows. |
| `apps/web/src/presentation/pages/CatalogPage.tsx` | Catalog | Search, import, edit, media, delete protection. |
| `apps/web/src/presentation/pages/InventoryPage.tsx` | Warehouse | Stock, transfers, receive, locations, movement history. |
| `apps/web/src/presentation/pages/SettingsPage.tsx` | Settings/Admin | Users, company profiles, email, portal/admin settings. |
| `apps/web/src/presentation/pages/CustomersPage.tsx` | Sales | Customer master, finance statement, payments. |
| `apps/web/src/infrastructure/api/ordersApi.ts` | Finance | Sales orders, purchase orders, invoices, bills, payments. |
| `apps/web/src/infrastructure/api/importApi.ts` | Shared Platform | Catalog, supplier, sales import behavior. |
| `netlify/functions/app-rpc.mts` | Shared Platform | Gateway, authorization sets, queue/status special cases. |
| `apps/web/src/app/App.tsx` | Shared Platform | Routing plus cross-page coordination. |

## Duplicate Paths

Do not delete until import references and runtime behavior are verified.

| Duplicate Pattern | Candidate Canonical Path |
|---|---|
| `netlify/functions/_shared/*.mts` and `netlify/functions/_shared/catalog/*.mts` catalog sync files | `netlify/functions/_shared/catalog/*` |
| `netlify/functions/_shared/portal-*.mts` and `netlify/functions/_shared/portal/*.mts` | `netlify/functions/_shared/portal/*` |
| `netlify/functions/_shared/auth.mts`, `app-auth.mts`, `roles.mts` and `_shared/auth/*` | `netlify/functions/_shared/auth/*` |
| `netlify/functions/_shared/http.mts`, `user-message.mts` and `_shared/core/*` | `netlify/functions/_shared/core/*` |
| `netlify/functions/_shared/warehouse-partner-auth.mts` and `_shared/warehouse/*` | `netlify/functions/_shared/warehouse/*` |
| root `scripts/*.mjs` and categorized `scripts/sync/*`, `scripts/maintenance/*`, `scripts/audit/*`, `scripts/mobile/*` | categorized `scripts/*` folders |
| `scripts/_shared/*` and `scripts/shared/*` | `scripts/shared/*` |

## Future Extraction Targets

Recommended order:

1. Operations Status Engine
2. Import Engine
3. Export Engine
4. Orders/Finance boundary split
5. Commercial Rule Engine
6. Portal module extraction
7. Catalog page split
8. Script duplicate cleanup
9. Netlify shared duplicate cleanup

## Do-Not-Touch / Deprecated Candidates

Do not touch without explicit approval:

- Historical migrations already deployed or potentially deployed.
- `20260707_zz_catalog_import_finalize.sql`; nonstandard name but part of current migration chain.
- `20260707_999_supplier_price_import_admin_authorization.sql`; nonstandard order but part of current migration chain.
- Root `scripts/*.mjs`; deprecated candidate, not deletion-approved.
- Root `netlify/functions/_shared/*.mts`; deprecated candidate where domain-folder duplicate exists, not deletion-approved.
- Global i18n locale files; do not split before domain extraction.
- `ordersApi.ts`; do not split until guarded order/finance boundaries are revalidated.

## Plug-and-Play Engine Candidates

### Import Engine

Candidate files:

- `apps/web/src/infrastructure/api/importApi.ts`
- `apps/web/src/infrastructure/api/quoteImportApi.ts`
- `apps/web/src/shared/spreadsheetImport.ts`
- `apps/web/src/shared/csv.ts`
- `apps/web/src/shared/orderImport.ts`
- `apps/web/src/shared/catalogTransfer.ts`
- `apps/web/src/presentation/pages/CatalogPage.tsx`
- `apps/web/src/presentation/pages/QuotesPage.tsx`
- `apps/web/src/presentation/pages/SuppliersPage.tsx`
- `supabase/migrations/20260701_84_supplier_price_staged_import_finalize.sql`
- `supabase/migrations/20260701_85_supplier_price_import_concurrent_guard.sql`
- `supabase/migrations/20260707_97_catalog_import_staged_boundary_slice1.sql`
- `supabase/migrations/20260707_98_catalog_import_stage_chunk.sql`
- `supabase/migrations/20260707_99_catalog_import_validate_rows.sql`
- `supabase/migrations/20260707_zz_catalog_import_finalize.sql`
- `supabase/migrations/20260708_01_supplier_price_finalize_batches.sql`

### Export Engine

Candidate files:

- `apps/web/src/shared/xlsx.ts`
- `apps/web/src/shared/documentPrint.ts`
- `apps/web/src/shared/quotePrint.ts`
- `apps/web/src/shared/accountStatementPrint.ts`
- `apps/web/src/infrastructure/api/priceListsApi.ts`
- `apps/web/src/infrastructure/api/masterApi.ts`
- `apps/web/src/presentation/pages/PriceListsPage.tsx`
- `apps/web/src/presentation/pages/QuotesPage.tsx`
- `apps/web/src/presentation/pages/CustomersPage.tsx`
- `apps/web/src/presentation/pages/MasterPage.tsx`
- `supabase/migrations/20260630_81_customer_price_list_export_fast_page.sql`
- `supabase/migrations/20260626_75_master_priced_fast_page.sql`
- `supabase/migrations/20260626_76_master_priced_fast_export_page.sql`
- `supabase/migrations/20260627_77_master_priced_fast_page_set_based.sql`
- `supabase/migrations/20260627_78_master_priced_fast_export_page_set_based.sql`

### Operations Status Engine

Candidate files:

- `apps/web/src/presentation/pages/DashboardPage.tsx`
- `apps/web/src/infrastructure/api/suppliersApi.ts`
- `apps/web/src/infrastructure/api/dashboardApi.ts`
- `apps/web/src/infrastructure/api/reportingApi.ts`
- `apps/web/src/types/suppliers.ts`
- `netlify/functions/app-rpc.mts`
- `supabase/migrations/20260627_79_supplier_price_rollup_refresh_runs.sql`
- `supabase/migrations/20260628_80_supplier_price_rollup_ledger_health.sql`
- `supabase/migrations/20260708_00_supplier_price_catalog_sync_background.sql`
- `supabase/migrations/20260708_01_supplier_price_finalize_batches.sql`

### Commercial Rule Engine

Candidate files:

- `apps/web/src/domain/shared/normalize.ts`
- `apps/web/src/domain/shared/lifecycle.ts`
- `apps/web/src/domain/shared/catalogFormatting.ts`
- `apps/web/src/domain/shared/catalogSegments.ts`
- `apps/web/src/infrastructure/api/quoteResolverApi.ts`
- `apps/web/src/infrastructure/api/priceListsApi.ts`
- `apps/web/src/shared/productCodeDisplay.ts`
- `netlify/functions/_shared/pricing/pricing-policy.mts`
- `netlify/functions/_shared/catalog/catalog-source-policy.mts`
- `netlify/functions/_shared/catalog/catalog-standardization.mts`
- `netlify/functions/_shared/catalog/catalog-segments.mts`

## Governance Rules

- Every new runtime feature must declare one canonical owner domain.
- Cross-domain files must declare the primary owner and the secondary consumers.
- No duplicate path should be deleted until all imports and deployed functions are verified.
- Do not move migrations.
- Do not rename historical migrations without a deployment-order review.
- Do not split large files and change behavior in the same commit.
- Prefer extracting engines before splitting pages when behavior is shared by multiple domains.
