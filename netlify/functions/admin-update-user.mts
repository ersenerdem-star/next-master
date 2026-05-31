import type { Config, Context } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import { requireCallerProfile } from "./_shared/auth.mts";
import { buildRestUrl, getJson, json, sendJson, serviceRoleHeaders } from "./_shared/http.mts";
import { sanitizeUserFacingError } from "./_shared/user-message.mts";

const allowedRoles = new Set(["superadmin", "admin", "sales", "viewer"]);

function normalizeEmail(value: unknown) {
  return String(value || "").trim().toLowerCase();
}

export default async (req: Request, _context: Context) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const caller = await requireCallerProfile(req, ["superadmin"]);
    if ("error" in caller) return json({ error: caller.error }, caller.status);

    const payload = await req.json().catch(() => ({}));
    const targetUserId = String(payload?.userId || "").trim();
    const email = normalizeEmail(payload?.email);
    const fullName = String(payload?.fullName || "").trim();
    const role = String(payload?.role || "sales").trim().toLowerCase();
    const isActive = payload?.isActive !== false;

    if (!targetUserId) return json({ error: "User id is required" }, 400);
    if (!email) return json({ error: "Email is required" }, 400);
    if (!allowedRoles.has(role)) return json({ error: "Invalid role" }, 400);

    const targetProfiles = await getJson<Array<{ id: string; email: string; full_name?: string | null; role: string; organization_id: string; is_active: boolean }>>(
      buildRestUrl(caller.supabaseUrl, "profiles", {
        select: "id,email,full_name,role,organization_id,is_active",
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

    const duplicateProfiles = await getJson<Array<{ id: string }>>(
      buildRestUrl(caller.supabaseUrl, "profiles", {
        select: "id",
        organization_id: `eq.${caller.profile.organization_id}`,
        email: `eq.${email}`,
        id: `neq.${targetUserId}`,
        limit: "1",
      }),
      {
        headers: serviceRoleHeaders(caller.serviceRoleKey),
      },
    );
    if (duplicateProfiles[0]?.id) {
      return json({ error: "A user with this email already exists in your organization" }, 409);
    }

    const nextRoleLosesAdminAccess =
      (targetProfile.role === "admin" || targetProfile.role === "superadmin") &&
      (role !== "admin" && role !== "superadmin" || !isActive);
    if (nextRoleLosesAdminAccess) {
      const otherActiveAdmins = await getJson<Array<{ id: string }>>(
        buildRestUrl(caller.supabaseUrl, "profiles", {
          select: "id",
          organization_id: `eq.${caller.profile.organization_id}`,
          is_active: "eq.true",
          id: `neq.${targetUserId}`,
          role: "in.(admin,superadmin)",
        }),
        {
          headers: serviceRoleHeaders(caller.serviceRoleKey),
        },
      );
      if (otherActiveAdmins.length === 0) {
        return json({ error: "You cannot remove or deactivate the last active admin-level user" }, 400);
      }
    }

    const adminClient = createClient(caller.supabaseUrl, caller.serviceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false,
      },
    });

    const { error: authUpdateError } = await adminClient.auth.admin.updateUserById(targetUserId, {
      email,
      user_metadata: fullName ? { full_name: fullName } : {},
    });
    if (authUpdateError) {
      throw authUpdateError;
    }

    const profileRows = await sendJson<Array<{ id: string; email: string; full_name?: string | null; role: string; is_active: boolean }>>(
      buildRestUrl(caller.supabaseUrl, "profiles", {
        select: "id,email,full_name,role,is_active",
        id: `eq.${targetUserId}`,
        organization_id: `eq.${caller.profile.organization_id}`,
      }),
      {
        method: "PATCH",
        headers: {
          ...serviceRoleHeaders(caller.serviceRoleKey),
          Prefer: "return=representation",
        },
        body: JSON.stringify({
          email,
          full_name: fullName || null,
          role,
          is_active: isActive,
        }),
      },
    );
    const updatedProfile = profileRows[0];
    if (!updatedProfile?.id) {
      return json({ error: "User profile update failed" }, 500);
    }

    return json({
      ok: true,
      userId: updatedProfile.id,
      email: String(updatedProfile.email || ""),
      fullName: String(updatedProfile.full_name || ""),
      role: String(updatedProfile.role || ""),
      isActive: Boolean(updatedProfile.is_active),
    });
  } catch (error) {
    return json({ error: sanitizeUserFacingError(error, "User update failed") }, 500);
  }
};

export const config: Config = {
  path: "/api/admin-update-user",
  method: "POST",
};
