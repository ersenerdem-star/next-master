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

    const body = await readJson<{ brandName?: string; refreshExisting?: boolean }>(req);
    const brandName = String(body.brandName || "").trim();
    if (brandName.toLowerCase() !== "kolbenschmidt") {
      return json({ error: "This bounded background import is only enabled for Kolbenschmidt." }, 400);
    }
    const refreshExisting = body.refreshExisting === true;
    // Spareto currently caps this listing at 48 rows even when a larger value is requested.
    const pageSize = 48;

    let page = 1;
    let lastPage = 1;
    let resolvedRows = 0;
    let errorRows = 0;
    let replacementRows = 0;

    do {
      let pageResult: Awaited<ReturnType<typeof syncBrandCatalog>> | null = null;
      let lastError: unknown = null;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          pageResult = await syncBrandCatalog({
            supabaseUrl: caller.supabaseUrl,
            serviceRoleKey: caller.serviceRoleKey,
            organizationId: caller.profile.organization_id,
            brandName: "Kolbenschmidt",
            refreshExisting: false,
            onlyNew: !refreshExisting,
            concurrency: 24,
            pageSize,
            requestTimeoutMs: 20000,
            startPage: page,
            maxPages: 1,
          });
          break;
        } catch (error) {
          lastError = error;
          if (attempt < 3) {
            await wait(attempt * 2000);
          }
        }
      }
      if (!pageResult) throw lastError;
      lastPage = Math.max(page, Number(pageResult.listingLastPage || page));
      resolvedRows += Number(pageResult.resolvedRows || 0);
      errorRows += Number(pageResult.errorRows || 0);
      replacementRows += Number(pageResult.replacementRows || 0);
      const nextSequentialPage = page + Math.max(1, Number(pageResult.listingPagesProcessed || 1));
      if (!refreshExisting && page === 1) {
        const estimatedResumePage = Math.max(2, Math.floor(Number(pageResult.existingRows || 0) / pageSize) - 1);
        page = Math.max(nextSequentialPage, Math.min(estimatedResumePage, lastPage));
      } else {
        page = nextSequentialPage;
      }
      if (page <= lastPage) await wait(750);
    } while (page <= lastPage);

    return json({
      ok: true,
      mode: "background",
      refreshExisting,
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

function wait(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
