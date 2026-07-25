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

    let page = 1;
    let lastPage = 1;
    let resolvedRows = 0;
    let errorRows = 0;
    let replacementRows = 0;

    do {
      const pageResult = await syncBrandCatalog({
        supabaseUrl: caller.supabaseUrl,
        serviceRoleKey: caller.serviceRoleKey,
        brandName: "Kolbenschmidt",
        refreshExisting: false,
        onlyNew: true,
        concurrency: 24,
        pageSize: 96,
        requestTimeoutMs: 20000,
        startPage: page,
        maxPages: 1,
      });
      lastPage = Math.max(page, Number(pageResult.listingLastPage || page));
      resolvedRows += Number(pageResult.resolvedRows || 0);
      errorRows += Number(pageResult.errorRows || 0);
      replacementRows += Number(pageResult.replacementRows || 0);
      page += Math.max(1, Number(pageResult.listingPagesProcessed || 1));
    } while (page <= lastPage);

    return json({
      ok: true,
      mode: "background",
      targetBrandName: "Kolbenschmidt",
      listingLastPage: lastPage,
      resolvedRows,
      errorRows,
      replacementRows,
    });
  } catch (error) {
    return json({ error: sanitizeUserFacingError(error, "Kolbenschmidt bulk import failed") }, 500);
  }
};

export const config: Config = {
  path: "/api/admin-sync-brand-catalog-background",
  method: "POST",
};
