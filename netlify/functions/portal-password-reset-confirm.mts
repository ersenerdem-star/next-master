import type { Config, Context } from "@netlify/functions";
import { buildRestUrl, json, serviceRoleHeaders } from "./_shared/http.mts";
import {
  buildPortalFallbackSnapshot,
  buildPortalSnapshot,
  fetchPortalInviteByIdAndEmail,
} from "./_shared/portal-access.mts";
import { enforcePortalRateLimit } from "./_shared/portal-rate-limit.mts";
import {
  createPortalSessionToken,
  hashPortalToken,
  verifyPortalPasswordResetToken,
} from "./_shared/portal-security.mts";
import { sanitizeUserFacingError } from "./_shared/user-message.mts";

export default async (req: Request, _context: Context) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const supabaseUrl = Netlify.env.get("SUPABASE_URL");
  const serviceRoleKey = Netlify.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const sessionSecret = Netlify.env.get("PORTAL_SESSION_SECRET") || serviceRoleKey;
  if (!supabaseUrl || !serviceRoleKey || !sessionSecret) {
    return json({ error: "System configuration is incomplete." }, 500);
  }

  try {
    const body = await req.json().catch(() => ({}));
    const email = String(body?.email || "").trim().toLowerCase();
    const resetToken = String(body?.resetToken || body?.reset_token || "").trim();
    const password = String(body?.password || "").trim();
    if (!email || !resetToken || !password) {
      return json({ error: "Email, reset token, and password are required" }, 400);
    }
    if (password.length < 8) {
      return json({ error: "Portal password must be at least 8 characters." }, 400);
    }

    const rateLimit = await enforcePortalRateLimit(req, supabaseUrl, serviceRoleKey, "password_reset_confirm", email);
    if (!rateLimit.allowed) {
      return json({ error: "Too many password reset attempts. Try again later." }, 429, {
        "Retry-After": String(rateLimit.retryAfterSeconds),
      });
    }

    const payload = await verifyPortalPasswordResetToken(sessionSecret, resetToken);
    if (!payload || payload.email !== email) {
      return json({ error: "Reset link is invalid or expired." }, 401);
    }

    const invite = await fetchPortalInviteByIdAndEmail(supabaseUrl, serviceRoleKey, payload.invite_id, payload.email);
    if (!invite || invite.status === "disabled" || invite.status === "draft" || !invite.updated_at) {
      return json({ error: "Reset link is invalid or expired." }, 401);
    }
    if (String(invite.updated_at || "") !== String(payload.updated_at || "")) {
      return json({ error: "Reset link is invalid or expired." }, 401);
    }

    const nextPasswordHash = await hashPortalToken(password);
    const nowIso = new Date().toISOString();
    const updateResponse = await fetch(
      buildRestUrl(supabaseUrl, "portal_invites", {
        id: `eq.${invite.id}`,
        email: `eq.${invite.email}`,
        select: "id",
        limit: "1",
      }),
      {
        method: "PATCH",
        headers: {
          ...serviceRoleHeaders(serviceRoleKey),
          Prefer: "return=representation",
        },
        body: JSON.stringify({
          invite_token_hash: nextPasswordHash,
          status: "active",
          last_used_at: nowIso,
          updated_at: nowIso,
        }),
      },
    );
    if (!updateResponse.ok) {
      return json({ error: "Portal password update failed." }, 500);
    }

    const nextInvite = {
      ...invite,
      invite_token_hash: nextPasswordHash,
      status: "active",
      last_used_at: nowIso,
      updated_at: nowIso,
    };
    const sessionToken = await createPortalSessionToken(sessionSecret, nextInvite.id, nextInvite.email);
    let snapshot;
    try {
      snapshot = await buildPortalSnapshot(supabaseUrl, serviceRoleKey, nextInvite);
    } catch {
      snapshot = await buildPortalFallbackSnapshot(supabaseUrl, serviceRoleKey, nextInvite);
    }
    return json({ ok: true, snapshot, sessionToken });
  } catch (error) {
    return json({ error: sanitizeUserFacingError(error, "Portal password reset failed") }, 500);
  }
};

export const config: Config = {
  path: "/api/portal-password-reset-confirm",
  method: "POST",
};
