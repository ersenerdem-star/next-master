const PLACEHOLDER_IMAGE_PATTERN =
  /placeholder|image[-_]?not[-_]?available|no[-_]?image|noimage|not[-_]?available|coming[-_]?soon|default[-_]?image/i;

export function normalizeCatalogPartNumber(value) {
  return String(value || "").replace(/\s+/g, "");
}

export function normalizeCatalogBrand(value) {
  const normalized = String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase("en-US");

  if (/^bf$/.test(normalized)) return "bf";
  if (/^pierburg$/.test(normalized)) return "pierburg";
  if (/^trw engine components?$/.test(normalized) || normalized === "trw") return "trw";
  return normalized;
}

export function isUsableCatalogImage(value) {
  const url = String(value || "").trim();
  return /^https:\/\//i.test(url) && !PLACEHOLDER_IMAGE_PATTERN.test(url);
}

export function validateSparetoEnrichment(primary, secondary) {
  if (!secondary || secondary.status !== "accepted") {
    return {
      accepted: false,
      reason: String(secondary?.reason || "SECONDARY_NOT_ACCEPTED"),
    };
  }

  if (secondary.exact_brand_match !== true || secondary.exact_code_match !== true) {
    return { accepted: false, reason: "EXACT_MATCH_EVIDENCE_MISSING" };
  }

  if (
    normalizeCatalogBrand(primary?.brand) !== normalizeCatalogBrand(secondary?.brand) ||
    normalizeCatalogPartNumber(primary?.product_code) !==
      normalizeCatalogPartNumber(secondary?.product_code)
  ) {
    return { accepted: false, reason: "PRIMARY_SECONDARY_IDENTITY_MISMATCH" };
  }

  return { accepted: true, reason: "" };
}

export function mergeMotorserviceSparetoCandidate(primary, secondary) {
  const validation = validateSparetoEnrichment(primary, secondary);
  const merged = structuredClone(primary);
  const sourceUrl = String(secondary?.source_url || "").trim();
  const appliedFields = [];

  if (validation.accepted) {
    if (
      !isPositiveNumber(merged.weight_kg) &&
      isPositiveNumber(secondary.weight_kg)
    ) {
      merged.weight_kg = Number(secondary.weight_kg);
      appliedFields.push("weight_kg");
    }
    if (!String(merged.hs_code || "").trim() && isHsCode(secondary.hs_code_candidate)) {
      merged.hs_code = String(secondary.hs_code_candidate);
      appliedFields.push("hs_code");
    }
    if (
      !String(merged.origin || "").trim() &&
      isOriginCode(secondary.origin_short_code_candidate)
    ) {
      merged.origin = String(secondary.origin_short_code_candidate).toUpperCase();
      merged.origin_source_value = String(secondary.origin_raw || "").trim();
      appliedFields.push("origin");
    }
    if (
      !isUsableCatalogImage(merged.image_url) &&
      isUsableCatalogImage(secondary.image_url_candidate)
    ) {
      merged.image_url = String(secondary.image_url_candidate).trim();
      appliedFields.push("image_url");
    }
  }

  const fitmentTruncated = (Array.isArray(primary?.fitment_outcomes)
    ? primary.fitment_outcomes
    : []
  ).some((outcome) => outcome?.truncated === true);
  const remainingTargetFields = [
    !isPositiveNumber(merged.weight_kg) ? "weight_kg" : "",
    !String(merged.hs_code || "").trim() ? "hs_code" : "",
    !String(merged.origin || "").trim() ? "origin" : "",
  ].filter(Boolean);

  let readiness = "READY_STAGED_CANDIDATE";
  if (fitmentTruncated) {
    readiness = "REVIEW_REQUIRED_TRUNCATED_FITMENT";
  } else if (primary?.fitment_review_status === "no_fitment_data") {
    readiness = "REVIEW_REQUIRED_NO_FITMENT";
  } else if (!validation.accepted && remainingTargetFields.length) {
    readiness = "REVIEW_REQUIRED_SECONDARY_NOT_FOUND";
  } else if (remainingTargetFields.length) {
    readiness = "REVIEW_REQUIRED_TARGET_FIELDS_MISSING";
  }

  merged.normalized_code = normalizeCatalogPartNumber(merged.product_code);
  merged.missing_fields = currentMissingFields(merged);
  merged.image_policy = isUsableCatalogImage(primary?.image_url)
    ? "OFFICIAL_MOTORSERVICE"
    : isUsableCatalogImage(merged.image_url)
      ? "EXACT_SPARETO_SECONDARY"
      : "BRAND_LOGO_FALLBACK";
  merged.brand_logo_fallback_required = merged.image_policy === "BRAND_LOGO_FALLBACK";
  merged.enrichment = {
    secondary_source: "Spareto",
    source_url: sourceUrl,
    status: validation.accepted ? "accepted" : "rejected",
    reason: validation.reason,
    applied_fields: appliedFields,
    overwrite_existing_primary_fields: false,
    raw_values: validation.accepted
      ? {
          weight: String(secondary.weight_raw || "").trim(),
          customs_code: String(secondary.customs_code_raw || "").trim(),
          origin: String(secondary.origin_raw || "").trim(),
        }
      : null,
  };
  merged.readiness = readiness;
  merged.production_import_authorized = false;
  merged.database_write = false;
  merged.production_write = false;
  return merged;
}

function currentMissingFields(row) {
  const fields = [];
  for (const [field, value] of [
    ["ean", row?.ean],
    ["description", row?.description],
    ["oem_no", row?.oem_no],
    ["vehicle_model", row?.vehicle_model],
    ["weight_kg", row?.weight_kg],
    ["hs_code", row?.hs_code],
    ["origin", row?.origin],
  ]) {
    if (value == null || value === "") fields.push(field);
  }
  if (!isUsableCatalogImage(row?.image_url)) fields.push("image_url");
  return fields;
}

function isPositiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0;
}

function isHsCode(value) {
  return /^\d{6,12}$/.test(String(value || "").trim());
}

function isOriginCode(value) {
  return /^[A-Za-z]{2}$/.test(String(value || "").trim());
}
