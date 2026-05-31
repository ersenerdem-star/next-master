#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { normalizeCatalogDisplayCode } from "./_shared/catalog-standardization.mjs";

const repoRoot = "/Users/ersen/Documents/Codex/2026-05-11-quote-desk-next-mvp";
const outputDir = path.join(repoRoot, "docs", "zf-aftermarket-detail-fill");

const supabaseUrl = String(process.env.SUPABASE_URL || "").replace(/\/+$/, "");
const serviceRoleKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "");

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
}

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const token = process.argv[index];
  if (!token.startsWith("--")) continue;
  const [rawKey, rawValue] = token.slice(2).split("=", 2);
  if (rawValue != null) {
    args.set(rawKey, rawValue);
    continue;
  }
  const next = process.argv[index + 1];
  if (next && !next.startsWith("--")) {
    args.set(rawKey, next);
    index += 1;
  } else {
    args.set(rawKey, "true");
  }
}

const applyMode = args.has("apply");
const refreshExisting = args.has("refresh-existing");
const discoverMissing = !args.has("skip-discovery");
const missingOnly = args.has("missing-only");
const batchSize = Math.max(1, Number.parseInt(args.get("batch-size") || "250", 10) || 250);
const detailConcurrency = Math.max(1, Number.parseInt(args.get("detail-concurrency") || "6", 10) || 6);
const searchConcurrency = Math.max(1, Number.parseInt(args.get("search-concurrency") || "2", 10) || 2);
const searchPageSize = Math.max(20, Number.parseInt(args.get("search-page-size") || "250", 10) || 250);
const requestTimeoutMs = Math.max(5000, Number.parseInt(args.get("request-timeout-ms") || "30000", 10) || 30000);
const sleepMs = Math.max(0, Number.parseInt(args.get("sleep-ms") || "15", 10) || 15);
const brandArg = String(args.get("brands") || "").trim();
const limitArg = args.get("limit");
const rowLimit = limitArg == null ? null : Math.max(1, Number.parseInt(limitArg, 10) || 0);
const prefixLimitArg = args.get("prefix-limit");
const prefixLimit = prefixLimitArg == null ? null : Math.max(1, Number.parseInt(prefixLimitArg, 10) || 0);
const existingPrefixesArg = String(args.get("existing-prefixes") || "").trim();
const existingPrefixes = dedupeStrings(
  existingPrefixesArg
    .split(",")
    .map((value) => normalizeCode(value))
    .filter(Boolean),
);

const headers = {
  apikey: serviceRoleKey,
  Authorization: `Bearer ${serviceRoleKey}`,
  "Content-Type": "application/json",
};

const requestHeaders = {
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0 Safari/537.36",
  accept: "application/json, text/plain, */*",
  "accept-language": "en-US,en;q=0.9,tr;q=0.6",
  "cache-control": "no-cache",
  pragma: "no-cache",
};

const ORIGIN_CODES = {
  ARGENTINA: "AR",
  AUSTRALIA: "AU",
  AUSTRIA: "AT",
  BELGIUM: "BE",
  BOSNIAANDHERZEGOVINA: "BA",
  BRAZIL: "BR",
  BULGARIA: "BG",
  CANADA: "CA",
  CHINA: "CN",
  CROATIA: "HR",
  CZECHIA: "CZ",
  CZECHREPUBLIC: "CZ",
  DENMARK: "DK",
  EGYPT: "EG",
  ESTONIA: "EE",
  FINLAND: "FI",
  FRANCE: "FR",
  GERMANY: "DE",
  GREECE: "GR",
  HUNGARY: "HU",
  INDIA: "IN",
  INDONESIA: "ID",
  IRELAND: "IE",
  ISRAEL: "IL",
  ITALY: "IT",
  JAPAN: "JP",
  KOREA: "KR",
  LATVIA: "LV",
  LITHUANIA: "LT",
  LUXEMBOURG: "LU",
  MALAYSIA: "MY",
  MEXICO: "MX",
  NETHERLANDS: "NL",
  NORWAY: "NO",
  POLAND: "PL",
  PORTUGAL: "PT",
  ROMANIA: "RO",
  SERBIA: "RS",
  SINGAPORE: "SG",
  SLOVAKIA: "SK",
  SLOVENIA: "SI",
  SOUTHAFRICA: "ZA",
  SOUTHKOREA: "KR",
  SPAIN: "ES",
  SWEDEN: "SE",
  SWITZERLAND: "CH",
  TAIWAN: "TW",
  THAILAND: "TH",
  TURKEY: "TR",
  UNITEDKINGDOM: "GB",
  UNITEDSTATES: "US",
  USA: "US",
  VIETNAM: "VN",
};

const BRAND_CONFIGS = [
  { key: "zf", internalName: "ZF", officialFilter: "ZF", aliases: ["ZF"] },
  { key: "lemforder", internalName: "Lemforder", officialFilter: "LEMFÖRDER", aliases: ["Lemforder", "Lemförder"] },
  { key: "sachs", internalName: "Sachs", officialFilter: "SACHS", aliases: ["Sachs"] },
  { key: "trw", internalName: "TRW", officialFilter: "TRW", aliases: ["TRW"] },
  { key: "wabco", internalName: "Wabco", officialFilter: "WABCO", aliases: ["Wabco", "WABCO"] },
  { key: "boge", internalName: "Boge", officialFilter: "BOGE", aliases: ["Boge", "BOGE"] },
];

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
  { label: "Ashok Leyland", pattern: /\bASHOK\s+LEYLAND\b/ },
  { label: "Land Rover", pattern: /\bLAND\s+ROVER\b/ },
  { label: "Toyota", pattern: /\bTOYOTA\b/ },
  { label: "Peugeot", pattern: /\bPEUGEOT\b/ },
  { label: "Citroen", pattern: /\bCITROE?N\b/ },
  { label: "Fiat", pattern: /\bFIAT\b/ },
];

fs.mkdirSync(outputDir, { recursive: true });

async function main() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const matchedCsvPath = path.join(outputDir, `zf-aftermarket-detail-fill-${timestamp}.csv`);
  const errorsCsvPath = path.join(outputDir, `zf-aftermarket-detail-fill-errors-${timestamp}.csv`);
  const summaryPath = path.join(outputDir, `zf-aftermarket-detail-fill-summary-${timestamp}.json`);

  const supportsImageColumn = await detectCatalogImageColumn();
  const targets = await resolveTargets(brandArg);
  const matched = [];
  const errors = [];
  const catalogPayload = [];
  const replacementPayload = [];
  const seenReplacementKeys = new Set();
  const brandSummaries = [];

  for (const target of targets) {
    const allExistingRows = await fetchCatalogRows(target);
    const existingRows = filterRowsByPrefixes(allExistingRows, existingPrefixes);
    const existingByCode = new Map(existingRows.map((row) => [row.normalized_code, row]));
    const allSeedPrefixes = discoverMissing ? buildSeedPrefixes(existingRows) : [];
    const seedPrefixes = prefixLimit == null ? allSeedPrefixes : allSeedPrefixes.slice(0, prefixLimit);
    const discoveredSearchMap = discoverMissing
      ? await crawlOfficialPrefixes({
          target,
          prefixes: seedPrefixes,
          errors,
        })
      : new Map();

    const workMap = new Map();
    for (const row of existingRows) {
      if (missingOnly) {
        if (shouldProcessRow(row)) {
          workMap.set(row.normalized_code, {
            target,
            existing: row,
            searchItem: discoveredSearchMap.get(row.normalized_code) || null,
            source: "existing",
          });
        }
        continue;
      }
      if (refreshExisting || shouldProcessRow(row)) {
        workMap.set(row.normalized_code, {
          target,
          existing: row,
          searchItem: discoveredSearchMap.get(row.normalized_code) || null,
          source: "existing",
        });
      }
    }

    let missingFromSearch = 0;
    for (const [normalizedCode, searchItem] of discoveredSearchMap.entries()) {
      if (existingByCode.has(normalizedCode)) continue;
      missingFromSearch += 1;
      workMap.set(normalizedCode, {
        target,
        existing: null,
        searchItem,
        source: "search",
      });
    }

    const selectedWorkItems = Array.from(workMap.values());
    const workItems = rowLimit == null ? selectedWorkItems : selectedWorkItems.slice(0, rowLimit);
    const extraCodes = new Set();
    const processedCodes = new Set(workItems.map((item) => item.searchItem?.normalized_code || item.existing?.normalized_code).filter(Boolean));

    await runPool(workItems, detailConcurrency, async (item, index) => {
      try {
        const detail = await resolveOfficialDetail(item.target, item.searchItem?.product_code || item.existing?.product_code || "");
        const merged = mergeCatalogRow({
          target: item.target,
          existing: item.existing,
          searchItem: item.searchItem,
          detail,
        });
        const changed = !item.existing || hasCatalogDelta(item.existing, merged);

        matched.push({
          brand_name: item.target.internalName,
          product_code: merged.product_code,
          normalized_code: normalizeCode(merged.product_code),
          source: item.source,
          source_url: detail.source_url || item.searchItem?.source_url || "",
          description: merged.description || "",
          oem_no: merged.oem_no || "",
          vehicle: merged.vehicle || "",
          hs_code: merged.hs_code || "",
          origin: merged.origin || "",
          weight_kg: merged.weight_kg == null ? "" : String(merged.weight_kg),
          image_url: merged.image_url || "",
          lifecycle_status: merged.lifecycle_status,
          lifecycle_note: merged.lifecycle_note || "",
          replacement_code: detail.replacement_code || "",
          changed: changed ? "yes" : "no",
        });

        if (refreshExisting || changed || item.source === "search") {
          catalogPayload.push(merged);
        }

        if (detail.replacement_code) {
          const replacement = {
            organization_id: item.target.organization_id,
            brand_id: item.target.brand_id,
            old_code: normalizeCatalogDisplayCode(merged.product_code, item.target.internalName),
            new_code: normalizeCatalogDisplayCode(detail.replacement_code, item.target.internalName),
            original_number: null,
            reason: detail.replacement_reason || "Replacement from ZF Aftermarket official source.",
            is_active: true,
          };
          const replacementKey = `${replacement.organization_id}::${replacement.brand_id}::${normalizeCode(replacement.old_code)}::${normalizeCode(replacement.new_code)}`;
          if (!seenReplacementKeys.has(replacementKey)) {
            seenReplacementKeys.add(replacementKey);
            replacementPayload.push(replacement);
          }
        }

        for (const relatedCode of detail.related_codes) {
          const normalizedRelated = normalizeCode(relatedCode);
          if (!normalizedRelated || processedCodes.has(normalizedRelated)) continue;
          processedCodes.add(normalizedRelated);
          extraCodes.add(relatedCode);
        }
      } catch (error) {
        errors.push({
          brand_name: item.target.internalName,
          product_code: item.searchItem?.product_code || item.existing?.product_code || "",
          normalized_code: item.searchItem?.normalized_code || item.existing?.normalized_code || "",
          source_url: item.searchItem?.source_url || "",
          error: error instanceof Error ? error.message : String(error),
        });
      }

      if ((index + 1) % 100 === 0 || index + 1 === workItems.length) {
        console.error(`${item.target.internalName} detail progress: ${index + 1}/${workItems.length}`);
      }
      if (sleepMs > 0) {
        await sleep(sleepMs);
      }
    });

    const extraSearchItems = await resolveExtraCodes({
      target,
      extraCodes,
      existingByCode,
      processedCodes,
      errors,
    });

    if (extraSearchItems.length) {
      await runPool(extraSearchItems, detailConcurrency, async (item, index) => {
        try {
          const detail = await resolveOfficialDetail(item.target, item.searchItem.product_code);
          const merged = mergeCatalogRow({
            target: item.target,
            existing: null,
            searchItem: item.searchItem,
            detail,
          });

          matched.push({
            brand_name: item.target.internalName,
            product_code: merged.product_code,
            normalized_code: normalizeCode(merged.product_code),
            source: "related",
            source_url: detail.source_url || item.searchItem.source_url || "",
            description: merged.description || "",
            oem_no: merged.oem_no || "",
            vehicle: merged.vehicle || "",
            hs_code: merged.hs_code || "",
            origin: merged.origin || "",
            weight_kg: merged.weight_kg == null ? "" : String(merged.weight_kg),
            image_url: merged.image_url || "",
            lifecycle_status: merged.lifecycle_status,
            lifecycle_note: merged.lifecycle_note || "",
            replacement_code: detail.replacement_code || "",
            changed: "yes",
          });

          catalogPayload.push(merged);

          if (detail.replacement_code) {
            const replacement = {
              organization_id: item.target.organization_id,
              brand_id: item.target.brand_id,
              old_code: normalizeCatalogDisplayCode(merged.product_code, item.target.internalName),
              new_code: normalizeCatalogDisplayCode(detail.replacement_code, item.target.internalName),
              original_number: null,
              reason: detail.replacement_reason || "Replacement from ZF Aftermarket official source.",
              is_active: true,
            };
            const replacementKey = `${replacement.organization_id}::${replacement.brand_id}::${normalizeCode(replacement.old_code)}::${normalizeCode(replacement.new_code)}`;
            if (!seenReplacementKeys.has(replacementKey)) {
              seenReplacementKeys.add(replacementKey);
              replacementPayload.push(replacement);
            }
          }
        } catch (error) {
          errors.push({
            brand_name: item.target.internalName,
            product_code: item.searchItem.product_code,
            normalized_code: item.searchItem.normalized_code,
            source_url: item.searchItem.source_url || "",
            error: error instanceof Error ? error.message : String(error),
          });
        }

        if ((index + 1) % 100 === 0 || index + 1 === extraSearchItems.length) {
          console.error(`${item.target.internalName} related detail progress: ${index + 1}/${extraSearchItems.length}`);
        }
        if (sleepMs > 0) {
          await sleep(sleepMs);
        }
      });
    }

    brandSummaries.push({
      brand_name: target.internalName,
      brand_id: target.brand_id,
      total_existing_rows: allExistingRows.length,
      existing_rows: existingRows.length,
      prefix_filter_count: existingPrefixes.length,
      prefix_count: seedPrefixes.length,
      total_prefix_count: allSeedPrefixes.length,
      discovered_search_rows: discoveredSearchMap.size,
      missing_discovered_rows: missingFromSearch,
      selected_work_rows: workItems.length,
      related_discovered_rows: extraSearchItems.length,
    });
  }

  writeCsv(
    matchedCsvPath,
    [
      "Brand",
      "Product_Code",
      "Normalized_Code",
      "Source",
      "Source_URL",
      "Description",
      "OEM_No",
      "Vehicle",
      "HS_Code",
      "Origin",
      "Weight_kg",
      "Image_URL",
      "Lifecycle_Status",
      "Lifecycle_Note",
      "Replacement_Code",
      "Changed",
    ],
    matched.map((row) => [
      row.brand_name,
      row.product_code,
      row.normalized_code,
      row.source,
      row.source_url,
      row.description,
      row.oem_no,
      row.vehicle,
      row.hs_code,
      row.origin,
      row.weight_kg,
      row.image_url,
      row.lifecycle_status,
      row.lifecycle_note,
      row.replacement_code,
      row.changed,
    ]),
  );

  writeCsv(
    errorsCsvPath,
    ["Brand", "Product_Code", "Normalized_Code", "Source_URL", "Error"],
    errors.map((row) => [row.brand_name, row.product_code, row.normalized_code, row.source_url, row.error]),
  );

  const processedBatches = [];
  if (applyMode) {
    const dedupedCatalogPayload = dedupeBy(
      catalogPayload.map((row) => ({
        organization_id: row.organization_id,
        brand_id: row.brand_id,
        product_code: row.product_code,
        description: emptyToNull(row.description),
        oem_no: emptyToNull(row.oem_no),
        vehicle: emptyToNull(row.vehicle),
        hs_code: emptyToNull(row.hs_code),
        origin: emptyToNull(row.origin),
        weight_kg: row.weight_kg == null || Number.isNaN(row.weight_kg) ? null : row.weight_kg,
        ...(supportsImageColumn ? { image_url: emptyToNull(row.image_url) } : {}),
        lifecycle_status: row.lifecycle_status,
        lifecycle_note: emptyToNull(row.lifecycle_note),
        updated_at: new Date().toISOString(),
      })),
      (row) => `${row.organization_id}::${row.brand_id}::${normalizeCode(row.product_code)}`,
    );

    if (dedupedCatalogPayload.length) {
      for (let index = 0; index < dedupedCatalogPayload.length; index += batchSize) {
        const batch = dedupedCatalogPayload.slice(index, index + batchSize);
        const result = await upsertCatalogBatch(batch);
        processedBatches.push({
          type: "catalog",
          batch: index / batchSize + 1,
          rows: batch.length,
          result,
        });
      }
    }

    if (replacementPayload.length) {
      for (let index = 0; index < replacementPayload.length; index += batchSize) {
        const batch = replacementPayload.slice(index, index + batchSize);
        const result = await upsertCodeReferenceBatch(
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
        );
        processedBatches.push({
          type: "code_reference",
          batch: index / batchSize + 1,
          rows: batch.length,
          result,
        });
      }
    }
  }

  const summary = {
    mode: applyMode ? "apply" : "plan",
    brands: brandSummaries,
    matched_rows: matched.length,
    changed_rows: matched.filter((row) => row.changed === "yes").length,
    missing_insert_rows: matched.filter((row) => row.source !== "existing").length,
    oem_rows: matched.filter((row) => String(row.oem_no || "").trim()).length,
    vehicle_rows: matched.filter((row) => String(row.vehicle || "").trim()).length,
    image_rows: matched.filter((row) => String(row.image_url || "").trim()).length,
    hs_rows: matched.filter((row) => String(row.hs_code || "").trim()).length,
    origin_rows: matched.filter((row) => String(row.origin || "").trim()).length,
    weight_rows: matched.filter((row) => String(row.weight_kg || "").trim()).length,
    discontinued_rows: matched.filter((row) => String(row.lifecycle_status || "") === "discontinued").length,
    replacement_rows: replacementPayload.length,
    error_rows: errors.length,
    matched_csv: matchedCsvPath,
    errors_csv: errorsCsvPath,
    processed_batches: processedBatches,
    refresh_existing: refreshExisting,
    discover_missing: discoverMissing,
    missing_only: missingOnly,
    image_column_supported: supportsImageColumn,
  };

  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(summary, null, 2));
}

async function resolveTargets(brandInput) {
  const requested = brandInput
    ? dedupeStrings(
        brandInput
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean),
      ).map((value) => normalizeBrandKey(value))
    : BRAND_CONFIGS.map((brand) => brand.key);

  const brands = await fetchAll(`${supabaseUrl}/rest/v1/brands?select=id,name,organization_id&order=name.asc`);
  const rows = Array.isArray(brands) ? brands : [];
  const defaultOrganizationId = rows.find((row) => String(row.organization_id || "").trim())?.organization_id
    ? String(rows.find((row) => String(row.organization_id || "").trim())?.organization_id || "").trim()
    : "";
  const targets = [];

  for (const config of BRAND_CONFIGS) {
    if (!requested.includes(config.key)) continue;
    let brand = rows.find((row) => {
      const name = normalizeBrandKey(row.name || "");
      return [config.key, ...config.aliases.map((alias) => normalizeBrandKey(alias))].includes(name);
    });
    if ((!brand?.id || !brand?.organization_id) && defaultOrganizationId) {
      brand = await createBrandRow(defaultOrganizationId, config.internalName);
      rows.push(brand);
      console.error(`Created missing target brand: ${config.internalName}`);
    }
    if (!brand?.id || !brand?.organization_id) {
      console.error(`Skipping ${config.internalName}: target brand not found and no default organization was resolved`);
      continue;
    }
    targets.push({
      ...config,
      brand_id: String(brand.id),
      organization_id: String(brand.organization_id),
      brand_name: String(brand.name || config.internalName),
    });
  }

  if (!targets.length) {
    throw new Error("No ZF Aftermarket target brands were resolved");
  }
  return targets;
}

async function fetchCatalogRows(target) {
  const results = [];
  const pageLimit = 1000;
  let offset = 0;
  while (true) {
    const response = await fetch(
      `${supabaseUrl}/rest/v1/catalog_products?select=organization_id,brand_id,product_code,normalized_code,description,oem_no,vehicle,hs_code,origin,weight_kg,image_url,lifecycle_status,lifecycle_note&brand_id=eq.${encodeURIComponent(target.brand_id)}&limit=${pageLimit}&offset=${offset}`,
      { headers },
    );
    const text = await response.text();
    const rows = text ? JSON.parse(text) : [];
    if (!response.ok) {
      throw new Error(`catalog_products fetch failed for ${target.internalName}: ${response.status} ${text}`);
    }
    if (!Array.isArray(rows) || rows.length === 0) break;
    results.push(
      ...rows
        .map((row) => ({
          organization_id: String(row.organization_id || target.organization_id).trim(),
          brand_id: String(row.brand_id || target.brand_id).trim(),
          product_code: normalizeCatalogDisplayCode(String(row.product_code || "").trim(), target.internalName),
          normalized_code: normalizeCode(row.normalized_code || row.product_code || ""),
          description: String(row.description || "").trim(),
          oem_no: String(row.oem_no || "").trim(),
          vehicle: String(row.vehicle || "").trim(),
          hs_code: String(row.hs_code || "").trim(),
          origin: String(row.origin || "").trim(),
          weight_kg: row.weight_kg == null ? null : Number(row.weight_kg),
          image_url: String(row.image_url || "").trim(),
          lifecycle_status: normalizeLifecycleStatus(row.lifecycle_status),
          lifecycle_note: String(row.lifecycle_note || "").trim(),
        }))
        .filter((row) => row.product_code && row.normalized_code),
    );
    if (rows.length < pageLimit) break;
    offset += pageLimit;
  }
  return dedupeBy(results, (row) => row.normalized_code);
}

function buildSeedPrefixes(rows) {
  return dedupeStrings(
    rows
      .map((row) => row.normalized_code)
      .filter((value) => String(value || "").length >= 3)
      .map((value) => String(value).slice(0, 3)),
  );
}

function filterRowsByPrefixes(rows, prefixes) {
  if (!Array.isArray(prefixes) || prefixes.length === 0) return rows;
  return rows.filter((row) => prefixes.some((prefix) => String(row.normalized_code || "").startsWith(prefix)));
}

async function crawlOfficialPrefixes({ target, prefixes, errors }) {
  const results = new Map();
  await runPool(prefixes, searchConcurrency, async (prefix, index) => {
    try {
      const items = await fetchAllSearchItems(target, prefix);
      for (const item of items) {
        if (!item.normalized_code) continue;
        if (!results.has(item.normalized_code)) {
          results.set(item.normalized_code, item);
        }
      }
    } catch (error) {
      errors.push({
        brand_name: target.internalName,
        product_code: prefix,
        normalized_code: prefix,
        source_url: "",
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if ((index + 1) % 50 === 0 || index + 1 === prefixes.length) {
      console.error(`${target.internalName} search prefix progress: ${index + 1}/${prefixes.length}`);
    }
    if (sleepMs > 0) {
      await sleep(sleepMs);
    }
  });
  return results;
}

async function fetchAllSearchItems(target, term) {
  const firstPage = await fetchSearchPage(target, term, 0);
  const items = [...firstPage.items];
  const totalItems = Number(firstPage.totalItems || items.length) || items.length;
  for (let offset = firstPage.items.length; offset < totalItems; offset += searchPageSize) {
    const page = await fetchSearchPage(target, term, offset);
    items.push(...page.items);
    if (!page.items.length) break;
  }
  return dedupeBy(items, (item) => item.normalized_code);
}

async function fetchSearchPage(target, term, offset) {
  const url = new URL("https://aftermarket.zf.com/api/search");
  url.searchParams.set("term", term);
  url.searchParams.set("country", "TR");
  url.searchParams.set("expand", "extended,special");
  url.searchParams.set("ipp", String(searchPageSize));
  url.searchParams.set("offset", String(offset));
  url.searchParams.set("filters", `brandname=${target.officialFilter}`);
  url.searchParams.set("language", "en");

  const payload = await fetchJson(url.toString());
  const productPayload = payload?.products;
  if (!productPayload) {
    throw new Error(`ZF search payload missing for ${target.internalName} term ${term}`);
  }
  const items = (productPayload.items || []).map((item) => normalizeSearchItem(target, item)).filter((item) => item.normalized_code);
  return {
    totalItems: Number(productPayload.pagination?.totalItems || items.length) || items.length,
    items,
  };
}

function normalizeSearchItem(target, item) {
  const productCode = normalizeCatalogDisplayCode(
    cleanText(item.productNumber || item.number || "").replace(/\+/g, " "),
    target.internalName,
  );
  const normalizedCode = normalizeCode(productCode);
  const imageUrl = String(item.productImage?.images?.[0]?.src || "").trim();
  return {
    brand_name: target.internalName,
    product_code: productCode,
    normalized_code: normalizedCode,
    description: formatOfficialDescription(target, item.name || ""),
    source_url: String(item.moreDetails?.href || item.productDetailsPageHref || "").trim()
      ? `https://aftermarket.zf.com${String(item.moreDetails?.href || item.productDetailsPageHref || "").trim()}`
      : "",
    image_url: imageUrl,
    lifecycle_status: normalizeLifecycleStatus(item.status?.value || item.status?.key),
    lifecycle_note: buildLifecycleNoteFromStatus(item.status, null),
  };
}

async function resolveOfficialDetail(target, productCode) {
  const candidates = dedupeStrings(buildArticleCandidates(target, productCode));
  let lastError = null;
  for (const candidate of candidates) {
    try {
      const detailPayload = await fetchArticle(target, candidate);
      if (detailPayload?.details?.number) {
        return normalizeDetailPayload(target, detailPayload);
      }
    } catch (error) {
      lastError = error;
    }
  }

  const exactSearch = await fetchSearchPage(target, normalizeCode(productCode), 0);
  const exactItem = exactSearch.items.find((item) => item.normalized_code === normalizeCode(productCode)) || exactSearch.items[0] || null;
  if (exactItem?.product_code) {
    for (const candidate of buildArticleCandidates(target, exactItem.product_code)) {
      try {
        const detailPayload = await fetchArticle(target, candidate);
        if (detailPayload?.details?.number) {
          return normalizeDetailPayload(target, detailPayload);
        }
      } catch (error) {
        lastError = error;
      }
    }
  }

  throw lastError || new Error(`Official ZF article not found for ${productCode}`);
}

function buildArticleCandidates(target, productCode) {
  const raw = normalizeCatalogDisplayCode(cleanText(productCode).replace(/\+/g, " "), target.internalName);
  const compact = normalizeCode(productCode);
  const candidates = [raw, compact];
  if (compact && compact !== raw) {
    candidates.push(normalizeCatalogDisplayCode(compact, target.internalName));
  }
  return candidates.filter(Boolean);
}

async function fetchArticle(target, articleCode) {
  const url = new URL(`https://aftermarket.zf.com/api/articles/${encodeURIComponent(articleCode)}`);
  url.searchParams.set("expand", "specifications,extended");
  url.searchParams.set("country", "TR");
  url.searchParams.set("language", "en");
  return fetchJson(url.toString(), { accept404: true });
}

function normalizeDetailPayload(target, payload) {
  const details = payload?.details || {};
  const specifications = payload?.specifications?.content || {};
  const generalSpecifications = Array.isArray(specifications.generalSpecifications?.specifications)
    ? specifications.generalSpecifications.specifications
    : [];
  const referenceNumbers = Array.isArray(specifications.referenceNumbers?.referenceNumbers)
    ? specifications.referenceNumbers.referenceNumbers
    : [];
  const textModules = Array.isArray(details.textModules?.values) ? details.textModules.values : [];
  const detailNumber = normalizeCatalogDisplayCode(cleanText(details.number || ""), target.internalName);
  const oemNumbers = [];
  for (const referenceGroup of referenceNumbers) {
    const label = cleanText(referenceGroup.label || "");
    for (const value of referenceGroup.values || []) {
      const number = cleanText(value.text || value || "");
      if (!number) continue;
      oemNumbers.push(label ? `${label} ${number}` : number);
    }
  }

  const imageUrl = chooseBestImage(details.images || []);
  const specEntries = [];
  const specText = [];
  for (const spec of generalSpecifications) {
    const label = cleanText(spec.label || "");
    const values = Array.isArray(spec.values) ? spec.values.map((value) => cleanText(value.text || value)).filter(Boolean) : [];
    if (!values.length) continue;
    specEntries.push({ label, values });
    specText.push(`${label}: ${values.join(", ")}`);
  }
  const vehicle = dedupeStrings([
    ...extractVehicleTokens([...textModules, ...specText].join(" | ")),
    ...extractVehicleTokens(referenceNumbers.map((group) => cleanText(group.label || "")).join(" | ")),
  ]).join(", ");
  const status = details.status || {};
  const replacedByValues = Array.isArray(details.replacedBy?.values) ? details.replacedBy.values : [];
  const replacementCodeRaw = cleanText(replacedByValues[0]?.text || "");
  const replacementCode = replacementCodeRaw ? normalizeCatalogDisplayCode(replacementCodeRaw, target.internalName) : "";
  const relatedCodes = dedupeStrings([
    ...collectRelatedCodes(specifications.partsList?.parts || []),
    ...collectRelatedCodes(specifications.inPartsList?.parts || []),
    replacementCode,
  ]);
  const hsCode = extractSpecValue(specEntries, [
    /commodity\s*code/i,
    /customs\s*tariff/i,
    /tariff\s*(?:number|code)/i,
    /customs\s*code/i,
    /g[\s-]*tip/i,
  ]);
  const origin = normalizeOriginCode(
    extractSpecValue(specEntries, [
      /country\s*of\s*origin/i,
      /origin/i,
      /mense/i,
      /ulke/i,
    ]),
  );

  return {
    product_code: detailNumber,
    description: formatOfficialDescription(target, details.name || ""),
    source_url: detailNumber ? `https://aftermarket.zf.com/tr/catalog/products/${encodeURIComponent(detailNumber)}` : "",
    oem_no: sanitizeCatalogOemNumbers(dedupeStrings(oemNumbers).join(", ")),
    vehicle,
    hs_code: hsCode,
    origin,
    weight_kg: extractWeightKg(details),
    image_url: imageUrl,
    lifecycle_status: normalizeLifecycleStatus(status.value || status.key),
    lifecycle_note: buildLifecycleNoteFromStatus(status, replacementCode),
    replacement_code: replacementCode,
    replacement_reason: replacementCode ? `Replacement code: ${replacementCode}. ZF Aftermarket official source.` : "",
    related_codes: relatedCodes,
  };
}

function collectRelatedCodes(parts) {
  const values = [];
  for (const part of parts || []) {
    for (const value of part.values || []) {
      const text = cleanText(value.text || value || "");
      if (!text) continue;
      values.push(text);
    }
  }
  return values;
}

function chooseBestImage(images) {
  for (const image of images || []) {
    const src = String(image?.src || "").trim();
    if (src) return src;
  }
  return "";
}

function extractWeightKg(details) {
  const productTypeWeight = details.productTypes?.find((item) => item?.grossWeight || item?.netWeight);
  const first = cleanText(productTypeWeight?.grossWeight || productTypeWeight?.netWeight || "");
  if (first) {
    const parsed = parseWeight(first);
    if (parsed != null) return parsed;
  }
  return parseWeight(details.mainStage?.weight?.value || "");
}

function buildLifecycleNoteFromStatus(status, replacementCode) {
  const value = cleanText(status?.value || "");
  const key = Number(status?.key || 0);
  if (replacementCode) {
    return value
      ? `Replacement code: ${replacementCode}. Official status: ${value}.`
      : `Replacement code: ${replacementCode}.`;
  }
  if (key && key !== 1) {
    return value ? `Official status: ${value}.` : "Official status marks this product as unavailable.";
  }
  return "";
}

function mergeCatalogRow({ target, existing, searchItem, detail }) {
  const productCode = normalizeCatalogDisplayCode(
    detail.product_code || searchItem?.product_code || existing?.product_code || "",
    target.internalName,
  );
  return {
    organization_id: target.organization_id,
    brand_id: target.brand_id,
    product_code: productCode,
    description: detail.description || searchItem?.description || existing?.description || "",
    oem_no: sanitizeCatalogOemNumbers(detail.oem_no || existing?.oem_no || ""),
    vehicle: detail.vehicle || existing?.vehicle || "",
    hs_code: detail.hs_code || existing?.hs_code || "",
    origin: detail.origin || existing?.origin || "",
    weight_kg: detail.weight_kg ?? existing?.weight_kg ?? null,
    image_url: detail.image_url || searchItem?.image_url || existing?.image_url || "",
    lifecycle_status: detail.lifecycle_status || searchItem?.lifecycle_status || existing?.lifecycle_status || "active",
    lifecycle_note: detail.lifecycle_note || searchItem?.lifecycle_note || existing?.lifecycle_note || "",
  };
}

async function resolveExtraCodes({ target, extraCodes, existingByCode, processedCodes, errors }) {
  const items = [];
  for (const code of extraCodes) {
    const normalizedCode = normalizeCode(code);
    if (!normalizedCode || existingByCode.has(normalizedCode)) continue;
    try {
      const page = await fetchSearchPage(target, normalizedCode, 0);
      const match = page.items.find((item) => item.normalized_code === normalizedCode) || page.items[0] || null;
      if (!match) continue;
      if (processedCodes.has(match.normalized_code)) continue;
      processedCodes.add(match.normalized_code);
      items.push({
        target,
        searchItem: match,
      });
    } catch (error) {
      errors.push({
        brand_name: target.internalName,
        product_code: code,
        normalized_code,
        source_url: "",
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (sleepMs > 0) {
      await sleep(sleepMs);
    }
  }
  return items;
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetch(url, {
      headers: requestHeaders,
      signal: controller.signal,
    });
    const text = await response.text();
    const payload = text ? JSON.parse(text) : {};
    if (options.accept404 && response.status === 404) {
      return payload;
    }
    if (!response.ok) {
      throw new Error(`${response.status} ${payload?.message || payload?.statusMessage || text}`.trim());
    }
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchAll(url) {
  const response = await fetch(url, { headers });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : [];
  if (!response.ok) {
    throw new Error(`Supabase fetch failed: ${response.status} ${text}`);
  }
  return payload;
}

async function createBrandRow(organizationId, brandName) {
  const response = await fetch(`${supabaseUrl}/rest/v1/brands`, {
    method: "POST",
    headers: {
      ...headers,
      Prefer: "resolution=merge-duplicates,return=representation",
    },
    body: JSON.stringify([
      {
        organization_id: organizationId,
        name: brandName,
      },
    ]),
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : [];
  if (!response.ok) {
    throw new Error(`brand create failed for ${brandName}: ${response.status} ${text}`);
  }
  const brand = Array.isArray(payload) ? payload[0] : payload;
  if (!brand?.id || !brand?.organization_id) {
    throw new Error(`brand create returned invalid payload for ${brandName}`);
  }
  return {
    id: String(brand.id).trim(),
    organization_id: String(brand.organization_id).trim(),
    name: String(brand.name || brandName).trim() || brandName,
  };
}

async function detectCatalogImageColumn() {
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

async function upsertCatalogBatch(payload) {
  const response = await fetch(`${supabaseUrl}/rest/v1/catalog_products?on_conflict=organization_id,brand_id,normalized_code`, {
    method: "POST",
    headers: {
      ...headers,
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`catalog_products upsert failed: ${response.status} ${text}`);
  }
  return { status: response.status };
}

async function upsertCodeReferenceBatch(payload) {
  const response = await fetch(`${supabaseUrl}/rest/v1/item_code_references?on_conflict=organization_id,brand_id,normalized_old_code`, {
    method: "POST",
    headers: {
      ...headers,
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`item_code_references upsert failed: ${response.status} ${text}`);
  }
  return { status: response.status };
}

function shouldProcessRow(row) {
  if (!normalizeTextValue(row.oem_no)) return true;
  if (!normalizeTextValue(row.vehicle)) return true;
  if (!normalizeTextValue(row.hs_code)) return true;
  if (!normalizeTextValue(row.origin)) return true;
  if (!normalizeTextValue(row.image_url)) return true;
  if (row.weight_kg == null || Number.isNaN(Number(row.weight_kg))) return true;
  if (normalizeLifecycleStatus(row.lifecycle_status) === "discontinued" && !normalizeTextValue(row.lifecycle_note)) return true;
  return false;
}

function hasCatalogDelta(existing, next) {
  return (
    normalizeTextValue(existing.description) !== normalizeTextValue(next.description) ||
    normalizeTextValue(existing.oem_no) !== normalizeTextValue(next.oem_no) ||
    normalizeTextValue(existing.vehicle) !== normalizeTextValue(next.vehicle) ||
    normalizeTextValue(existing.hs_code) !== normalizeTextValue(next.hs_code) ||
    normalizeTextValue(existing.origin) !== normalizeTextValue(next.origin) ||
    Number(existing.weight_kg ?? null) !== Number(next.weight_kg ?? null) ||
    normalizeTextValue(existing.image_url) !== normalizeTextValue(next.image_url) ||
    normalizeTextValue(existing.lifecycle_status) !== normalizeTextValue(next.lifecycle_status) ||
    normalizeTextValue(existing.lifecycle_note) !== normalizeTextValue(next.lifecycle_note)
  );
}

async function runPool(items, concurrencyLimit, worker) {
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

function writeCsv(filePath, headersRow, rows) {
  const lines = [headersRow, ...rows].map((row) => row.map((cell) => toCsvCell(cell)).join(","));
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
}

function toCsvCell(value) {
  const text = value == null ? "" : String(value);
  if (/["\n,]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function parseWeight(value) {
  const text = String(value || "").replace(",", ".").trim();
  if (!text) return null;
  const match = text.match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

function extractVehicleTokens(raw) {
  const text = cleanText(raw);
  if (!text) return [];
  const hits = [];
  const normalized = ` ${text.toUpperCase()} `;
  for (const entry of KNOWN_MANUFACTURER_PATTERNS) {
    const matchIndex = normalized.search(entry.pattern);
    if (matchIndex < 0) continue;
    hits.push({ label: entry.label, index: matchIndex });
  }
  return dedupeStrings(
    hits
      .sort((left, right) => left.index - right.index)
      .map((item) => item.label),
  );
}

function extractVehicleList(raw) {
  return extractVehicleTokens(raw).join(", ");
}

function extractSpecValue(entries, patterns) {
  for (const entry of entries) {
    if (!patterns.some((pattern) => pattern.test(entry.label))) continue;
    const value = entry.values.join(", ").trim();
    if (value) return value;
  }
  return "";
}

function normalizeOriginCode(value) {
  const raw = cleanText(value);
  if (!raw) return "";
  const compact = raw
    .toUpperCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Z]/g, "");
  if (ORIGIN_CODES[compact]) return ORIGIN_CODES[compact];
  const upper = raw.toUpperCase();
  if (/^[A-Z]{2,3}$/.test(upper)) return upper;
  return raw;
}

function formatOfficialDescription(target, value) {
  const cleaned = cleanText(value);
  if (!cleaned) return "";
  const stripped = stripBrandPrefix(cleaned, target);
  if (isMostlyUppercase(stripped)) return toTitleCase(stripped);
  if (stripped === stripped.toLowerCase()) return stripped.replace(/^\p{Ll}/u, (letter) => letter.toUpperCase());
  return stripped;
}

function stripBrandPrefix(value, target) {
  const aliases = dedupeStrings([target?.internalName || "", ...(target?.aliases || []), target?.officialFilter || ""]);
  let result = value;
  for (const alias of aliases) {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/Ö/g, "[ÖO]").replace(/ö/g, "[öo]");
    result = result.replace(new RegExp(`^${escaped}\\s+`, "i"), "").trim();
  }
  return result;
}

function isMostlyUppercase(value) {
  const letters = value.match(/[A-Za-z]/g) || [];
  if (!letters.length) return false;
  const uppercase = letters.filter((letter) => letter === letter.toUpperCase()).length;
  return uppercase / letters.length >= 0.75;
}

function toTitleCase(value) {
  return value
    .toLowerCase()
    .replace(/\b([a-z])/g, (match) => match.toUpperCase())
    .replace(/\bZf\b/g, "ZF")
    .replace(/\bTrw\b/g, "TRW")
    .replace(/\bBoge\b/g, "Boge");
}

function normalizeBrandKey(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function normalizeLifecycleStatus(value) {
  const text = String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
  if (!text) return "active";
  return /discontinued|obsolete|replaced|replacement only|superceded|superseded|production ended|production end|production stopped|not in production|no longer deliverable|no longer available|not supplied|end of life|article ended|ended|teslim edilemiyor|unavailable|not available|sunulmuyor|uretimden|artik sunulmuyor|kaldirilacak/.test(text)
    ? "discontinued"
    : "active";
}

function sanitizeCatalogOemNumbers(value) {
  const raw = String(value || "").replace(/\r/g, "\n").trim();
  if (!raw) return "";
  const parts = raw
    .split(/[,;\n|]+/g)
    .map((part) => part.trim())
    .filter(Boolean);
  const values = new Set();
  for (const part of parts.length ? parts : [raw]) {
    const digitGroups = part.match(/\d+/g) || [];
    if (!digitGroups.length) continue;
    const longGroups = digitGroups.filter((group) => group.length >= 4);
    if (longGroups.length >= 2) {
      for (const group of longGroups) values.add(group);
      continue;
    }
    const compact = digitGroups.join("");
    if (compact.length >= 4) values.add(compact);
  }
  return [...values].join(", ");
}

function cleanText(value) {
  return String(value || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeCode(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function dedupeBy(items, keyFn) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const key = keyFn(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

function dedupeStrings(values) {
  return dedupeBy(values.map((value) => String(value || "").trim()).filter(Boolean), (value) => normalizeTextValue(value));
}

function normalizeTextValue(value) {
  return String(value || "").replace(/\s+/g, " ").trim().toLowerCase();
}

function emptyToNull(value) {
  const text = String(value || "").trim();
  return text ? text : null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
