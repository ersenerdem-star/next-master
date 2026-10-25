import { getJson, sendJson, serviceRoleHeaders } from "./http.mts";
import { canAccessOperationsModules } from "./roles.mts";
import {
  fetchExportJobById, fetchPortalInviteForExport, startAdminPriceListExport, startCatalogMasterExport,
  startPortalPriceListExport, startSupplierPriceListExport,
  type ExportJobRow,
} from "./export-jobs.mts";

export type PreparedPriceProfile = {
  id: string; organization_id: string; seed_job_id: string;
  revision: number; lease_token: string;
};

export type PreparedAdminExportProfile = {
  id: string; organization_id: string; seed_job_id: string;
  export_type: "catalog_master" | "supplier_price_list";
  revision: number; lease_token: string;
};

// One profile per scheduled tick, with a durable SQL lease and globally bounded
// cold generation. An unavailable profile yields to the remaining profiles.
export async function runPreparedPricePrewarm<T extends { id: string; seed_job_id: string; revision: number; lease_token: string }>(deps: {
  claim: () => Promise<T[]>;
  prepare: (profile: T) => Promise<{ job: ExportJobRow; cached: boolean }>;
  dispatch: (jobId: string) => Promise<unknown>;
  finish: (profile: T, errorCode: string | null) => Promise<unknown>;
}) {
  const profile = (await deps.claim())[0];
  if (!profile) return { status: "idle", prepared: 0, reused: 0, failed: 0 };
  let errorCode: string | null = null;
  try {
    const { job, cached } = await deps.prepare(profile);
    if (job.status === "queued") await deps.dispatch(job.id);
    return { status: "checked", prepared: job.status === "queued" ? 1 : 0, reused: cached ? 1 : 0, failed: 0 };
  } catch (error) {
    // No customer details, secrets, upstream payload or unbounded exception text.
    errorCode = error instanceof Error && error.message === "PREWARM_NO_PUBLISHED_PRICES"
      ? "PREPARED_PRICE_SOURCE_UNAVAILABLE" : "PREPARED_PRICE_REFRESH_FAILED";
    return { status: "checked", prepared: 0, reused: 0, failed: 1 };
  } finally {
    await deps.finish(profile, errorCode);
  }
}

export async function prewarmPreparedPriceFile(supabaseUrl: string, serviceRoleKey: string, dispatch: (jobId: string) => Promise<unknown>) {
  const rpc = <T,>(name: string, body: Record<string, unknown>) => sendJson<T>(`${supabaseUrl}/rest/v1/rpc/${name}`, {
    method: "POST", headers: serviceRoleHeaders(serviceRoleKey), body: JSON.stringify(body), timeoutMs: 15_000,
  });
  return runPreparedPricePrewarm({
    claim: () => rpc<PreparedPriceProfile[]>("claim_prepared_price_profile", {}),
    dispatch,
    finish: (profile, errorCode) => rpc("finish_prepared_price_profile", {
      input_id: profile.id, input_lease_token: profile.lease_token, input_revision: profile.revision, input_error_code: errorCode,
    }),
    prepare: async (profile) => {
      const seed = await fetchExportJobById(supabaseUrl, serviceRoleKey, profile.organization_id, profile.seed_job_id);
      if (!seed) throw new Error("PREWARM_PROFILE_UNAVAILABLE");
      const pricedBrands = await rpc<Array<{ id: string }>>("cloud_admin_price_list_brands", {
        input_organization_id: profile.organization_id,
      });
      if (!pricedBrands.some(brand => brand.id === seed.scope.brandId)) throw new Error("PREWARM_NO_PUBLISHED_PRICES");
      if (seed.audience === "portal" && seed.export_type === "portal_price_list") {
        const invite = await fetchPortalInviteForExport(supabaseUrl, serviceRoleKey, profile.organization_id, String(seed.scope.inviteId || ""));
        return startPortalPriceListExport(supabaseUrl, serviceRoleKey, invite, { brand: String(seed.scope.brandName || "") });
      }
      if (seed.audience !== "admin" || seed.export_type !== "admin_price_list" || !seed.requested_by) {
        throw new Error("PREWARM_PROFILE_UNAVAILABLE");
      }
      const query = new URLSearchParams({
        select: "id,organization_id,role,department,permissions,is_active", id: `eq.${seed.requested_by}`,
        organization_id: `eq.${profile.organization_id}`, limit: "1",
      });
      type Actor = { id: string; role: string; department: string; permissions: Record<string, boolean>; is_active: boolean };
      const [actor] = await getJson<Actor[]>(`${supabaseUrl}/rest/v1/profiles?${query}`, {
        headers: serviceRoleHeaders(serviceRoleKey), timeoutMs: 10_000,
      });
      if (!actor?.is_active || !canAccessOperationsModules(actor.role, actor.department, actor.permissions)) {
        throw new Error("PREWARM_PROFILE_UNAVAILABLE");
      }
      return startAdminPriceListExport(supabaseUrl, serviceRoleKey, {
        ...actor, email: "", organizationId: profile.organization_id, customerScopeMode: "all",
      }, {
        brandId: String(seed.scope.brandId || ""), brandName: String(seed.scope.brandName || ""),
        priceListType: seed.scope.priceListType === "B" ? "B" : "A", marginPercent: Number(seed.scope.marginPercent),
      });
    },
  });
}

/**
 * Keep the requested admin comparison and supplier buy-price workbooks warm.
 * The profile stores the original scope; each refresh resolves the current
 * source fingerprint through the normal start function before dispatching.
 */
export async function prewarmPreparedAdminExportFile(supabaseUrl: string, serviceRoleKey: string, dispatch: (jobId: string) => Promise<unknown>) {
  const rpc = <T,>(name: string, body: Record<string, unknown>) => sendJson<T>(`${supabaseUrl}/rest/v1/rpc/${name}`, {
    method: "POST", headers: serviceRoleHeaders(serviceRoleKey), body: JSON.stringify(body), timeoutMs: 15_000,
  });
  return runPreparedPricePrewarm({
    claim: () => rpc<PreparedAdminExportProfile[]>("claim_prepared_admin_export_profile", {}),
    dispatch,
    finish: (profile, errorCode) => rpc("finish_prepared_admin_export_profile", {
      input_id: profile.id, input_lease_token: profile.lease_token, input_revision: profile.revision, input_error_code: errorCode,
    }),
    prepare: async (profile) => {
      const seed = await fetchExportJobById(supabaseUrl, serviceRoleKey, profile.organization_id, profile.seed_job_id);
      if (!seed || seed.audience !== "admin" || !seed.requested_by || seed.export_type !== profile.export_type) {
        throw new Error("PREWARM_PROFILE_UNAVAILABLE");
      }
      const query = new URLSearchParams({
        select: "id,organization_id,role,department,permissions,is_active", id: `eq.${seed.requested_by}`,
        organization_id: `eq.${profile.organization_id}`, limit: "1",
      });
      type Actor = { id: string; role: string; department: string; permissions: Record<string, boolean>; is_active: boolean };
      const [actor] = await getJson<Actor[]>(`${supabaseUrl}/rest/v1/profiles?${query}`, {
        headers: serviceRoleHeaders(serviceRoleKey), timeoutMs: 10_000,
      });
      if (!actor?.is_active || !canAccessOperationsModules(actor.role, actor.department, actor.permissions)) {
        throw new Error("PREWARM_PROFILE_UNAVAILABLE");
      }
      const caller = { ...actor, email: "", fullName: "", organizationId: profile.organization_id, customerScopeMode: "all" as const };
      const scope = seed.scope;
      if (profile.export_type === "catalog_master") {
        return startCatalogMasterExport(supabaseUrl, serviceRoleKey, caller, {
          brandId: String(scope.brandId || ""), brandName: String(scope.brandName || ""),
          search: String(scope.search || ""), scope: scope.scope === "catalog" ? "catalog" : "priced",
          marginA: Number(scope.marginA ?? 0.1), marginB: Number(scope.marginB ?? 0.15),
        });
      }
      return startSupplierPriceListExport(supabaseUrl, serviceRoleKey, caller, {
        supplierId: String(scope.supplierId || ""), brandName: String(scope.brandName || ""),
        search: String(scope.search || ""), freshness: String(scope.freshness || "all"), format: "csv",
      });
    },
  });
}
