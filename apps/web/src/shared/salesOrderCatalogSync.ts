import { markupMoney } from "../../../../shared/order-money.mjs";
import { canonicalizeBrandName, canonicalizePriceBrandName, canonicalizePriceProductCode, normalizeBrandKey, normalizePartCode } from "../domain/shared/normalize";
import { fetchCatalogMetadataForRows } from "../infrastructure/api/quoteImportApi";
import { fetchCodeReferenceMatchesForRows } from "../infrastructure/api/codeReferencesApi";
import { resolveQuoteLine } from "../infrastructure/api/quoteResolverApi";
import { callAppRpc } from "../infrastructure/api/appRpcApi";
import {
  currentSupplierPriceKey,
  exactProductCode,
  fetchCurrentSupplierPriceMap,
  type CurrentSupplierPriceBatchRow,
  type CurrentSupplierPriceRequest,
  type SelectedSupplierPrice,
} from "./currentSupplierPriceSync.mjs";
import { normalizeOrderQuantity } from "../domain/shared/orderQuantityRules";
import type { QuoteBuilderLine } from "../types/quoteBuilder";
import type { LocalBillLine, LocalInvoiceLine, LocalPurchaseOrderLine } from "../types/orders";

export type SalesOrderCatalogSyncOptions = {
  customerType: "A" | "B" | "C" | "Other";
  marginA: number;
  marginB: number;
  currency?: string;
  onlyFillBlanks?: boolean;
  keepPrices?: boolean;
  hydrateMissingPricesIfKeepingPrices?: boolean;
};

export type InvoiceCatalogSyncOptions = {
  customerType: "A" | "B" | "C" | "Other";
  marginA: number;
  marginB: number;
  accountMarginPercent?: number | null;
  currency?: string;
  onlyFillBlanks?: boolean;
  keepPrices?: boolean;
};

export type PurchaseOrderCatalogSyncOptions = {
  currency?: string;
  onlyFillBlanks?: boolean;
  keepPrices?: boolean;
};

function roundMoney(value: number) {
  return Math.round(value * 100) / 100;
}

function isBlankText(value: string | null | undefined) {
  return !String(value || "").trim();
}

function isBlankNumber(value: number | null | undefined) {
  return value == null || Number.isNaN(Number(value));
}

function fillText(current: string, next: string, onlyFillBlanks: boolean) {
  if (!onlyFillBlanks) return next || current;
  return isBlankText(current) ? next || current : current;
}

function fillNumber(current: number | null, next: number | null, onlyFillBlanks: boolean) {
  if (!onlyFillBlanks) return next ?? current;
  return isBlankNumber(current) ? next ?? current : current;
}

function mergeCatalogMetadata(
  line: QuoteBuilderLine,
  metadata:
    | {
        product_code: string;
        description: string;
        oem_no: string;
        hs_code: string;
        origin: string;
        weight_kg: number | null;
        lifecycle_status?: "active" | "discontinued" | null;
        lifecycle_note?: string | null;
      }
    | undefined,
  onlyFillBlanks: boolean,
): QuoteBuilderLine {
  if (!metadata) return line;
  return {
    ...line,
    resolvedCode: onlyFillBlanks ? line.resolvedCode || metadata.product_code : metadata.product_code || line.resolvedCode,
    description: fillText(line.description, metadata.description, onlyFillBlanks),
    oem_no: fillText(line.oem_no, metadata.oem_no, onlyFillBlanks),
    hs_code: fillText(line.hs_code, metadata.hs_code, onlyFillBlanks),
    origin: fillText(line.origin, metadata.origin, onlyFillBlanks),
    weight_kg: fillNumber(line.weight_kg ?? null, metadata.weight_kg ?? null, onlyFillBlanks),
    lifecycle_status: metadata.lifecycle_status ?? line.lifecycle_status ?? "active",
    lifecycle_note: metadata.lifecycle_note ?? line.lifecycle_note ?? null,
    lifecycle_warning:
      metadata.lifecycle_status === "discontinued"
        ? `Production ended for ${metadata.product_code || line.resolvedCode || line.requestedCode}.${metadata.lifecycle_note ? ` ${metadata.lifecycle_note}` : ""}`
        : line.lifecycle_warning ?? null,
    found: line.found || Boolean(metadata.product_code || metadata.description || metadata.oem_no),
  };
}

function getSelectedSupplierName(line: QuoteBuilderLine) {
  const selectedFromOptions =
    line.supplierOptions.find((option, index) => `${option.supplier_name}-${index}` === line.selectedSupplierKey) ||
    line.supplierOptions[0] ||
    null;
  return String(selectedFromOptions?.supplier_name || line.supplier_name || "").trim().toLowerCase();
}

function lineHasVisiblePrices(line: QuoteBuilderLine) {
  return Number(line.buy_price ?? 0) > 0 || Number(line.sell_price ?? 0) > 0;
}

export function salesOrderResyncPriceSummary(before: QuoteBuilderLine[], after: QuoteBuilderLine[]) {
  const complete = (line: QuoteBuilderLine) =>
    Number.isFinite(Number(line.buy_price)) && Number(line.buy_price) > 0
    && Number.isFinite(Number(line.sell_price)) && Number(line.sell_price) > 0;
  const failed = after.filter((line) => line.price_sync_issue === "PRICE_LOOKUP_FAILED").length;
  const unpriced = after.filter((line) => !complete(line)).length;
  return {
    filled: after.filter((line, index) => complete(line) && before[index] && !complete(before[index])).length,
    unavailable: after.filter((line) => !complete(line) && line.price_sync_issue !== "PRICE_LOOKUP_FAILED").length,
    failed,
    unpriced,
  };
}

async function refreshSalesOrderPriceLines(
  lines: QuoteBuilderLine[], options: SalesOrderCatalogSyncOptions, onlyFillBlanks: boolean,
): Promise<QuoteBuilderLine[]> {
  const result = [...lines];
  const pending = lines.map((_, index) => index).filter((index) =>
    options.keepPrices === false || !lineHasVisiblePrices(lines[index]));
  // One lookup per exact brand/SKU for this action. Duplicate order rows keep
  // their own quantities and supplier selections, but share the read result.
  const lookups = new Map<string, ReturnType<typeof resolveQuoteLine>>();
  const lookup: typeof resolveQuoteLine = (input) => {
    const key = JSON.stringify([normalizeBrandKey(input.brand || ""), exactProductCode(input.code)]);
    let request = lookups.get(key);
    if (!request) {
      request = resolveQuoteLine(input);
      lookups.set(key, request);
    }
    return request;
  };
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(4, pending.length) }, async () => {
    while (cursor < pending.length) {
      const index = pending[cursor++];
      result[index] = await refreshLinePricesFromCatalog(lines[index], options, onlyFillBlanks, lookup);
    }
  }));
  return result;
}

async function fetchSupplierPriceMap(rows: CurrentSupplierPriceRequest[]): Promise<Map<string, SelectedSupplierPrice>> {
  return fetchCurrentSupplierPriceMap(rows, (batch) =>
    callAppRpc<CurrentSupplierPriceBatchRow[]>("cloud_current_supplier_price_options_batch", {
      input_requests: batch,
    }));
}

function requireRepricingCurrency(currency: string | undefined) {
  if (String(currency || "").trim().toUpperCase() !== "EUR") {
    throw new Error("Current supplier prices are in EUR. Set the document currency to EUR before refreshing prices.");
  }
}

function getInvoiceMarkupPercent(options: InvoiceCatalogSyncOptions): number {
  if (options.customerType === "C") {
    throw new Error("The retired C price list cannot be refreshed. Set A, B, or Other on the customer account.");
  }
  const override = options.accountMarginPercent;
  if (override != null) {
    if (!Number.isFinite(override)) throw new Error("Customer account margin must be a valid number.");
    return override;
  }
  if (options.customerType === "Other") {
    throw new Error("Other pricing requires a margin on the customer account.");
  }
  const margin = options.customerType === "B" ? options.marginB : options.marginA;
  if (!Number.isFinite(margin)) throw new Error("Customer price-list margin must be a valid number.");
  return margin;
}

export async function resyncSalesOrderLinesFromCatalog(
  lines: QuoteBuilderLine[],
  options: SalesOrderCatalogSyncOptions,
): Promise<QuoteBuilderLine[]> {
  const onlyFillBlanks = options.onlyFillBlanks !== false;
  const keepPrices = options.keepPrices !== false;
  if (!keepPrices) requireRepricingCurrency(options.currency);

  // Code References are applied when a new quote line is resolved. A saved
  // order can outlive that lookup, so resync must explicitly re-read the
  // approved old-code -> new-code mapping before loading catalog metadata.
  const referenceMatches = await fetchCodeReferenceMatchesForRows(
    lines.map((line) => ({
      brand: canonicalizePriceBrandName(line.brand || "",line.resolvedCode || line.requestedCode),
      code: line.requestedCode || line.resolvedCode,
    })),
  );

  const mappedLines = lines.map((savedLine) => {
    const line = {
      ...savedLine,
      brand: canonicalizePriceBrandName(savedLine.brand,savedLine.resolvedCode || savedLine.requestedCode),
      resolvedCode: canonicalizePriceProductCode(savedLine.resolvedCode || savedLine.requestedCode, savedLine.brand),
    };
    const requestedCode = line.requestedCode || line.resolvedCode;
    const referenceMatch = referenceMatches.get(
      `${normalizeBrandKey(line.brand || "")}::${normalizePartCode(requestedCode)}`,
    );
    if (!referenceMatch || canonicalizePriceProductCode(referenceMatch.old_code, line.brand)
        !== canonicalizePriceProductCode(requestedCode, line.brand)) return line;
    const changesSku=canonicalizePriceProductCode(referenceMatch.new_code,line.brand)!==exactProductCode(line.resolvedCode||line.requestedCode);
    return {
      ...line,
      ...(changesSku?{description:'',oem_no:'',hs_code:'',origin:'',weight_kg:null,found:false,
        buy_price:null,sell_price:null,c_sell_price:null,manual_sell_price:false,price_date:'',
        supplierOptions:[],selectedSupplierKey:'',moq:null,order_multiple:null,stock_qty:null,valid_to:null,
        lifecycle_status:null,lifecycle_note:null,lifecycle_warning:null,price_sync_issue:null}:{}),
      resolvedCode: canonicalizePriceProductCode(referenceMatch.new_code || line.resolvedCode || line.requestedCode, line.brand),
      codeChanged: true,
      codeChangeWarning:
        `Old Code ${referenceMatch.old_code} => New Code ${referenceMatch.new_code}.` +
        (referenceMatch.reason ? ` ${referenceMatch.reason}` : ""),
    };
  });

  const metadataMap = await fetchCatalogMetadataForRows(
    mappedLines.map((line) => ({
      brand: canonicalizeBrandName(line.brand || ""),
      product_code: line.resolvedCode || line.requestedCode,
    })),
  );

  const patchedLines = mappedLines.map((line) => {
    const rawCode = line.resolvedCode || line.requestedCode;
    const candidateMetadata = metadataMap.get(`${normalizeBrandKey(line.brand || "")}::${normalizePartCode(rawCode)}`);
    const metadata = candidateMetadata && canonicalizePriceProductCode(candidateMetadata.product_code, line.brand) === exactProductCode(rawCode)
      ? { ...candidateMetadata, product_code: canonicalizePriceProductCode(candidateMetadata.product_code, line.brand) } : undefined;
    return mergeCatalogMetadata(
      {
        ...line,
        brand: canonicalizeBrandName(line.brand || "") || line.brand,
      },
      metadata,
      onlyFillBlanks,
    );
  });

  const refreshesCurrentPrice = !keepPrices
    || (options.hydrateMissingPricesIfKeepingPrices && patchedLines.some((line) => !lineHasVisiblePrices(line)));
  if (refreshesCurrentPrice && options.customerType === "C") {
    throw new Error("The retired C price list cannot be refreshed. Set A, B, or Other on the customer account.");
  }
  if (refreshesCurrentPrice) requireRepricingCurrency(options.currency);

  if (keepPrices) {
    if (!options.hydrateMissingPricesIfKeepingPrices) {
      return patchedLines;
    }

    return refreshSalesOrderPriceLines(patchedLines, options, onlyFillBlanks);
  }

  return refreshSalesOrderPriceLines(patchedLines, options, onlyFillBlanks);
}

async function refreshLinePricesFromCatalog(
  line: QuoteBuilderLine,
  options: SalesOrderCatalogSyncOptions,
  onlyFillBlanks: boolean,
  lookup: typeof resolveQuoteLine = resolveQuoteLine,
) {
  const reprice = options.keepPrices === false;
  const itemName = `${canonicalizeBrandName(line.brand || "") || line.brand} ${line.resolvedCode || line.requestedCode}`.trim();
  try {
    const { resolved, supplierOptions } = await lookup({
      code: line.resolvedCode || line.requestedCode,
      brand: canonicalizeBrandName(line.brand || ""),
      customerType: options.customerType,
      marginA: options.marginA,
      marginB: options.marginB,
      includeSupplierOptions: true,
    });

    const selectedFromSavedOptions = line.supplierOptions.find((option, index) =>
      `${option.supplier_name}-${index}` === line.selectedSupplierKey) || null;
    const savedSupplierName = String(line.supplier_name || "").trim().toLowerCase();
    const selectedSupplierName = reprice
      ? savedSupplierName || String(selectedFromSavedOptions?.supplier_name || "").trim().toLowerCase()
      : getSelectedSupplierName(line);
    const selectedSupplierId = reprice ? String(selectedFromSavedOptions?.supplier_id || "").trim() : "";
    if (reprice && selectedFromSavedOptions && savedSupplierName
        && String(selectedFromSavedOptions.supplier_name || "").trim().toLowerCase() !== savedSupplierName) {
      throw new Error("The saved supplier selection is inconsistent.");
    }
    const matchingOptions = supplierOptions.filter((option) => selectedSupplierId
      ? String(option.supplier_id || "").trim() === selectedSupplierId
      : String(option.supplier_name || "").trim().toLowerCase() === selectedSupplierName);
    const selectUnpricedSupplier=!selectedSupplierName&&!lineHasVisiblePrices(line);
    const selected = reprice
      ? selectUnpricedSupplier ? supplierOptions[0]||null : matchingOptions.length === 1 ? matchingOptions[0] : null
      : matchingOptions[0] || supplierOptions[0] || null;
    if ((!resolved.found
        || exactProductCode(resolved.product_code) !== exactProductCode(line.resolvedCode || line.requestedCode)
        || (!selectUnpricedSupplier&&!selectedSupplierName) || !selected
        || !Number.isFinite(Number(selected.buy_price)) || Number(selected.buy_price) <= 0
        || !Number.isFinite(Number(selected.sell_price)) || Number(selected.sell_price) <= 0)) {
      if(!reprice)throw Error('NO_CURRENT_PRICE');
      throw new Error("No exact current price exists for the saved supplier and SKU.");
    }
    const quantityAdjustment = normalizeOrderQuantity(line.qty, selected || {});

    const nextSellPrice = reprice ? selected!.sell_price : selected?.sell_price ?? resolved.sell_price ?? line.sell_price;

    const refreshed = mergeCatalogMetadata(
      {
        ...line,
        resolvedCode: onlyFillBlanks ? line.resolvedCode || resolved.product_code : resolved.product_code || line.resolvedCode,
        description: fillText(line.description, resolved.description || "", onlyFillBlanks),
        oem_no: fillText(line.oem_no, resolved.oem_no || "", onlyFillBlanks),
        hs_code: fillText(line.hs_code, resolved.hs_code || "", onlyFillBlanks),
        origin: fillText(line.origin, resolved.origin || "", onlyFillBlanks),
        weight_kg: fillNumber(line.weight_kg ?? null, resolved.weight_kg ?? null, onlyFillBlanks),
        found: line.found || resolved.found === true,
        lifecycle_status: resolved.lifecycle_status ?? line.lifecycle_status ?? "active",
        lifecycle_note: resolved.lifecycle_note ?? line.lifecycle_note ?? null,
        lifecycle_warning: resolved.lifecycle_warning ?? line.lifecycle_warning ?? null,
      },
      undefined,
      onlyFillBlanks,
    );

    return {
      ...refreshed,
      price_sync_issue:null,
      brand: canonicalizeBrandName(resolved.brand || refreshed.brand || line.brand || "") || refreshed.brand || line.brand,
      supplier_name: selected?.supplier_name || resolved.supplier_name || line.supplier_name,
      buy_price: reprice ? selected!.buy_price : selected?.buy_price ?? resolved.buy_price ?? line.buy_price,
      sell_price: nextSellPrice,
      qty: quantityAdjustment.corrected,
      requested_qty: quantityAdjustment.adjusted ? quantityAdjustment.requested : null,
      moq: selected ? selected.moq ?? null : line.moq ?? null,
      order_multiple: selected ? selected.order_multiple ?? null : line.order_multiple ?? null,
      quantity_adjusted: quantityAdjustment.adjusted,
      quantity_adjustment_note: quantityAdjustment.adjusted
        ? `Order amount ${quantityAdjustment.requested} pcs corrected to ${quantityAdjustment.corrected} pcs by supplier quantity rule.`
        : null,
      c_sell_price: reprice ? null : line.c_sell_price,
      price_date: reprice ? String(selected!.price_date || "") : selected?.price_date || resolved.price_date || line.price_date,
      supplierOptions: reprice ? supplierOptions : supplierOptions.length ? supplierOptions : line.supplierOptions,
      selectedSupplierKey: selected ? `${selected.supplier_name}-${supplierOptions.indexOf(selected)}` : line.selectedSupplierKey,
    } satisfies QuoteBuilderLine;
  } catch (error) {
    if (reprice) {
      const reason = error instanceof Error ? error.message : "Current price lookup failed.";
      throw new Error(`Current supplier price refresh failed for ${itemName}: ${reason}`);
    }
    return {...line,price_sync_issue:error instanceof Error&&error.message==='NO_CURRENT_PRICE'?'PRICE_NOT_AVAILABLE':'PRICE_LOOKUP_FAILED'} as QuoteBuilderLine;
  }
}

export async function resyncInvoiceLinesFromCatalog(
  lines: LocalInvoiceLine[],
  options: InvoiceCatalogSyncOptions,
): Promise<LocalInvoiceLine[]> {
  const onlyFillBlanks = options.onlyFillBlanks !== false;
  const keepPrices = options.keepPrices !== false;
  const markupPercent = keepPrices ? null : getInvoiceMarkupPercent(options);
  if (!keepPrices) requireRepricingCurrency(options.currency);
  const metadataMap = await fetchCatalogMetadataForRows(
    lines.map((line) => ({
      brand: canonicalizeBrandName(line.brand || ""),
      product_code: line.product_code || line.old_code,
    })),
  );

  const supplierPriceMap = keepPrices
    ? new Map<string, SelectedSupplierPrice>()
    : await fetchSupplierPriceMap(
        lines.map((line) => ({
          brand: canonicalizeBrandName(line.brand || "") || line.brand,
          productCode: line.product_code || line.old_code,
          supplierName: line.supplier_name || "",
        })),
      );

  return lines.map((line) => {
    const rawCode = line.product_code || line.old_code;
    const candidateMetadata = metadataMap.get(`${normalizeBrandKey(line.brand || "")}::${normalizePartCode(rawCode)}`);
    const metadata = candidateMetadata && exactProductCode(candidateMetadata.product_code) === exactProductCode(rawCode)
      ? candidateMetadata : undefined;
    const canonicalBrand = canonicalizeBrandName(line.brand || "") || line.brand;
    const supplierPrice = keepPrices
      ? null
      : supplierPriceMap.get(currentSupplierPriceKey({ brand: canonicalBrand, productCode: rawCode, supplierName: line.supplier_name || "" }));
    if (!keepPrices && !supplierPrice) throw new Error(`Current supplier price is missing for ${canonicalBrand} ${rawCode}.`);
    const nextBuyPrice = keepPrices ? line.buy_price : supplierPrice!.buy_price;
    const nextBuyPriceValue = Number(nextBuyPrice ?? 0) || 0;
    const nextSellPriceRaw = keepPrices
      ? line.sell_price
      : markupMoney(nextBuyPriceValue, markupPercent!);
    const nextSellPrice = Number(nextSellPriceRaw ?? 0) || 0;
    const qty = Math.max(1, Number(line.qty || 1) || 1);
    const purchaseTotal = roundMoney(nextBuyPriceValue * qty);
    const salesTotal = roundMoney(nextSellPrice * qty);
    const profitTotal = roundMoney(salesTotal - purchaseTotal);
    const marginPercent = salesTotal > 0 ? roundMoney((profitTotal / salesTotal) * 100) : 0;

    return {
      ...line,
      brand: canonicalBrand,
      product_code: onlyFillBlanks ? line.product_code || metadata?.product_code || line.old_code : metadata?.product_code || line.product_code || line.old_code,
      description: fillText(line.description, metadata?.description || "", onlyFillBlanks),
      oem_no: fillText(line.oem_no, metadata?.oem_no || "", onlyFillBlanks),
      hs_code: fillText(line.hs_code, metadata?.hs_code || "", onlyFillBlanks),
      origin: fillText(line.origin, metadata?.origin || "", onlyFillBlanks),
      weight_kg: fillNumber(line.weight_kg ?? null, metadata?.weight_kg ?? null, onlyFillBlanks),
      lifecycle_status: metadata?.lifecycle_status ?? line.lifecycle_status ?? "active",
      lifecycle_note: metadata?.lifecycle_note ?? line.lifecycle_note ?? null,
      lifecycle_warning:
        metadata?.lifecycle_status === "discontinued"
          ? `Production ended for ${metadata.product_code || line.product_code}.${metadata.lifecycle_note ? ` ${metadata.lifecycle_note}` : ""}`
          : line.lifecycle_warning ?? null,
      buy_price: nextBuyPriceValue,
      sell_price: nextSellPrice,
      purchase_total: purchaseTotal,
      sales_total: salesTotal,
      profit_total: profitTotal,
      margin_percent: marginPercent,
      notes: keepPrices ? line.notes : supplierPrice?.notes || line.notes,
    } satisfies LocalInvoiceLine;
  });
}

export async function resyncPurchaseOrderLinesFromCatalog(
  lines: LocalPurchaseOrderLine[],
  options: PurchaseOrderCatalogSyncOptions,
): Promise<LocalPurchaseOrderLine[]> {
  const onlyFillBlanks = options.onlyFillBlanks !== false;
  const keepPrices = options.keepPrices !== false;
  if (!keepPrices) requireRepricingCurrency(options.currency);
  const metadataMap = await fetchCatalogMetadataForRows(
    lines.map((line) => ({
      brand: canonicalizeBrandName(line.brand || ""),
      product_code: line.product_code || line.old_code,
    })),
  );

  const supplierPriceMap = keepPrices
    ? new Map<string, SelectedSupplierPrice>()
    : await fetchSupplierPriceMap(
        lines.map((line) => ({
          brand: canonicalizeBrandName(line.brand || "") || line.brand,
          productCode: line.product_code || line.old_code,
          supplierName: line.supplier_name || "",
        })),
      );

  return lines.map((line) => {
    const rawCode = line.product_code || line.old_code;
    const candidateMetadata = metadataMap.get(`${normalizeBrandKey(line.brand || "")}::${normalizePartCode(rawCode)}`);
    const metadata = candidateMetadata && exactProductCode(candidateMetadata.product_code) === exactProductCode(rawCode)
      ? candidateMetadata : undefined;
    const canonicalBrand = canonicalizeBrandName(line.brand || "") || line.brand;
    const supplierPrice = keepPrices
      ? null
      : supplierPriceMap.get(currentSupplierPriceKey({ brand: canonicalBrand, productCode: rawCode, supplierName: line.supplier_name || "" }));
    if (!keepPrices && !supplierPrice) throw new Error(`Current supplier price is missing for ${canonicalBrand} ${rawCode}.`);
    const nextBuyPrice = keepPrices ? line.buy_price : supplierPrice!.buy_price;
    const nextBuyPriceValue = Number(nextBuyPrice ?? 0) || 0;
    return {
      ...line,
      brand: canonicalBrand,
      product_code: onlyFillBlanks ? line.product_code || metadata?.product_code || line.old_code : metadata?.product_code || line.product_code || line.old_code,
      description: fillText(line.description, metadata?.description || "", onlyFillBlanks),
      oem_no: fillText(line.oem_no, metadata?.oem_no || "", onlyFillBlanks),
      hs_code: fillText(line.hs_code, metadata?.hs_code || "", onlyFillBlanks),
      weight_kg: fillNumber(line.weight_kg ?? null, metadata?.weight_kg ?? null, onlyFillBlanks),
      origin: fillText(line.origin, metadata?.origin || "", onlyFillBlanks),
      buy_price: nextBuyPriceValue,
      line_total: keepPrices ? line.line_total : roundMoney(nextBuyPriceValue * Math.max(1, Number(line.qty || 1) || 1)),
      notes: keepPrices ? line.notes : supplierPrice?.notes || line.notes,
    } satisfies LocalPurchaseOrderLine;
  });
}

export async function resyncBillLinesFromCatalog(
  lines: LocalBillLine[],
  options: Pick<PurchaseOrderCatalogSyncOptions, "onlyFillBlanks"> = {},
): Promise<LocalBillLine[]> {
  const onlyFillBlanks = options.onlyFillBlanks !== false;
  const metadataMap = await fetchCatalogMetadataForRows(
    lines.map((line) => ({
      brand: canonicalizeBrandName(line.brand || ""),
      product_code: line.product_code || line.old_code,
    })),
  );

  return lines.map((line) => {
    const rawCode = line.product_code || line.old_code;
    const candidateMetadata = metadataMap.get(`${normalizeBrandKey(line.brand || "")}::${normalizePartCode(rawCode)}`);
    const metadata = candidateMetadata && exactProductCode(candidateMetadata.product_code) === exactProductCode(rawCode)
      ? candidateMetadata : undefined;
    const canonicalBrand = canonicalizeBrandName(line.brand || "") || line.brand;
    return {
      ...line,
      brand: canonicalBrand,
      product_code: onlyFillBlanks ? line.product_code || metadata?.product_code || "" : metadata?.product_code || line.product_code,
      description: fillText(line.description, metadata?.description || "", onlyFillBlanks),
      oem_no: fillText(line.oem_no, metadata?.oem_no || "", onlyFillBlanks),
      hs_code: fillText(line.hs_code, metadata?.hs_code || "", onlyFillBlanks),
      weight_kg: fillNumber(line.weight_kg ?? null, metadata?.weight_kg ?? null, onlyFillBlanks),
      origin: fillText(line.origin, metadata?.origin || "", onlyFillBlanks),
    } satisfies LocalBillLine;
  });
}
