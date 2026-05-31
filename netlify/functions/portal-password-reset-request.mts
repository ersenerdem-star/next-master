import type { Config, Context } from "@netlify/functions";
import { json } from "./_shared/http.mts";
import { buildPortalBranding, fetchPortalInviteByEmail } from "./_shared/portal-access.mts";
import { enforcePortalRateLimit } from "./_shared/portal-rate-limit.mts";
import { createPortalPasswordResetToken } from "./_shared/portal-security.mts";
import { sanitizeUserFacingError } from "./_shared/user-message.mts";

const GENERIC_MESSAGE = "If the portal email exists, a reset link has been sent.";

async function sendResetEmail(apiKey: string, from: string, to: string, subject: string, body: string) {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to,
      subject,
      text: body,
    }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(String(data?.message || `Resend failed: ${response.status}`));
  }
}

export default async (req: Request, _context: Context) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const supabaseUrl = Netlify.env.get("SUPABASE_URL");
  const serviceRoleKey = Netlify.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const sessionSecret = Netlify.env.get("PORTAL_SESSION_SECRET") || serviceRoleKey;
  const resendApiKey = Netlify.env.get("RESEND_API_KEY");
  const emailFrom = Netlify.env.get("EMAIL_FROM");
  if (!supabaseUrl || !serviceRoleKey || !sessionSecret) {
    return json({ error: "System configuration is incomplete." }, 500);
  }
  if (!resendApiKey || !emailFrom) {
    return json({ error: "Email delivery is not configured." }, 500);
  }

  try {
    const body = await req.json().catch(() => ({}));
    const email = String(body?.email || "").trim().toLowerCase();
    if (!email) return json({ error: "Email is required" }, 400);

    const rateLimit = await enforcePortalRateLimit(req, supabaseUrl, serviceRoleKey, "password_reset_request", email);
    if (!rateLimit.allowed) {
      return json({ error: "Too many password reset attempts. Try again later." }, 429, {
        "Retry-After": String(rateLimit.retryAfterSeconds),
      });
    }

    const invite = await fetchPortalInviteByEmail(supabaseUrl, serviceRoleKey, email).catch(() => null);
    if (!invite || invite.status === "disabled" || invite.status === "draft" || !invite.invite_token_hash || !invite.updated_at) {
      return json({ ok: true, message: GENERIC_MESSAGE });
    }

    const resetToken = await createPortalPasswordResetToken(sessionSecret, invite.id, invite.email, invite.updated_at);
    const resetUrl = new URL("/portal", req.url);
    resetUrl.searchParams.set("email", invite.email);
    resetUrl.searchParams.set("reset", resetToken);

    const branding = await buildPortalBranding(supabaseUrl, serviceRoleKey, invite).catch(() => null);
    const companyName = String(branding?.companyProfile?.company_name || invite.party_name || "Next Master");
    const portalLabel = invite.party_type === "vendor" ? "Vendor Portal" : "Customer Portal";
    const subject = `${companyName} ${portalLabel} password reset`;
    const message = [
      `Hello ${invite.contact_name || invite.party_name || ""},`,
      "",
      `A password reset was requested for your ${portalLabel.toLowerCase()} access at ${companyName}.`,
      "",
      "Open this link to create a new password:",
      resetUrl.toString(),
      "",
      "This link expires in 60 minutes and becomes invalid after any password change or portal access update.",
      "",
      "If you did not request this, ignore this email.",
    ].join("\n");

    await sendResetEmail(resendApiKey, emailFrom, invite.email, subject, message);

    return json({ ok: true, message: GENERIC_MESSAGE });
  } catch (error) {
    return json({ error: sanitizeUserFacingError(error, "Portal password reset request failed") }, 500);
  }
};

export const config: Config = {
  path: "/api/portal-password-reset-request",
  method: "POST",
};
