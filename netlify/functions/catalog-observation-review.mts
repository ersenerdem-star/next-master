import type { Config, Context } from "@netlify/functions";
import { json } from "./_shared/http.mts";
import { requireCallerProfile } from "./_shared/auth.mts";
import { sanitizeUserFacingError } from "./_shared/user-message.mts";
import {
  authorizeCatalogObservationReviewAccess,
  buildCatalogObservationReviewResponse,
  createCatalogObservationReviewDb,
  parseCatalogObservationReviewQuery,
} from "./_shared/catalog/catalog-observation-review-api.mjs";

export default async (req: Request, _context: Context) => {
  if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);

  const supabaseUrl = Netlify.env.get("SUPABASE_URL");
  const supabaseAnonKey = Netlify.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Netlify.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !supabaseAnonKey || !serviceRoleKey) {
    return json({ error: "System configuration is incomplete." }, 500);
  }

  try {
    const caller = await requireCallerProfile(req, ["admin", "superadmin"]);
    if ("error" in caller) {
      return json({ error: caller.error }, caller.status);
    }

    const query = parseCatalogObservationReviewQuery(new URL(req.url));
    const access = authorizeCatalogObservationReviewAccess(caller.profile, query.organization_id);
    if ("error" in access) {
      return json({ error: access.error }, access.status);
    }

    const db = createCatalogObservationReviewDb({ supabaseUrl, serviceRoleKey });
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
    return json({ error: sanitizeUserFacingError(error, "Review queue could not be loaded right now.") }, 400);
  }
};

export const config: Config = {
  path: "/api/catalog/observation-review",
  method: "GET",
};
