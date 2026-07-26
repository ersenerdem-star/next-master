import type { Config, Context } from "@netlify/functions";
import { getBearerToken } from "./_shared/app-auth.mts";
import { requireCallerProfile } from "./_shared/auth.mts";
import {
  buildCatalogZfStagingReviewResponse,
  CatalogZfStagingReviewError,
  createCatalogZfStagingReviewReadDb,
  parseCatalogZfStagingReviewQuery,
} from "./_shared/catalog/catalog-zf-staging-review-read-api.mjs";
import { json } from "./_shared/http.mts";

export async function handleCatalogZfStagingReviewRequest(
  req: Request,
  _context: Context,
  deps = {
    requireCallerProfile,
    createCatalogZfStagingReviewReadDb,
    env: Netlify.env,
  },
) {
  if (req.method !== "GET") {
    return json({ error: "Method not allowed" }, 405);
  }

  const accessToken = getBearerToken(req);
  if (!accessToken) {
    return json({ error: "Missing caller token" }, 401);
  }

  const supabaseUrl = deps.env.get("SUPABASE_URL");
  const supabaseAnonKey = deps.env.get("SUPABASE_ANON_KEY");
  if (!supabaseUrl || !supabaseAnonKey) {
    return json({ error: "Staging review is temporarily unavailable." }, 503);
  }

  let caller;
  try {
    caller = await deps.requireCallerProfile(req, ["admin", "superadmin"]);
  } catch (error) {
    if (isExpiredAuthenticationError(error)) {
      return json({ error: "Your session has expired. Sign in again." }, 401);
    }
    return json({ error: "Staging review is temporarily unavailable." }, 503);
  }
  if ("error" in caller) {
    return json({ error: caller.error }, caller.status);
  }

  try {
    const query = parseCatalogZfStagingReviewQuery(new URL(req.url));
    const db = deps.createCatalogZfStagingReviewReadDb({
      supabaseUrl,
      supabaseAnonKey,
      accessToken,
    });
    const body = await buildCatalogZfStagingReviewResponse({
      db,
      organizationId: caller.profile.organization_id,
      query,
    });
    return json(body);
  } catch (error) {
    if (error instanceof CatalogZfStagingReviewError) {
      return json({ error: error.message }, error.status);
    }
    return json({ error: "Staging review is temporarily unavailable." }, 503);
  }
}

export default async (req: Request, context: Context) =>
  handleCatalogZfStagingReviewRequest(req, context);

export const config: Config = {
  path: "/api/catalog/zf-group/staging-review",
  method: "GET",
};

function isExpiredAuthenticationError(error: unknown) {
  const message = String(error instanceof Error ? error.message : error || "")
    .toLowerCase();
  return (
    message.includes("jwt") ||
    message.includes("token") ||
    message.includes("session") ||
    message.includes("authentication expired")
  );
}
