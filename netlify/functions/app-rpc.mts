import type { Config, Context } from "@netlify/functions";
import { buildRestUrl, json, readJson, sendJson, serviceRoleHeaders } from "./_shared/http.mts";
import { resolveCaller } from "./_shared/app-auth.mts";
import { canAccessCustomerOps, canAccessOperationsModules, isSuperadminRole } from "./_shared/roles.mts";
import { sanitizeUserFacingError } from "./_shared/user-message.mts";

const ALLOWED_RPCS = new Set([
  "admin_list_org_users",
  "bulk_import_catalog",
  "bulk_import_supplier_prices",
  "cloud_catalog_page",
  "cloud_master_page",
  "cloud_quote_supplier_options",
  "cloud_resolve_quote_line",
  "cloud_supplier_brand_summary",
  "cloud_supplier_price_page",
  "deactivate_supplier_prices_by_filter",
  "get_cloud_quote",
  "list_cloud_quotes",
  "list_cloud_suppliers",
  "touch_user_presence",
]);

const SUPERADMIN_RPCS = new Set([
  "admin_list_org_users",
  "bulk_import_catalog",
  "bulk_import_supplier_prices",
  "cloud_catalog_page",
  "cloud_supplier_brand_summary",
  "cloud_supplier_price_page",
  "deactivate_supplier_prices_by_filter",
  "list_cloud_suppliers",
]);

const OPERATIONS_RPCS = new Set([
  "cloud_master_page",
]);

const CUSTOMER_STAFF_RPCS = new Set([
  "cloud_quote_supplier_options",
  "cloud_resolve_quote_line",
  "get_cloud_quote",
  "list_cloud_quotes",
  "touch_user_presence",
]);

type CatalogSourceRow = {
  id?: string | null;
  product_code?: string | null;
  description?: string | null;
  oem_no?: string | null;
  hs_code?: string | null;
  origin?: string | null;
  weight_kg?: number | string | null;
  image_url?: string | null;
  brand_id?: string | null;
  normalized_code?: string | null;
  normalized_oem?: string | null;
  lifecycle_status?: string | null;
  lifecycle_note?: string | null;
};

type BrandMapCacheEntry = {
  byId: Map<string, string>;
  byName: Map<string, string>;
  expiresAt: number;
};

const BRAND_MAP_CACHE_TTL_MS = 2 * 60 * 1000;
const brandMapCache = new Map<string, BrandMapCacheEntry>();

function normalizePartCode(value: string) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function normalizeOriginalNumberSearch(value: string) {
  const normalized = normalizePartCode(value);
  if (!normalized) return "";
  const stripped = normalized.replace(/^[A-Z]{1,3}(?=\d{6,}$)/, "");
  return stripped || normalized;
}

function buildLooseOriginalNumberPattern(value: string, wildcard = "*") {
  const normalized = normalizeOriginalNumberSearch(value);
  if (!normalized) return "";
  return normalized.split("").join(wildcard);
}

function buildSeparatorInsensitivePattern(value: string, wildcard = "*") {
  const tokens = String(value || "")
    .toUpperCase()
    .match(/[A-Z0-9]+/g);
  if (!tokens?.length) return "";
  return tokens.join(wildcard);
}

function buildOriginalNumberVariants(value: string) {
  const variants = new Set<string>();
  const normalized = normalizePartCode(value);
  if (normalized) variants.add(normalized);
  const normalizedOriginal = normalizeOriginalNumberSearch(value);
  if (normalizedOriginal) variants.add(normalizedOriginal);
  return [...variants];
}

function splitOriginalNumberCandidates(value: string) {
  const raw = String(value || "").replace(/\r/g, "\n").trim();
  if (!raw) return [];
  const pieces = raw
    .split(/[,;\n|]+/g)
    .map((part) => part.trim())
    .filter(Boolean);
  return pieces.length ? pieces : [raw];
}

function matchesOriginalNumberSearch(haystack: string, needle: string) {
  const needleVariants = buildOriginalNumberVariants(needle);
  if (!needleVariants.length) return false;
  const candidates = splitOriginalNumberCandidates(haystack);
  if (
    candidates.some((candidate) => {
      const candidateVariants = buildOriginalNumberVariants(candidate);
      if (!candidateVariants.length) return false;
      return candidateVariants.some((candidateVariant) =>
        needleVariants.some(
          (needleVariant) =>
            candidateVariant === needleVariant ||
            candidateVariant.includes(needleVariant) ||
            needleVariant.includes(candidateVariant),
        ),
      );
    })
  ) {
    return true;
  }
  const haystackVariants = buildOriginalNumberVariants(haystack);
  return haystackVariants.some((haystackVariant) =>
    needleVariants.some(
      (needleVariant) =>
        haystackVariant === needleVariant ||
        haystackVariant.includes(needleVariant) ||
        needleVariant.includes(haystackVariant),
    ),
  );
}

function shouldRunLooseOriginalNumberSearch(search: string) {
  return normalizeOriginalNumberSearch(search).length >= 6;
}

function isLikelyCatalogCodeSearch(search: string) {
  const value = String(search || "").trim();
  if (!value) return false;
  return /\d/.test(value) || /[-/+.()]/.test(value);
}

function buildCatalogSearchOr(search: string, normalizedSearch: string, mode: "strict" | "loose") {
  const escaped = search.replace(/[%*(),]/g, " ").trim();
  const normalizedOriginalSearch = normalizeOriginalNumberSearch(search);
  const looseOriginalPattern = buildLooseOriginalNumberPattern(search);
  const separatorInsensitivePattern = buildSeparatorInsensitivePattern(search);
  const clauses = new Set<string>();
  const isCodeSearch = isLikelyCatalogCodeSearch(search);

  if (isCodeSearch) {
    if (normalizedSearch.length >= 3) {
      clauses.add(`normalized_code.eq.${normalizedSearch}`);
      clauses.add(`normalized_oem.eq.${normalizedSearch}`);
      clauses.add(`normalized_code.like.${normalizedSearch}*`);
      clauses.add(`normalized_oem.like.${normalizedSearch}*`);
    }
    if (escaped && escaped.length <= 24 && /[A-Z]/i.test(escaped)) {
      clauses.add(`product_code.ilike.${escaped}*`);
      clauses.add(`oem_no.ilike.${escaped}*`);
    }
    if (separatorInsensitivePattern && separatorInsensitivePattern !== escaped.toUpperCase() && /[A-Z]/i.test(separatorInsensitivePattern)) {
      clauses.add(`product_code.ilike.${separatorInsensitivePattern}*`);
      clauses.add(`oem_no.ilike.${separatorInsensitivePattern}*`);
    }
    if (mode === "loose" && normalizedOriginalSearch.length >= 6) {
      clauses.add(`normalized_oem.like.*${normalizedOriginalSearch}*`);
    }
    if (mode === "loose" && looseOriginalPattern.length >= 6 && /[A-Z]/i.test(looseOriginalPattern)) {
      clauses.add(`oem_no.ilike.${looseOriginalPattern}*`);
    }
    return `(${[...clauses].join(",")})`;
  }

  if (escaped) {
    clauses.add(`product_code.ilike.*${escaped}*`);
    clauses.add(`oem_no.ilike.*${escaped}*`);
    clauses.add(`description.ilike.*${escaped}*`);
  }
  if (separatorInsensitivePattern && separatorInsensitivePattern !== escaped.toUpperCase()) {
    clauses.add(`product_code.ilike.*${separatorInsensitivePattern}*`);
    clauses.add(`oem_no.ilike.*${separatorInsensitivePattern}*`);
  }
  if (normalizedSearch.length >= 3) {
    clauses.add(`normalized_code.eq.${normalizedSearch}`);
    clauses.add(`normalized_oem.eq.${normalizedSearch}`);
    clauses.add(`normalized_code.like.${normalizedSearch}*`);
    clauses.add(`normalized_oem.like.${normalizedSearch}*`);
    if (normalizedSearch.length <= 8) {
      clauses.add(`product_code.ilike.*${normalizedSearch}*`);
      clauses.add(`oem_no.ilike.*${normalizedSearch}*`);
    }
  }
  if (mode === "loose" && looseOriginalPattern.length >= 6) {
    clauses.add(`oem_no.ilike.*${looseOriginalPattern}*`);
  }
  if (mode === "loose" && normalizedOriginalSearch.length >= 6) {
    clauses.add(`normalized_oem.like.*${normalizedOriginalSearch}*`);
  }
  return `(${[...clauses].join(",")})`;
}

function dedupeCatalogRows(rows: CatalogSourceRow[]) {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const id = String(row.id || row.product_code || "");
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

function parseContentRangeTotal(value: string | null, fallback: number) {
  if (!value) return fallback;
  const match = value.match(/\/(\d+|\*)$/);
  if (!match || match[1] === "*") return fallback;
  const total = Number(match[1]);
  return Number.isFinite(total) ? total : fallback;
}

async function fetchRestRowsWithCount<T>(
  supabaseUrl: string,
  serviceRoleKey: string,
  table: string,
  params: Record<string, string>,
) {
  const response = await fetch(buildRestUrl(supabaseUrl, table, params), {
    headers: {
      ...serviceRoleHeaders(serviceRoleKey),
      Prefer: "count=planned",
    },
  });
  const data = await readJson<Array<T> & { message?: string; error?: string; msg?: string }>(response);
  if (!response.ok) {
    throw new Error(sanitizeUserFacingError(data?.msg || data?.message || data?.error || "Catalog request failed"));
  }
  return {
    rows: (data ?? []) as T[],
    totalCount: parseContentRangeTotal(response.headers.get("content-range"), Array.isArray(data) ? data.length : 0),
  };
}

async function fetchBrandMaps(supabaseUrl: string, serviceRoleKey: string, organizationId: string) {
  const cached = brandMapCache.get(organizationId);
  if (cached && cached.expiresAt > Date.now()) {
    return { byId: cached.byId, byName: cached.byName };
  }
  const { rows } = await fetchRestRowsWithCount<{ id?: string | null; name?: string | null }>(
    supabaseUrl,
    serviceRoleKey,
    "brands",
    {
      select: "id,name",
      organization_id: `eq.${organizationId}`,
      order: "name.asc",
      limit: "1000",
    },
  );
  const byId = new Map<string, string>();
  const byName = new Map<string, string>();
  for (const row of rows) {
    const id = String(row.id || "").trim();
    const name = String(row.name || "").trim();
    if (!id || !name) continue;
    byId.set(id, name);
    byName.set(normalizePartCode(name), id);
  }
  brandMapCache.set(organizationId, {
    byId,
    byName,
    expiresAt: Date.now() + BRAND_MAP_CACHE_TTL_MS,
  });
  return { byId, byName };
}

async function fetchCloudCatalogPageViaRest(
  supabaseUrl: string,
  serviceRoleKey: string,
  caller: { organizationId: string },
  args: Record<string, unknown>,
) {
  const search = String(args.input_search || "").trim();
  const brand = String(args.input_brand || "").trim();
  const page = Math.max(1, Number(args.input_page || 1) || 1);
  const pageSize = Math.min(250, Math.max(1, Number(args.input_page_size || 50) || 50));
  const offset = (page - 1) * pageSize;
  const normalizedSearch = normalizePartCode(search);
  const brandMaps = await fetchBrandMaps(supabaseUrl, serviceRoleKey, caller.organizationId);
  const selectedBrandId = brand ? brandMaps.byName.get(normalizePartCode(brand)) || "" : "";
  const select =
    "id,product_code,description,oem_no,hs_code,origin,weight_kg,image_url,brand_id,normalized_code,normalized_oem,lifecycle_status,lifecycle_note";
  const baseParams: Record<string, string> = {
    select,
    organization_id: `eq.${caller.organizationId}`,
    order: "product_code.asc",
    limit: String(pageSize),
    offset: String(offset),
  };
  if (selectedBrandId) baseParams.brand_id = `eq.${selectedBrandId}`;
  if (search) {
    baseParams.or = buildCatalogSearchOr(search, normalizedSearch, "strict");
  }

  let { rows, totalCount } = await fetchRestRowsWithCount<CatalogSourceRow>(supabaseUrl, serviceRoleKey, "catalog_products", baseParams);
  if (!rows.length && search && shouldRunLooseOriginalNumberSearch(search)) {
    ({ rows, totalCount } = await fetchRestRowsWithCount<CatalogSourceRow>(supabaseUrl, serviceRoleKey, "catalog_products", {
      ...baseParams,
      or: buildCatalogSearchOr(search, normalizedSearch, "loose"),
    }));
  }

  if (!rows.length && search && shouldRunLooseOriginalNumberSearch(search)) {
    const normalizedOriginalSearch = normalizeOriginalNumberSearch(search);
    const fallbackBase: Record<string, string> = {
      select,
      organization_id: `eq.${caller.organizationId}`,
      order: "product_code.asc",
      limit: "200",
    };
    if (selectedBrandId) fallbackBase.brand_id = `eq.${selectedBrandId}`;
    const fallbackByNormalized = await fetchRestRowsWithCount<CatalogSourceRow>(supabaseUrl, serviceRoleKey, "catalog_products", {
      ...fallbackBase,
      normalized_oem: `like.*${normalizedOriginalSearch}*`,
    }).catch(() => ({ rows: [] as CatalogSourceRow[], totalCount: 0 }));

    const filtered = dedupeCatalogRows(fallbackByNormalized.rows).filter(
      (row) =>
        matchesOriginalNumberSearch(String(row.oem_no || ""), search) ||
        normalizePartCode(String(row.product_code || "")).includes(normalizedSearch),
    );
    totalCount = filtered.length;
    rows = filtered.slice(offset, offset + pageSize);
  }

  return rows.map((row) => ({
    total_count: totalCount,
    product_id: String(row.id || ""),
    product_code: String(row.product_code || ""),
    brand: brandMaps.byId.get(String(row.brand_id || "")) || "",
    image_url: String(row.image_url || ""),
    description: String(row.description || ""),
    oem_no: String(row.oem_no || ""),
    hs_code: String(row.hs_code || ""),
    origin: String(row.origin || ""),
    weight_kg: row.weight_kg == null ? null : Number(row.weight_kg),
    lifecycle_status: String(row.lifecycle_status || ""),
    lifecycle_note: String(row.lifecycle_note || ""),
  }));
}

export default async (req: Request, _context: Context) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const supabaseUrl = Netlify.env.get("SUPABASE_URL");
  const supabaseAnonKey = Netlify.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Netlify.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !supabaseAnonKey || !serviceRoleKey) {
    return json({ error: "System configuration is incomplete." }, 500);
  }

  try {
    const caller = await resolveCaller(req, supabaseUrl, supabaseAnonKey, serviceRoleKey);
    const body = await req.json().catch(() => ({}));
    const name = String(body?.name || "").trim();
    const args = body?.args && typeof body.args === "object" ? body.args : {};

    if (!ALLOWED_RPCS.has(name)) {
      return json({ error: "RPC is not allowed through app gateway" }, 403);
    }

    if (SUPERADMIN_RPCS.has(name) && !isSuperadminRole(caller.role)) {
      return json({ error: "Superadmin access required" }, 403);
    }

    if (OPERATIONS_RPCS.has(name) && !canAccessOperationsModules(caller.role)) {
      return json({ error: "This area is not enabled for your user. Ask superadmin to open the required permission." }, 403);
    }

    if (CUSTOMER_STAFF_RPCS.has(name) && !canAccessCustomerOps(caller.role)) {
      return json({ error: "Staff access required" }, 403);
    }

    if (name === "cloud_catalog_page") {
      const data = await fetchCloudCatalogPageViaRest(supabaseUrl, serviceRoleKey, caller, args);
      return json({ ok: true, data });
    }

    const data = await sendJson<unknown>(`${supabaseUrl}/rest/v1/rpc/${name}`, {
      method: "POST",
      headers: {
        apikey: supabaseAnonKey,
        Authorization: String(req.headers.get("authorization") || ""),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(args),
    });

    return json({ ok: true, data });
  } catch (error) {
    return json({ error: sanitizeUserFacingError(error, "The request could not be completed right now.") }, 400);
  }
};

export const config: Config = {
  path: "/api/app-rpc",
  method: "POST",
};
