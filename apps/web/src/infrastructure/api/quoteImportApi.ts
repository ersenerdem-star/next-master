import { buildDiscontinuedWarning, normalizeCatalogLifecycleStatus } from "../../domain/shared/lifecycle";
import { normalizePartCode } from "../../domain/shared/normalize";
import type { CodeReferenceMatch } from "../../types/codeReferences";
import type { QuoteBuilderLine, QuoteSupplierOption } from "../../types/quoteBuilder";
import { fetchCPriceMapForRows, getCPriceForRow } from "./cPriceApi";
import { fetchCodeReferenceMatchesForRows } from "./codeReferencesApi";
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

function roundMoney(value: number) {
  return Math.round(value * 100) / 100;
}

function codeKey(brandId: string, normalizedCode: string) {
  return `${brandId}::${normalizedCode}`;
}

function buildReferenceKey(brand: string, code: string) {
  return `${brand.trim().toLowerCase()}::${normalizePartCode(code)}`;
}

function chunk<T>(items: T[], size: number) {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
}

async function getCurrentOrgId() {
  const { data, error } = await supabaseClient
    .from("profiles")
    .select("organization_id")
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(error.message || "Organization lookup failed");
  const organizationId = String(data?.organization_id || "");
  if (!organizationId) throw new Error("No organization found for current user");
  return organizationId;
}

export async function batchResolveQuoteImportRows(input: {
  rows: QuoteImportRow[];
  customerType: "A" | "B" | "C" | "Other";
  marginA: number;
  marginB: number;
}): Promise<QuoteBuilderLine[]> {
  const rows = input.rows.filter((row) => row.code.trim() && row.brand.trim());
  if (!rows.length) return [];
  const organizationId = await getCurrentOrgId();

  const referenceMatches = await fetchCodeReferenceMatchesForRows(rows);
  const normalizedBrands = [...new Set(rows.map((row) => row.brand.trim()))];
  const { data: brandRows, error: brandError } = await supabaseClient
    .from("brands")
    .select("id,name")
    .eq("organization_id", organizationId)
    .in("name", normalizedBrands);
  if (brandError) throw new Error(brandError.message || "Brand lookup failed");

  const brandIdByName = new Map<string, string>();
  for (const row of (brandRows || []) as Array<{ id: string; name: string }>) {
    brandIdByName.set(String(row.name || "").trim().toLowerCase(), String(row.id));
  }

  const preparedRows = rows.map((row) => {
    const referenceMatch = referenceMatches.get(buildReferenceKey(row.brand, row.code)) || null;
    const targetCode = referenceMatch?.new_code || row.code;
    const normalizedTargetCode = normalizePartCode(targetCode);
    const brandId = brandIdByName.get(row.brand.trim().toLowerCase()) || "";
    return {
      ...row,
      referenceMatch,
      targetCode,
      normalizedTargetCode,
      brandId,
    };
  });

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
      notes: "Brand not found.",
      found: false,
      codeChanged: Boolean(row.referenceMatch),
      codeChangeWarning: row.referenceMatch
        ? `Old Code ${row.referenceMatch.old_code} => New Code ${row.referenceMatch.new_code}.${row.referenceMatch.reason ? ` ${row.referenceMatch.reason}` : ""}`
        : "",
      supplierOptions: [],
      selectedSupplierKey: "",
    }));
  }

  const catalogExact = new Map<string, any>();
  const catalogOem = new Map<string, any>();
  const supplierExact = new Map<string, Array<any>>();
  const supplierOem = new Map<string, Array<any>>();

  for (const codeChunk of chunk(normalizedCodes, 150)) {
    const [catalogExactResult, catalogOemResult, supplierExactResult, supplierOemResult] = await Promise.all([
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
      supabaseClient
        .from("supplier_prices")
        .select("supplier_id,brand_id,product_code,normalized_code,normalized_oem,description,oem_no,buy_price,valid_from,notes,suppliers(name)")
        .eq("organization_id", organizationId)
        .eq("is_active", true)
        .not("buy_price", "is", null)
        .in("brand_id", brandIds)
        .in("normalized_code", codeChunk),
      supabaseClient
        .from("supplier_prices")
        .select("supplier_id,brand_id,product_code,normalized_code,normalized_oem,description,oem_no,buy_price,valid_from,notes,suppliers(name)")
        .eq("organization_id", organizationId)
        .eq("is_active", true)
        .not("buy_price", "is", null)
        .in("brand_id", brandIds)
        .in("normalized_oem", codeChunk),
    ]);

    if (catalogExactResult.error) throw new Error(catalogExactResult.error.message || "Catalog exact lookup failed");
    if (catalogOemResult.error) throw new Error(catalogOemResult.error.message || "Catalog OEM lookup failed");
    if (supplierExactResult.error) throw new Error(supplierExactResult.error.message || "Supplier exact lookup failed");
    if (supplierOemResult.error) throw new Error(supplierOemResult.error.message || "Supplier OEM lookup failed");

    for (const row of (catalogExactResult.data || []) as Array<any>) {
      catalogExact.set(codeKey(String(row.brand_id), String(row.normalized_code || normalizePartCode(String(row.product_code || "")))), row);
    }
    for (const row of (catalogOemResult.data || []) as Array<any>) {
      catalogOem.set(codeKey(String(row.brand_id), String(row.normalized_oem || normalizePartCode(String(row.oem_no || "")))), row);
    }
    for (const row of (supplierExactResult.data || []) as Array<any>) {
      const key = codeKey(String(row.brand_id), String(row.normalized_code || normalizePartCode(String(row.product_code || ""))));
      const bucket = supplierExact.get(key) || [];
      bucket.push(row);
      supplierExact.set(key, bucket);
    }
    for (const row of (supplierOemResult.data || []) as Array<any>) {
      const key = codeKey(String(row.brand_id), String(row.normalized_oem || normalizePartCode(String(row.oem_no || ""))));
      const bucket = supplierOem.get(key) || [];
      bucket.push(row);
      supplierOem.set(key, bucket);
    }
  }

  const resolvedCatalogRows = preparedRows.map((row) => {
    const key = codeKey(row.brandId, row.normalizedTargetCode);
    const catalogMatch = catalogExact.get(key) || catalogOem.get(key) || null;
    return {
      row,
      key,
      catalogMatch,
    };
  });

  const cPriceMap =
    input.customerType === "C"
      ? await fetchCPriceMapForRows(
          resolvedCatalogRows.map(({ row, catalogMatch }) => ({
            brand: row.brand,
            product_code: String(catalogMatch?.product_code || row.targetCode || row.code),
          })),
        )
      : null;

  return resolvedCatalogRows.map(({ row, key, catalogMatch }) => {
    const supplierMatchesRaw = [...(supplierExact.get(key) || []), ...(supplierOem.get(key) || [])];
    const uniqueSupplierMatches = new Map<string, any>();
    supplierMatchesRaw.forEach((item) => {
      const supplierId = String(item.supplier_id || "");
      const supplierName = String(item.suppliers?.name || "");
      const key = `${supplierId}::${supplierName}`;
      const current = uniqueSupplierMatches.get(key);
      if (!current || Number(item.buy_price ?? Number.MAX_SAFE_INTEGER) < Number(current.buy_price ?? Number.MAX_SAFE_INTEGER)) {
        uniqueSupplierMatches.set(key, item);
      }
    });

    const supplierMatches = [...uniqueSupplierMatches.values()]
      .map((item) => ({
        supplier_id: item.supplier_id || null,
        supplier_name: (item.suppliers?.name || "") as string,
        buy_price: item.buy_price ?? null,
        price_date: item.valid_from || null,
        sell_price:
          input.customerType === "B"
            ? roundMoney(Number(item.buy_price ?? 0) * (1 + input.marginB / 100))
            : roundMoney(Number(item.buy_price ?? 0) * (1 + input.marginA / 100)),
        notes: item.notes || null,
      }))
      .filter((item) => item.supplier_name)
      .sort((a, b) => Number(a.buy_price ?? Number.MAX_SAFE_INTEGER) - Number(b.buy_price ?? Number.MAX_SAFE_INTEGER));

    const selected = supplierMatches[0] || null;
    const sellPrice =
      input.customerType === "C"
        ? getCPriceForRow(cPriceMap || new Map<string, number>(), {
            brand: row.brand,
            product_code: String(catalogMatch?.product_code || row.targetCode || row.code),
          })
        : selected?.sell_price ?? null;
    const lifecycleStatus = normalizeCatalogLifecycleStatus(String(catalogMatch?.lifecycle_status || ""));
    const lifecycleNote = String(catalogMatch?.lifecycle_note || "").trim() || null;

    return {
      lineId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      requestedCode: row.code,
      resolvedCode: String(catalogMatch?.product_code || row.targetCode || row.code),
      brand: row.brand,
      description: String(catalogMatch?.description || supplierMatchesRaw[0]?.description || ""),
      qty: row.qty,
      oem_no: String(catalogMatch?.oem_no || supplierMatchesRaw[0]?.oem_no || ""),
      hs_code: String(catalogMatch?.hs_code || ""),
      origin: String(catalogMatch?.origin || ""),
      weight_kg: (catalogMatch?.weight_kg as number | null) ?? null,
      supplier_name: selected?.supplier_name || "",
      buy_price: selected?.buy_price ?? null,
      sell_price: sellPrice,
      c_sell_price: input.customerType === "C" ? sellPrice : null,
      price_date: String(selected?.price_date || ""),
      notes: String(selected?.notes || ""),
      found: Boolean(catalogMatch || supplierMatches.length),
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

export async function fetchCatalogMetadataForRows(
  rows: Array<{ brand: string; product_code: string }>,
): Promise<Map<string, CatalogMetadataRow>> {
  const candidates = rows
    .map((row) => ({
      brand: row.brand.trim(),
      normalizedCode: normalizePartCode(row.product_code),
    }))
    .filter((row) => row.brand && row.normalizedCode);

  if (!candidates.length) return new Map<string, CatalogMetadataRow>();

  const organizationId = await getCurrentOrgId();
  const brandNames = [...new Set(candidates.map((row) => row.brand))];
  const { data: brandRows, error: brandError } = await supabaseClient
    .from("brands")
    .select("id,name")
    .eq("organization_id", organizationId)
    .in("name", brandNames);

  if (brandError) throw new Error(brandError.message || "Brand lookup failed");

  const brandIdToName = new Map<string, string>();
  const brandIdByName = new Map<string, string>();
  for (const row of (brandRows || []) as Array<{ id: string; name: string }>) {
    const id = String(row.id || "");
    const name = String(row.name || "").trim();
    if (!id || !name) continue;
    brandIdToName.set(id, name);
    brandIdByName.set(name.toLowerCase(), id);
  }

  const prepared = candidates
    .map((row) => ({
      brandId: brandIdByName.get(row.brand.toLowerCase()) || "",
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
      const brandName = (brandIdToName.get(brandId) || "").trim().toLowerCase();
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
