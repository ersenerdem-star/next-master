import type { Config, Context } from "@netlify/functions";
import { requireCallerProfile } from "./_shared/auth.mts";
import { json, readJson } from "./_shared/http.mts";
import { syncBrandCatalog } from "./_shared/catalog-sync-provider.mts";
import { sanitizeUserFacingError } from "./_shared/user-message.mts";

export default async (req: Request, _context: Context) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const caller = await requireCallerProfile(req, ["superadmin"]);
    if ("error" in caller) return json({ error: caller.error }, caller.status);

    const body = await readJson<{ brandName?: string; refreshExisting?: boolean }>(req);
    const brandName = String(body.brandName || "").trim();
    if (!brandName) {
      return json({ error: "Brand name is required" }, 400);
    }

    const result = await syncBrandCatalog({
      supabaseUrl: caller.supabaseUrl,
      serviceRoleKey: caller.serviceRoleKey,
      brandName,
      refreshExisting: body.refreshExisting !== false,
      concurrency: 8,
      pageSize: 48,
      requestTimeoutMs: 20000,
    });

    return json({
      ok: true,
      ...result,
    });
  } catch (error) {
    return json({ error: sanitizeUserFacingError(error, "Brand catalog sync failed") }, 500);
  }
};

export const config: Config = {
  path: "/api/admin-sync-brand-catalog",
  method: "POST",
};
