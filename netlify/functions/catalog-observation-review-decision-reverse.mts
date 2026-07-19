import type { Config, Context } from "@netlify/functions";
import { getBearerToken } from "./_shared/app-auth.mts";
import { requireCallerProfile } from "./_shared/auth.mts";
import { json } from "./_shared/http.mts";
import {
  authorizeDecisionCaller,
  createCatalogObservationDecisionCommandDb,
  parseJsonCommandBody,
  serializeDecisionResult,
  serializeError,
  validateReversalCommand,
} from "./_shared/catalog/catalog-observation-review-decision-api.mjs";

export async function handleCatalogObservationReviewDecisionReverseRequest(
  req: Request,
  _context: Context,
  deps = {
    requireCallerProfile,
    createCatalogObservationDecisionCommandDb,
    env: Netlify.env,
  },
) {
  if (req.method !== "POST") return json({ error: "Method not allowed", code: "CATALOG_REVIEW_METHOD_NOT_ALLOWED" }, 405);

  const supabaseUrl = deps.env.get("SUPABASE_URL");
  const supabaseAnonKey = deps.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = deps.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !supabaseAnonKey || !serviceRoleKey) {
    return json({ error: "System configuration is incomplete.", code: "CATALOG_REVIEW_CONFIG_MISSING" }, 500);
  }

  try {
    const caller = await deps.requireCallerProfile(req, ["admin", "superadmin"]);
    if ("error" in caller) return json({ error: caller.error, code: caller.status === 401 ? "CATALOG_REVIEW_UNAUTHORIZED" : "CATALOG_REVIEW_FORBIDDEN" }, caller.status);
    authorizeDecisionCaller(caller.profile);

    const accessToken = getBearerToken(req);
    const command = validateReversalCommand(await parseJsonCommandBody(req));
    const db = deps.createCatalogObservationDecisionCommandDb({ supabaseUrl, supabaseAnonKey, accessToken });
    const result = await db.reverseDecision(command);
    return json(serializeDecisionResult(result, { action: "reverse_decision" }));
  } catch (error) {
    const serialized = serializeError(error);
    return json(serialized.body, serialized.status);
  }
}

export default async (req: Request, context: Context) => handleCatalogObservationReviewDecisionReverseRequest(req, context);

export const config: Config = {
  path: "/api/catalog/observation-review/decision/reverse",
  method: "POST",
};
