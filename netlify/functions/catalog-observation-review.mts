import type { Config, Context } from "@netlify/functions";
import { json } from "./_shared/http.mts";
import { requireCallerProfile } from "./_shared/auth.mts";
import { sanitizeUserFacingMessage } from "./_shared/user-message.mts";
import {
  authorizeCatalogObservationReviewAccess,
  buildCatalogObservationReviewResponse,
  CatalogObservationReviewError,
  createCatalogObservationReviewDb,
  parseCatalogObservationReviewQuery,
} from "./_shared/catalog/catalog-observation-review-api.mjs";

export async function handleCatalogObservationReviewRequest(
  req: Request,
  _context: Context,
  deps = {
    requireCallerProfile,
    createCatalogObservationReviewDb,
    env: Netlify.env,
  },
) {
  if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);

  const supabaseUrl = deps.env.get("SUPABASE_URL");
  const supabaseAnonKey = deps.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = deps.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !supabaseAnonKey || !serviceRoleKey) {
    return json({ error: "System configuration is incomplete." }, 500);
  }

  try {
    const caller = await deps.requireCallerProfile(req, ["admin", "superadmin"]);
    if ("error" in caller) {
      return json({ error: caller.error }, caller.status);
    }

    let query;
    try {
      query = parseCatalogObservationReviewQuery(new URL(req.url));
    } catch (error) {
      return json({ error: sanitizeUserFacingMessage(error instanceof Error ? error.message : error, "Invalid request.") }, 400);
    }

    const access = authorizeCatalogObservationReviewAccess(caller.profile, query.organization_id);
    if ("error" in access) {
      return json({ error: access.error }, access.status);
    }

    const db = deps.createCatalogObservationReviewDb({ supabaseUrl, serviceRoleKey });
    const body = await buildCatalogObservationReviewResponse({
      db,
      organizationId: query.organization_id,
      runId: query.run_id,
      productId: query.product_id,
      fieldFamily: query.field_family,
      comparisonResult: query.comparison_result,
      recommendation: query.recommendation,
      cursor: query.cursor,
      limit: query.limit,
    });

    return json(body);
  } catch (error) {
    if (error instanceof CatalogObservationReviewError) {
      return json({ error: error.message }, error.status);
    }
    return json({ error: "Review queue could not be loaded right now." }, 500);
  }
}

export default async (req: Request, context: Context) => handleCatalogObservationReviewRequest(req, context);

export const config: Config = {
  path: "/api/catalog/observation-review",
  method: "GET",
};
