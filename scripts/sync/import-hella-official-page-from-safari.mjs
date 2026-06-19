import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { parseHellaOfficialProductPage } from "../../netlify/functions/_shared/catalog/hella-official-page.mts";

function resolveEnvValue(name) {
  const direct = String(process.env[name] || "").trim();
  if (direct) return direct;
  return String(execFileSync("npx", ["netlify", "env:get", name, "--context", "production"], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }) || "").trim();
}

function parseArg(name) {
  const prefix = `${name}=`;
  return String(process.argv.find((arg) => arg.startsWith(prefix)) || "").slice(prefix.length).trim();
}

function normalizeCode(value) {
  return String(value || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "")
    .trim();
}

function getSafariHellaPage() {
  const script = `
tell application "Safari"
  repeat with w in windows
    repeat with t in tabs of w
      if (URL of t as text) contains "shop.hella.com" then
        set tabUrl to URL of t as text
        set pageHtml to do JavaScript "document.documentElement.outerHTML" in t
        return tabUrl & "~~~HELLA_HTML_BOUNDARY~~~" & pageHtml
      end if
    end repeat
  end repeat
end tell
`;
  const output = execFileSync("osascript", ["-e", script], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  const [sourceUrl = "", html = ""] = output.split("~~~HELLA_HTML_BOUNDARY~~~");
  if (!html.trim()) throw new Error("No open Safari HELLA product page was found");
  return { sourceUrl: sourceUrl.trim(), html };
}

async function fetchJson(url, headers, init = {}) {
  const response = await fetch(url, { ...init, headers: { ...headers, ...(init.headers || {}) } });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${text}`);
  }
  return payload;
}

async function main() {
  const htmlFile = parseArg("--html-file");
  const explicitUrl = parseArg("--url");
  const page = htmlFile
    ? { sourceUrl: explicitUrl, html: readFileSync(htmlFile, "utf8") }
    : getSafariHellaPage();
  const sourceUrl = explicitUrl || page.sourceUrl;
  const detail = parseHellaOfficialProductPage(page.html, sourceUrl);

  const supabaseUrl = resolveEnvValue("SUPABASE_URL").replace(/\/+$/, "");
  const serviceRoleKey = resolveEnvValue("SUPABASE_SERVICE_ROLE_KEY");
  const headers = {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    "Content-Type": "application/json",
  };

  const brands = await fetchJson(`${supabaseUrl}/rest/v1/brands?select=id,name,organization_id&name=eq.Hella&limit=1`, headers);
  const brand = Array.isArray(brands) ? brands[0] : null;
  if (!brand?.id || !brand?.organization_id) {
    throw new Error("Hella brand not found in live database");
  }

  const existing = await fetchJson(
    `${supabaseUrl}/rest/v1/catalog_products?select=id,product_code,ean,description,lifecycle_status,lifecycle_note,replacement_old_code,replacement_code,replacement_reason&brand_id=eq.${encodeURIComponent(brand.id)}&normalized_code=eq.${encodeURIComponent(detail.normalized_code)}&limit=1`,
    headers,
  );
  const existingRow = Array.isArray(existing) ? existing[0] : null;

  const payload = {
    organization_id: brand.organization_id,
    brand_id: brand.id,
    product_code: detail.product_code,
    ean: detail.ean,
    description: detail.description || null,
    image_url: detail.image_url || null,
  };

  if (existingRow?.lifecycle_status) {
    payload.lifecycle_status = existingRow.lifecycle_status;
  }
  if (existingRow?.lifecycle_note) {
    payload.lifecycle_note = existingRow.lifecycle_note;
  }
  if (existingRow?.replacement_old_code) {
    payload.replacement_old_code = existingRow.replacement_old_code;
  }
  if (existingRow?.replacement_code) {
    payload.replacement_code = existingRow.replacement_code;
  }
  if (existingRow?.replacement_reason) {
    payload.replacement_reason = existingRow.replacement_reason;
  }
  if (existingRow?.description && !payload.description) {
    payload.description = existingRow.description;
  }

  await fetchJson(`${supabaseUrl}/rest/v1/catalog_products?on_conflict=organization_id,brand_id,normalized_code`, headers, {
    method: "POST",
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify(payload),
  });

  const verify = await fetchJson(
    `${supabaseUrl}/rest/v1/catalog_products?select=product_code,normalized_code,ean,description,image_url&brand_id=eq.${encodeURIComponent(brand.id)}&normalized_code=eq.${encodeURIComponent(normalizeCode(detail.product_code))}&limit=1`,
    headers,
  );

  console.log(
    JSON.stringify(
      {
        status: "ok",
        action: existingRow ? "updated" : "inserted",
        sourceUrl: detail.source_url,
        parsed: detail,
        liveRow: Array.isArray(verify) ? verify[0] || null : null,
      },
      null,
      2,
    ),
  );
}

await main();
