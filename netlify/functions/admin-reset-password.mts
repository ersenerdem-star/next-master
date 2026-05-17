import type { Config, Context } from "@netlify/functions";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

async function getJson<T>(url: string, init: RequestInit) {
  const response = await fetch(url, init);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.msg || data?.message || `Request failed: ${response.status}`);
  }
  return data as T;
}

export default async (req: Request, _context: Context) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const supabaseUrl = Netlify.env.get("SUPABASE_URL");
  const supabaseAnonKey = Netlify.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Netlify.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !supabaseAnonKey || !serviceRoleKey) {
    return json({ error: "Missing Netlify environment variables for Supabase" }, 500);
  }

  const authHeader = req.headers.get("authorization") || "";
  const callerToken = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!callerToken) return json({ error: "Missing caller token" }, 401);

  try {
    const payload = await req.json();
    const targetUserId = String(payload?.userId || "").trim();
    const newPassword = String(payload?.password || "").trim();
    if (!targetUserId || !newPassword) {
      return json({ error: "User id and password are required" }, 400);
    }
    if (newPassword.length < 8) {
      return json({ error: "Password must be at least 8 characters" }, 400);
    }

    const caller = await getJson<{ id: string }>(`${supabaseUrl}/auth/v1/user`, {
      headers: {
        apikey: supabaseAnonKey,
        Authorization: `Bearer ${callerToken}`,
      },
    });

    const [adminProfile] = await getJson<Array<{ role: string; is_active: boolean; organization_id: string }>>(
      `${supabaseUrl}/rest/v1/profiles?select=role,is_active,organization_id&id=eq.${caller.id}`,
      {
        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
        },
      },
    );
    if (!adminProfile?.is_active || adminProfile.role !== "admin") {
      return json({ error: "Only admin users can reset passwords" }, 403);
    }

    const [targetProfile] = await getJson<Array<{ id: string; organization_id: string; email: string }>>(
      `${supabaseUrl}/rest/v1/profiles?select=id,organization_id,email&id=eq.${targetUserId}`,
      {
        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
        },
      },
    );
    if (!targetProfile) return json({ error: "Target user not found" }, 404);
    if (targetProfile.organization_id !== adminProfile.organization_id) {
      return json({ error: "Target user is outside your organization" }, 403);
    }

    await getJson(`${supabaseUrl}/auth/v1/admin/users/${targetUserId}`, {
      method: "PUT",
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ password: newPassword }),
    });

    return json({ ok: true, userId: targetUserId, email: targetProfile.email });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Password reset failed" }, 500);
  }
};

export const config: Config = {
  path: "/api/admin-reset-password",
  method: "POST",
};
