import type { Config } from "@netlify/functions";
import { json } from "./_shared/http.mts";

const BREMBO_HOME_URL = "https://www.bremboparts.com/europe/en";
const BREMBO_SEARCH_CODE_URL = `${BREMBO_HOME_URL}/catalogue/search/searchcode`;

const requestHeaders = {
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
  "cache-control": "no-cache",
  pragma: "no-cache",
};

type CatalogProductMediaItem = {
  src: string;
  label: string;
};

type BremboSessionContext = {
  token: string;
  cookieHeader: string;
};

export default async (req: Request) => {
  if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);

  try {
    const url = new URL(req.url);
    const brand = normalizeTextValue(url.searchParams.get("brand") || "");
    const code = normalizeTextValue(url.searchParams.get("code") || "");
    const imageUrl = normalizeTextValue(url.searchParams.get("image_url") || "");

    if (!brand || !code) {
      return json({ error: "brand and code are required" }, 400);
    }

    const items =
      normalizeBrand(brand) === "BREMBO"
        ? await fetchBremboMediaByCode(code, imageUrl)
        : buildDefaultMedia(imageUrl);

    return json({ ok: true, items });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Media load failed" }, 400);
  }
};

async function fetchBremboMediaByCode(code: string, currentImageUrl: string): Promise<CatalogProductMediaItem[]> {
  const session = await createBremboSessionContext(20000);
  const searchResult = await postBremboJson<{ url?: string }>(
    session,
    BREMBO_SEARCH_CODE_URL,
    { code },
    BREMBO_HOME_URL,
    20000,
  );
  const detailPath = normalizeTextValue(searchResult?.url || "");
  if (!detailPath) return buildDefaultMedia(currentImageUrl);

  const detailUrl = asAbsoluteBremboUrl(detailPath);
  const detailHtml = await fetchText(detailUrl, 20000);
  const items = extractBremboGallery(detailHtml, currentImageUrl);
  return items.length ? items : buildDefaultMedia(currentImageUrl);
}

function extractBremboGallery(detailHtml: string, currentImageUrl: string) {
  const primary =
    asAbsoluteBremboUrl(
      firstMatch(detailHtml, /<img[^>]+src="([^"]*\/media\/product\/images\/1920-1920-[^"]+)"[^>]*alt="[^"]*"[^>]*\/?>/i),
    ) ||
    asAbsoluteBremboUrl(firstMatch(detailHtml, /<div class="image">\s*<img[^>]+src="([^"]*\/media\/product\/images\/[^"]+)"/i)) ||
    normalizeTextValue(currentImageUrl);

  const drawing =
    asAbsoluteBremboUrl(
      firstMatch(
        detailHtml,
        /<div id="ProductDrawingZoomImage_[^"]+" class="image">\s*<img[^>]+src="([^"]*\/media\/product\/images\/1920-1920-[^"]+)"/i,
      ),
    ) || "";

  const items = dedupeMedia([
    primary ? { src: primary, label: "Product" } : null,
    drawing ? { src: drawing, label: "Drawing" } : null,
  ]);
  return items;
}

function buildDefaultMedia(imageUrl: string): CatalogProductMediaItem[] {
  const src = normalizeTextValue(imageUrl);
  return src ? [{ src, label: "Product" }] : [];
}

async function createBremboSessionContext(requestTimeoutMs: number): Promise<BremboSessionContext> {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetch(BREMBO_HOME_URL, {
      headers: requestHeaders,
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Brembo session bootstrap failed: ${response.status}`);
    const html = await response.text();
    const token = firstMatch(html, /name="__RequestVerificationToken"[^>]+value="([^"]+)"/i);
    const cookieHeader = extractCookieHeader(response);
    if (!token) throw new Error("Brembo session bootstrap missing RequestVerificationToken");
    if (!cookieHeader) throw new Error("Brembo session bootstrap missing cookies");
    return { token, cookieHeader };
  } finally {
    clearTimeout(timeoutHandle);
  }
}

async function postBremboJson<T>(
  session: BremboSessionContext,
  url: string,
  payload: Record<string, unknown>,
  referrerUrl: string,
  requestTimeoutMs: number,
) {
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        ...requestHeaders,
        accept: "application/json, text/plain, */*",
        "content-type": "application/json; charset=UTF-8",
        "x-requested-with": "XMLHttpRequest",
        RequestVerificationToken: session.token,
        Cookie: session.cookieHeader,
        Referer: referrerUrl,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Brembo request failed ${response.status} for ${url}`);
    return (await response.json().catch(() => ({}))) as T;
  } finally {
    clearTimeout(timeoutHandle);
  }
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

function extractCookieHeader(response: Response) {
  const headerBag = response.headers as Headers & { getSetCookie?: () => string[] };
  const rawCookies = typeof headerBag.getSetCookie === "function" ? headerBag.getSetCookie() : [];
  const fallbackCookie = response.headers.get("set-cookie");
  const cookies = (rawCookies.length ? rawCookies : fallbackCookie ? [fallbackCookie] : [])
    .map((value) => String(value || "").split(";")[0].trim())
    .filter(Boolean);
  return cookies.join("; ");
}

function dedupeMedia(items: Array<CatalogProductMediaItem | null>) {
  const seen = new Set<string>();
  return items.filter((item): item is CatalogProductMediaItem => {
    if (!item?.src) return false;
    if (seen.has(item.src)) return false;
    seen.add(item.src);
    return true;
  });
}

function normalizeBrand(value: string) {
  return String(value || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function normalizeTextValue(value: unknown) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function asAbsoluteBremboUrl(value: string) {
  const text = normalizeTextValue(value);
  if (!text) return "";
  if (/^https?:\/\//i.test(text)) return text;
  return `https://www.bremboparts.com${text.startsWith("/") ? text : `/${text}`}`;
}

function firstMatch(value: string, pattern: RegExp) {
  const match = value.match(pattern);
  return match?.[1] || "";
}

export const config: Config = {
  path: "/api/catalog-product-media",
  method: "GET",
};
