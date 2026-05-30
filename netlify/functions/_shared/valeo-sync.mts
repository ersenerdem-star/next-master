import { normalizeCatalogDescription, normalizeCatalogDisplayCode } from "./catalog-standardization.mts";

const VALEO_PRODUCT_LINES_URL = "https://www.valeoservice.us/en-us/techassist/products/product-lines";

const requestHeaders = {
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
  "cache-control": "no-cache",
  pragma: "no-cache",
};

const KNOWN_MANUFACTURER_PATTERNS = [
  { label: "Mercedes-Benz", pattern: /\bMERCEDES(?:-BENZ)?\b/ },
  { label: "Volkswagen", pattern: /\b(?:VW|VOLKSWAGEN)\b/ },
  { label: "Audi", pattern: /\bAUDI\b/ },
  { label: "MAN", pattern: /\bMAN\b/ },
  { label: "Volvo", pattern: /\bVOLVO\b/ },
  { label: "DAF", pattern: /\bDAF\b/ },
  { label: "Scania", pattern: /\bSCANIA\b/ },
  { label: "Iveco", pattern: /\bIVECO\b/ },
  { label: "Renault", pattern: /\bRENAULT\b/ },
  { label: "Ford", pattern: /\bFORD\b/ },
  { label: "BMW", pattern: /\bBMW\b/ },
  { label: "Opel", pattern: /\bOPEL\b/ },
  { label: "Nissan", pattern: /\bNISSAN\b/ },
  { label: "Toyota", pattern: /\bTOYOTA\b/ },
  { label: "Honda", pattern: /\bHONDA\b/ },
  { label: "Peugeot", pattern: /\bPEUGEOT\b/ },
  { label: "Citroen", pattern: /\bCITROE?N\b/ },
  { label: "Fiat", pattern: /\bFIAT\b/ },
  { label: "Seat", pattern: /\bSEAT\b/ },
  { label: "Kia", pattern: /\bKIA\b/ },
  { label: "Mazda", pattern: /\bMAZDA\b/ },
  { label: "Suzuki", pattern: /\bSUZUKI\b/ },
  { label: "Subaru", pattern: /\bSUBARU\b/ },
  { label: "Porsche", pattern: /\bPORSCHE\b/ },
  { label: "Alfa Romeo", pattern: /\bALFA ROMEO\b/ },
  { label: "Vauxhall", pattern: /\bVAUXHALL\b/ },
  { label: "Saab", pattern: /\bSAAB\b/ },
  { label: "Jeep", pattern: /\bJEEP\b/ },
  { label: "Pontiac", pattern: /\bPONTIAC\b/ },
  { label: "Saturn", pattern: /\bSATURN\b/ },
  { label: "Chevrolet", pattern: /\bCHEVROLET\b/ },
  { label: "GMC", pattern: /\bGMC\b/ },
  { label: "Buick", pattern: /\bBUICK\b/ },
  { label: "Cadillac", pattern: /\bCADILLAC\b/ },
  { label: "Dodge", pattern: /\bDODGE\b/ },
  { label: "Chrysler", pattern: /\bCHRYSLER\b/ },
  { label: "Ram", pattern: /\bRAM\b/ },
  { label: "Lincoln", pattern: /\bLINCOLN\b/ },
  { label: "Mercury", pattern: /\bMERCURY\b/ },
  { label: "Acura", pattern: /\bACURA\b/ },
  { label: "Infiniti", pattern: /\bINFINITI\b/ },
  { label: "Hyundai", pattern: /\bHYUNDAI\b/ },
  { label: "Mitsubishi", pattern: /\bMITSUBISHI\b/ },
  { label: "Mini", pattern: /\bMINI\b/ },
];

type SyncBrandTarget = {
  brandId: string;
  organizationId: string;
  name: string;
};

type CatalogRow = {
  organization_id: string;
  brand_id: string;
  product_code: string;
  normalized_code: string;
  description: string;
  oem_no: string;
  vehicle: string;
  hs_code: string;
  origin: string;
  weight_kg: number | null;
  image_url: string;
  lifecycle_status: "active" | "discontinued";
  lifecycle_note: string | null;
};

type ValeoProductLine = {
  id: number;
  name: string;
  articlesCount: number;
};

type ValeoPartGroup = {
  id: number;
  description: string;
  articlesCount: number;
  lineId: number;
  lineName: string;
};

type ValeoListingProduct = {
  product_code: string;
  normalized_code: string;
  description: string;
  additional_description: string;
  supplier_id: string;
  reference_code: string;
  oem_no: string;
  vehicle: string;
  weight_kg: number | null;
  image_url: string;
  lifecycle_status: "active" | "discontinued";
  lifecycle_note: string | null;
  replacement_code: string | null;
  replacement_reason: string | null;
};

export async function syncBrandCatalogFromValeoService(input: {
  supabaseUrl: string;
  serviceRoleKey: string;
  brandName: string;
  refreshExisting?: boolean;
  concurrency?: number;
  requestTimeoutMs?: number;
}) {
  const refreshExisting = input.refreshExisting !== false;
  const concurrency = Math.max(1, input.concurrency ?? 4);
  const requestTimeoutMs = Math.max(5000, input.requestTimeoutMs ?? 30000);
  const headers = {
    apikey: input.serviceRoleKey,
    Authorization: `Bearer ${input.serviceRoleKey}`,
    "Content-Type": "application/json",
  };

  const target = await resolveOrCreateTargetBrand(input.supabaseUrl, headers, input.brandName);
  const supportsImageColumn = await detectCatalogImageColumn(input.supabaseUrl, headers);
  const existingRows = await fetchCatalogRows(input.supabaseUrl, headers, target);
  const existingByCode = new Map(existingRows.map((row) => [row.normalized_code, row]));
  const crawl = await crawlValeoCatalog(requestTimeoutMs, concurrency);
  const listingByCode = new Map(crawl.items.map((row) => [row.normalized_code, row]));

  const catalogPayload: Array<Record<string, unknown>> = [];
  const replacementPayload: Array<Record<string, unknown>> = [];
  let matchedRows = 0;
  let changedRows = 0;
  let oemRows = 0;
  let vehicleRows = 0;
  let discontinuedRows = 0;
  let weightRows = 0;

  for (const item of crawl.items) {
    const current = existingByCode.get(item.normalized_code) || null;
    const merged = buildMergedCatalogRow(target, current, item);
    const changed = !current || hasCatalogDelta(current, merged);

    matchedRows += 1;
    if (changed) changedRows += 1;
    if (normalizeTextValue(merged.oem_no)) oemRows += 1;
    if (normalizeTextValue(merged.vehicle)) vehicleRows += 1;
    if (merged.weight_kg != null && !Number.isNaN(Number(merged.weight_kg))) weightRows += 1;
    if (normalizeLifecycleStatus(merged.lifecycle_status) === "discontinued") discontinuedRows += 1;

    if (!current || refreshExisting || changed) {
      catalogPayload.push(merged);
    }

    if (item.replacement_code) {
      replacementPayload.push({
        organization_id: target.organizationId,
        brand_id: target.brandId,
        old_code: normalizeCatalogDisplayCode(item.product_code, target.name),
        new_code: normalizeCatalogDisplayCode(item.replacement_code, target.name),
        original_number: null,
        reason: item.replacement_reason || "Replacement from Valeo Service official catalog.",
        is_active: true,
      });
    }
  }

  const batchSize = 200;
  const processedBatches = [];
  if (catalogPayload.length) {
    for (let index = 0; index < catalogPayload.length; index += batchSize) {
      const batch = catalogPayload.slice(index, index + batchSize);
      const response = await fetch(`${input.supabaseUrl}/rest/v1/catalog_products?on_conflict=organization_id,brand_id,normalized_code`, {
        method: "POST",
        headers: {
          ...headers,
          Prefer: "resolution=merge-duplicates,return=minimal",
        },
        body: JSON.stringify(
          batch.map((row) => ({
            organization_id: row.organization_id,
            brand_id: row.brand_id,
            product_code: row.product_code,
            description: emptyToNull(row.description),
            oem_no: emptyToNull(row.oem_no),
            vehicle: emptyToNull(row.vehicle),
            hs_code: emptyToNull(row.hs_code),
            origin: emptyToNull(row.origin),
            weight_kg: row.weight_kg == null || Number.isNaN(Number(row.weight_kg)) ? null : Number(row.weight_kg),
            ...(supportsImageColumn ? { image_url: emptyToNull(row.image_url) } : {}),
            lifecycle_status: emptyToNull(row.lifecycle_status) || "active",
            lifecycle_note: emptyToNull(row.lifecycle_note),
            updated_at: new Date().toISOString(),
          })),
        ),
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`catalog_products upsert failed: ${response.status} ${text}`);
      }
      processedBatches.push({ type: "catalog", batch: index / batchSize + 1, rows: batch.length, status: response.status });
    }
  }

  const replacementDeduped = dedupeBy(
    replacementPayload,
    (row) => `${String(row.brand_id)}::${normalizeCode(String(row.old_code || ""))}::${normalizeCode(String(row.new_code || ""))}`,
  );
  const processedReplacementBatches = [];
  if (replacementDeduped.length) {
    for (let index = 0; index < replacementDeduped.length; index += batchSize) {
      const batch = replacementDeduped.slice(index, index + batchSize);
      const response = await fetch(`${input.supabaseUrl}/rest/v1/item_code_references?on_conflict=organization_id,brand_id,normalized_old_code`, {
        method: "POST",
        headers: {
          ...headers,
          Prefer: "resolution=merge-duplicates,return=minimal",
        },
        body: JSON.stringify(
          batch.map((row) => ({
            organization_id: row.organization_id,
            brand_id: row.brand_id,
            old_code: row.old_code,
            new_code: row.new_code,
            original_number: row.original_number,
            reason: row.reason,
            is_active: row.is_active,
            updated_at: new Date().toISOString(),
          })),
        ),
      });
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`item_code_references upsert failed: ${response.status} ${text}`);
      }
      processedReplacementBatches.push({ type: "code_reference", batch: index / batchSize + 1, rows: batch.length, status: response.status });
    }
  }

  return {
    targetBrandId: target.brandId,
    targetBrandName: target.name,
    organizationId: target.organizationId,
    existingRows: existingRows.length,
    listingPagesProcessed: crawl.listingPagesProcessed,
    listingLastPage: 0,
    listingUniqueRows: crawl.items.length,
    newRowsInListing: crawl.items.filter((row) => !existingByCode.has(row.normalized_code)).length,
    incompleteExistingRows: existingRows.filter((row) => shouldProcessRow(row)).length,
    candidateRows: crawl.items.length,
    resolvedRows: matchedRows,
    errorRows: 0,
    discontinuedRows,
    replacementRows: replacementDeduped.length,
    replacementFetchRows: 0,
    supportsImageColumn,
    processedBatches,
    processedReplacementBatches,
    oemRows,
    vehicleRows,
    imageRows: 0,
    hsRows: 0,
    weightRows,
    listingProductLines: crawl.productLinesProcessed,
    listingPartGroups: crawl.partGroupsProcessed,
  };
}

async function resolveOrCreateTargetBrand(supabaseUrl: string, headers: Record<string, string>, brandName: string): Promise<SyncBrandTarget> {
  const existingBrands = await fetchAll<Record<string, unknown>>(supabaseUrl, headers, "/rest/v1/brands?select=id,name,organization_id&order=name.asc");
  const exact =
    existingBrands.find((row) => normalizeCode(String(row.name || "")) === normalizeCode(brandName)) ||
    existingBrands.find((row) => normalizeCode(String(row.name || "")).includes(normalizeCode(brandName))) ||
    null;

  if (exact?.id && exact?.organization_id) {
    return {
      brandId: String(exact.id),
      organizationId: String(exact.organization_id),
      name: String(exact.name || brandName).trim() || brandName,
    };
  }

  const seedOrgId = String(existingBrands[0]?.organization_id || "").trim();
  if (!seedOrgId) throw new Error("Could not resolve organization_id from brands table");

  const response = await fetch(`${supabaseUrl}/rest/v1/brands`, {
    method: "POST",
    headers: {
      ...headers,
      Prefer: "return=representation",
    },
    body: JSON.stringify({
      organization_id: seedOrgId,
      name: brandName.trim(),
    }),
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : [];
  if (!response.ok) throw new Error(`Brand create failed: ${response.status} ${JSON.stringify(data)}`);
  const created = Array.isArray(data) ? data[0] : data;
  if (!created?.id) throw new Error(`Brand create returned no id: ${JSON.stringify(data)}`);
  return {
    brandId: String(created.id),
    organizationId: seedOrgId,
    name: brandName.trim(),
  };
}

async function detectCatalogImageColumn(supabaseUrl: string, headers: Record<string, string>) {
  const response = await fetch(`${supabaseUrl}/rest/v1/catalog_products?select=image_url&limit=1`, { headers });
  if (response.ok) return true;
  const text = await response.text();
  return !/column .*image_url/i.test(text);
}

async function fetchCatalogRows(supabaseUrl: string, headers: Record<string, string>, target: SyncBrandTarget) {
  const results: CatalogRow[] = [];
  const pageLimit = 1000;
  let offset = 0;
  while (true) {
    const rows = await fetchAll<Record<string, unknown>>(
      supabaseUrl,
      headers,
      `/rest/v1/catalog_products?select=organization_id,brand_id,product_code,normalized_code,description,oem_no,vehicle,hs_code,origin,weight_kg,image_url,lifecycle_status,lifecycle_note&brand_id=eq.${encodeURIComponent(target.brandId)}&limit=${pageLimit}&offset=${offset}`,
    );
    if (!rows.length) break;
    results.push(
      ...rows
        .map((row) => ({
          organization_id: String(row.organization_id || target.organizationId),
          brand_id: String(row.brand_id || target.brandId),
          product_code: normalizeCatalogDisplayCode(String(row.product_code || "").trim(), target.name),
          normalized_code: normalizeCode(row.normalized_code || row.product_code || ""),
          description: String(row.description || "").trim(),
          oem_no: String(row.oem_no || "").trim(),
          vehicle: String(row.vehicle || "").trim(),
          hs_code: String(row.hs_code || "").trim(),
          origin: String(row.origin || "").trim(),
          weight_kg: row.weight_kg == null ? null : Number(row.weight_kg),
          image_url: String(row.image_url || "").trim(),
          lifecycle_status: normalizeLifecycleStatus(row.lifecycle_status),
          lifecycle_note: String(row.lifecycle_note || "").trim() || null,
        }))
        .filter((row) => row.product_code && row.normalized_code),
    );
    if (rows.length < pageLimit) break;
    offset += pageLimit;
  }
  return dedupeBy(results, (row) => row.normalized_code);
}

async function crawlValeoCatalog(requestTimeoutMs: number, concurrency: number) {
  const productLinesPage = await fetchPageProps(VALEO_PRODUCT_LINES_URL, requestTimeoutMs);
  const productLines = Array.isArray(productLinesPage.productLines) ? (productLinesPage.productLines as ValeoProductLine[]) : [];
  const partsMap = new Map<string, ValeoPartGroup>();
  let listingPagesProcessed = 1;
  let productLinesProcessed = 0;

  await runPool(productLines, Math.min(concurrency, 4), async (line) => {
    try {
      const firstPageProps = await fetchPageProps(`${VALEO_PRODUCT_LINES_URL}/product-line/${line.id}`, requestTimeoutMs);
      const pageCount = Number(firstPageProps.productLine?.pagination?.pageCount || 1);
      collectValeoPartGroups(partsMap, line, firstPageProps.productLine?.parts || []);
      productLinesProcessed += 1;
      listingPagesProcessed += 1;
      for (let page = 2; page <= pageCount; page += 1) {
        try {
          const pageProps = await fetchPageProps(`${VALEO_PRODUCT_LINES_URL}/product-line/${line.id}?page=${page}`, requestTimeoutMs);
          collectValeoPartGroups(partsMap, line, pageProps.productLine?.parts || []);
          listingPagesProcessed += 1;
        } catch {
          continue;
        }
      }
    } catch {
      return;
    }
  });

  const listingMap = new Map<string, ValeoListingProduct>();
  const replacementMap = new Map<string, { newCode: string; reason: string }>();
  let partGroupsProcessed = 0;

  await runPool([...partsMap.values()], concurrency, async (part) => {
    try {
      const groupProducts = await fetchValeoGroupProducts(part.id, requestTimeoutMs);
      partGroupsProcessed += 1;
      listingPagesProcessed += groupProducts.pagesFetched;
      const inferredReplacements = inferValeoReplacements(groupProducts.products);
      for (const [oldCode, payload] of inferredReplacements.entries()) replacementMap.set(oldCode, payload);
      for (const rawProduct of groupProducts.products) {
        const mapped = mapValeoListingProduct(rawProduct);
        if (!mapped.normalized_code) continue;
        const current = listingMap.get(mapped.normalized_code);
        listingMap.set(mapped.normalized_code, pickBetterListingProduct(current, mapped));
      }
    } catch {
      return;
    }
  });

  const items = [...listingMap.values()].map((item) => {
    const replacement = replacementMap.get(item.normalized_code);
    return replacement
      ? {
          ...item,
          replacement_code: replacement.newCode,
          replacement_reason: replacement.reason,
        }
      : item;
  });

  await runPool(items, concurrency, async (item) => {
    const detail = await fetchValeoProductDetail(item.supplier_id, item.reference_code, requestTimeoutMs);
    if (!detail) return;
    enrichValeoListingProduct(item, detail);
  });

  return {
    items,
    listingPagesProcessed,
    productLinesProcessed,
    partGroupsProcessed,
  };
}

function collectValeoPartGroups(target: Map<string, ValeoPartGroup>, line: ValeoProductLine, parts: any[]) {
  for (const rawPart of Array.isArray(parts) ? parts : []) {
    const id = Number(rawPart?.id || 0);
    const description = normalizeTextValue(rawPart?.description);
    if (!id || !description) continue;
    target.set(String(id), {
      id,
      description,
      articlesCount: Number(rawPart?.articlesCount || 0),
      lineId: line.id,
      lineName: line.name,
    });
  }
}

async function fetchValeoGroupProducts(partId: number, requestTimeoutMs: number) {
  const products: any[] = [];
  const firstPageProps = await fetchPageProps(`https://www.valeoservice.us/en-us/techassist/products/product-group/${partId}`, requestTimeoutMs);
  const firstGroup = firstPageProps.productGroupData || {};
  products.push(...(Array.isArray(firstGroup.articles) ? firstGroup.articles : []));
  return {
    products,
    pagesFetched: 1,
  };
}

function mapValeoListingProduct(product: any): ValeoListingProduct {
  const productCode = normalizeCatalogDisplayCode(String(product?.reference || product?.valeoPartNumber || ""), "Valeo");
  const normalizedCode = normalizeCode(productCode);
  const description = normalizeCatalogDescription(normalizeTextValue(product?.description || ""));
  const additionalDescription = normalizeTextValue(product?.additionalDescription || "");
  const oemNumbers = flattenValeoOemNumbers(product?.oemNumbers || {});
  const vehicle = extractValeoVehicles({
    additionalDescription,
    oemNumberKeys: Object.keys(product?.oemNumbers || {}),
  });
  const weightKg = extractValeoWeightKg(product?.packageInfo?.weight || []);
  const lifecycleStatus = normalizeValeoLifecycleStatus(product?.statusDescription || product?.statusCode);
  const lifecycleNote = normalizeTextValue(product?.statusDescription || "");
  return {
    product_code: productCode,
    normalized_code: normalizedCode,
    description,
    additional_description: additionalDescription,
    supplier_id: normalizeTextValue(product?.brandId || ""),
    reference_code: normalizeTextValue(product?.reference || product?.valeoPartNumber || ""),
    oem_no: oemNumbers,
    vehicle,
    weight_kg: weightKg,
    image_url: "",
    lifecycle_status: lifecycleStatus,
    lifecycle_note: lifecycleNote || null,
    replacement_code: null,
    replacement_reason: null,
  };
}

async function fetchValeoProductDetail(supplierId: string, reference: string, requestTimeoutMs: number) {
  const safeSupplierId = normalizeTextValue(supplierId);
  const safeReference = normalizeTextValue(reference);
  if (!safeSupplierId || !safeReference) return null;
  try {
    const pageProps = await fetchPageProps(
      `https://www.valeoservice.us/en-us/techassist/supplier/${encodeURIComponent(safeSupplierId)}/product/${encodeURIComponent(safeReference)}`,
      requestTimeoutMs,
    );
    return pageProps.product || null;
  } catch {
    return null;
  }
}

function enrichValeoListingProduct(target: ValeoListingProduct, detail: any) {
  const detailDescription = normalizeCatalogDescription(normalizeTextValue(detail?.description || ""));
  const detailAdditionalDescription = normalizeTextValue(detail?.additionalDescription || "");
  const detailOem = flattenValeoOemNumbers(detail?.oemNumbers || {});
  const detailVehicle = extractValeoVehiclesFromDetail(detail);
  const detailWeightKg = extractValeoWeightKg(detail?.packageInfo?.weight || []);
  const detailLifecycleStatus = normalizeValeoLifecycleStatus(detail?.statusDescription || detail?.statusCode);
  const detailLifecycleNote = normalizeTextValue(detail?.statusDescription || "");
  const detailImage = extractValeoImageUrl(detail?.images || []);

  if (detailDescription) target.description = detailDescription;
  if (detailAdditionalDescription) target.additional_description = detailAdditionalDescription;
  if (detailOem) target.oem_no = detailOem;
  if (detailVehicle) target.vehicle = detailVehicle;
  if (detailWeightKg != null) target.weight_kg = detailWeightKg;
  if (detailImage) target.image_url = detailImage;
  target.lifecycle_status = detailLifecycleStatus;
  target.lifecycle_note = detailLifecycleNote || target.lifecycle_note || null;
}

function inferValeoReplacements(products: any[]) {
  const replacements = new Map<string, { newCode: string; reason: string }>();
  const activeProducts = (Array.isArray(products) ? products : []).filter(
    (row) => normalizeValeoLifecycleStatus(row?.statusDescription || row?.statusCode) === "active",
  );
  for (const row of Array.isArray(products) ? products : []) {
    const oldCode = normalizeCode(row?.reference || row?.valeoPartNumber || "");
    if (!oldCode) continue;
    if (normalizeValeoLifecycleStatus(row?.statusDescription || row?.statusCode) !== "discontinued") continue;
    const rowValeoCodes = new Set(
      flattenBrandOemNumbers(row?.oemNumbers?.Valeo || [])
        .concat(flattenBrandOemNumbers(row?.oemNumbers?.VALEO || []))
        .concat([row?.reference || "", row?.valeoPartNumber || ""])
        .map((value) => normalizeCode(value))
        .filter(Boolean),
    );
    let bestCandidate: any = null;
    let bestScore = 0;
    for (const candidate of activeProducts) {
      const candidateCode = normalizeCode(candidate?.reference || candidate?.valeoPartNumber || "");
      if (!candidateCode || candidateCode === oldCode) continue;
      const candidateValeoCodes = new Set(
        flattenBrandOemNumbers(candidate?.oemNumbers?.Valeo || [])
          .concat(flattenBrandOemNumbers(candidate?.oemNumbers?.VALEO || []))
          .concat([candidate?.reference || "", candidate?.valeoPartNumber || ""])
          .map((value) => normalizeCode(value))
          .filter(Boolean),
      );
      let score = 0;
      if (candidateValeoCodes.has(oldCode)) score += 10;
      for (const code of rowValeoCodes) {
        if (code && candidateValeoCodes.has(code)) score += 3;
      }
      if (!score && (candidateCode.startsWith(oldCode) || oldCode.startsWith(candidateCode))) score += 1;
      if (score > bestScore) {
        bestScore = score;
        bestCandidate = candidate;
      }
    }
    const replacementCode = normalizeCatalogDisplayCode(String(bestCandidate?.reference || bestCandidate?.valeoPartNumber || ""), "Valeo");
    if (!replacementCode || normalizeCode(replacementCode) === oldCode) continue;
    replacements.set(oldCode, {
      newCode: replacementCode,
      reason: normalizeTextValue(row?.statusDescription || "") || "Superseded in Valeo official catalog.",
    });
  }
  return replacements;
}

function pickBetterListingProduct(current: ValeoListingProduct | undefined, next: ValeoListingProduct) {
  if (!current) return next;
  const currentScore = listingCompletenessScore(current);
  const nextScore = listingCompletenessScore(next);
  return nextScore > currentScore ? next : current;
}

function listingCompletenessScore(row: ValeoListingProduct) {
  let score = 0;
  if (normalizeTextValue(row.description)) score += 3;
  if (normalizeTextValue(row.oem_no)) score += 3;
  if (normalizeTextValue(row.vehicle)) score += 2;
  if (row.weight_kg != null && !Number.isNaN(Number(row.weight_kg))) score += 1;
  if (normalizeLifecycleStatus(row.lifecycle_status) === "discontinued") score += 1;
  return score;
}

function buildMergedCatalogRow(target: SyncBrandTarget, current: CatalogRow | null, listing: ValeoListingProduct) {
  const productCode = normalizeCatalogDisplayCode(listing.product_code, target.name);
  return {
    organization_id: target.organizationId,
    brand_id: target.brandId,
    product_code: productCode,
    normalized_code: normalizeCode(productCode),
    description: listing.description || current?.description || "",
    oem_no: listing.oem_no || current?.oem_no || "",
    vehicle: listing.vehicle || current?.vehicle || "",
    hs_code: current?.hs_code || "",
    origin: current?.origin || "",
    weight_kg: listing.weight_kg ?? current?.weight_kg ?? null,
    image_url: current?.image_url || "",
    lifecycle_status: listing.lifecycle_status || current?.lifecycle_status || "active",
    lifecycle_note: listing.lifecycle_note || current?.lifecycle_note || null,
  };
}

function hasCatalogDelta(current: CatalogRow, next: CatalogRow) {
  return (
    normalizeTextValue(current.product_code) !== normalizeTextValue(next.product_code) ||
    normalizeTextValue(current.description) !== normalizeTextValue(next.description) ||
    normalizeTextValue(current.oem_no) !== normalizeTextValue(next.oem_no) ||
    normalizeTextValue(current.vehicle) !== normalizeTextValue(next.vehicle) ||
    normalizeTextValue(current.hs_code) !== normalizeTextValue(next.hs_code) ||
    normalizeTextValue(current.origin) !== normalizeTextValue(next.origin) ||
    normalizeTextValue(current.image_url) !== normalizeTextValue(next.image_url) ||
    (current.weight_kg ?? null) !== (next.weight_kg ?? null) ||
    normalizeLifecycleStatus(current.lifecycle_status) !== normalizeLifecycleStatus(next.lifecycle_status) ||
    normalizeTextValue(current.lifecycle_note || "") !== normalizeTextValue(next.lifecycle_note || "")
  );
}

function shouldProcessRow(row: CatalogRow) {
  return (
    !normalizeTextValue(row.description) ||
    !normalizeTextValue(row.oem_no) ||
    !normalizeTextValue(row.vehicle) ||
    row.weight_kg == null ||
    (normalizeLifecycleStatus(row.lifecycle_status) === "discontinued" && !normalizeTextValue(row.lifecycle_note))
  );
}

async function fetchPageProps(url: string, requestTimeoutMs: number) {
  const html = await fetchText(url, requestTimeoutMs);
  const payload = parseNextData(html);
  return payload?.props?.pageProps || {};
}

function parseNextData(html: string) {
  const match = String(html || "").match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/i);
  if (!match?.[1]) throw new Error("Could not locate __NEXT_DATA__ payload");
  return JSON.parse(match[1]);
}

function flattenValeoOemNumbers(input: Record<string, any>) {
  const values: string[] = [];
  for (const list of Object.values(input || {})) {
    values.push(...flattenBrandOemNumbers(list));
  }
  return dedupeStrings(values.map((value) => normalizeTextValue(value)).filter(Boolean)).join(", ");
}

function flattenBrandOemNumbers(input: any[]) {
  return (Array.isArray(input) ? input : [])
    .map((entry) => normalizeTextValue(entry?.articleNumber || entry?.article_number || entry?.number || ""))
    .filter(Boolean);
}

function extractValeoVehicles(input: { additionalDescription: string; oemNumberKeys: string[] }) {
  const sourceText = [input.additionalDescription, ...(input.oemNumberKeys || [])]
    .map((value) => normalizeTextValue(value))
    .filter(Boolean)
    .join(" | ")
    .toUpperCase();
  const matches = KNOWN_MANUFACTURER_PATTERNS.filter((entry) => entry.pattern.test(sourceText)).map((entry) => entry.label);
  return dedupeStrings(matches).join(", ");
}

function extractValeoVehiclesFromDetail(detail: any) {
  const manufacturerLabels = (Array.isArray(detail?.linkedVehiclesManufacturers) ? detail.linkedVehiclesManufacturers : [])
    .map((entry) => normalizeTextValue(entry?.name || ""))
    .filter(Boolean);
  if (manufacturerLabels.length) return dedupeStrings(manufacturerLabels).join(", ");

  const vehicleManufacturers = (Array.isArray(detail?.linkedVehicles) ? detail.linkedVehicles : [])
    .map((entry) => normalizeTextValue(entry?.manufacturerName || ""))
    .filter(Boolean);
  if (vehicleManufacturers.length) return dedupeStrings(vehicleManufacturers).join(", ");

  return extractValeoVehicles({
    additionalDescription: normalizeTextValue(detail?.additionalDescription || ""),
    oemNumberKeys: Object.keys(detail?.oemNumbers || {}),
  });
}

function extractValeoImageUrl(images: any[]) {
  const first = (Array.isArray(images) ? images : []).find((entry) => {
    const value =
      normalizeTextValue(entry?.src || "") ||
      normalizeTextValue(entry?.url || "") ||
      normalizeTextValue(entry?.imageUrl || "") ||
      "";
    return /^https?:\/\//i.test(value) || /^data:image\//i.test(value);
  });
  if (!first) return "";
  return (
    normalizeTextValue(first?.src || "") ||
    normalizeTextValue(first?.url || "") ||
    normalizeTextValue(first?.imageUrl || "") ||
    ""
  );
}

function extractValeoWeightKg(weights: any[]) {
  const values = Array.isArray(weights) ? weights : [];
  const kgEntry =
    values.find((entry) => normalizeTextValue(entry?.uomCode).toUpperCase() === "KG") ||
    values.find((entry) => normalizeTextValue(entry?.uomName).toUpperCase().includes("KILOGRAM")) ||
    null;
  if (!kgEntry) return null;
  const value = Number(kgEntry.value);
  return Number.isFinite(value) ? value : null;
}

function normalizeValeoLifecycleStatus(value: unknown): "active" | "discontinued" {
  const text = normalizeTextValue(value).toLowerCase();
  if (!text) return "active";
  if (/(superceded|superseded|discontinued|obsolete|no longer|end of life|ended)/i.test(text)) return "discontinued";
  return "active";
}

function normalizeLifecycleStatus(value: unknown): "active" | "discontinued" {
  return String(value || "").trim().toLowerCase() === "discontinued" ? "discontinued" : "active";
}

function normalizeCode(value: unknown) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function normalizeTextValue(value: unknown) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function emptyToNull(value: unknown) {
  const text = String(value || "").trim();
  return text ? text : null;
}

function dedupeBy<T>(rows: T[], keyFn: (row: T) => string) {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = keyFn(row);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeStrings(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

async function fetchText(url: string, requestTimeoutMs: number) {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetch(url, {
      headers: requestHeaders,
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Request failed ${response.status} for ${url}`);
    return await response.text();
  } finally {
    clearTimeout(timeoutHandle);
  }
}

async function fetchAll<T>(supabaseUrl: string, headers: Record<string, string>, path: string) {
  const response = await fetch(`${supabaseUrl}${path}`, { headers });
  const text = await response.text();
  const rows = text ? JSON.parse(text) : [];
  if (!response.ok) throw new Error(`Fetch failed: ${response.status} ${text}`);
  return rows as T[];
}

async function runPool<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>) {
  const queue = [...items];
  const runners = Array.from({ length: Math.min(concurrency, queue.length || 1) }, async () => {
    while (queue.length) {
      const next = queue.shift();
      if (!next) break;
      await worker(next);
    }
  });
  await Promise.all(runners);
}
