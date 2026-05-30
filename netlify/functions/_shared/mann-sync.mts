import { normalizeCatalogDisplayCode } from "./catalog-standardization.mts";

const MANN_GRAPHQL_ENDPOINT = "https://www.mann-filter.com/api/graphql/catalog-prod";

const requestHeaders = {
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0 Safari/537.36",
  accept: "application/json, text/plain, */*",
  "accept-language": "en-US,en;q=0.9",
  "cache-control": "no-cache",
  pragma: "no-cache",
  Store: "pcat_mf_gb_store_en",
  "content-type": "application/json",
};

const PRODUCT_BY_SKU_QUERY = `
  query ($sku: String!) {
    products(filter: { sku: { eq: $sku } }) {
      items {
        sku
        name
        urlKey: url_key
        thumbnail { url }
        smallImage: small_image { url }
        image { url }
        successorProduct: successor_product {
          salesDesignation: sales_designation
          urlKey: url_key
        }
        replacedProduct: replaced_product {
          salesDesignation: sales_designation
          urlKey: url_key
        }
        attributes: attributes_value {
          key
          value
          label
        }
        customTables: custom_tables {
          code
          unit
          values {
            key
            label
            value
            unit
          }
        }
      }
    }
  }
`;

const PRODUCT_BY_URL_KEY_QUERY = `
  query ($urlKey: String!) {
    products(filter: { url_key: { eq: $urlKey } }) {
      items {
        sku
        name
        urlKey: url_key
        thumbnail { url }
        smallImage: small_image { url }
        image { url }
        successorProduct: successor_product {
          salesDesignation: sales_designation
          urlKey: url_key
        }
        replacedProduct: replaced_product {
          salesDesignation: sales_designation
          urlKey: url_key
        }
        attributes: attributes_value {
          key
          value
          label
        }
        customTables: custom_tables {
          code
          unit
          values {
            key
            label
            value
            unit
          }
        }
      }
    }
  }
`;

const SMART_SEARCH_QUERY = `
  query ($search: String!, $currentPage: Int!, $pageSize: Int!) {
    catalogSearch: smart_search(search: $search, currentPage: $currentPage, pageSize: $pageSize) {
      crossReference: cross_reference {
        items {
          product {
            sku
            name
            urlKey: url_key
            attributes: attributes_value {
              key
              value
              label
            }
            customTables: custom_tables {
              code
              unit
              values {
                key
                label
                value
                unit
              }
            }
          }
          externalNumber: external_number
          manufacturer: ext_brand_name
          externalProductName: ext_product_name
        }
        totalCount: total_count
      }
      products {
        items {
          product {
            sku
            name
            urlKey: url_key
            attributes: attributes_value {
              key
              value
              label
            }
            references {
              referenceTypeName: reference_type_name
              referenceProducts: reference_products {
                salesDesignation: sales_designation
                urlKey: url_key
              }
            }
          }
        }
        totalCount: total_count
      }
    }
  }
`;

const DISCONTINUED_PRODUCTS_QUERY = `
  query ($pageSize: Int, $currentPage: Int, $filterBy: TYPE_OF_FILTER) {
    products(
      pageSize: $pageSize
      currentPage: $currentPage
      filter: {
        filterProductList: { productListType: DISCONTINUED }
        filterBy: { eq: $filterBy }
      }
    ) {
      totalCount: total_count
      pageInfo: page_info {
        currentPage: current_page
        totalPages: total_pages
      }
      items {
        sku
        urlKey: url_key
        successorProduct: successor_product {
          salesDesignation: sales_designation
          urlKey: url_key
        }
        attributes: attributes_value {
          key
          value
          label
        }
      }
    }
  }
`;

const NEW_PRODUCTS_QUERY = `
  query ($pageSize: Int, $currentPage: Int, $filterBy: TYPE_OF_FILTER) {
    products(
      pageSize: $pageSize
      currentPage: $currentPage
      filter: {
        filterProductList: { productListType: NEW }
        filterBy: { eq: $filterBy }
      }
    ) {
      totalCount: total_count
      pageInfo: page_info {
        currentPage: current_page
        totalPages: total_pages
      }
      items {
        sku
        urlKey: url_key
        replacedProduct: replaced_product {
          salesDesignation: sales_designation
          urlKey: url_key
        }
        attributes: attributes_value {
          key
          value
          label
        }
      }
    }
  }
`;

export async function syncBrandCatalogFromMann(input: {
  supabaseUrl: string;
  serviceRoleKey: string;
  brandName: string;
  refreshExisting?: boolean;
  concurrency?: number;
  requestTimeoutMs?: number;
}) {
  const refreshExisting = input.refreshExisting !== false;
  const concurrency = Math.max(1, input.concurrency ?? 5);
  const requestTimeoutMs = Math.max(5000, input.requestTimeoutMs ?? 30000);
  const headers = {
    apikey: input.serviceRoleKey,
    Authorization: `Bearer ${input.serviceRoleKey}`,
    "Content-Type": "application/json",
  };

  const target = await resolveMannTarget(input.supabaseUrl, headers);
  const supportsImageColumn = await detectCatalogImageColumn(input.supabaseUrl, headers);
  const catalogRows = await fetchMannCatalogRows(input.supabaseUrl, headers, target.brand_id);
  const discontinuedMap = await fetchOfficialListMap("discontinued", requestTimeoutMs);
  const newProductMap = await fetchOfficialListMap("new", requestTimeoutMs);
  const selectedCatalogRows = catalogRows.filter((row) =>
    shouldProcessRow({
      row,
      discontinuedMap,
      newProductMap,
      refreshExisting,
    }),
  );

  const catalogPayload: Array<Record<string, unknown>> = [];
  const replacementPayload: Array<Record<string, unknown>> = [];
  const replacementSeen = new Set<string>();
  let matchedRows = 0;
  let changedRows = 0;
  let oemRows = 0;
  let vehicleRows = 0;
  let imageRows = 0;
  let hsRows = 0;
  let weightRows = 0;
  let discontinuedRows = 0;
  const errorRows: Array<{ product_code: string; normalized_code: string; error: string }> = [];

  await runPool(selectedCatalogRows, concurrency, async (row) => {
    try {
      const official = await resolveOfficialProduct(row, requestTimeoutMs);
      const merged = mergeCatalogRow({
        target,
        existing: row,
        official,
        discontinuedMap,
        newProductMap,
      });
      const changed = hasCatalogDelta(row, merged);

      matchedRows += 1;
      if (changed) changedRows += 1;
      if (normalizeTextValue(merged.oem_no)) oemRows += 1;
      if (normalizeTextValue(merged.vehicle)) vehicleRows += 1;
      if (normalizeTextValue(merged.image_url)) imageRows += 1;
      if (normalizeTextValue(merged.hs_code)) hsRows += 1;
      if (merged.weight_kg != null && !Number.isNaN(Number(merged.weight_kg))) weightRows += 1;
      if (String(merged.lifecycle_status || "") === "discontinued") discontinuedRows += 1;

      if (refreshExisting || changed) {
        catalogPayload.push(merged);
      }

      const outgoingReplacement = official.successor_code
        ? {
            organization_id: target.organization_id,
            brand_id: target.brand_id,
            old_code: normalizeCatalogDisplayCode(row.product_code, target.name),
            new_code: normalizeCatalogDisplayCode(official.successor_code, target.name),
            original_number: null,
            reason: official.successor_reason || "Replacement from MANN-FILTER official source.",
            is_active: true,
          }
        : null;

      if (outgoingReplacement) {
        const key = `${outgoingReplacement.organization_id}::${outgoingReplacement.brand_id}::${normalizeCode(outgoingReplacement.old_code)}::${normalizeCode(outgoingReplacement.new_code)}`;
        if (!replacementSeen.has(key)) {
          replacementSeen.add(key);
          replacementPayload.push(outgoingReplacement);
        }
      }

      for (const oldCode of official.replaced_by_old_codes) {
        const incoming = {
          organization_id: target.organization_id,
          brand_id: target.brand_id,
          old_code: normalizeCatalogDisplayCode(oldCode, target.name),
          new_code: normalizeCatalogDisplayCode(row.product_code, target.name),
          original_number: null,
          reason: "Replacement from MANN-FILTER official source.",
          is_active: true,
        };
        const key = `${incoming.organization_id}::${incoming.brand_id}::${normalizeCode(incoming.old_code)}::${normalizeCode(incoming.new_code)}`;
        if (!replacementSeen.has(key)) {
          replacementSeen.add(key);
          replacementPayload.push(incoming);
        }
      }
    } catch (error) {
      errorRows.push({
        product_code: row.product_code,
        normalized_code: row.normalized_code,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  const processedBatches = [];
  const batchSize = 200;

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
            oem_no: emptyToNull(row.oem_no),
            vehicle: emptyToNull(row.vehicle),
            hs_code: emptyToNull(row.hs_code),
            weight_kg: row.weight_kg == null || Number.isNaN(Number(row.weight_kg)) ? null : row.weight_kg,
            ...(supportsImageColumn ? { image_url: emptyToNull(row.image_url) } : {}),
            lifecycle_status: row.lifecycle_status,
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

  const processedReplacementBatches = [];
  if (replacementPayload.length) {
    for (let index = 0; index < replacementPayload.length; index += batchSize) {
      const batch = replacementPayload.slice(index, index + batchSize);
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
    targetBrandId: target.brand_id,
    targetBrandName: target.name,
    organizationId: target.organization_id,
    existingRows: catalogRows.length,
    listingPagesProcessed: 0,
    listingLastPage: 0,
    listingUniqueRows: catalogRows.length,
    newRowsInListing: 0,
    incompleteExistingRows: selectedCatalogRows.length,
    candidateRows: selectedCatalogRows.length,
    resolvedRows: matchedRows,
    errorRows: errorRows.length,
    discontinuedRows,
    replacementRows: replacementPayload.length,
    replacementFetchRows: 0,
    supportsImageColumn,
    processedBatches,
    processedReplacementBatches,
    oemRows,
    vehicleRows,
    imageRows,
    hsRows,
    weightRows,
    officialDiscontinuedRows: discontinuedMap.size,
    officialNewRows: newProductMap.size,
  };
}

async function resolveMannTarget(supabaseUrl: string, headers: Record<string, string>) {
  const response = await fetch(`${supabaseUrl}/rest/v1/brands?select=id,name,organization_id&name=ilike.Mann&limit=1`, { headers });
  const text = await response.text();
  const rows = text ? JSON.parse(text) : [];
  if (!response.ok) throw new Error(`MANN brand lookup failed: ${response.status} ${text}`);
  const brand = Array.isArray(rows) ? rows[0] : null;
  if (!brand?.id || !brand?.organization_id) throw new Error("MANN brand target not found");
  return {
    brand_id: String(brand.id),
    organization_id: String(brand.organization_id),
    name: String(brand.name || "Mann"),
  };
}

async function fetchMannCatalogRows(supabaseUrl: string, headers: Record<string, string>, brandId: string) {
  const results = [];
  const pageLimit = 1000;
  let offset = 0;
  while (true) {
    const response = await fetch(
      `${supabaseUrl}/rest/v1/catalog_products?select=organization_id,brand_id,product_code,normalized_code,oem_no,vehicle,hs_code,weight_kg,image_url,lifecycle_status,lifecycle_note&brand_id=eq.${encodeURIComponent(brandId)}&limit=${pageLimit}&offset=${offset}`,
      { headers },
    );
    const text = await response.text();
    const rows = text ? JSON.parse(text) : [];
    if (!response.ok) throw new Error(`catalog_products fetch failed: ${response.status} ${text}`);
    if (!Array.isArray(rows) || rows.length === 0) break;
    results.push(
      ...rows
        .map((row) => ({
          organization_id: String(row.organization_id || "").trim(),
          brand_id: String(row.brand_id || brandId).trim(),
          product_code: normalizeCatalogDisplayCode(String(row.product_code || "").trim(), "Mann"),
          normalized_code: normalizeCode(row.normalized_code || row.product_code || ""),
          oem_no: String(row.oem_no || "").trim(),
          vehicle: String(row.vehicle || "").trim(),
          hs_code: String(row.hs_code || "").trim(),
          weight_kg: row.weight_kg == null ? null : Number(row.weight_kg),
          image_url: String(row.image_url || "").trim(),
          lifecycle_status: String(row.lifecycle_status || "active").trim().toLowerCase() || "active",
          lifecycle_note: String(row.lifecycle_note || "").trim(),
        }))
        .filter((row) => row.product_code && row.normalized_code),
    );
    if (rows.length < pageLimit) break;
    offset += pageLimit;
  }
  return dedupeBy(results, (row) => row.normalized_code);
}

async function fetchOfficialListMap(kind: "discontinued" | "new", requestTimeoutMs: number) {
  const query = kind === "discontinued" ? DISCONTINUED_PRODUCTS_QUERY : NEW_PRODUCTS_QUERY;
  const rows = new Map<string, any>();
  const pageSize = 100;
  let currentPage = 1;
  let totalPages = 1;
  while (currentPage <= totalPages) {
    const data = await fetchGraphql(query, { pageSize, currentPage, filterBy: "ALL_FILTER" }, requestTimeoutMs);
    const payload = data?.products;
    if (!payload) break;
    totalPages = Number(payload.pageInfo?.totalPages || 1) || 1;
    for (const item of payload.items || []) {
      const attrMap = attributesToMap(item.attributes);
      const salesDesignation = normalizeCatalogDisplayCode(attrMap.sales_designation || item.sku || "", "Mann");
      const key = normalizeCode(salesDesignation || skuBase(item.sku || ""));
      if (!key) continue;
      rows.set(key, {
        sku: String(item.sku || "").trim(),
        urlKey: String(item.urlKey || "").trim(),
        salesDesignation,
        attrMap,
        successorProduct: normalizeReferenceProducts(item.successorProduct || []),
        replacedProduct: normalizeReferenceProducts(item.replacedProduct || []),
      });
    }
    currentPage += 1;
  }
  return rows;
}

async function resolveOfficialProduct(row: any, requestTimeoutMs: number) {
  const direct = await fetchProductDirect(row.product_code, requestTimeoutMs);
  const shouldSearchForOem = !normalizeTextValue(row.oem_no);
  const aggregateSearch = { crossReferenceItems: [], productCandidates: [] as any[] };

  let product = direct;
  if (!product || shouldSearchForOem) {
    const searchVariants = buildSearchVariants(row.product_code);
    for (const search of searchVariants) {
      const searchResult = await fetchSmartSearch(search, requestTimeoutMs);
      aggregateSearch.crossReferenceItems.push(...searchResult.crossReferenceItems);
      aggregateSearch.productCandidates.push(...searchResult.productCandidates);
    }
  }

  if (!product) {
    const bestCandidate = chooseBestSearchCandidate(row.product_code, aggregateSearch.productCandidates);
    if (!bestCandidate?.urlKey) throw new Error("Official MANN product not found");
    product = await fetchProductByUrlKey(bestCandidate.urlKey, requestTimeoutMs);
  }

  const attrMap = attributesToMap(product.attributes);
  const customTableMap = customTablesToMap(product.customTables);
  const matchingCrossReferenceItems = dedupeBy(
    aggregateSearch.crossReferenceItems.filter((item: any) => {
      const itemUrlKey = String(item.product?.urlKey || "").trim();
      if (itemUrlKey && itemUrlKey === product.urlKey) return true;
      const itemAttrs = attributesToMap(item.product?.attributes || []);
      const itemSalesDesignation = itemAttrs.sales_designation || "";
      return normalizeCode(itemSalesDesignation) === normalizeCode(attrMap.sales_designation || row.product_code);
    }),
    (item: any) => `${String(item.manufacturer || "").trim()}::${String(item.externalNumber || "").trim()}::${String(item.product?.urlKey || "").trim()}`,
  );

  const oemNumbers = collectOemNumbers(product, matchingCrossReferenceItems);
  const imageUrl = chooseOfficialImageUrl(product, attrMap);
  const vehicle = extractVehicleList(attrMap.main_application_aa || attrMap.application || "");
  const hsCode = extractOfficialHsCode(attrMap, customTableMap);
  const weightKg = extractOfficialWeight(attrMap, customTableMap);
  const lifecycle = buildLifecycle(product, attrMap);

  return {
    source_url: product.urlKey
      ? `https://www.mann-filter.com/uk-en/catalogue/search-results/product.html/${product.urlKey}.html`
      : "",
    oem_no: oemNumbers.join(", "),
    vehicle,
    hs_code: hsCode,
    weight_kg: weightKg,
    image_url: imageUrl,
    lifecycle_status: lifecycle.status,
    lifecycle_note: lifecycle.note,
    successor_code: lifecycle.successor_code,
    successor_reason: lifecycle.successor_reason,
    replaced_by_old_codes: lifecycle.replaced_by_old_codes,
  };
}

async function fetchProductDirect(productCode: string, requestTimeoutMs: number) {
  const compact = normalizeCode(productCode);
  if (!compact) return null;
  const data = await fetchGraphql(PRODUCT_BY_SKU_QUERY, { sku: `${compact}_MANN-FILTER` }, requestTimeoutMs);
  const item = data?.products?.items?.[0] || null;
  return item?.urlKey ? normalizeOfficialProduct(item) : null;
}

async function fetchProductByUrlKey(urlKey: string, requestTimeoutMs: number) {
  const data = await fetchGraphql(PRODUCT_BY_URL_KEY_QUERY, { urlKey }, requestTimeoutMs);
  const item = data?.products?.items?.[0] || null;
  if (!item?.urlKey) throw new Error(`Official MANN product not found for urlKey ${urlKey}`);
  return normalizeOfficialProduct(item);
}

async function fetchSmartSearch(search: string, requestTimeoutMs: number) {
  const data = await fetchGraphql(SMART_SEARCH_QUERY, { search, currentPage: 1, pageSize: 40 }, requestTimeoutMs);
  const payload = data?.catalogSearch || {};
  const crossReferenceItems = (payload.crossReference?.items || []).map((item: any) => ({
    externalNumber: String(item.externalNumber || "").trim(),
    manufacturer: String(item.manufacturer || "").trim(),
    externalProductName: String(item.externalProductName || "").trim(),
    product: normalizeOfficialProduct(item.product || {}),
  }));
  const productCandidates = [
    ...(payload.products?.items || []).map((entry: any) => normalizeOfficialProduct(entry.product || {})),
    ...crossReferenceItems.map((item: any) => item.product),
  ].filter((item) => item.urlKey);
  return {
    crossReferenceItems,
    productCandidates: dedupeBy(productCandidates, (item) => item.urlKey),
  };
}

function chooseBestSearchCandidate(productCode: string, candidates: any[]) {
  const target = normalizeCode(productCode);
  let best = null;
  let bestScore = -1;
  for (const candidate of candidates) {
    const score = scoreProductCandidate(target, candidate);
    if (score > bestScore) {
      best = candidate;
      bestScore = score;
    }
  }
  return bestScore > 0 ? best : null;
}

function scoreProductCandidate(target: string, product: any) {
  const attrMap = attributesToMap(product.attributes);
  const salesDesignation = normalizeCode(attrMap.sales_designation || "");
  const directSku = normalizeCode(skuBase(product.sku || ""));
  const urlKeyCode = normalizeCode(String(product.urlKey || "").replace(/-?mann-filter$/i, ""));
  const erpNumber = normalizeCode(attrMap.erp_number || "");
  if (salesDesignation === target) return 1000;
  if (directSku === target) return 950;
  if (urlKeyCode === target) return 900;
  if (erpNumber && erpNumber === target) return 850;
  let score = 0;
  if (salesDesignation && (salesDesignation.includes(target) || target.includes(salesDesignation))) score = Math.max(score, 400);
  if (directSku && (directSku.includes(target) || target.includes(directSku))) score = Math.max(score, 350);
  if (urlKeyCode && (urlKeyCode.includes(target) || target.includes(urlKeyCode))) score = Math.max(score, 300);
  return score;
}

function mergeCatalogRow({ target, existing, official, discontinuedMap, newProductMap }: any) {
  const normalizedExisting = normalizeCode(existing.product_code);
  const discontinuedEntry = discontinuedMap.get(normalizedExisting);
  const newProductEntry = newProductMap.get(normalizedExisting);
  let lifecycleStatus = official.lifecycle_status || existing.lifecycle_status || "active";
  let lifecycleNote = official.lifecycle_note || existing.lifecycle_note || "";

  if (discontinuedEntry) {
    lifecycleStatus = "discontinued";
    const obsoleteSince = discontinuedEntry.attrMap.obsolete_since || "";
    const discontinuedSince = obsoleteSince ? formatDateForNote(obsoleteSince) : "";
    const successorCode = discontinuedEntry.successorProduct[0]?.salesDesignation
      ? normalizeCatalogDisplayCode(discontinuedEntry.successorProduct[0].salesDesignation, target.name)
      : official.successor_code || "";
    lifecycleNote = successorCode
      ? `Replacement code: ${successorCode}. Not in production${discontinuedSince ? ` since ${discontinuedSince}` : ""} according to MANN-FILTER source.`
      : `Not in production${discontinuedSince ? ` since ${discontinuedSince}` : ""} according to MANN-FILTER source.`;
  }

  if (!lifecycleNote && newProductEntry?.replacedProduct?.length) {
    lifecycleNote = `Replacement for: ${newProductEntry.replacedProduct
      .map((item: any) => normalizeCatalogDisplayCode(item.salesDesignation, target.name))
      .filter(Boolean)
      .join(", ")}.`;
  }

  return {
    organization_id: target.organization_id,
    brand_id: target.brand_id,
    product_code: normalizeCatalogDisplayCode(existing.product_code, target.name),
    oem_no: official.oem_no || existing.oem_no || "",
    vehicle: official.vehicle || existing.vehicle || "",
    hs_code: official.hs_code || existing.hs_code || "",
    weight_kg: official.weight_kg ?? existing.weight_kg ?? null,
    image_url: official.image_url || existing.image_url || "",
    lifecycle_status: normalizeLifecycleStatus(lifecycleStatus),
    lifecycle_note: lifecycleNote,
  };
}

function buildLifecycle(product: any, attrMap: Record<string, string>) {
  const statusRaw = String(attrMap.product_status_aa || "").trim();
  const obsoleteSince = String(attrMap.obsolete_since || "").trim();
  const successor = normalizeReferenceProducts(product.successorProduct || []);
  const replaced = normalizeReferenceProducts(product.replacedProduct || []);
  const discontinued = Boolean(
    successor.length || /discontinued|obsolete|production stopped|replaced|not supplied|no longer/i.test(statusRaw) || obsoleteSince,
  );
  const successorCode = successor[0]?.salesDesignation ? normalizeCatalogDisplayCode(successor[0].salesDesignation, "Mann") : "";
  const obsoleteSinceText = obsoleteSince ? formatDateForNote(obsoleteSince) : "";
  let note = "";
  if (successorCode) {
    note = `Replacement code: ${successorCode}.`;
    if (discontinued) note = `${note} Not in production${obsoleteSinceText ? ` since ${obsoleteSinceText}` : ""} according to MANN-FILTER source.`;
  } else if (discontinued) {
    note = `Not in production${obsoleteSinceText ? ` since ${obsoleteSinceText}` : ""} according to MANN-FILTER source.`;
  } else if (statusRaw && !/available$/i.test(statusRaw)) {
    note = statusRaw;
  }
  return {
    status: discontinued ? "discontinued" : "active",
    note: note.trim(),
    successor_code: successorCode,
    successor_reason: successorCode ? `Replacement code: ${successorCode}. MANN-FILTER official source.` : "",
    replaced_by_old_codes: replaced.map((item: any) => normalizeCatalogDisplayCode(item.salesDesignation, "Mann")).filter(Boolean),
  };
}

function collectOemNumbers(product: any, crossReferenceItems: any[]) {
  const values = [];
  const attrMap = attributesToMap(product.attributes);
  const officialManufacturer = cleanText(product.referenceInformation?.oeManufacturer || attrMap.oe_manufacturer || "");
  const officialNumber = cleanText(product.referenceInformation?.oeNumber || attrMap.oe_number || "");
  if (officialNumber) values.push(officialManufacturer ? `${officialManufacturer} ${officialNumber}` : officialNumber);
  for (const item of crossReferenceItems) {
    const externalNumber = cleanText(item.externalNumber || "");
    const manufacturer = cleanText(item.manufacturer || "");
    if (!externalNumber) continue;
    values.push(manufacturer ? `${manufacturer} ${externalNumber}` : externalNumber);
  }
  return dedupeStrings(values.filter(Boolean));
}

function chooseOfficialImageUrl(product: any, attrMap: Record<string, string>) {
  const candidates = [
    product.thumbnail?.url,
    product.smallImage?.url,
    product.image?.url,
    attrMap.product_shape_group_product_shape_image,
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  for (const candidate of candidates) {
    if (!/\/placeholder\//i.test(candidate)) return candidate;
  }
  return "";
}

function extractVehicleList(raw: string) {
  const text = cleanText(raw);
  if (!text) return "";
  const canonicalHits = collectKnownManufacturers(text);
  if (canonicalHits.length) return canonicalHits.join(", ");
  const manufacturers = [];
  for (const sentence of text.split(/\.\s*/)) {
    const prefix = extractManufacturerPrefix(sentence);
    if (!prefix) continue;
    for (const part of prefix.split("/")) {
      const normalized = normalizeManufacturerName(part);
      if (normalized) manufacturers.push(normalized);
    }
  }
  return dedupeStrings(manufacturers).join(", ");
}

function collectKnownManufacturers(text: string) {
  const normalized = ` ${String(text || "").toUpperCase()} `;
  const hits = [];
  for (const entry of KNOWN_MANUFACTURER_PATTERNS) {
    const matchIndex = normalized.search(entry.pattern);
    if (matchIndex < 0) continue;
    hits.push({ label: entry.label, index: matchIndex });
  }
  return dedupeStrings(hits.sort((a, b) => a.index - b.index).map((item) => item.label));
}

function extractManufacturerPrefix(value: string) {
  const tokens = String(value || "").replace(/[;,]+/g, " ").trim().split(/\s+/).filter(Boolean);
  const accepted = [];
  for (const token of tokens) {
    const bare = token.replace(/[.,]+$/g, "");
    if (/^[A-Z0-9/()+-]+$/.test(bare)) accepted.push(bare);
    else break;
  }
  return accepted.join(" ").replace(/\s+\/\s+/g, " / ").trim();
}

function normalizeManufacturerName(value: string) {
  const cleaned = cleanText(value).replace(/\s+/g, " ").trim();
  if (!cleaned) return "";
  const known = new Map([
    ["AUDI", "Audi"],
    ["BMW", "BMW"],
    ["CHEVROLET", "Chevrolet"],
    ["CHEVROLET EUROPE", "Chevrolet Europe"],
    ["CUPRA", "Cupra"],
    ["DAEWOO", "Daewoo"],
    ["DAEWOO (GM)", "Daewoo (GM)"],
    ["DAF", "DAF"],
    ["FORD", "Ford"],
    ["IVECO", "Iveco"],
    ["MAN", "MAN"],
    ["MERCEDES-BENZ", "Mercedes-Benz"],
    ["NISSAN", "Nissan"],
    ["OPEL", "Opel"],
    ["RENAULT", "Renault"],
    ["SCANIA", "Scania"],
    ["SKODA", "Skoda"],
    ["VAUXHALL", "Vauxhall"],
    ["VOLKSWAGEN", "Volkswagen"],
    ["VW", "Volkswagen"],
    ["VW (VOLKSWAGEN)", "Volkswagen"],
    ["VOLVO", "Volvo"],
  ]);
  const upper = cleaned.toUpperCase();
  if (known.has(upper)) return known.get(upper) || "";
  return cleaned
    .split(/\s+/)
    .map((part) => {
      if (/^\([A-Z0-9]+\)$/.test(part) || /^[A-Z0-9-]{2,}$/.test(part)) return part.toUpperCase();
      return part
        .split("-")
        .map((segment) => (segment ? segment.charAt(0).toUpperCase() + segment.slice(1).toLowerCase() : segment))
        .join("-");
    })
    .join(" ");
}

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
  { label: "Skoda", pattern: /\bSKODA\b/ },
  { label: "Nissan", pattern: /\bNISSAN\b/ },
  { label: "Chevrolet", pattern: /\bCHEVROLET\b/ },
  { label: "Vauxhall", pattern: /\bVAUXHALL\b/ },
  { label: "Cupra", pattern: /\bCUPRA\b/ },
];

function extractOfficialHsCode(attrMap: Record<string, string>, customTableMap: Record<string, string>) {
  const candidates = [
    attrMap.hs_code,
    attrMap.customs_code,
    attrMap.customs_tariff_number,
    attrMap.tariff_number,
    customTableMap.hs_code,
    customTableMap.customs_code,
    customTableMap.customs_tariff_number,
    customTableMap.tariff_number,
  ]
    .map((value) => cleanText(value))
    .filter(Boolean);
  return candidates[0] || "";
}

function extractOfficialWeight(attrMap: Record<string, string>, customTableMap: Record<string, string>) {
  const candidates = [
    attrMap.weight,
    attrMap.weight_kg,
    attrMap.gross_weight,
    attrMap.net_weight,
    customTableMap.weight,
    customTableMap.weight_kg,
    customTableMap.gross_weight,
    customTableMap.net_weight,
  ];
  for (const value of candidates) {
    const parsed = parseWeight(value);
    if (parsed != null) return parsed;
  }
  return null;
}

function attributesToMap(attributes: any[]) {
  const result: Record<string, string> = {};
  for (const attribute of attributes || []) {
    const key = String(attribute?.key || "").trim();
    if (!key) continue;
    result[key] = String(attribute?.value || "").trim();
  }
  return result;
}

function customTablesToMap(customTables: any[]) {
  const result: Record<string, string> = {};
  for (const table of customTables || []) {
    for (const value of table?.values || []) {
      const key = String(value?.key || "").trim();
      const raw = String(value?.value || "").trim();
      if (!key || !raw) continue;
      if (!(key in result)) result[key] = raw;
    }
  }
  return result;
}

function normalizeOfficialProduct(product: any) {
  return {
    sku: String(product.sku || "").trim(),
    name: String(product.name || "").trim(),
    urlKey: String(product.urlKey || "").trim(),
    thumbnail: product.thumbnail || null,
    smallImage: product.smallImage || null,
    image: product.image || null,
    successorProduct: normalizeReferenceProducts(product.successorProduct || []),
    replacedProduct: normalizeReferenceProducts(product.replacedProduct || []),
    references: (product.references || []).map((item: any) => ({
      referenceTypeName: cleanText(item.referenceTypeName || ""),
      referenceProducts: normalizeReferenceProducts(item.referenceProducts || []),
    })),
    referenceInformation: product.referenceInformation || null,
    attributes: product.attributes || [],
    customTables: product.customTables || [],
  };
}

function normalizeReferenceProducts(items: any[]) {
  return dedupeBy(
    (items || [])
      .map((item) => ({
        salesDesignation: cleanText(item.salesDesignation || ""),
        urlKey: cleanText(item.urlKey || ""),
      }))
      .filter((item) => item.salesDesignation || item.urlKey),
    (item) => `${normalizeCode(item.salesDesignation)}::${item.urlKey}`,
  );
}

async function fetchGraphql(query: string, variables: Record<string, unknown>, requestTimeoutMs: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetch(MANN_GRAPHQL_ENDPOINT, {
      method: "POST",
      headers: requestHeaders,
      signal: controller.signal,
      body: JSON.stringify({ query, variables }),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`MANN GraphQL HTTP ${response.status}: ${text.slice(0, 300)}`);
    const payload = text ? JSON.parse(text) : {};
    if (payload.errors?.length) throw new Error(payload.errors.map((error: any) => error.message).join(" | "));
    return payload.data || {};
  } finally {
    clearTimeout(timeout);
  }
}

async function detectCatalogImageColumn(supabaseUrl: string, headers: Record<string, string>) {
  try {
    const response = await fetch(`${supabaseUrl}/rest/v1/catalog_products?select=image_url&limit=1`, { headers });
    const text = await response.text();
    if (response.ok) return true;
    if (String(text || "").toLowerCase().includes("image_url")) return false;
    throw new Error(`catalog_products image_url probe failed: ${response.status} ${text}`);
  } catch (error) {
    if (String(error || "").toLowerCase().includes("image_url")) return false;
    throw error;
  }
}

function hasCatalogDelta(existing: any, next: any) {
  return (
    normalizeTextValue(existing.oem_no) !== normalizeTextValue(next.oem_no) ||
    normalizeTextValue(existing.vehicle) !== normalizeTextValue(next.vehicle) ||
    normalizeTextValue(existing.hs_code) !== normalizeTextValue(next.hs_code) ||
    Number(existing.weight_kg ?? null) !== Number(next.weight_kg ?? null) ||
    normalizeTextValue(existing.image_url) !== normalizeTextValue(next.image_url) ||
    normalizeTextValue(existing.lifecycle_status) !== normalizeTextValue(next.lifecycle_status) ||
    normalizeTextValue(existing.lifecycle_note) !== normalizeTextValue(next.lifecycle_note)
  );
}

function shouldProcessRow({ row, discontinuedMap, newProductMap, refreshExisting }: any) {
  if (refreshExisting) return true;
  const normalizedCode = normalizeCode(row.normalized_code || row.product_code || "");
  if (!normalizedCode) return false;
  if (!normalizeTextValue(row.oem_no)) return true;
  if (!normalizeTextValue(row.vehicle)) return true;
  if (!normalizeTextValue(row.hs_code)) return true;
  if (row.weight_kg == null || Number.isNaN(Number(row.weight_kg))) return true;
  if (!normalizeTextValue(row.image_url)) return true;
  if (discontinuedMap.has(normalizedCode)) return true;
  if (newProductMap.has(normalizedCode)) return true;
  if (normalizeLifecycleStatus(row.lifecycle_status) === "discontinued" && !normalizeTextValue(row.lifecycle_note)) return true;
  return false;
}

async function runPool(items: any[], concurrencyLimit: number, worker: (item: any, index: number) => Promise<void>) {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrencyLimit, items.length) }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      await worker(items[index], index);
    }
  });
  await Promise.all(runners);
}

function buildSearchVariants(productCode: string) {
  const raw = cleanText(productCode).replace(/\s+/g, " ").trim();
  const compact = normalizeCode(productCode);
  return dedupeStrings([raw, compact].filter(Boolean));
}

function normalizeLifecycleStatus(value: string) {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return "active";
  return /discontinued|obsolete|replaced|production stopped/.test(text) ? "discontinued" : "active";
}

function parseWeight(value: unknown) {
  const text = String(value || "").replace(",", ".").trim();
  if (!text) return null;
  const match = text.match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

function skuBase(value: string) {
  return String(value || "").replace(/_MANN-FILTER$/i, "").trim();
}

function formatDateForNote(value: string) {
  const text = String(value || "").trim();
  if (!text) return "";
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return text;
  return `${match[1]}-${match[2]}`;
}

function cleanText(value: unknown) {
  return String(value || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeCode(value: unknown) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function dedupeBy<T>(items: T[], keyFn: (item: T) => string) {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const item of items) {
    const key = keyFn(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function dedupeStrings(values: string[]) {
  return dedupeBy(values.map((value) => String(value || "").trim()).filter(Boolean), (value) => normalizeTextValue(value));
}

function normalizeTextValue(value: unknown) {
  return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function emptyToNull(value: unknown) {
  const text = String(value || "").trim();
  return text ? text : null;
}
