import type { Config, Context } from "@netlify/functions";
import { getBearerToken } from "./_shared/app-auth.mts";
import { requireCallerProfile } from "./_shared/auth.mts";
import { json } from "./_shared/http.mts";
import {
  authorizeApplyCaller,
  createCatalogObservationApplyCommandDb,
  parseJsonApplyCommandBody,
  serializeApplyError,
  serializeApplyResult,
  validateApplyCommand,
} from "./_shared/catalog/catalog-observation-review-apply-api.mjs";

export async function handleCatalogObservationReviewApplyRequest(
  req: Request,
  _context: Context,
  deps = {
    requireCallerProfile,
    createCatalogObservationApplyCommandDb,
    env: Netlify.env,
  },
) {
  if (req.method !== "POST") return json({ error: "Method not allowed", code: "CATALOG_REVIEW_APPLY_METHOD_NOT_ALLOWED" }, 405);

  const supabaseUrl = deps.env.get("SUPABASE_URL");
  const supabaseAnonKey = deps.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = deps.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !supabaseAnonKey || !serviceRoleKey) {
    return json({ error: "System configuration is incomplete.", code: "CATALOG_REVIEW_APPLY_CONFIG_MISSING" }, 500);
  }

  try {
    const caller = await deps.requireCallerProfile(req, ["admin", "superadmin"]);
    if ("error" in caller) {
      return json({ error: caller.error, code: caller.status === 401 ? "CATALOG_REVIEW_APPLY_UNAUTHORIZED" : "CATALOG_REVIEW_APPLY_FORBIDDEN" }, caller.status);
    }
    authorizeApplyCaller(caller.profile);

    const accessToken = getBearerToken(req);
    const command = validateApplyCommand(await parseJsonApplyCommandBody(req));
    const db = deps.createCatalogObservationApplyCommandDb({ supabaseUrl, supabaseAnonKey, accessToken });
    const result = await db.applyImage(command);
    return json(serializeApplyResult(result));
  } catch (error) {
    const serialized = serializeApplyError(error);
    return json(serialized.body, serialized.status);
  }
}

export default async (req: Request, context: Context) => handleCatalogObservationReviewApplyRequest(req, context);

export const config: Config = {
  path: "/api/catalog/observation-review/apply",
  method: "POST",
};
