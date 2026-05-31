import type { Config, Context } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import { requireCallerProfile } from "./_shared/auth.mts";
import { buildRestUrl, getJson, json, sendJson, serviceRoleHeaders } from "./_shared/http.mts";
import { sanitizeUserFacingError, sanitizeUserFacingMessage } from "./_shared/user-message.mts";

const allowedRoles = new Set(["admin", "sales", "viewer"]);
const welcomeTemplateKey = "internal_user_welcome";
const defaultWelcomeTemplate = {
  template_name: "Internal User Welcome",
  subject: "Set your password for {{company_name}}",
  body:
    "Hello {{full_name}},\n\nYour user account is ready.\n\nUser email: {{user_email}}\nLogin link: {{login_link}}\nSet password link: {{set_password_link}}\n\nOpen the set password link first and define your own password. After that, use the login link to sign in.\n\nRegards,\n{{company_name}}",
};

function normalizeEmail(value: unknown) {
  return String(value || "").trim().toLowerCase();
}

function renderTemplate(input: string, values: Record<string, string>) {
  return input.replace(/\{\{(.*?)\}\}/g, (_, rawKey: string) => {
    const key = rawKey.trim();
    return values[key] ?? "";
  });
}

function resolveSiteUrl(req: Request) {
  const envUrl = Netlify.env.get("URL") || Netlify.env.get("DEPLOY_PRIME_URL") || "";
  if (envUrl) return envUrl.replace(/\/$/, "");
  const proto = req.headers.get("x-forwarded-proto") || "https";
  const host = req.headers.get("x-forwarded-host") || req.headers.get("host") || "";
  return host ? `${proto}://${host}` : "";
}

function generateTemporaryPassword(length = 20) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (value) => alphabet[value % alphabet.length]).join("");
}

async function fetchCompanyName(supabaseUrl: string, serviceRoleKey: string, organizationId: string) {
  try {
    const rows = await getJson<Array<{ company_name: string }>>(
      buildRestUrl(supabaseUrl, "company_profiles", {
        select: "company_name",
        organization_id: `eq.${organizationId}`,
        order: "company_name.asc",
        limit: "1",
      }),
      { headers: serviceRoleHeaders(serviceRoleKey) },
    );
    return String(rows[0]?.company_name || "").trim() || "Next Master";
  } catch {
    return "Next Master";
  }
}

async function ensureWelcomeTemplate(supabaseUrl: string, serviceRoleKey: string, organizationId: string) {
  const select = "id,template_key,template_name,subject,body,is_active";
  const existing = await getJson<
    Array<{ id: string; template_key: string; template_name: string; subject: string; body: string; is_active: boolean }>
  >(
    buildRestUrl(supabaseUrl, "email_templates", {
      select,
      organization_id: `eq.${organizationId}`,
      template_key: `eq.${welcomeTemplateKey}`,
      limit: "1",
    }),
    { headers: serviceRoleHeaders(serviceRoleKey) },
  );
  if (existing[0]?.id) return existing[0];

  const created = await sendJson<Array<{ id: string; template_name: string; subject: string; body: string }>>(
    buildRestUrl(supabaseUrl, "email_templates", { select }),
    {
      method: "POST",
      headers: {
        ...serviceRoleHeaders(serviceRoleKey),
        Prefer: "return=representation",
      },
      body: JSON.stringify([
        {
          organization_id: organizationId,
          template_key: welcomeTemplateKey,
          template_name: defaultWelcomeTemplate.template_name,
          subject: defaultWelcomeTemplate.subject,
          body: defaultWelcomeTemplate.body,
          is_active: true,
        },
      ]),
    },
  );
  if (!created[0]?.id) {
    throw new Error("Welcome email template create failed");
  }
  return created[0];
}

async function queueWelcomeEmail(input: {
  supabaseUrl: string;
  serviceRoleKey: string;
  organizationId: string;
  userId: string;
  fullName: string;
  email: string;
  companyName: string;
  loginLink: string;
  setPasswordLink: string;
}) {
  const template = await ensureWelcomeTemplate(input.supabaseUrl, input.serviceRoleKey, input.organizationId);
  const variables = {
    full_name: input.fullName || input.email,
    user_email: input.email,
    login_link: input.loginLink,
    set_password_link: input.setPasswordLink,
    company_name: input.companyName,
  };

  const queued = await sendJson<Array<{ id: string }>>(
    buildRestUrl(input.supabaseUrl, "outbound_emails", {
      on_conflict: "organization_id,template_key,related_type,related_id,recipient_email",
      select: "id",
    }),
    {
      method: "POST",
      headers: {
        ...serviceRoleHeaders(input.serviceRoleKey),
        Prefer: "resolution=merge-duplicates,return=representation",
      },
      body: JSON.stringify([
        {
          organization_id: input.organizationId,
          template_key: welcomeTemplateKey,
          recipient_type: "internal",
          recipient_name: input.fullName || input.email,
          recipient_email: input.email,
          subject: renderTemplate(template.subject, variables),
          body: renderTemplate(template.body, variables),
          related_type: "user",
          related_id: input.userId,
          status: "queued",
          sent_at: null,
          updated_at: new Date().toISOString(),
        },
      ]),
    },
  );
  return String(queued[0]?.id || "");
}

export default async (req: Request, _context: Context) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const caller = await requireCallerProfile(req, ["superadmin"]);
    if ("error" in caller) return json({ error: caller.error }, caller.status);

    const payload = await req.json().catch(() => ({}));
    const email = normalizeEmail(payload?.email);
    const fullName = String(payload?.fullName || "").trim();
    const role = String(payload?.role || "sales").trim().toLowerCase();
    const isActive = payload?.isActive !== false;

    if (!email) return json({ error: "Email is required" }, 400);
    if (!allowedRoles.has(role)) return json({ error: "Invalid role" }, 400);

    const temporaryPassword = generateTemporaryPassword();
    const siteUrl = resolveSiteUrl(req);

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
          password: temporaryPassword,
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

    let welcomeEmailId = "";
    let welcomeEmailError = "";
    try {
      const companyName = await fetchCompanyName(caller.supabaseUrl, caller.serviceRoleKey, caller.profile.organization_id);
      const adminClient = createClient(caller.supabaseUrl, caller.serviceRoleKey, {
        auth: {
          autoRefreshToken: false,
          persistSession: false,
        },
      });
      const { data: generated, error: generateError } = await adminClient.auth.admin.generateLink({
        type: "recovery",
        email,
        options: siteUrl ? { redirectTo: siteUrl } : undefined,
      });
      if (generateError) throw generateError;
      const setPasswordLink = String(generated?.properties?.action_link || "").trim();
      if (!setPasswordLink) throw new Error("Password setup link generation failed");

      welcomeEmailId = await queueWelcomeEmail({
        supabaseUrl: caller.supabaseUrl,
        serviceRoleKey: caller.serviceRoleKey,
        organizationId: caller.profile.organization_id,
        userId: createdUserId,
        fullName,
        email,
        companyName,
        loginLink: siteUrl || caller.supabaseUrl,
        setPasswordLink,
      });
      if (!welcomeEmailId) {
        throw new Error("Welcome email queue failed");
      }
    } catch (error) {
      welcomeEmailError = sanitizeUserFacingMessage(error instanceof Error ? error.message : error, "Welcome email queue failed");
    }

    return json({
      ok: true,
      userId: createdUserId,
      email,
      role,
      isActive,
      welcomeEmailId: welcomeEmailId || undefined,
      welcomeEmailQueued: Boolean(welcomeEmailId),
      welcomeEmailError: welcomeEmailError || undefined,
    });
  } catch (error) {
    return json({ error: sanitizeUserFacingError(error, "User create failed") }, 500);
  }
};

export const config: Config = {
  path: "/api/admin-create-user",
  method: "POST",
};
