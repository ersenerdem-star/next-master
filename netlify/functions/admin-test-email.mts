import type { Config, Context } from "@netlify/functions";
import { requireCallerProfile } from "./_shared/auth.mts";
import { json } from "./_shared/http.mts";
import { sanitizeUserFacingError, sanitizeUserFacingMessage } from "./_shared/user-message.mts";

export default async (req: Request, _context: Context) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const caller = await requireCallerProfile(req, ["superadmin"]);
    if ("error" in caller) return json({ error: caller.error }, caller.status);

    const resendApiKey = Netlify.env.get("RESEND_API_KEY");
    const emailFrom = Netlify.env.get("EMAIL_FROM");
    if (!resendApiKey || !emailFrom) {
      return json({ error: "Missing email delivery environment variables" }, 500);
    }

    const payload = await req.json().catch(() => ({}));
    const email = String(payload?.email || caller.profile.email || "").trim();
    if (!email) {
      return json({ error: "Email is required" }, 400);
    }

    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: emailFrom,
        to: email,
        subject: "Next Master diagnostics test email",
        text: `Diagnostics mail from Next Master.\n\nAdmin: ${caller.profile.email || "-"}\nOrganization: ${caller.profile.organization_id}\nTime: ${new Date().toISOString()}`,
      }),
    });

    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      return json({ error: sanitizeUserFacingMessage(data?.message || `Resend failed: ${response.status}`, "Test email failed") }, 500);
    }

    return json({ ok: true, email, messageId: data?.id || "" });
  } catch (error) {
    return json({ error: sanitizeUserFacingError(error, "Test email failed") }, 500);
  }
};

export const config: Config = {
  path: "/api/admin-test-email",
  method: "POST",
};
