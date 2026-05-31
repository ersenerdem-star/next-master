import type { Config, Context } from "@netlify/functions";
import { requireCallerProfile } from "./_shared/auth.mts";
import { buildRestUrl, getJson, json, sendJson, serviceRoleHeaders } from "./_shared/http.mts";
import { sanitizeUserFacingError } from "./_shared/user-message.mts";

export default async (req: Request, _context: Context) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const caller = await requireCallerProfile(req, ["superadmin"]);
    if ("error" in caller) return json({ error: caller.error }, caller.status);

    const payload = await req.json().catch(() => ({}));
    const targetUserId = String(payload?.userId || "").trim();
    if (!targetUserId) return json({ error: "User id is required" }, 400);
    if (targetUserId === caller.profile.id) {
      return json({ error: "You cannot delete your own account" }, 400);
    }

    const targetProfiles = await getJson<Array<{ id: string; email: string; role: string; organization_id: string }>>(
      buildRestUrl(caller.supabaseUrl, "profiles", {
        select: "id,email,role,organization_id",
        id: `eq.${targetUserId}`,
        limit: "1",
      }),
      {
        headers: serviceRoleHeaders(caller.serviceRoleKey),
      },
    );
    const targetProfile = targetProfiles[0];
    if (!targetProfile) return json({ error: "Target user not found" }, 404);
    if (targetProfile.organization_id !== caller.profile.organization_id) {
      return json({ error: "Target user is outside your organization" }, 403);
    }

    if (targetProfile.role === "admin") {
      const activeAdmins = await getJson<Array<{ id: string }>>(
        buildRestUrl(caller.supabaseUrl, "profiles", {
          select: "id",
          organization_id: `eq.${caller.profile.organization_id}`,
          role: "eq.admin",
          is_active: "eq.true",
        }),
        {
          headers: serviceRoleHeaders(caller.serviceRoleKey),
        },
      );
      if (activeAdmins.length <= 1) {
        return json({ error: "You cannot delete the last active admin user" }, 400);
      }
    }

    await sendJson(`${caller.supabaseUrl}/auth/v1/admin/users/${targetUserId}`, {
      method: "DELETE",
      headers: serviceRoleHeaders(caller.serviceRoleKey),
    });

    await fetch(
      buildRestUrl(caller.supabaseUrl, "profiles", {
        id: `eq.${targetUserId}`,
      }),
      {
        method: "DELETE",
        headers: serviceRoleHeaders(caller.serviceRoleKey),
      },
    ).catch(() => undefined);

    await fetch(
      buildRestUrl(caller.supabaseUrl, "user_presence", {
        user_id: `eq.${targetUserId}`,
      }),
      {
        method: "DELETE",
        headers: serviceRoleHeaders(caller.serviceRoleKey),
      },
    ).catch(() => undefined);

    return json({
      ok: true,
      userId: targetUserId,
      email: targetProfile.email,
    });
  } catch (error) {
    return json({ error: sanitizeUserFacingError(error, "User delete failed") }, 500);
  }
};

export const config: Config = {
  path: "/api/admin-delete-user",
  method: "POST",
};
