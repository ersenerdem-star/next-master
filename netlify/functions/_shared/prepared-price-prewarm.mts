import { getJson, sendJson, serviceRoleHeaders } from "./http.mts";
import { canAccessOperationsModules } from "./roles.mts";
import {
  fetchExportJobById, fetchPortalInviteForExport, startAdminPriceListExport, startPortalPriceListExport,
  type ExportJobRow,
} from "./export-jobs.mts";

export type PreparedPriceProfile = {
  id: string; organization_id: string; seed_job_id: string;
  revision: number; lease_token: string;
};

// A durable SQL lease and the database's active-job guard bound cold generation.
// An unavailable profile yields to the remaining profiles.
export async function runPreparedPricePrewarm(deps: {
  claim: () => Promise<PreparedPriceProfile[]>;
  prepare: (profile: PreparedPriceProfile) => Promise<{ job: ExportJobRow; cached: boolean }>;
  dispatch: (jobId: string) => Promise<unknown>;
  finish: (profile: PreparedPriceProfile, errorCode: string | null) => Promise<unknown>;
}) {
  const profile = (await deps.claim())[0];
  if (!profile) return { status: "idle", prepared: 0, reused: 0, failed: 0 };
  let errorCode: string | null = null;
  try {
    const { job, cached } = await deps.prepare(profile);
    const needsDispatch = job.status === "queued" && !job.scope?.sharedLeaderJobId;
    if (needsDispatch) await deps.dispatch(job.id);
    return { status: "checked", prepared: needsDispatch ? 1 : 0, reused: cached ? 1 : 0, failed: 0 };
  } catch (error) {
    // No customer details, secrets, upstream payload or unbounded exception text.
    errorCode = error instanceof Error && error.message === "PREWARM_NO_PUBLISHED_PRICES"
      ? "PREPARED_PRICE_SOURCE_UNAVAILABLE" : "PREPARED_PRICE_REFRESH_FAILED";
    return { status: "checked", prepared: 0, reused: 0, failed: 1 };
  } finally {
    await deps.finish(profile, errorCode);
  }
}

// Recheck several inexpensive cached/unavailable profiles per scheduled tick.
// Stop immediately after starting a cold build; the database remains the
// authority for cross-invocation concurrency and active jobs.
export async function runPreparedPricePrewarmBatch(
  runOne: () => ReturnType<typeof runPreparedPricePrewarm>,
  options: { deadlineMs: number; now?: () => number; maxProfiles?: number },
) {
  const now = options.now ?? Date.now;
  const maxProfiles = options.maxProfiles ?? 8;
  const result = { status: "idle", checked: 0, prepared: 0, reused: 0, failed: 0 };
  while (result.checked < maxProfiles && now() < options.deadlineMs) {
    const item = await runOne();
    if (item.status === "idle") break;
    result.status = "checked";
    result.checked++;
    result.prepared += item.prepared;
    result.reused += item.reused;
    result.failed += item.failed;
    if (item.prepared) break;
  }
  return result;
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
