import { fetchCPriceMapForRows, getCPriceForRow } from "../infrastructure/api/cPriceApi";
import { canonicalizeBrandName, normalizeBrandKey, normalizePartCode } from "../domain/shared/normalize";
import { fetchCatalogMetadataForRows } from "../infrastructure/api/quoteImportApi";
import { resolveQuoteLine } from "../infrastructure/api/quoteResolverApi";
import { supabaseClient } from "../infrastructure/api/supabaseClient";
import type { QuoteBuilderLine } from "../types/quoteBuilder";
import type { LocalInvoiceLine, LocalPurchaseOrderLine } from "../types/orders";

export type SalesOrderCatalogSyncOptions = {
  customerType: "A" | "B" | "C" | "Other";
  marginA: number;
  marginB: number;
  onlyFillBlanks?: boolean;
  keepPrices?: boolean;
  hydrateMissingPricesIfKeepingPrices?: boolean;
};

export type InvoiceCatalogSyncOptions = {
  customerType: "A" | "B" | "C" | "Other";
  marginA: number;
  marginB: number;
  onlyFillBlanks?: boolean;
  keepPrices?: boolean;
};

export type PurchaseOrderCatalogSyncOptions = {
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

function chunk<T>(items: T[], size: number) {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
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

type SupplierPriceMapRow = {
  brand: string;
  product_code: string;
  supplier_name: string;
};

function supplierPriceKey(brand: string, productCode: string, supplierName: string) {
  return `${normalizeBrandKey(brand)}::${normalizePartCode(productCode)}::${supplierName.trim().toLowerCase()}`;
}

let currentOrgIdPromise: Promise<string> | null = null;

async function getCurrentOrgId() {
  if (!currentOrgIdPromise) {
    currentOrgIdPromise = (async () => {
      const { data: authData, error: authError } = await supabaseClient.auth.getUser();
      if (authError) throw new Error(authError.message || "Failed to read current user");
      const userId = authData.user?.id;
      if (!userId) throw new Error("No authenticated user found");
      const { data, error } = await supabaseClient
        .from("profiles")
        .select("organization_id")
        .eq("id", userId)
        .maybeSingle();
      if (error) throw new Error(error.message || "Organization lookup failed");
      const organizationId = String(data?.organization_id || "");
      if (!organizationId) throw new Error("No organization found for current user");
      return organizationId;
    })();
  }
  return await currentOrgIdPromise;
}

async function fetchSupplierPriceMap(rows: SupplierPriceMapRow[]) {
  const organizationId = await getCurrentOrgId();
  const requestedBrandKeys = new Set(rows.map((row) => normalizeBrandKey(row.brand)).filter(Boolean));
  const normalizedCodes = [...new Set(rows.map((row) => normalizePartCode(row.product_code)).filter(Boolean))];
  const supplierNames = [...new Set(rows.map((row) => row.supplier_name.trim().toLowerCase()).filter(Boolean))];
  if (!requestedBrandKeys.size || !normalizedCodes.length || !supplierNames.length) return new Map<string, { buy_price: number | null; price_date: string | null; notes: string | null }>();

  const { data: brandRows, error: brandError } = await supabaseClient
    .from("brands")
    .select("id,name")
    .eq("organization_id", organizationId);

  if (brandError) throw new Error(brandError.message || "Brand lookup failed");

  const brandIdToName = new Map<string, string>();
  const brandIds = (brandRows || [])
    .filter((row) => requestedBrandKeys.has(normalizeBrandKey(String(row.name || ""))))
    .map((row) => {
      const id = String(row.id || "");
      const name = String(row.name || "").trim();
      brandIdToName.set(id, name);
      return id;
    });

  const result = new Map<string, { buy_price: number | null; price_date: string | null; notes: string | null }>();
  if (!brandIds.length) return result;

  for (const codeChunk of chunk(normalizedCodes, 200)) {
    const { data, error } = await supabaseClient
      .from("supplier_prices")
      .select("brand_id,product_code,normalized_code,buy_price,valid_from,notes,suppliers(name)")
      .eq("organization_id", organizationId)
      .eq("is_active", true)
      .in("brand_id", brandIds)
      .in("normalized_code", codeChunk);

    if (error) throw new Error(error.message || "Supplier price lookup failed");

    for (const row of (data || []) as Array<any>) {
      const supplierName = String(row.suppliers?.name || "").trim();
      const brandName = brandIdToName.get(String(row.brand_id || "")) || "";
      const productCode = String(row.product_code || "");
      if (!supplierName || !brandName || !productCode) continue;
      const key = supplierPriceKey(brandName, productCode, supplierName);
      const current = result.get(key);
      const nextBuyPrice = row.buy_price == null ? null : Number(row.buy_price);
      if (!current || Number(nextBuyPrice ?? Number.MAX_SAFE_INTEGER) < Number(current.buy_price ?? Number.MAX_SAFE_INTEGER)) {
        result.set(key, {
          buy_price: nextBuyPrice,
          price_date: String(row.valid_from || "").trim() || null,
          notes: String(row.notes || "").trim() || null,
        });
      }
    }
  }

  return result;
}

export async function resyncSalesOrderLinesFromCatalog(
  lines: QuoteBuilderLine[],
  options: SalesOrderCatalogSyncOptions,
): Promise<QuoteBuilderLine[]> {
  const onlyFillBlanks = options.onlyFillBlanks !== false;
  const keepPrices = options.keepPrices !== false;

  const metadataMap = await fetchCatalogMetadataForRows(
    lines.map((line) => ({
      brand: canonicalizeBrandName(line.brand || ""),
      product_code: line.resolvedCode || line.requestedCode,
    })),
  );

  const patchedLines = lines.map((line) => {
    const metadata = metadataMap.get(`${normalizeBrandKey(line.brand || "")}::${normalizePartCode(line.resolvedCode || line.requestedCode)}`);
    return mergeCatalogMetadata(
      {
        ...line,
        brand: canonicalizeBrandName(line.brand || "") || line.brand,
      },
      metadata,
      onlyFillBlanks,
    );
  });

  if (keepPrices) {
    if (!options.hydrateMissingPricesIfKeepingPrices) {
      return patchedLines;
    }

    return await Promise.all(
      patchedLines.map(async (line) => {
        if (lineHasVisiblePrices(line)) return line;
        return await refreshLinePricesFromCatalog(line, options, onlyFillBlanks);
      }),
    );
  }

  return await Promise.all(
    patchedLines.map(async (line) => {
      return await refreshLinePricesFromCatalog(line, options, onlyFillBlanks);
    }),
  );
}

async function refreshLinePricesFromCatalog(
  line: QuoteBuilderLine,
  options: SalesOrderCatalogSyncOptions,
  onlyFillBlanks: boolean,
) {
  try {
    const { resolved, supplierOptions } = await resolveQuoteLine({
      code: line.resolvedCode || line.requestedCode,
      brand: canonicalizeBrandName(line.brand || ""),
      customerType: options.customerType,
      marginA: options.marginA,
      marginB: options.marginB,
      includeSupplierOptions: true,
    });

    const cPriceMap =
      options.customerType === "C"
        ? await fetchCPriceMapForRows([
            {
              brand: canonicalizeBrandName(resolved.brand || line.brand || ""),
              product_code: resolved.product_code || line.resolvedCode || line.requestedCode,
            },
          ])
        : null;

    const selectedSupplierName = getSelectedSupplierName(line);
    const selected =
      supplierOptions.find((option) => String(option.supplier_name || "").trim().toLowerCase() === selectedSupplierName) ||
      supplierOptions[0] ||
      null;

    const nextSellPrice =
      options.customerType === "C"
        ? getCPriceForRow(cPriceMap || new Map<string, number>(), {
            brand: resolved.brand || line.brand || "",
            product_code: resolved.product_code || line.resolvedCode || line.requestedCode,
          })
        : selected?.sell_price ?? resolved.sell_price ?? line.sell_price;

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
      brand: canonicalizeBrandName(resolved.brand || refreshed.brand || line.brand || "") || refreshed.brand || line.brand,
      supplier_name: selected?.supplier_name || resolved.supplier_name || line.supplier_name,
      buy_price: selected?.buy_price ?? resolved.buy_price ?? line.buy_price,
      sell_price: nextSellPrice,
      c_sell_price: options.customerType === "C" ? nextSellPrice : line.c_sell_price,
      price_date: selected?.price_date || resolved.price_date || line.price_date,
      supplierOptions: supplierOptions.length ? supplierOptions : line.supplierOptions,
      selectedSupplierKey: selected ? `${selected.supplier_name}-${supplierOptions.indexOf(selected)}` : line.selectedSupplierKey,
    } satisfies QuoteBuilderLine;
  } catch {
    return line;
  }
}

export async function resyncInvoiceLinesFromCatalog(
  lines: LocalInvoiceLine[],
  options: InvoiceCatalogSyncOptions,
): Promise<LocalInvoiceLine[]> {
  const onlyFillBlanks = options.onlyFillBlanks !== false;
  const keepPrices = options.keepPrices !== false;
  const metadataMap = await fetchCatalogMetadataForRows(
    lines.map((line) => ({
      brand: canonicalizeBrandName(line.brand || ""),
      product_code: line.product_code || line.old_code,
    })),
  );

  const supplierPriceMap = keepPrices
    ? new Map<string, { buy_price: number | null; price_date: string | null; notes: string | null }>()
    : await fetchSupplierPriceMap(
        lines.map((line) => ({
          brand: line.brand || "",
          product_code: line.product_code || line.old_code,
          supplier_name: line.supplier_name || "",
        })),
      );

  const cPriceMap =
    !keepPrices && options.customerType === "C"
      ? await fetchCPriceMapForRows(lines.map((line) => ({ brand: canonicalizeBrandName(line.brand || ""), product_code: line.product_code || line.old_code })))
      : null;

  return lines.map((line) => {
    const metadata = metadataMap.get(`${normalizeBrandKey(line.brand || "")}::${normalizePartCode(line.product_code || line.old_code)}`);
    const canonicalBrand = canonicalizeBrandName(line.brand || "") || line.brand;
    const supplierPrice = keepPrices
      ? null
      : supplierPriceMap.get(supplierPriceKey(canonicalBrand, metadata?.product_code || line.product_code || line.old_code, line.supplier_name || ""));
    const nextBuyPrice = keepPrices ? line.buy_price : supplierPrice?.buy_price ?? line.buy_price;
    const nextBuyPriceValue = Number(nextBuyPrice ?? 0) || 0;
    const nextSellPriceRaw = keepPrices
      ? line.sell_price
      : options.customerType === "C"
        ? getCPriceForRow(cPriceMap || new Map<string, number>(), { brand: canonicalBrand, product_code: metadata?.product_code || line.product_code || line.old_code })
        : nextBuyPrice != null
          ? roundMoney(Number(nextBuyPrice) * (1 + ((options.customerType === "B" ? options.marginB : options.marginA) / 100)))
          : line.sell_price;
    const nextSellPrice = Number(nextSellPriceRaw ?? 0) || 0;
    const qty = Math.max(1, Number(line.qty || 1) || 1);
    const purchaseTotal = roundMoney(nextBuyPriceValue * qty);
    const salesTotal = roundMoney(nextSellPrice * qty);
    const profitTotal = roundMoney(salesTotal - purchaseTotal);
    const marginPercent = salesTotal > 0 ? roundMoney((profitTotal / salesTotal) * 100) : 0;

    return {
      ...line,
      brand: canonicalBrand,
      product_code: onlyFillBlanks ? line.product_code || metadata?.product_code || "" : metadata?.product_code || line.product_code,
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
  const metadataMap = await fetchCatalogMetadataForRows(
    lines.map((line) => ({
      brand: canonicalizeBrandName(line.brand || ""),
      product_code: line.product_code || line.old_code,
    })),
  );

  const supplierPriceMap = keepPrices
    ? new Map<string, { buy_price: number | null; price_date: string | null; notes: string | null }>()
    : await fetchSupplierPriceMap(
        lines.map((line) => ({
          brand: canonicalizeBrandName(line.brand || ""),
          product_code: line.product_code || line.old_code,
          supplier_name: line.supplier_name || "",
        })),
      );

  return lines.map((line) => {
    const metadata = metadataMap.get(`${normalizeBrandKey(line.brand || "")}::${normalizePartCode(line.product_code || line.old_code)}`);
    const canonicalBrand = canonicalizeBrandName(line.brand || "") || line.brand;
    const supplierPrice = keepPrices
      ? null
      : supplierPriceMap.get(supplierPriceKey(canonicalBrand, metadata?.product_code || line.product_code || line.old_code, line.supplier_name || ""));
    const nextBuyPrice = keepPrices ? line.buy_price : supplierPrice?.buy_price ?? line.buy_price;
    const nextBuyPriceValue = Number(nextBuyPrice ?? 0) || 0;
    return {
      ...line,
      brand: canonicalBrand,
      product_code: onlyFillBlanks ? line.product_code || metadata?.product_code || "" : metadata?.product_code || line.product_code,
      description: fillText(line.description, metadata?.description || "", onlyFillBlanks),
      oem_no: fillText(line.oem_no, metadata?.oem_no || "", onlyFillBlanks),
      origin: fillText(line.origin, metadata?.origin || "", onlyFillBlanks),
      buy_price: nextBuyPriceValue,
      notes: keepPrices ? line.notes : supplierPrice?.notes || line.notes,
    } satisfies LocalPurchaseOrderLine;
  });
}
