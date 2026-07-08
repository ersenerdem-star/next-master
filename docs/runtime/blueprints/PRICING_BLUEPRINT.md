# Pricing Blueprint

Status: discovery draft for `DISC-003`.

Scope: runtime Pricing system only. This document is evidence-backed and intentionally avoids guesses.

## 1. Business Purpose

Observed purpose:

- Pricing turns supplier buy truth, catalog identity, and customer pricing policy into customer-facing sell prices.
- It supports three commercial outputs:
  - A/B margin-based customer price lists,
  - C-price customer-specific lists,
  - quote/sales/portal price decisions.
- Pricing does not own product identity or commercial documents; it consumes catalog and supplier truth and publishes pricing projections.

Evidence:

- `apps/web/src/infrastructure/api/priceListsApi.ts`
- `apps/web/src/infrastructure/api/cPriceApi.ts`
- `apps/web/src/infrastructure/api/quoteResolverApi.ts`
- `apps/web/src/shared/salesOrderCatalogSync.ts`
- `apps/web/src/infrastructure/api/importApi.ts`
- `apps/web/src/infrastructure/api/masterApi.ts`
- `apps/web/src/infrastructure/api/reportingApi.ts`
- `apps/web/src/infrastructure/api/portalOrderApi.ts`
- `netlify/functions/_shared/pricing/pricing-policy.mts`
- `netlify/functions/_shared/portal/portal-access.mts`
- `netlify/functions/_shared/portal/portal-orders.mts`
- `apps/web/src/presentation/pages/SalesPage.tsx`
- `apps/web/src/presentation/pages/PriceListsPage.tsx`
- `apps/web/src/presentation/pages/QuotesPage.tsx`
- `apps/web/src/presentation/pages/PortalPage.tsx`

## 2. Commercial Model

Observed model:

1. Supplier price truth lands in `supplier_prices`.
2. Supplier price rollups summarize cheapest/second supplier pricing and price gaps.
3. Customer price lists define sell-price policies for A, B, and C lists.
4. Pricing is read by quote, sales, portal, master, and reporting surfaces.

Observed pricing types:

- A and B: margin-driven customer price lists.
- C: explicit customer-specific price list rows.
- Portal pricing: customer account settings choose list type and whether C price is preferred when available.

Evidence:

- `priceListsApi.fetchPriceListSettings()` reads `customer_price_lists` and filters `list_type in ["A", "B", "C"]`.
- `priceListsApi.updateMarginPriceList()` updates `margin_percent` for A/B lists.
- `priceListsApi.importCPriceList()` writes `customer_price_list_items` directly.
- `cPriceApi.fetchCPriceMapForRows()` reads active C lists and items.
- `quoteImportApi.batchResolveQuoteImportRows()` reads `catalog_products`, `supplier_prices`, and C price maps.
- `salesOrderCatalogSync.ts` uses `supplier_prices`, catalog metadata, and C price maps.
- `portal-access.mts` and `portal-orders.mts` project `price_list_type` and `portal_c_price_mode`.

## 3. Runtime Map

### UI

- `SalesPage` hosts `PriceListsPage` as the `"Price Lists"` tab.
- `QuotesPage` resolves quote lines and applies C-price / margin pricing.
- `PortalPage` shows pricing profile, portal C-price mode, and customer-specific price list downloads.
- `MasterPage` and reporting screens surface pricing comparisons and priced catalog views.

Evidence:

- `apps/web/src/presentation/pages/SalesPage.tsx`
- `apps/web/src/presentation/pages/QuotesPage.tsx`
- `apps/web/src/presentation/pages/PortalPage.tsx`
- `apps/web/src/presentation/pages/MasterPage.tsx`

### API

- `priceListsApi.ts`
  - `fetchPriceListSettings()`
  - `updateMarginPriceList()`
  - `fetchCustomerPriceListExportRows()`
  - `importCPriceList()`
- `cPriceApi.ts`
  - `fetchCPriceMapForRows()`
  - `getCPriceForRow()`
- `quoteResolverApi.ts`
  - `resolveQuoteLine()`
- `quoteImportApi.ts`
  - `batchResolveQuoteImportRows()`
- `salesOrderCatalogSync.ts`
  - `resyncSalesOrderLinesFromCatalog()`
  - `resyncInvoiceLinesFromCatalog()`
  - `resyncPurchaseOrderLinesFromCatalog()`
  - `resyncBillLinesFromCatalog()`
- `masterApi.ts`
  - supplier-price rollup reads and priced master exports
- `reportingApi.ts`
  - reporting refresh and variance views
- `portalOrderApi.ts`
  - portal price list download and order pricing requests

### Gateway / RPC

- `cloud_customer_price_list_export_page_fast` is the fast export RPC for customer price list pages.
- `cloud_resolve_quote_line` and `cloud_quote_supplier_options` are the quote-time pricing RPCs.
- `app-rpc.mts` allowlists the customer price list replace RPC family for the runtime gateway.

Evidence:

- `apps/web/src/infrastructure/api/priceListsApi.ts`
- `apps/web/src/infrastructure/api/quoteResolverApi.ts`
- `netlify/functions/app-rpc.mts`

### SQL / Tables / Views

Observed pricing tables and views:

- `supplier_prices`
- `supplier_price_rollups`
- `customer_price_lists`
- `customer_price_list_items`
- `price_variance_checks`
- `reporting_core_refresh_runs`

Observed pricing-linked account fields:

- `price_list_type`
- `portal_c_price_mode`
- `price_list_margin_percent`
- `payment_terms`

Evidence:

- `apps/web/src/infrastructure/api/priceListsApi.ts`
- `apps/web/src/infrastructure/api/cPriceApi.ts`
- `apps/web/src/infrastructure/api/masterApi.ts`
- `apps/web/src/infrastructure/api/reportingApi.ts`
- `netlify/functions/_shared/portal/portal-access.mts`
- `netlify/functions/_shared/portal/portal-orders.mts`
- `apps/web/src/infrastructure/api/customersApi.ts`

## 4. Source of Truth

Observed truth owners:

- `supplier_prices` is the canonical supplier buy-price store.
- `customer_price_lists` is the canonical customer pricing configuration store.
- `customer_price_list_items` is the canonical C-price row store.
- `supplier_price_rollups` is derived pricing intelligence, not primary truth.
- `catalog_products` is the commercial identity input, not pricing truth.
- portal pricing profile fields are customer/account configuration, not pricing truth.

Observed projections / read models:

- C-price maps
- customer price list export rows
- quote line resolution output
- sales and invoice line resync output
- master priced exports
- portal price list downloads
- reporting variance and procurement views

Evidence:

- `priceListsApi.ts`
- `cPriceApi.ts`
- `quoteResolverApi.ts`
- `salesOrderCatalogSync.ts`
- `masterApi.ts`
- `reportingApi.ts`
- `portalOrderApi.ts`

## 5. Pricing Rules

Observed rules:

- Margin lists A/B compute sales price from supplier buy price and a margin percentage.
- C-price is used for customerType `C`, or when the account pricing mode is `prefer_c_when_available`.
- Portal pricing follows the account `price_list_type` and `portal_c_price_mode`.
- Quote and sales synchronization reuse the same C-price preference rule.
- Supplier rollups determine cheapest supplier, second supplier, price gap, and gap percent.
- Values are rounded to money precision before display or export.

Evidence:

- `netlify/functions/_shared/pricing/pricing-policy.mts`
- `apps/web/src/presentation/pages/QuotesPage.tsx`
- `apps/web/src/shared/salesOrderCatalogSync.ts`
- `apps/web/src/infrastructure/api/masterApi.ts`
- `apps/web/src/infrastructure/api/reportingApi.ts`

## 6. Business Flow

Observed flow:

1. Supplier prices are imported or updated.
2. Catalog and quote resolution read those prices.
3. Supplier rollups summarize the cheapest and second supplier position.
4. Sales sets or exports customer price lists.
5. Quotes and sales orders reuse the pricing rule set.
6. Portal downloads customer-specific price lists.
7. Master and reporting surfaces compare price gaps and margins.

Evidence:

- `importApi.ts`
- `priceListsApi.ts`
- `quoteImportApi.ts`
- `salesOrderCatalogSync.ts`
- `portalOrderApi.ts`
- `masterApi.ts`
- `reportingApi.ts`

## 7. Current Boundaries

Observed boundaries:

- Pricing consumes catalog identity; it does not own catalog identity.
- Pricing consumes supplier buy truth; it does not own supplier import truth.
- Pricing projects values into sales, invoices, portal views, and exports; those documents own their own saved snapshots.
- In the current UI, pricing is exposed through Sales > Price Lists and embedded in Quotes, Portal, Master, and Reporting surfaces.

Observed current tension:

- `importCPriceList()` still writes `customer_price_list_items` directly through the API helper.
- The runtime gateway already allowlists a customer price list replace family, so the codebase shows both legacy direct-write behavior and a staged-replace direction.

Evidence:

- `apps/web/src/infrastructure/api/priceListsApi.ts`
- `netlify/functions/app-rpc.mts`

## 8. Business Value

Observed value:

- Pricing lets the business quote faster and with less manual calculation.
- It keeps A/B margin policy and C-price policy distinct.
- It supports customer-specific portal price lists.
- It exposes pricing intelligence through supplier rollups, master views, and reporting variance checks.
- It propagates price decisions into quotes, sales orders, invoices, purchase documents, and portal outputs.

Evidence:

- `PriceListsPage.tsx`
- `QuotesPage.tsx`
- `PortalPage.tsx`
- `masterApi.ts`
- `reportingApi.ts`
- `salesOrderCatalogSync.ts`

## 9. Final Conclusion

Observed conclusion:

Pricing is the commercial translation layer between supplier buy truth and customer sell truth.
It takes catalog identity and supplier price inputs, applies customer pricing policy, and publishes sell-price outputs into sales, quotes, portal, and reporting surfaces.

It is not a standalone ledger.
It is a rule-and-projection layer that keeps price policy visible across the system.
