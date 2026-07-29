import type { Config, Context } from "@netlify/functions";
import { getBearerToken } from "./_shared/app-auth.mts";
import { requireCallerProfile } from "./_shared/auth.mts";
import { json } from "./_shared/http.mts";

const API_URL = "https://partsfinder.bilsteingroup.com/api/articles";
const BRAND_NAMES = {
  FEBI: "Febi",
  SWAG: "Swag",
  BLUE_PRINT: "Blue Print",
} as const;

type SupportedBrand = keyof typeof BRAND_NAMES;

type ProductStageRequest = {
  brand?: unknown;
  page?: unknown;
  max_items?: unknown;
};

function parseInteger(value: unknown, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function cleanText(value: unknown) {
  const text = String(value ?? "").trim();
  return text || null;
}

function readProductCode(article: Record<string, unknown>) {
  const attributes = (article.attributes || {}) as Record<string, unknown>;
  const candidates = [
    attributes.articleNumber,
    attributes.article_number,
    attributes.productNumber,
    attributes.product_number,
    attributes.productCode,
    attributes.product_code,
    attributes.number,
    attributes.code,
    attributes.sku,
    article.id,
  ];
  return candidates.map(cleanText).find(Boolean) || null;
}

function readDescription(article: Record<string, unknown>) {
  const attributes = (article.attributes || {}) as Record<string, unknown>;
  const candidates = [
    attributes.productDescription,
    attributes.product_description,
    attributes.articleDescription,
    attributes.article_description,
    attributes.shortDescription,
    attributes.short_description,
    attributes.description,
    attributes.name,
    attributes.title,
  ];
  for (const candidate of candidates) {
    if (candidate && typeof candidate === "object") {
      const localized = candidate as Record<string, unknown>;
      const text = cleanText(localized.en || localized.de || localized.tr || localized.name || localized.label || localized.value);
      if (text) return text;
    }
    const text = cleanText(candidate);
    if (text) return text;
  }
  return null;
}

function parseRequest(body: ProductStageRequest) {
  const brand = String(body.brand || "").trim().toUpperCase().replace(/[\s-]+/g, "_");
  if (!(brand in BRAND_NAMES)) throw new Error("brand must be FEBI, SWAG, or BLUE_PRINT.");

  const page = parseInteger(body.page, 0);
  if (page < 0 || page > 10000) throw new Error("page must be an integer between 0 and 10000.");

  const maxItems = parseInteger(body.max_items, 10);
  if (maxItems < 1 || maxItems > 25) throw new Error("max_items must be an integer between 1 and 25.");

  return { brand: brand as SupportedBrand, page, maxItems };
}

export async function handleCatalogBilsteinGroupProductStageRequest(
  req: Request,
  _context: Context,
  deps = { requireCallerProfile },
) {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!getBearerToken(req)) return json({ error: "Missing caller token" }, 401);

  let caller;
  try {
    caller = await deps.requireCallerProfile(req, ["admin", "superadmin"]);
  } catch {
    return json({ error: "Provider staging is temporarily unavailable." }, 503);
  }
  if ("error" in caller) return json({ error: caller.error }, caller.status);

  let input;
  try {
    input = parseRequest((await req.json()) as ProductStageRequest);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Invalid request." }, 400);
  }

  const url = new URL(API_URL);
  url.searchParams.set("page[number]", String(input.page));
  url.searchParams.set("page[size]", String(input.maxItems));
  url.searchParams.set("filter[brands]", input.brand);
  url.searchParams.set("filter[country]", "TR");
  url.searchParams.set("filter[vehicleType]", "CAR");

  let payload: { data?: unknown };
  try {
    const response = await fetch(url, {
      headers: {
        Accept: "application/vnd.api+json",
        "User-Agent": "Next-Master Bilstein Group stage-only collector",
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      console.warn("bilstein_group_source_non_success", {
        status: response.status,
        statusText: response.statusText,
      });
      return json(
        {
          error: `Bilstein Group source returned HTTP ${response.status}. No catalog data was staged.`,
        },
        502,
      );
    }
    payload = (await response.json()) as { data?: unknown };
  } catch (error) {
    console.warn("bilstein_group_source_request_failed", {
      message: error instanceof Error ? error.message : "unknown error",
    });
    return json({ error: "Bilstein Group source request timed out." }, 504);
  }

  const articles = Array.isArray(payload.data) ? payload.data : [];
  const rows = articles
    .filter((article): article is Record<string, unknown> => Boolean(article) && typeof article === "object")
    .map((article, rowIndex) => ({
      row_index: rowIndex,
      brand: BRAND_NAMES[input.brand],
      product_code: readProductCode(article),
      description: readDescription(article),
      market_segment: "aftermarket",
    }))
    .filter((row) => Boolean(row.product_code));

  if (!rows.length) return json({ error: "Bilstein Group returned no stageable products for this page." }, 422);

  return json({
    brand: BRAND_NAMES[input.brand],
    rows,
    source_scope: {
      provider: "bilstein_group_partsfinder",
      source_url: url.toString(),
      source_brand: input.brand,
      country: "TR",
      vehicle_type: "CAR",
      page: input.page,
      max_items: input.maxItems,
      collector_mode: "stage_only",
    },
  });
}

export default async (req: Request, context: Context) =>
  handleCatalogBilsteinGroupProductStageRequest(req, context);

export const config: Config = {
  path: "/api/catalog/bilstein-group/product-stage",
  method: "POST",
};
