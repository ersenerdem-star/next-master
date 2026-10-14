import type { Config, Context } from "@netlify/functions";
import { json, sendJson } from "./_shared/http.mts";
import { resolveSupplierUpgradeAdmin, supplierUpgradeServiceHeaders, SupplierUpgradeError } from "./_shared/supplier-upgrade-auth.mts";
import { supplierVerifiedUploadTargetEnabled, supplierUploadTargetPauseMessage } from './_shared/supplier-upload-target.mts';

// Narrow read-only companion for the verified upload screen. The legacy
// supplier-price listing RPCs remain superadmin-only; this endpoint exposes
// only the current organization’s supplier/brand ids to an authenticated
// admin or superadmin who can manage supplier prices.
export default async (req: Request, _context: Context) => {
  if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);
  if (!supplierVerifiedUploadTargetEnabled(req.url)) return json({error:supplierUploadTargetPauseMessage},503);
  const supabaseUrl = Netlify.env.get("SUPABASE_URL");
  const anon = Netlify.env.get("SUPABASE_ANON_KEY");
  const service = Netlify.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !anon || !service) return json({ error: "System configuration is incomplete." }, 500);
  try {
    const caller = await resolveSupplierUpgradeAdmin(req, supabaseUrl, anon, service);
    const headers = supplierUpgradeServiceHeaders(service);
    const filter = encodeURIComponent(caller.organizationId);
    async function readRows<T>(url: string) {
      return sendJson<T>(url, { headers, timeoutMs: 8_000 });
    }
    const [suppliers, brands] = await Promise.all([
      readRows<Array<{ id: string; name: string; is_active: boolean }>>(`${supabaseUrl}/rest/v1/suppliers?select=id,name,is_active&organization_id=eq.${filter}&order=name`),
      readRows<Array<{ id: string; name: string }>>(`${supabaseUrl}/rest/v1/brands?select=id,name&organization_id=eq.${filter}&order=name`),
    ]);
    return json({
      suppliers: (suppliers || []).map((row) => ({ supplier_id: row.id, name: row.name, is_active: row.is_active !== false, line_count: 0, latest_price_date: null, old_or_unknown_count: 0 })),
      brands: (brands || []).map((row) => ({ id: row.id, name: row.name })),
    });
  } catch (error) {
    if (error instanceof SupplierUpgradeError) return json({ error: error.message }, error.status);
    console.error("supplier upload options failed");
    if (error instanceof Error && "status" in error) {
      const upstream = error as Error & { status?: unknown; code?: unknown };
      return json({
        error: "Supplier upload options could not be loaded.",
        code: error.name,
        upstream_status: typeof upstream.status === "number" ? upstream.status : null,
        upstream_code: typeof upstream.code === "string" && upstream.code ? upstream.code : null,
      }, 503);
    }
    return json({ error: "Supplier upload options could not be loaded.", code: error instanceof Error ? error.name : "UnknownError" }, 503);
  }
};

export const config: Config = { path: "/api/supplier-price-upload-options" };
