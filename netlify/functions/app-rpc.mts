import type { Config, Context } from "@netlify/functions";
import { json, sendJson } from "./_shared/http.mts";
import { resolveCaller } from "./_shared/app-auth.mts";

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

export default async (req: Request, _context: Context) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const supabaseUrl = Netlify.env.get("SUPABASE_URL");
  const supabaseAnonKey = Netlify.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Netlify.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !supabaseAnonKey || !serviceRoleKey) {
    return json({ error: "Missing Netlify environment variables for app RPC" }, 500);
  }

  try {
    const caller = await resolveCaller(req, supabaseUrl, supabaseAnonKey, serviceRoleKey);
    const body = await req.json().catch(() => ({}));
    const name = String(body?.name || "").trim();
    const args = body?.args && typeof body.args === "object" ? body.args : {};

    if (!ALLOWED_RPCS.has(name)) {
      return json({ error: "RPC is not allowed through app gateway" }, 403);
    }

    if (name === "admin_list_org_users" && caller.role !== "admin") {
      return json({ error: "Admin access required" }, 403);
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
    return json({ error: error instanceof Error ? error.message : "App RPC request failed" }, 400);
  }
};

export const config: Config = {
  path: "/api/app-rpc",
  method: "POST",
};
