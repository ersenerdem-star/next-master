import crypto from "node:crypto";

export const SOURCE_KEY = "zf_sachs_official_observation";
export const SOURCE_DISPLAY_NAME = "ZF SACHS Official Observation";
export const JOB_KEY = "nm-catalog-wp2b-zf-sachs-pilot";
export const ALLOWED_FIELD_FAMILIES = new Set(["image_reference", "supplemental_description"]);
export const MAX_CODES = 5;
export const MAX_OBSERVATIONS = 10;
export const MAX_SOURCE_CONCURRENCY = 2;

export function normalizeCode(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

export function normalizeWhitespace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

export function parseArgs(argv = process.argv.slice(2)) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) continue;
    const [rawKey, rawValue] = token.slice(2).split("=", 2);
    const key = rawKey.trim();
    if (rawValue != null) {
      args.set(key, rawValue);
      continue;
    }
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      args.set(key, next);
      index += 1;
    } else {
      args.set(key, "true");
    }
  }
  return args;
}

export function parseCodeList(value) {
  const entries = String(value || "")
    .split(",")
    .map((entry) => ({ input: entry.trim(), normalized: normalizeCode(entry) }))
    .filter((entry) => entry.input && entry.normalized);
  const seen = new Set();
  const unique = [];
  for (const entry of entries) {
    if (seen.has(entry.normalized)) continue;
    seen.add(entry.normalized);
    unique.push(entry);
  }
  return unique;
}

export function validateCliOptions(options) {
  const errors = [];
  if (!options.organizationId) errors.push("organization ID is required");
  if (!options.actorId) errors.push("actor ID is required");
  if (String(options.brand || "").trim().toUpperCase() !== "SACHS") errors.push("brand must equal SACHS");
  if (!options.codes.length) errors.push("explicit product-code list is required");
  if (options.codes.length > MAX_CODES) errors.push(`at most ${MAX_CODES} unique product codes are allowed`);
  if (!options.dryRun && !options.confirmProduction) errors.push("real production execution requires --confirm-production");
  return errors;
}

export function buildObservationInputs({ product, source }) {
  const observations = [];
  const observedAt = source.observed_at || new Date().toISOString();
  const externalRef = normalizeWhitespace(source.external_product_ref || source.product_code || product.product_code);
  const evidenceUrl = normalizeWhitespace(source.source_url || "");

  const imageUrl = normalizeWhitespace(source.image_url || "");
  if (imageUrl) {
    observations.push(buildObservation({
      product,
      fieldFamily: "image_reference",
      fieldName: "image_url",
      rawValue: imageUrl,
      normalizedValue: imageUrl,
      evidenceUrl,
      externalProductRef: externalRef,
      observedAt,
    }));
  }

  const description = normalizeWhitespace(source.description || "");
  if (description) {
    observations.push(buildObservation({
      product,
      fieldFamily: "supplemental_description",
      fieldName: "description",
      rawValue: source.description,
      normalizedValue: description,
      evidenceUrl,
      externalProductRef: externalRef,
      observedAt,
    }));
  }

  return observations;
}

function buildObservation({ product, fieldFamily, fieldName, rawValue, normalizedValue, evidenceUrl, externalProductRef, observedAt }) {
  if (!ALLOWED_FIELD_FAMILIES.has(fieldFamily)) {
    throw new Error(`Unsupported field family: ${fieldFamily}`);
  }
  const canonicalEvidence = stableJson({
    source_key: SOURCE_KEY,
    brand_name: "Sachs",
    product_code: product.product_code,
    normalized_code: product.normalized_code,
    external_product_ref: externalProductRef,
    field_family: fieldFamily,
    field_name: fieldName,
    normalized_value: normalizedValue,
    evidence_url: evidenceUrl,
  });
  const evidenceHash = sha256(canonicalEvidence);
  return {
    input_product_code: product.product_code,
    input_normalized_code: product.normalized_code,
    input_field_family: fieldFamily,
    input_field_name: fieldName,
    input_raw_value: String(rawValue || ""),
    input_normalized_value: normalizedValue,
    input_evidence_reference: `${SOURCE_KEY}:${product.normalized_code}:${fieldFamily}:${fieldName}:${evidenceHash}`,
    input_evidence_url: evidenceUrl || null,
    input_evidence_hash: evidenceHash,
    input_evidence_payload: {
      source_key: SOURCE_KEY,
      source_name: SOURCE_DISPLAY_NAME,
      brand_name: "Sachs",
      product_id: product.id,
      product_code: product.product_code,
      normalized_code: product.normalized_code,
      external_product_ref: externalProductRef,
      field_family: fieldFamily,
      field_name: fieldName,
      value: normalizedValue,
      evidence_url: evidenceUrl || null,
    },
    input_external_product_ref: externalProductRef || null,
    input_confidence: 0.8,
    input_observed_at: observedAt,
  };
}

export function stableJson(value) {
  return JSON.stringify(sortForJson(value));
}

function sortForJson(value) {
  if (Array.isArray(value)) return value.map(sortForJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortForJson(value[key])]));
}

export function sha256(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

export async function runPool(items, concurrencyLimit, worker) {
  let active = 0;
  let maxActive = 0;
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrencyLimit, items.length) }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        await worker(items[index], index);
      } finally {
        active -= 1;
      }
    }
  });
  await Promise.all(runners);
  return { maxActive };
}

export function deriveFinalStatus({ appendedCount, failureCount }) {
  if (appendedCount <= 0) return "failed";
  if (failureCount > 0) return "completed_with_warnings";
  return "succeeded";
}

export function buildCheckpointCursor({ codes, observations }) {
  const summary = observations.map((item) => ({
    normalized_code: item.input_normalized_code,
    field_family: item.input_field_family,
    field_name: item.input_field_name,
    evidence_hash: item.input_evidence_hash,
  }));
  return `manual:${sha256(stableJson({ codes: codes.map((code) => code.normalized).sort(), observations: summary }))}`;
}
