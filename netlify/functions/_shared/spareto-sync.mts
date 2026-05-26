import { normalizeCatalogDescription, normalizeCatalogDisplayCode } from "./catalog-standardization.mts";

type SyncBrandTarget = {
  brandId: string;
  organizationId: string;
  name: string;
};

const requestHeaders = {
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
  "cache-control": "no-cache",
  pragma: "no-cache",
};

export function canonicalizeInternalBrandName(input: string) {
  const value = String(input || "").trim();
  if (!value) return "";
  const lower = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  if (lower === "lemforder" || lower === "lemforder") return "Lemforder";
  if (lower === "wabco") return "WABCO";
  if (lower === "trw") return "TRW";
  if (lower === "bosch") return "Bosch";
  if (lower === "mann" || lower === "mann-filter") return "Mann";
  if (lower === "sachs") return "Sachs";
  if (lower === "nrf") return "NRF";
  if (lower === "skf") return "SKF";
  if (lower === "knorrbremse" || lower === "knorr-bremse") return "Knorr-Bremse";
  if (lower === "fag") return "FAG";
  if (lower === "nissens") return "Nissens";
  if (lower === "ina") return "INA";
  if (lower === "donaldson") return "Donaldson";
  if (lower === "valeo") return "Valeo";
  if (lower === "hepu") return "HEPU";
  return value;
}

export function resolveSparetoBrandQuery(input: string) {
  const value = canonicalizeInternalBrandName(input);
  switch (value) {
    case "Lemforder":
      return "LEMFÖRDER";
    case "Bosch":
      return "BOSCH";
    case "TRW":
      return "TRW";
    case "WABCO":
      return "WABCO";
    case "Mann":
      return "MANN-FILTER";
    case "Sachs":
      return "SACHS";
    case "NRF":
      return "NRF";
    case "SKF":
      return "SKF";
    case "Knorr-Bremse":
      return "Knorr-Bremse";
    case "FAG":
      return "FAG";
    case "Nissens":
      return "NISSENS";
    case "INA":
      return "INA";
    case "Donaldson":
      return "DONALDSON";
    case "Valeo":
      return "VALEO";
    case "HEPU":
      return "HEPU";
    default:
      return value.toUpperCase();
  }
}

function resolveSparetoBrandSlug(input: string) {
  const value = canonicalizeInternalBrandName(input);
  switch (value) {
    case "Lemforder":
      return "lemforder";
    case "Bosch":
      return "bosch";
    case "WABCO":
      return "wabco";
    case "TRW":
      return "trw";
    case "Mann":
      return "mann-filter";
    case "Sachs":
      return "sachs";
    case "NRF":
      return "nrf";
    case "SKF":
      return "skf";
    case "Knorr-Bremse":
      return "knorr-bremse";
    case "FAG":
      return "fag";
    case "Nissens":
      return "nissens";
    case "INA":
      return "ina";
    case "Donaldson":
      return "donaldson";
    case "Valeo":
      return "valeo";
    case "HEPU":
      return "hepu";
    default:
      return value
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
  }
}

export async function syncBrandCatalogFromSpareto(input: {
  supabaseUrl: string;
  serviceRoleKey: string;
  brandName: string;
  refreshExisting?: boolean;
  concurrency?: number;
  pageSize?: number;
  requestTimeoutMs?: number;
}) {
  const brandName = canonicalizeInternalBrandName(input.brandName);
  const brandQuery = resolveSparetoBrandQuery(brandName);
  const brandSlug = resolveSparetoBrandSlug(brandName);
  const refreshExisting = input.refreshExisting !== false;
  const concurrency = Math.max(1, input.concurrency ?? 8);
  const pageSize = Math.max(12, input.pageSize ?? 48);
  const requestTimeoutMs = Math.max(5000, input.requestTimeoutMs ?? 20000);
  const headers = {
    apikey: input.serviceRoleKey,
    Authorization: `Bearer ${input.serviceRoleKey}`,
    "Content-Type": "application/json",
  };

  const target = await resolveOrCreateTargetBrand(input.supabaseUrl, headers, brandName);
  const supportsImageColumn = await detectCatalogImageColumn(input.supabaseUrl, headers);
  const existingRows = await fetchExistingCatalogRows(input.supabaseUrl, headers, target.brandId);
  const existingByCode = new Map(existingRows.map((row) => [row.normalized_code, row]));

  const listing = await fetchSparetoListing(brandQuery, pageSize, requestTimeoutMs);
  const candidates = listing.rows.filter((row) => {
    const existing = existingByCode.get(row.normalized_code);
    if (!existing) return true;
    if (refreshExisting) return true;
    return isIncomplete(existing);
  });

  const resolvedRows: Array<Record<string, unknown>> = [];
  const errorRows: Array<{ product_code: string; normalized_code: string; source_url: string; error: string }> = [];
  const replacementRows: Array<Record<string, unknown>> = [];
  const replacementFetchQueue = new Map<string, { product_code: string; normalized_code: string; source_url: string; image_url: string }>();

  await runPool(candidates, concurrency, async (candidate) => {
    try {
      const detail = await fetchSparetoDetail(candidate, requestTimeoutMs, brandSlug);
      const existing = existingByCode.get(candidate.normalized_code) || null;
      resolvedRows.push(buildCatalogRow(target, candidate, detail, existing));

      if (detail.replacement_code && detail.replacement_same_brand) {
        replacementRows.push({
          organization_id: target.organizationId,
          brand_id: target.brandId,
          old_code: detail.product_code,
          normalized_old_code: normalizeCode(detail.product_code),
          new_code: detail.replacement_code,
          original_number: null,
          reason: "Automatic replacement. Production stopped by manufacturer.",
          is_active: true,
        });
        const replacementNormalizedCode = normalizeCode(detail.replacement_code);
        if (!existingByCode.has(replacementNormalizedCode) && detail.replacement_url) {
          replacementFetchQueue.set(replacementNormalizedCode, {
            product_code: detail.replacement_code,
            normalized_code: replacementNormalizedCode,
            source_url: detail.replacement_url,
            image_url: "",
          });
        }
      }
    } catch (error) {
      errorRows.push({
        product_code: candidate.product_code,
        normalized_code: candidate.normalized_code,
        source_url: candidate.source_url,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  if (replacementFetchQueue.size) {
    await runPool([...replacementFetchQueue.values()], concurrency, async (candidate) => {
      try {
        const detail = await fetchSparetoDetail(candidate, requestTimeoutMs, brandSlug);
        const existing = existingByCode.get(candidate.normalized_code) || null;
        resolvedRows.push(buildCatalogRow(target, candidate, detail, existing));
      } catch (error) {
        errorRows.push({
          product_code: candidate.product_code,
          normalized_code: candidate.normalized_code,
          source_url: candidate.source_url,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
  }

  const mergedRows = dedupeBy(resolvedRows, (row) => String(row.normalized_code || ""));
  const payload = mergedRows.map((row) => ({
    organization_id: row.organization_id,
    brand_id: row.brand_id,
    product_code: row.product_code,
    description: emptyToNull(row.description),
    oem_no: emptyToNull(row.oem_no),
    hs_code: emptyToNull(row.hs_code),
    origin: emptyToNull(row.origin),
    weight_kg: row.weight_kg == null || Number.isNaN(Number(row.weight_kg)) ? null : Number(row.weight_kg),
    lifecycle_status: emptyToNull(row.lifecycle_status) || "active",
    lifecycle_note: emptyToNull(row.lifecycle_note),
    ...(supportsImageColumn ? { image_url: emptyToNull(row.image_url) } : {}),
    updated_at: new Date().toISOString(),
  }));

  const batchSize = 300;
  const processedBatches = [];
  for (let index = 0; index < payload.length; index += batchSize) {
    const batch = payload.slice(index, index + batchSize);
    const response = await fetch(
      `${input.supabaseUrl}/rest/v1/catalog_products?on_conflict=organization_id,brand_id,normalized_code`,
      {
        method: "POST",
        headers: {
          ...headers,
          Prefer: "resolution=merge-duplicates,return=minimal",
        },
        body: JSON.stringify(batch),
      },
    );
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`catalog_products upsert failed: ${response.status} ${text}`);
    }
    processedBatches.push({ batch: index / batchSize + 1, rows: batch.length, status: response.status });
  }

  const replacementPayload = dedupeBy(replacementRows, (row) => String(row.normalized_old_code || ""));
  const processedReplacementBatches = [];
  for (let index = 0; index < replacementPayload.length; index += batchSize) {
    const batch = replacementPayload.slice(index, index + batchSize).map((row) => ({
      organization_id: row.organization_id,
      brand_id: row.brand_id,
      old_code: row.old_code,
      new_code: row.new_code,
      original_number: row.original_number,
      reason: row.reason,
      is_active: row.is_active,
      updated_at: new Date().toISOString(),
    }));
    const response = await fetch(
      `${input.supabaseUrl}/rest/v1/item_code_references?on_conflict=organization_id,brand_id,normalized_old_code`,
      {
        method: "POST",
        headers: {
          ...headers,
          Prefer: "resolution=merge-duplicates,return=minimal",
        },
        body: JSON.stringify(batch),
      },
    );
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`item_code_references upsert failed: ${response.status} ${text}`);
    }
    processedReplacementBatches.push({ batch: index / batchSize + 1, rows: batch.length, status: response.status });
  }

  const discontinuedRows = mergedRows.filter((row) => String(row.lifecycle_status || "").trim().toLowerCase() === "discontinued").length;

  return {
    targetBrandId: target.brandId,
    targetBrandName: target.name,
    organizationId: target.organizationId,
    existingRows: existingRows.length,
    listingPagesProcessed: listing.pagesProcessed,
    listingLastPage: listing.lastPage,
    listingUniqueRows: listing.rows.length,
    newRowsInListing: listing.rows.filter((row) => !existingByCode.has(row.normalized_code)).length,
    incompleteExistingRows: listing.rows.filter((row) => {
      const existing = existingByCode.get(row.normalized_code);
      return existing ? isIncomplete(existing) : false;
    }).length,
    candidateRows: candidates.length,
    resolvedRows: mergedRows.length,
    errorRows: errorRows.length,
    discontinuedRows,
    replacementRows: replacementPayload.length,
    replacementFetchRows: replacementFetchQueue.size,
    supportsImageColumn,
    processedBatches,
    processedReplacementBatches,
  };
}

async function resolveOrCreateTargetBrand(supabaseUrl: string, headers: Record<string, string>, brandName: string): Promise<SyncBrandTarget> {
  const existingBrands = await fetchAll(supabaseUrl, headers, "/rest/v1/brands?select=id,name,organization_id&order=name.asc");
  const exact =
    existingBrands.find((row) => normalizeBrand(row.name) === normalizeBrand(brandName)) ||
    existingBrands.find((row) => normalizeBrand(row.name).includes(normalizeBrand(brandName))) ||
    null;

  if (exact?.id && exact?.organization_id) {
    return {
      brandId: String(exact.id),
      organizationId: String(exact.organization_id),
      name: String(exact.name || brandName).trim() || brandName,
    };
  }

  const seedOrgId = String(existingBrands[0]?.organization_id || "").trim();
  if (!seedOrgId) {
    throw new Error("Could not resolve organization_id from brands table");
  }

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
  if (!response.ok) {
    throw new Error(`Brand create failed: ${response.status} ${JSON.stringify(data)}`);
  }

  const created = Array.isArray(data) ? data[0] : data;
  if (!created?.id) {
    throw new Error(`Brand create returned no id: ${JSON.stringify(data)}`);
  }

  return {
    brandId: String(created.id),
    organizationId: seedOrgId,
    name: brandName.trim(),
  };
}

async function detectCatalogImageColumn(supabaseUrl: string, headers: Record<string, string>) {
  try {
    await getJson(`${supabaseUrl}/rest/v1/catalog_products?select=image_url&limit=1`, { headers });
    return true;
  } catch (error) {
    if (String(error || "").toLowerCase().includes("image_url")) {
      return false;
    }
    throw error;
  }
}

async function fetchExistingCatalogRows(supabaseUrl: string, headers: Record<string, string>, brandId: string) {
  const results = [];
  const restPageLimit = 1000;
  let offset = 0;
  while (true) {
    const response = await fetch(
      `${supabaseUrl}/rest/v1/catalog_products?select=product_code,normalized_code,description,oem_no,hs_code,origin,weight_kg,image_url,lifecycle_status,lifecycle_note&brand_id=eq.${encodeURIComponent(brandId)}&limit=${restPageLimit}&offset=${offset}`,
      { headers },
    );
    const text = await response.text();
    const rows = text ? JSON.parse(text) : [];
    if (!response.ok) {
      throw new Error(`catalog_products fetch failed: ${response.status} ${text}`);
    }
    if (!Array.isArray(rows) || rows.length === 0) break;
    results.push(
      ...rows.map((row) => ({
        product_code: String(row.product_code || "").trim(),
        normalized_code: normalizeCode(row.normalized_code || row.product_code || ""),
        description: String(row.description || "").trim(),
        oem_no: String(row.oem_no || "").trim(),
        hs_code: String(row.hs_code || "").trim(),
        origin: String(row.origin || "").trim(),
        weight_kg: row.weight_kg == null ? null : Number(row.weight_kg),
        image_url: String(row.image_url || "").trim(),
        lifecycle_status: String(row.lifecycle_status || "active").trim().toLowerCase(),
        lifecycle_note: String(row.lifecycle_note || "").trim(),
      })),
    );
    if (rows.length < restPageLimit) break;
    offset += restPageLimit;
  }
  return dedupeBy(results, (row) => row.normalized_code);
}

async function fetchSparetoListing(brandQuery: string, pageSize: number, requestTimeoutMs: number) {
  const rowsByCode = new Map();
  let page = 1;
  let lastPage = 1;
  let pagesProcessed = 0;

  while (true) {
    const url = `https://spareto.com/products?utf8=%E2%9C%93&sort_by=&brand%5B%5D=${encodeURIComponent(brandQuery)}&per_page=${pageSize}&page=${page}`;
    const html = await fetchText(url, requestTimeoutMs);
    const cards = extractListingCards(html, brandQuery);
    if (pagesProcessed === 0) {
      lastPage = extractLastPage(html, page);
    }

    for (const card of cards) {
      if (!card.normalized_code) continue;
      const existing = rowsByCode.get(card.normalized_code);
      rowsByCode.set(card.normalized_code, mergeListingCards(existing, card));
    }

    pagesProcessed += 1;
    if (page >= lastPage) break;
    page += 1;
  }

  return {
    rows: Array.from(rowsByCode.values()),
    pagesProcessed,
    lastPage,
  };
}

function extractListingCards(html: string, brandQuery: string) {
  const cards = [];
  const targetBrand = normalizeBrand(brandQuery);
  const cardRegex =
    /<div class='card bg-transparent card-product mt-4'[\s\S]*?data-variant-card-gtm-item-value='([^']+)'[\s\S]*?<a[^>]+href="([^"]+)"[\s\S]*?<img[^>]+(?:data-src|src)="([^"]*)"/g;
  for (const match of html.matchAll(cardRegex)) {
    const gtmValue = decodeHtml(match[1]);
    const href = match[2];
    const imageUrl = match[3];
    try {
      const data = JSON.parse(gtmValue);
      const productCode = normalizeCatalogDisplayCode(String(data.item_id || "").trim());
      const cardBrand = String(data.item_brand || "").trim();
      if (!productCode || normalizeBrand(cardBrand) !== targetBrand) continue;
      cards.push({
        product_code: productCode,
        normalized_code: normalizeCode(productCode),
        description: normalizeCatalogDescription(String(data.item_name || "").trim()),
        brand: cardBrand,
        source_url: new URL(href, "https://spareto.com").toString(),
        image_url: sanitizeImageUrl(imageUrl),
      });
    } catch {
      continue;
    }
  }
  return cards;
}

function mergeListingCards(existing: any, incoming: any) {
  if (!existing) return incoming;
  return {
    ...existing,
    product_code: preferValue(existing.product_code, incoming.product_code),
    description: preferValue(existing.description, incoming.description),
    image_url: preferValue(existing.image_url, incoming.image_url),
    source_url: preferValue(existing.source_url, incoming.source_url),
  };
}

function extractLastPage(html: string, fallback: number) {
  let maxPage = fallback;
  for (const match of html.matchAll(/page=(\d+)/g)) {
    const page = Number.parseInt(match[1], 10);
    if (Number.isFinite(page) && page > maxPage) {
      maxPage = page;
    }
  }
  return maxPage;
}

async function fetchSparetoDetail(card: any, requestTimeoutMs: number, targetBrandSlug: string) {
  const html = await fetchText(card.source_url, requestTimeoutMs);
  const detail = extractDetailProperties(html);
  const lifecycle = extractCurrentLifecycle(html, targetBrandSlug);
  return {
    product_code: normalizeCatalogDisplayCode(card.product_code),
    normalized_code: card.normalized_code,
    description: normalizeCatalogDescription(detail.product_name || card.description || ""),
    oem_no: detail.oe_numbers || "",
    hs_code: detail.customs_code || "",
    origin: formatOrigin(detail.country_of_origin),
    weight_kg: detail.weight_kg,
    image_url: sanitizeImageUrl(detail.image_url || card.image_url),
    source_url: card.source_url,
    lifecycle_status: lifecycle.discontinued ? "discontinued" : "active",
    lifecycle_note: lifecycle.note,
    replacement_code: lifecycle.replacement_code,
    replacement_url: lifecycle.replacement_url,
    replacement_same_brand: lifecycle.replacement_same_brand,
  };
}

function extractDetailProperties(html: string) {
  const ogTitle = capture(html, /<meta content='([^']+)' property='og:title'>/i) || capture(html, /<meta property="og:title" content="([^"]+)"/i);
  const titleText = capture(html, /<title>([\s\S]*?)<\/title>/i);
  return {
    product_name: extractDetailName(ogTitle || titleText) || capture(html, /<p class='m-0 name'>([\s\S]*?)<\/p>/i) || "",
    image_url:
      capture(html, /<meta content='([^']+)' property='og:image'>/i) ||
      capture(html, /<meta property="og:image" content="([^"]+)"/i) ||
      "",
    customs_code: captureTableValue(html, "Customs Code"),
    country_of_origin: captureTableValue(html, "Country of Origin"),
    weight_kg: parseWeight(
      capture(
        html,
        /translation missing: en\.spree\.shared\.variant_item\.weight[\s\S]*?<td>\s*([\d.,]+)\s*Kg\s*<\/td>/i,
      ),
    ),
    oe_numbers: extractReferenceNumbers(html, "OE Numbers"),
  };
}

function extractReferenceNumbers(html: string, heading: string) {
  const escaped = escapeRegExp(heading);
  const sectionMatch = html.match(new RegExp(`<h3[^>]*>${escaped}<\\/h3>([\\s\\S]*?)(?:<h3|<\\/section>)`, "i"));
  if (!sectionMatch) return "";
  const numbers = [];
  for (const match of sectionMatch[1].matchAll(/<a[^>]+href="[^"]+"[^>]*>([\s\S]*?)<\/a>/g)) {
    const value = cleanText(match[1]);
    if (value) numbers.push(value);
  }
  return compactReferenceNumbers(numbers);
}

function captureTableValue(html: string, label: string) {
  const escaped = escapeRegExp(label);
  return capture(html, new RegExp(`<td>${escaped}<\\/td>\\s*<td>([\\s\\S]*?)<\\/td>`, "i"));
}

function extractCurrentLifecycle(html: string, targetBrandSlug: string) {
  const preAlternatives = html.split("<section class='mb-5' id='nav-alternatives'")[0] || html;
  const discontinued = /No longer deliverable by the manufacturer/i.test(preAlternatives);
  const replacementIndex = preAlternatives.search(/Product has been replaced by:/i);
  let replacement_code = "";
  let replacement_url = "";
  let replacement_same_brand = false;

  if (replacementIndex >= 0) {
    const snippet = preAlternatives.slice(replacementIndex, replacementIndex + 1000);
    const match = snippet.match(/<a[^>]+href=['"]([^'"]+)['"][^>]*>([\s\S]*?)<\/a>/i);
    if (match) {
      replacement_url = new URL(match[1], "https://spareto.com").toString();
      replacement_code = cleanText(match[2]).toUpperCase();
      replacement_same_brand = new RegExp(`/products/${escapeRegExp(targetBrandSlug)}-`, "i").test(match[1]);
    }
  }

  const note = replacement_code ? `Replacement code: ${replacement_code}.` : "";
  return {
    discontinued,
    replacement_code,
    replacement_url,
    replacement_same_brand,
    note,
  };
}

function buildCatalogRow(target: SyncBrandTarget, candidate: any, detail: any, existing: any) {
  const nextDescription = normalizeCatalogDescription(preferCatalogValue(detail.description, candidate.description, existing?.description));
  const nextOemNo = preferCatalogValue(existing?.oem_no, detail.oem_no);
  const nextHsCode = preferCatalogValue(existing?.hs_code, detail.hs_code);
  const nextOrigin = preferOrigin(existing?.origin, detail.origin);
  const nextWeight = existing?.weight_kg ?? detail.weight_kg ?? null;
  const nextImage = preferCatalogValue(existing?.image_url, detail.image_url, candidate.image_url);
  const nextLifecycleStatus = detail.lifecycle_status === "discontinued" ? "discontinued" : String(existing?.lifecycle_status || "active").trim().toLowerCase() || "active";
  const nextLifecycleNote = preferCatalogValue(detail.lifecycle_note, existing?.lifecycle_note);

  return {
    organization_id: target.organizationId,
    brand_id: target.brandId,
    product_code: normalizeCatalogDisplayCode(preferCatalogValue(detail.product_code, candidate.product_code, existing?.product_code)),
    normalized_code: candidate.normalized_code,
    description: nextDescription,
    oem_no: nextOemNo,
    hs_code: nextHsCode,
    origin: nextOrigin,
    weight_kg: nextWeight,
    image_url: nextImage,
    lifecycle_status: nextLifecycleStatus,
    lifecycle_note: nextLifecycleNote,
    source_url: detail.source_url || candidate.source_url,
  };
}

function isIncomplete(row: any) {
  return !String(row.description || "").trim() ||
    !String(row.oem_no || "").trim() ||
    !String(row.hs_code || "").trim() ||
    !String(row.origin || "").trim() ||
    row.weight_kg == null ||
    Number.isNaN(Number(row.weight_kg)) ||
    !String(row.image_url || "").trim();
}

function preferCatalogValue(...values: unknown[]) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) return text;
  }
  return "";
}

function preferOrigin(existing: unknown, incoming: unknown) {
  const current = String(existing || "").trim().toUpperCase();
  const next = String(incoming || "").trim().toUpperCase();
  if (!current) return next;
  if (!next) return current;
  if (current.length > 2 && next.length <= 3) return next;
  return current;
}

function preferValue(existing: unknown, incoming: unknown) {
  const current = String(existing || "").trim();
  const next = String(incoming || "").trim();
  if (!current) return next;
  if (!next) return current;
  return next.length > current.length ? next : current;
}

function capture(html: string, regex: RegExp) {
  const match = html.match(regex);
  return match ? cleanText(match[1]) : "";
}

function cleanText(value: unknown) {
  return decodeHtml(String(value || ""))
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtml(value: string) {
  return String(value || "")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x2F;/g, "/");
}

function compactReferenceNumbers(values: string[], maxLength = 1000) {
  const unique = Array.from(new Set(values.map((value) => String(value || "").trim()).filter(Boolean)));
  const kept = [];
  let totalLength = 0;
  for (const value of unique) {
    const nextLength = kept.length === 0 ? value.length : totalLength + 2 + value.length;
    if (nextLength > maxLength) break;
    kept.push(value);
    totalLength = nextLength;
  }
  return kept.join(", ");
}

async function fetchText(url: string, requestTimeoutMs: number) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  let response: Response;
  try {
    response = await fetch(url, {
      headers: requestHeaders,
      signal: controller.signal,
    });
  } catch (error: any) {
    if (error?.name === "AbortError") {
      throw new Error(`Request timeout after ${requestTimeoutMs}ms for ${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }
  return await response.text();
}

async function fetchAll(supabaseUrl: string, headers: Record<string, string>, initialPath: string) {
  const results = [];
  const restPageLimit = 1000;
  let offset = 0;

  while (true) {
    const separator = initialPath.includes("?") ? "&" : "?";
    const pathWithRange = `${initialPath}${separator}limit=${restPageLimit}&offset=${offset}`;
    const batch = await getJson<Array<Record<string, unknown>>>(`${supabaseUrl}${pathWithRange}`, { headers });
    results.push(...batch);
    if (batch.length < restPageLimit) break;
    offset += restPageLimit;
  }

  return results;
}

function normalizeBrand(value: unknown) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/gi, "")
    .toLowerCase()
    .trim();
}

function normalizeCode(value: unknown) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "")
    .trim();
}

function parseWeight(value: string) {
  const normalized = String(value || "").trim().replace(",", ".");
  const numeric = Number(normalized);
  return Number.isFinite(numeric) ? numeric : null;
}

function sanitizeImageUrl(value: unknown) {
  const text = String(value || "").trim();
  return text && /^https?:\/\//i.test(text) ? text : "";
}

function extractDetailName(text: string) {
  const cleaned = cleanText(text);
  if (!cleaned) return "";
  const parts = cleaned.split(" - ");
  if (parts.length >= 2) {
    return parts.slice(1).join(" - ").trim();
  }
  return cleaned.trim();
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function emptyToNull(value: unknown) {
  const text = String(value || "").trim();
  return text ? text : null;
}

function dedupeBy<T>(rows: T[], keyFn: (row: T) => string) {
  const map = new Map<string, T>();
  for (const row of rows) {
    map.set(keyFn(row), row);
  }
  return [...map.values()];
}

async function runPool<T>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<void>) {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      await worker(items[index], index);
    }
  });
  await Promise.all(runners);
}

function formatOrigin(value: string) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const map = new Map<string, string>([
    ["GERMANY", "DE"],
    ["POLAND", "PL"],
    ["ITALY", "IT"],
    ["SPAIN", "ES"],
    ["CZECH REPUBLIC", "CZ"],
    ["TURKEY", "TR"],
    ["FRANCE", "FR"],
    ["CHINA", "CN"],
    ["ROMANIA", "RO"],
    ["HUNGARY", "HU"],
    ["BULGARIA", "BG"],
    ["NETHERLANDS", "NL"],
    ["BELGIUM", "BE"],
    ["UNITED KINGDOM", "GB"],
    ["PORTUGAL", "PT"],
    ["AUSTRIA", "AT"],
    ["SWEDEN", "SE"],
    ["DENMARK", "DK"],
    ["SWITZERLAND", "CH"],
    ["USA", "US"],
    ["UNITED STATES", "US"],
    ["JAPAN", "JP"],
    ["SOUTH KOREA", "KR"],
    ["KOREA", "KR"],
    ["MEXICO", "MX"],
    ["INDIA", "IN"],
  ]);
  const normalized = raw.toUpperCase();
  return map.get(normalized) || (normalized.length <= 3 ? normalized : raw);
}
