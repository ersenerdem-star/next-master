import { buildDiscontinuedWarning, normalizeCatalogLifecycleStatus } from "../../domain/shared/lifecycle";
import { readSupplierCommercialTerms, type SupplierCommercialTerms } from "../../domain/shared/supplierCommercialTerms";
import { normalizeOrderQuantity } from "../../domain/shared/orderQuantityRules";
import { markupMoney } from "../../../../../shared/order-money.mjs";
import { canonicalizeBrandName, normalizeBrandKey, normalizePartCode } from "../../domain/shared/normalize";
import type { QuoteBuilderLine, QuoteSupplierOption } from "../../types/quoteBuilder";
import { fetchCodeReferenceMatchesForRows } from "./codeReferencesApi";
import { callAppRpc } from "./appRpcApi";
import { getCurrentOrgId } from "./organizationApi";
import { supabaseClient } from "./supabaseClient";

type QuoteImportRow = {
  code: string;
  brand: string;
  qty: number;
};

type CatalogMetadataRow = {
  product_code: string;
  description: string;
  oem_no: string;
  hs_code: string;
  origin: string;
  weight_kg: number | null;
  lifecycle_status?: "active" | "discontinued" | null;
  lifecycle_note?: string | null;
};

type CurrentSupplierPriceOption = SupplierCommercialTerms & {
  supplier_id: string | null;
  supplier_name: string;
  brand_id: string;
  brand: string;
  product_code: string;
  description: string | null;
  buy_price: number | string | null;
  price_date: string | null;
  notes: string | null;
};

type CurrentSupplierPriceBatchRow = {
  request_index: number;
  has_published_scope: boolean;
  options: CurrentSupplierPriceOption[];
};

function exactSku(value: string) {
  return String(value || "").trim().replace(/\s+/g, "").toUpperCase();
}

async function fetchCurrentSupplierPriceBatch(rows: Array<{ code: string; brand: string }>) {
  const resolved: CurrentSupplierPriceBatchRow[] = [];
  for (const batch of chunk(rows, 25)) {
    const result = await callAppRpc<CurrentSupplierPriceBatchRow[]>("cloud_current_supplier_price_options_batch", {
      input_requests: batch,
    });
    if (!Array.isArray(result) || result.length !== batch.length) {
      throw new Error("Published supplier price lookup returned incomplete data.");
    }
    const ordered = new Array<CurrentSupplierPriceBatchRow>(batch.length);
    for (const row of result) {
      const index = Number(row?.request_index);
      if (!Number.isInteger(index) || index < 0 || index >= batch.length || ordered[index]
          || typeof row?.has_published_scope !== "boolean" || !Array.isArray(row?.options)) {
        throw new Error("Published supplier price lookup returned invalid data.");
      }
      if (row.options.some((option) =>
        !String(option?.supplier_id || "").trim()
        || !String(option?.supplier_name || "").trim()
        || !String(option?.product_code || "").trim()
        || exactSku(option?.product_code || "") !== exactSku(batch[index].code)
        || !Number.isFinite(Number(option?.buy_price))
        || Number(option?.buy_price) <= 0)) {
        throw new Error("Published supplier price lookup returned an invalid price.");
      }
      ordered[index] = { ...row, options: row.options.map((option) => ({ ...option, ...readSupplierCommercialTerms(option) })) };
    }
    if (ordered.some((row) => !row)) throw new Error("Published supplier price lookup omitted a row.");
    resolved.push(...ordered);
  }
  return resolved;
}

function codeKey(brandId: string, normalizedCode: string) {
  return `${brandId}::${normalizedCode}`;
}

function buildReferenceKey(brand: string, code: string) {
  return `${normalizeBrandKey(brand)}::${normalizePartCode(code)}`;
}

function chunk<T>(items: T[], size: number) {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
}

async function resolveQuoteImportRowsOnce(input: {
  rows: QuoteImportRow[];
  customerType: "A" | "B" | "C" | "Other";
  marginA: number;
  marginB: number;
}): Promise<QuoteBuilderLine[]> {
  const rows = input.rows.filter((row) => row.code.trim() && row.brand.trim());
  if (!rows.length) return [];
  if (input.customerType === "C") throw new Error("Customer C price list is retired. Select A, B, or an account margin.");
  const organizationId = await getCurrentOrgId();

  const referenceMatches = await fetchCodeReferenceMatchesForRows(rows);
  const normalizedBrands = [...new Set(rows.map((row) => normalizeBrandKey(row.brand)).filter(Boolean))];
  const { data: brandRows, error: brandError } = await supabaseClient
    .from("brands")
    .select("id,name")
    .eq("organization_id", organizationId);
  if (brandError) throw new Error(brandError.message || "Brand lookup failed");

  const brandIdByName = new Map<string, string>();
  const canonicalBrandByName = new Map<string, string>();
  for (const row of (brandRows || []) as Array<{ id: string; name: string }>) {
    const normalizedName = normalizeBrandKey(String(row.name || ""));
    if (!normalizedBrands.includes(normalizedName)) continue;
    brandIdByName.set(normalizedName, String(row.id));
    canonicalBrandByName.set(normalizedName, String(row.name || "").trim());
  }

  const baseRows = rows.map((row) => {
    const normalizedBrandName = normalizeBrandKey(row.brand);
    const brandId = brandIdByName.get(normalizedBrandName) || "";
    const canonicalBrand = canonicalBrandByName.get(normalizedBrandName) || canonicalizeBrandName(row.brand);
    return {
      ...row,
      brand: canonicalBrand,
      brandId,
    };
  });

  const scopedRows = baseRows.filter((row) => row.brandId);
  const scopedPrices = await fetchCurrentSupplierPriceBatch(scopedRows.map((row) => ({ code: row.code, brand: row.brand })));
  const pricesByRawRow = new Map<(typeof baseRows)[number], CurrentSupplierPriceBatchRow>();
  scopedRows.forEach((row, index) => pricesByRawRow.set(row, scopedPrices[index]));

  const preparedRows = baseRows.map((row) => {
    const publishedPrice = pricesByRawRow.get(row) || null;
    const rawReferenceMatch = referenceMatches.get(buildReferenceKey(row.brand, row.code)) || null;
    // Reference lookup uses an alphanumeric key; verify the original SKU before
    // allowing a redirect, including for brands still using legacy prices.
    const referenceMatch = rawReferenceMatch
      && exactSku(rawReferenceMatch.old_code) !== exactSku(row.code)
      ? null
      : rawReferenceMatch;
    const targetCode = referenceMatch?.new_code || row.code;
    return {
      ...row,
      referenceMatch,
      targetCode,
      normalizedTargetCode: normalizePartCode(targetCode),
      publishedPrice,
    };
  });

  const redirectedPublishedRows = preparedRows.filter((row) =>
    row.brandId && exactSku(row.targetCode) !== exactSku(row.code));
  if (redirectedPublishedRows.length) {
    const redirectedPrices = await fetchCurrentSupplierPriceBatch(
      redirectedPublishedRows.map((row) => ({ code: row.targetCode, brand: row.brand })),
    );
    redirectedPublishedRows.forEach((row, index) => {
      if (row.publishedPrice?.has_published_scope && !redirectedPrices[index].has_published_scope) {
        throw new Error("Published supplier price scope changed during quote import.");
      }
      row.publishedPrice = redirectedPrices[index];
    });
  }

  const brandIds = [...new Set(preparedRows.map((row) => row.brandId).filter(Boolean))];
  const normalizedCodes = [...new Set(preparedRows.map((row) => row.normalizedTargetCode).filter(Boolean))];
  if (!brandIds.length || !normalizedCodes.length) {
    return preparedRows.map((row) => ({
      lineId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      requestedCode: row.code,
      resolvedCode: row.targetCode,
      brand: row.brand,
      description: "",
      qty: row.qty,
      oem_no: "",
      hs_code: "",
      origin: "",
      weight_kg: null,
      supplier_name: "",
      buy_price: null,
      sell_price: null,
      c_sell_price: null,
      price_date: "",
      notes: row.brandId ? "Product code is not usable for a supplier price lookup." : "Brand not found.",
      found: false,
      codeChanged: Boolean(row.referenceMatch),
      codeChangeWarning: row.referenceMatch
        ? `Old Code ${row.referenceMatch.old_code} => New Code ${row.referenceMatch.new_code}.${row.referenceMatch.reason ? ` ${row.referenceMatch.reason}` : ""}`
        : "",
      supplierOptions: [],
      selectedSupplierKey: "",
    }));
  }

  const catalogExact = new Map<string, Array<any>>();
  const catalogOem = new Map<string, any>();

  for (const codeChunk of chunk(normalizedCodes, 150)) {
    const [catalogExactResult, catalogOemResult] = await Promise.all([
      supabaseClient
        .from("catalog_products")
        .select("id,product_code,normalized_code,normalized_oem,description,oem_no,hs_code,origin,weight_kg,brand_id,lifecycle_status,lifecycle_note")
        .eq("organization_id", organizationId)
        .in("brand_id", brandIds)
        .in("normalized_code", codeChunk),
      supabaseClient
        .from("catalog_products")
        .select("id,product_code,normalized_code,normalized_oem,description,oem_no,hs_code,origin,weight_kg,brand_id,lifecycle_status,lifecycle_note")
        .eq("organization_id", organizationId)
        .in("brand_id", brandIds)
        .in("normalized_oem", codeChunk),
    ]);

    if (catalogExactResult.error) throw new Error(catalogExactResult.error.message || "Catalog exact lookup failed");
    if (catalogOemResult.error) throw new Error(catalogOemResult.error.message || "Catalog OEM lookup failed");

    for (const row of (catalogExactResult.data || []) as Array<any>) {
      const key = codeKey(String(row.brand_id), String(row.normalized_code || normalizePartCode(String(row.product_code || ""))));
      const bucket = catalogExact.get(key) || [];
      bucket.push(row);
      catalogExact.set(key, bucket);
    }
    for (const row of (catalogOemResult.data || []) as Array<any>) {
      catalogOem.set(codeKey(String(row.brand_id), String(row.normalized_oem || normalizePartCode(String(row.oem_no || "")))), row);
    }
  }

  const resolvedCatalogRows = preparedRows.map((row) => {
    const key = codeKey(row.brandId, row.normalizedTargetCode);
    const candidates = catalogExact.get(key) || [];
    const oemMatch = catalogOem.get(key);
    const catalogMatch = candidates.filter((candidate) => exactSku(candidate.product_code) === exactSku(row.targetCode)).at(-1)
      || (oemMatch && exactSku(oemMatch.product_code) === exactSku(row.targetCode) ? oemMatch : null)
      || null;
    return {
      row,
      key,
      catalogMatch,
    };
  });

  return resolvedCatalogRows.map(({ row, key, catalogMatch }) => {
    // Canonical RPC owns pointer fencing, expiry and atomic supplier terms for both sources.
    const supplierMatchesRaw = (row.publishedPrice?.options || [])
      .filter((option) => exactSku(option.product_code) === exactSku(row.targetCode));
    const uniqueSupplierMatches = new Map<string, any>();
    supplierMatchesRaw.forEach((item) => {
      const supplierId = String(item.supplier_id || "");
      const supplierName = String(item.supplier_name || "");
      const key = `${supplierId}::${supplierName}`;
      const current = uniqueSupplierMatches.get(key);
      if (!current || Number(item.buy_price ?? Number.MAX_SAFE_INTEGER) < Number(current.buy_price ?? Number.MAX_SAFE_INTEGER)) {
        uniqueSupplierMatches.set(key, item);
      }
    });

    const supplierMatches = [...uniqueSupplierMatches.values()]
      .map((item) => ({
        ...readSupplierCommercialTerms(item),
        supplier_id: item.supplier_id || null,
        supplier_name: (item.supplier_name || "") as string,
        buy_price: item.buy_price == null ? null : Number(item.buy_price),
        price_date: item.price_date || item.valid_from || null,
        sell_price:
          input.customerType === "B"
            ? markupMoney(item.buy_price ?? 0, input.marginB)
            : markupMoney(item.buy_price ?? 0, input.marginA),
        notes: item.notes || null,
      }))
      .filter((item) => item.supplier_name)
      .sort((a, b) => Number(a.buy_price ?? Number.MAX_SAFE_INTEGER) - Number(b.buy_price ?? Number.MAX_SAFE_INTEGER));

    const selected = supplierMatches[0] || null;
    const sellPrice = selected?.sell_price ?? null;
    const quantityAdjustment = normalizeOrderQuantity(row.qty, selected || {});
    const lifecycleStatus = normalizeCatalogLifecycleStatus(String(catalogMatch?.lifecycle_status || ""));
    const lifecycleNote = String(catalogMatch?.lifecycle_note || "").trim() || null;

    return {
      lineId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      requestedCode: row.code,
      resolvedCode: String(row.publishedPrice?.has_published_scope
        ? supplierMatchesRaw[0]?.product_code || row.targetCode || row.code
        : catalogMatch?.product_code || row.targetCode || row.code),
      brand: row.brand,
      description: String(catalogMatch?.description || supplierMatchesRaw[0]?.description || ""),
      qty: quantityAdjustment.corrected,
      requested_qty: quantityAdjustment.adjusted ? quantityAdjustment.requested : null,
      moq: selected?.moq ?? null,
      order_multiple: selected?.order_multiple ?? null,
      quantity_adjusted: quantityAdjustment.adjusted,
      quantity_adjustment_note: quantityAdjustment.adjusted
        ? `Requested ${quantityAdjustment.requested} pcs; prepared ${quantityAdjustment.corrected} pcs (minimum ${quantityAdjustment.moq}, order multiple ${quantityAdjustment.orderMultiple}). Review this quantity before saving.`
        : null,
      oem_no: String(catalogMatch?.oem_no || ""),
      hs_code: String(catalogMatch?.hs_code || ""),
      origin: String(catalogMatch?.origin || ""),
      weight_kg: (catalogMatch?.weight_kg as number | null) ?? null,
      supplier_name: selected?.supplier_name || "",
      buy_price: selected?.buy_price ?? null,
      sell_price: sellPrice,
      c_sell_price: null,
      price_date: String(selected?.price_date || ""),
      notes: String(selected?.notes || ""),
      found: row.publishedPrice?.has_published_scope
        ? supplierMatches.length > 0
        : Boolean(catalogMatch || supplierMatches.length),
      codeChanged: Boolean(row.referenceMatch),
      codeChangeWarning: row.referenceMatch
        ? `Old Code ${row.referenceMatch.old_code} => New Code ${row.referenceMatch.new_code}.${row.referenceMatch.reason ? ` ${row.referenceMatch.reason}` : ""}`
        : "",
      lifecycle_status: lifecycleStatus,
      lifecycle_note: lifecycleNote,
      lifecycle_warning:
        lifecycleStatus === "discontinued"
          ? buildDiscontinuedWarning({
              resolvedCode: String(catalogMatch?.product_code || row.targetCode || row.code),
              note: lifecycleNote,
            })
          : null,
      supplierOptions: supplierMatches as QuoteSupplierOption[],
      selectedSupplierKey: selected ? `${selected.supplier_name}-0` : "",
    } satisfies QuoteBuilderLine;
  });
}

function isTransientImportError(error: unknown) {
  const message = String(error instanceof Error ? error.message : error || "").toLowerCase();
  return ["timeout", "timed out", "statement timeout", "canceling statement", "upstream request", "fetch failed", "connection", "504", "503", "502"].some((token) => message.includes(token));
}

function delayedQuoteImportLine(row: QuoteImportRow, reason: string): QuoteBuilderLine {
  return {
    lineId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    requestedCode: row.code,
    resolvedCode: row.code,
    brand: canonicalizeBrandName(row.brand),
    description: "",
    qty: row.qty,
    oem_no: "",
    hs_code: "",
    origin: "",
    weight_kg: null,
    supplier_name: "",
    buy_price: null,
    sell_price: null,
    c_sell_price: null,
    price_date: "",
    notes: `${reason} Retry this line from the quote workspace.`,
    found: false,
    codeChanged: false,
    codeChangeWarning: "",
    lifecycle_status: null,
    lifecycle_note: null,
    lifecycle_warning: null,
    supplierOptions: [],
    selectedSupplierKey: "",
  } satisfies QuoteBuilderLine;
}

/**
 * Timeout-safe sales-order import rule. Reads are retried briefly and then
 * split into smaller independent batches. A single slow row becomes an
 * explicit unresolved line rather than aborting the whole order import.
 */
export async function batchResolveQuoteImportRows(input: {
  rows: QuoteImportRow[];
  customerType: "A" | "B" | "C" | "Other";
  marginA: number;
  marginB: number;
}): Promise<QuoteBuilderLine[]> {
  const rows = input.rows.filter((row) => row.code.trim() && row.brand.trim());
  if (!rows.length) return [];
  if (input.customerType === "C") throw new Error("Customer C price list is retired. Select A, B, or an account margin.");

  let lastError: unknown = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await resolveQuoteImportRowsOnce(input);
    } catch (error) {
      lastError = error;
      if (!isTransientImportError(error) || attempt === 2) break;
      await new Promise((resolve) => window.setTimeout(resolve, 400 * (attempt + 1)));
    }
  }

  if (isTransientImportError(lastError) && rows.length > 1) {
    const midpoint = Math.ceil(rows.length / 2);
    const left = await batchResolveQuoteImportRows({ ...input, rows: rows.slice(0, midpoint) });
    const right = await batchResolveQuoteImportRows({ ...input, rows: rows.slice(midpoint) });
    return [...left, ...right];
  }

  const reason = lastError instanceof Error ? lastError.message : "Resolution timed out.";
  return rows.map((row) => delayedQuoteImportLine(row, reason));
}

export async function fetchCatalogMetadataForRows(
  rows: Array<{ brand: string; product_code: string }>,
): Promise<Map<string, CatalogMetadataRow>> {
  const candidates = rows
    .map((row) => ({
      brand: canonicalizeBrandName(row.brand),
      normalizedCode: normalizePartCode(row.product_code),
    }))
    .filter((row) => row.brand && row.normalizedCode);

  if (!candidates.length) return new Map<string, CatalogMetadataRow>();

  const organizationId = await getCurrentOrgId();
  const requestedBrandKeys = new Set(candidates.map((row) => normalizeBrandKey(row.brand)));
  const { data: brandRows, error: brandError } = await supabaseClient
    .from("brands")
    .select("id,name")
    .eq("organization_id", organizationId);

  if (brandError) throw new Error(brandError.message || "Brand lookup failed");

  const brandIdToName = new Map<string, string>();
  const brandIdByName = new Map<string, string>();
  for (const row of (brandRows || []) as Array<{ id: string; name: string }>) {
    const id = String(row.id || "");
    const name = String(row.name || "").trim();
    if (!id || !name) continue;
    if (!requestedBrandKeys.has(normalizeBrandKey(name))) continue;
    brandIdToName.set(id, name);
    brandIdByName.set(normalizeBrandKey(name), id);
  }

  const prepared = candidates
    .map((row) => ({
      brandId: brandIdByName.get(normalizeBrandKey(row.brand)) || "",
      normalizedCode: row.normalizedCode,
    }))
    .filter((row) => row.brandId && row.normalizedCode);

  if (!prepared.length) return new Map<string, CatalogMetadataRow>();

  const brandIds = [...new Set(prepared.map((row) => row.brandId))];
  const normalizedCodes = [...new Set(prepared.map((row) => row.normalizedCode))];
  const result = new Map<string, CatalogMetadataRow>();

  for (const codeChunk of chunk(normalizedCodes, 200)) {
    const { data, error } = await supabaseClient
      .from("catalog_products")
      .select("brand_id,product_code,normalized_code,description,oem_no,hs_code,origin,weight_kg,lifecycle_status,lifecycle_note")
      .eq("organization_id", organizationId)
      .in("brand_id", brandIds)
      .in("normalized_code", codeChunk);

    if (error) throw new Error(error.message || "Catalog metadata lookup failed");

    for (const row of (data || []) as Array<any>) {
      const brandId = String(row.brand_id || "");
      const brandName = normalizeBrandKey(brandIdToName.get(brandId) || "");
      const normalizedCode = String(row.normalized_code || normalizePartCode(String(row.product_code || "")));
      if (!brandName || !normalizedCode) continue;
      result.set(`${brandName}::${normalizedCode}`, {
        product_code: String(row.product_code || ""),
        description: String(row.description || ""),
        oem_no: String(row.oem_no || ""),
        hs_code: String(row.hs_code || ""),
        origin: String(row.origin || ""),
        weight_kg: row.weight_kg == null ? null : Number(row.weight_kg),
        lifecycle_status: normalizeCatalogLifecycleStatus(String(row.lifecycle_status || "")),
        lifecycle_note: String(row.lifecycle_note || "").trim() || null,
      });
    }
  }

  return result;
}
