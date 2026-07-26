#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import {
  mergeMotorserviceSparetoCandidate,
  normalizeCatalogBrand,
  normalizeCatalogPartNumber,
} from "./_shared/spareto-catalog-enrichment.mjs";

const [
  ,
  ,
  primaryPath,
  secondaryPath,
  outputPath,
  summaryPath,
] = process.argv;

if (!primaryPath || !secondaryPath || !outputPath || !summaryPath) {
  throw new Error(
    "Usage: build-motorservice-spareto-import-candidate.mjs <primary.json> <secondary.json> <output.json> <summary.json>",
  );
}

const primary = JSON.parse(readFileSync(primaryPath, "utf8"));
const secondary = JSON.parse(readFileSync(secondaryPath, "utf8"));
const secondaryByIdentity = new Map(
  secondary.results.map((row) => [identity(row), row]),
);

const rows = primary.rows.map((row) =>
  mergeMotorserviceSparetoCandidate(row, secondaryByIdentity.get(identity(row))),
);
const generatedAt = new Date().toISOString();
const candidate = {
  schema_version: "1.0.0",
  generated_at: generatedAt,
  scope:
    "local staged import candidate; official Motorservice primary and exact Spareto secondary; no database or production write",
  merge_policy: {
    primary: "official_motorservice_guest",
    secondary: "Spareto exact brand+code only",
    part_number_normalization: "remove whitespace only; preserve all punctuation",
    overwrite_non_empty_primary: false,
    missing_image: "brand logo fallback; never blank in UI",
  },
  rows,
};

const readiness = countBy(rows, (row) => row.readiness);
const byBrand = Object.values(
  rows.reduce((acc, row) => {
    const key = row.brand;
    acc[key] ||= {
      brand: key,
      products: 0,
      secondary_accepted: 0,
      enriched_weight: 0,
      enriched_hs_code: 0,
      enriched_origin: 0,
      image_official: 0,
      image_secondary: 0,
      image_brand_logo_fallback: 0,
      ready_staged_candidates: 0,
      review_required: 0,
    };
    const entry = acc[key];
    entry.products += 1;
    if (row.enrichment.status === "accepted") entry.secondary_accepted += 1;
    if (row.enrichment.applied_fields.includes("weight_kg")) entry.enriched_weight += 1;
    if (row.enrichment.applied_fields.includes("hs_code")) entry.enriched_hs_code += 1;
    if (row.enrichment.applied_fields.includes("origin")) entry.enriched_origin += 1;
    if (row.image_policy === "OFFICIAL_MOTORSERVICE") entry.image_official += 1;
    if (row.image_policy === "EXACT_SPARETO_SECONDARY") entry.image_secondary += 1;
    if (row.image_policy === "BRAND_LOGO_FALLBACK") entry.image_brand_logo_fallback += 1;
    if (row.readiness === "READY_STAGED_CANDIDATE") entry.ready_staged_candidates += 1;
    else entry.review_required += 1;
    return acc;
  }, {}),
);

const summary = {
  schema_version: "1.0.0",
  generated_at: generatedAt,
  total_products: rows.length,
  secondary_accepted: rows.filter((row) => row.enrichment.status === "accepted").length,
  secondary_rejected: rows.filter((row) => row.enrichment.status !== "accepted").length,
  target_field_coverage: {
    weight_kg: rows.filter((row) => Number(row.weight_kg) > 0).length,
    hs_code: rows.filter((row) => String(row.hs_code || "").trim()).length,
    origin: rows.filter((row) => String(row.origin || "").trim()).length,
  },
  catalog_field_coverage: {
    ean: rows.filter((row) => String(row.ean || "").trim()).length,
    description: rows.filter((row) => String(row.description || "").trim()).length,
    oem_no: rows.filter((row) => String(row.oem_no || "").trim()).length,
    vehicle_model: rows.filter((row) => String(row.vehicle_model || "").trim()).length,
    replacement_codes: rows.filter((row) => row.replacement_codes?.length).length,
    superseded_by_codes: rows.filter((row) => row.superseded_by_codes?.length).length,
    alternative_codes: rows.filter((row) => row.alternative_codes?.length).length,
  },
  image_policy: countBy(rows, (row) => row.image_policy),
  readiness,
  review_queue: rows
    .filter((row) => row.readiness !== "READY_STAGED_CANDIDATE")
    .map((row) => ({
      brand: row.brand,
      product_code: row.product_code,
      readiness: row.readiness,
      secondary_reason: row.enrichment.reason,
      remaining_missing_fields: row.missing_fields,
    })),
  by_brand: byBrand,
  production_import_authorized: false,
  database_write: false,
  production_write: false,
};

writeFileSync(outputPath, `${JSON.stringify(candidate, null, 2)}\n`, "utf8");
writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");

const candidateHash = sha256(readFileSync(outputPath));
const summaryHash = sha256(readFileSync(summaryPath));
console.log(
  JSON.stringify(
    {
      output_path: outputPath,
      output_sha256: candidateHash,
      summary_path: summaryPath,
      summary_sha256: summaryHash,
      summary,
    },
    null,
    2,
  ),
);

function identity(row) {
  return `${normalizeCatalogBrand(row?.brand)}::${normalizeCatalogPartNumber(
    row?.product_code,
  )}`;
}

function countBy(items, selector) {
  return items.reduce((counts, item) => {
    const key = selector(item);
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
