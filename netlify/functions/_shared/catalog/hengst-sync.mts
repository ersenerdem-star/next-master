import { isCatalogPlaceholderDescription, normalizeCatalogDescription, normalizeCatalogDisplayCode, pickCatalogDescription } from "./catalog-standardization.mts";

export type HengstResolvedPage = {
  product_code: string;
  internal_item_number: string;
  description: string;
  ean_number: string;
  oem_no: string;
  vehicle: string;
  image_url: string;
};

export async function syncBrandCatalogFromHengstConnect(_input: {
  supabaseUrl: string;
  serviceRoleKey: string;
  brandName: string;
  refreshExisting?: boolean;
  concurrency?: number;
  pageSize?: number;
  requestTimeoutMs?: number;
  seedPrefixes?: string[];
}) {
  throw new Error(
    "Hengst official source is currently blocking automated server-side access with Cloudflare 403. When access is available, use the visible title code like 'E340H D247' as product_code, not the numeric item number.",
  );
}

export function extractHengstResolvedPage(html: string): HengstResolvedPage {
  const titleCode = normalizeCatalogDisplayCode(extractProductTitleCode(html), "Hengst");
  const internalItemNumber = extractLabelValue(html, "Item number");
  const description =
    pickCatalogDescription([extractDescription(html), extractMetaDescription(html), extractSupportDescription(html)], titleCode) ||
    "";
  const eanNumber = extractLabelValue(html, "EAN number");
  const oemNumbers = extractHengstOemNumbers(html);
  const vehicles = extractHengstVehiclePreview(html);
  const imageUrl = extractHengstPrimaryImage(html);

  return {
    product_code: titleCode,
    internal_item_number: internalItemNumber,
    description,
    ean_number: eanNumber,
    oem_no: oemNumbers.join(", "),
    vehicle: vehicles.join(" | "),
    image_url: imageUrl,
  };
}

function extractProductTitleCode(html: string): string {
  const headingMatch = html.match(/<h1[^>]*>\s*([^<]+?)\s*<\/h1>/i);
  if (headingMatch?.[1]) return headingMatch[1].trim();

  const ogTitleMatch = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  if (ogTitleMatch?.[1]) return ogTitleMatch[1].trim();

  throw new Error("Unable to extract Hengst product title code from official page");
}

function extractDescription(html: string): string {
  const headingBlockMatch = html.match(/<h1[^>]*>[\s\S]*?<\/h1>[\s\S]{0,600}/i);
  if (headingBlockMatch?.[0]) {
    const nearbyText = decodeHtml(headingBlockMatch[0].replace(/<[^>]+>/g, " "))
      .replace(/\s+/g, " ")
      .trim();
    const titleCode = extractProductTitleCode(html);
    const cleaned = nearbyText
      .replace(titleCode, "")
      .replace(/Item number:\s*[A-Z0-9 ]+/i, "")
      .replace(/EAN number:\s*[A-Z0-9 ]+/i, "")
      .trim();
    if (cleaned) {
      return cleaned.split(/\s{2,}/)[0] || cleaned;
    }
  }

  return extractMetaDescription(html);
}

function extractSupportDescription(html: string): string {
  const snippets = [
    /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+name=["']twitter:description["'][^>]+content=["']([^"']+)["']/i,
  ];
  for (const pattern of snippets) {
    const match = html.match(pattern);
    const value = match?.[1] ? decodeHtml(match[1]).trim() : "";
    if (value && !isCatalogPlaceholderDescription(value, "")) return normalizeCatalogDescription(value);
  }
  return "";
}

function extractMetaDescription(html: string): string {
  const match = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i);
  return match?.[1]?.trim() || "";
}

function extractLabelValue(html: string, label: string): string {
  const escaped = escapeRegExp(label);
  const inlineMatch = html.match(new RegExp(`${escaped}:?\\s*<\\/[^>]+>\\s*<[^>]*>\\s*([^<]+?)\\s*<\\/[^>]+>`, "i"));
  if (inlineMatch?.[1]) return decodeHtml(inlineMatch[1]).trim();

  const textMatch = html.match(new RegExp(`${escaped}:?\\s*([^<\\n\\r]+)`, "i"));
  if (textMatch?.[1]) return decodeHtml(textMatch[1]).trim();

  return "";
}

function extractHengstOemNumbers(html: string): string[] {
  const rows = [...html.matchAll(/<tr[^>]*>\s*<td[^>]*>\s*([^<]+?)\s*<\/td>\s*<td[^>]*>\s*([^<]+?)\s*<\/td>\s*<\/tr>/gi)];
  const values = new Set<string>();
  for (const row of rows) {
    const code = decodeHtml(row[1] || "").trim();
    const manufacturer = decodeHtml(row[2] || "").trim();
    if (!code || !manufacturer) continue;
    values.add(code);
  }
  return [...values];
}

function extractHengstVehiclePreview(html: string): string[] {
  const values = new Set<string>();
  const rows = [...html.matchAll(/Vehicle Application[\s\S]{0,5000}?<tr[^>]*>([\s\S]*?)<\/tr>/gi)];
  for (const row of rows) {
    const text = decodeHtml(String(row[1] || "").replace(/<[^>]+>/g, " "))
      .replace(/\s+/g, " ")
      .trim();
    if (text) values.add(text);
  }
  return [...values];
}

function extractHengstPrimaryImage(html: string): string {
  const galleryMatch = html.match(/Images for [\s\S]{0,1500}?<img[^>]+src=["']([^"']+)["']/i);
  if (galleryMatch?.[1]) return decodeHtml(galleryMatch[1]).trim();

  const firstImageMatch = html.match(/<img[^>]+src=["']([^"']+)["'][^>]*>/i);
  return firstImageMatch?.[1] ? decodeHtml(firstImageMatch[1]).trim() : "";
}

function decodeHtml(value: string): string {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function escapeRegExp(value: string): string {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
