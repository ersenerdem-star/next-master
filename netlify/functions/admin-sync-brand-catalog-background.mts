import type { Config, Context } from "@netlify/functions";
import { requireCallerProfile } from "./_shared/auth.mts";
import { json, readJson } from "./_shared/http.mts";
import { syncBrandCatalog } from "./_shared/catalog/catalog-sync-provider.mts";
import { sanitizeUserFacingError } from "./_shared/user-message.mts";

export default async (req: Request, _context: Context) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const caller = await requireCallerProfile(req, ["superadmin"]);
    if ("error" in caller) return json({ error: caller.error }, caller.status);

    const body = await readJson<{ brandName?: string }>(req);
    const brandName = String(body.brandName || "").trim();
    if (brandName.toLowerCase() !== "kolbenschmidt") {
      return json({ error: "This bounded background import is only enabled for Kolbenschmidt." }, 400);
    }

    const result = await syncBrandCatalog({
      supabaseUrl: caller.supabaseUrl,
      serviceRoleKey: caller.serviceRoleKey,
      brandName: "Kolbenschmidt",
      refreshExisting: true,
      concurrency: 24,
      pageSize: 96,
      requestTimeoutMs: 20000,
    });

    return json({
      ok: true,
      mode: "background",
      ...result,
    });
  } catch (error) {
    return json({ error: sanitizeUserFacingError(error, "Kolbenschmidt bulk import failed") }, 500);
  }
};

export const config: Config = {
  path: "/api/admin-sync-brand-catalog-background",
  method: "POST",
};
