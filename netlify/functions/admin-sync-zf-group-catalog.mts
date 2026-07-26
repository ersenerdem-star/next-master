import type { Config, Context } from "@netlify/functions";
import { requireCallerProfile } from "./_shared/auth.mts";
import { json, readJson } from "./_shared/http.mts";
import { syncBrandCatalog } from "./_shared/catalog/catalog-sync-provider.mts";
import { sanitizeUserFacingError } from "./_shared/user-message.mts";

const ZF_GROUP_BRANDS = new Map([
  ["zf", "ZF"],
  ["sachs", "Sachs"],
  ["lemforder", "Lemforder"],
  ["trw", "TRW"],
  ["wabco", "Wabco"],
  ["boge", "Boge"],
]);

const ALLOWED_CANDIDATE_LIMITS = new Set([1, 50, 100, 500, 1000, 2000, 3000]);

export default async (req: Request, _context: Context) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const caller = await requireCallerProfile(req, ["superadmin"]);
    if ("error" in caller) return json({ error: caller.error }, caller.status);

    const body = await readJson<{
      brandName?: string;
      candidateLimit?: number;
      refreshExisting?: boolean;
    }>(req);
    const requestedBrand = String(body.brandName || "").trim().toLowerCase();
    const brandName = ZF_GROUP_BRANDS.get(requestedBrand);
    if (!brandName) {
      return json({
        error: "Brand must be one of ZF, Sachs, Lemforder, TRW, Wabco, or Boge.",
      }, 400);
    }

    const candidateLimit = Number(body.candidateLimit);
    if (!ALLOWED_CANDIDATE_LIMITS.has(candidateLimit)) {
      return json({
        error: "Candidate limit must be one of 1, 50, 100, 500, 1000, 2000, or 3000.",
      }, 400);
    }

    const result = await syncBrandCatalog({
      supabaseUrl: caller.supabaseUrl,
      serviceRoleKey: caller.serviceRoleKey,
      organizationId: caller.profile.organization_id,
      brandName,
      refreshExisting: body.refreshExisting === true,
      concurrency: candidateLimit === 1 ? 1 : 6,
      pageSize: 100,
      requestTimeoutMs: 20000,
      candidateLimit,
      skipDiscovery: true,
      skipCompletion: true,
    });

    return json({
      ok: true,
      executionMode: "bounded_zf_group_sync",
      candidateLimit,
      sourceMode: "zf_aftermarket_official_only",
      ...result,
    });
  } catch (error) {
    return json({
      error: sanitizeUserFacingError(error, "ZF Group catalog sync failed"),
    }, 500);
  }
};

export const config: Config = {
  path: "/api/admin-sync-zf-group-catalog",
  method: "POST",
};
