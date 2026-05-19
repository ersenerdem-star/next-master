import type { Config, Context } from "@netlify/functions";
import { requireCallerProfile } from "./_shared/auth.mts";
import { buildRestUrl, getJson, json, sendJson, serviceRoleHeaders } from "./_shared/http.mts";

const allowedRoles = new Set(["admin", "sales", "viewer"]);

function normalizeEmail(value: unknown) {
  return String(value || "").trim().toLowerCase();
}

export default async (req: Request, _context: Context) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const caller = await requireCallerProfile(req, ["admin"]);
    if ("error" in caller) return json({ error: caller.error }, caller.status);

    const payload = await req.json().catch(() => ({}));
    const email = normalizeEmail(payload?.email);
    const password = String(payload?.password || "").trim();
    const fullName = String(payload?.fullName || "").trim();
    const role = String(payload?.role || "sales").trim().toLowerCase();
    const isActive = payload?.isActive !== false;

    if (!email) return json({ error: "Email is required" }, 400);
    if (!password || password.length < 8) return json({ error: "Password must be at least 8 characters" }, 400);
    if (!allowedRoles.has(role)) return json({ error: "Invalid role" }, 400);

    const existingProfiles = await getJson<Array<{ id: string; email: string }>>(
      buildRestUrl(caller.supabaseUrl, "profiles", {
        select: "id,email",
        organization_id: `eq.${caller.profile.organization_id}`,
        email: `eq.${email}`,
        limit: "1",
      }),
      {
        headers: serviceRoleHeaders(caller.serviceRoleKey),
      },
    );
    if (existingProfiles[0]?.id) {
      return json({ error: "A user with this email already exists in your organization" }, 409);
    }

    const created = await sendJson<{ user?: { id: string; email?: string }; id?: string; email?: string }>(
      `${caller.supabaseUrl}/auth/v1/admin/users`,
      {
        method: "POST",
        headers: serviceRoleHeaders(caller.serviceRoleKey),
        body: JSON.stringify({
          email,
          password,
          email_confirm: true,
          user_metadata: fullName ? { full_name: fullName } : {},
        }),
      },
    );

    const createdUserId = String(created.user?.id || created.id || "").trim();
    if (!createdUserId) {
      throw new Error("Auth user create returned no user id");
    }

    try {
      await sendJson(
        buildRestUrl(caller.supabaseUrl, "profiles", {
          on_conflict: "id",
        }),
        {
          method: "POST",
          headers: {
            ...serviceRoleHeaders(caller.serviceRoleKey),
            Prefer: "resolution=merge-duplicates,return=minimal",
          },
          body: JSON.stringify([
            {
              id: createdUserId,
              organization_id: caller.profile.organization_id,
              email,
              full_name: fullName || null,
              role,
              is_active: isActive,
            },
          ]),
        },
      );
    } catch (error) {
      await fetch(`${caller.supabaseUrl}/auth/v1/admin/users/${createdUserId}`, {
        method: "DELETE",
        headers: serviceRoleHeaders(caller.serviceRoleKey),
      }).catch(() => undefined);
      throw error;
    }

    return json({
      ok: true,
      userId: createdUserId,
      email,
      role,
      isActive,
    });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "User create failed" }, 500);
  }
};

export const config: Config = {
  path: "/api/admin-create-user",
  method: "POST",
};
