import type { Config, Context } from "@netlify/functions";
import { requireCallerProfile } from "./_shared/auth/auth.mts";
import { buildRestUrl, json, sendJson, serviceRoleHeaders } from "./_shared/core/http.mts";
import { sanitizeUserFacingError } from "./_shared/core/user-message.mts";

export default async (req: Request, _context: Context) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const caller = await requireCallerProfile(req, ["superadmin"]);
    if ("error" in caller) return json({ error: caller.error }, caller.status);

    const updatedRows = await sendJson<Array<{ id: string }>>(
      buildRestUrl(caller.supabaseUrl, "profiles", {
        select: "id",
        organization_id: `eq.${caller.profile.organization_id}`,
      }),
      {
        method: "PATCH",
        headers: {
          ...serviceRoleHeaders(caller.serviceRoleKey),
          Prefer: "return=representation",
        },
        body: JSON.stringify({
          session_revoked_at: new Date().toISOString(),
        }),
      },
    );

    return json({
      ok: true,
      revokedCount: updatedRows.length,
      organizationId: caller.profile.organization_id,
    });
  } catch (error) {
    return json({ error: sanitizeUserFacingError(error, "Force sign-out failed") }, 500);
  }
};

export const config: Config = {
  path: "/api/admin-force-signout",
  method: "POST",
};
