import type { Config, Context } from "@netlify/functions";
import { requireCallerProfile } from "./_shared/auth.mts";
import { buildRestUrl, getJson, json, serviceRoleHeaders } from "./_shared/http.mts";

export default async (req: Request, _context: Context) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const caller = await requireCallerProfile(req, ["admin"]);
    if ("error" in caller) return json({ error: caller.error }, caller.status);

    const resendApiKey = Netlify.env.get("RESEND_API_KEY");
    const emailFrom = Netlify.env.get("EMAIL_FROM") || "";
    const siteUrl = Netlify.env.get("URL") || "";
    const functionRegion = Netlify.env.get("AWS_REGION") || "";

    let authOk = true;
    let authDetail = "Active caller profile resolved.";
    let databaseOk = true;
    let databaseDetail = "Organization data API reachable.";

    try {
      await getJson<Array<{ id: string }>>(
        buildRestUrl(caller.supabaseUrl, "profiles", {
          select: "id",
          organization_id: `eq.${caller.profile.organization_id}`,
          limit: "1",
        }),
        { headers: serviceRoleHeaders(caller.serviceRoleKey) },
      );
    } catch (error) {
      databaseOk = false;
      databaseDetail = error instanceof Error ? error.message : "Database probe failed";
    }

    if (!caller.supabaseAnonKey || !caller.serviceRoleKey || !caller.supabaseUrl) {
      authOk = false;
      authDetail = "One or more Supabase environment variables are missing.";
    }

    return json({
      runtime: {
        siteUrl,
        functionRegion,
      },
      env: {
        supabaseUrl: Boolean(caller.supabaseUrl),
        supabaseAnonKey: Boolean(caller.supabaseAnonKey),
        serviceRoleKey: Boolean(caller.serviceRoleKey),
        resendApiKey: Boolean(resendApiKey),
        emailFrom: Boolean(emailFrom),
        emailFromValue: emailFrom,
      },
      checks: {
        auth: {
          ok: authOk,
          detail: authDetail,
        },
        database: {
          ok: databaseOk,
          detail: databaseDetail,
        },
        email: {
          ok: Boolean(resendApiKey && emailFrom),
          detail: resendApiKey && emailFrom ? "Resend credentials loaded." : "Missing Resend credentials.",
        },
      },
    });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Diagnostics failed" }, 500);
  }
};

export const config: Config = {
  path: "/api/admin-diagnostics",
  method: "POST",
};
