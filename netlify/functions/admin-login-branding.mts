import type { Config, Context } from "@netlify/functions";
import { json } from "./_shared/http.mts";

type CompanyProfileRow = {
  company_name?: string | null;
  logo_data_url?: string | null;
};

export default async (_req: Request, _context: Context) => {
  const supabaseUrl = Netlify.env.get("SUPABASE_URL");
  const serviceRoleKey = Netlify.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return json({
      branding: {
        companyName: "Asad Otomotiv",
        logoDataUrl: "",
        label: "Admin Workspace",
      },
    });
  }

  try {
    const response = await fetch(
      `${supabaseUrl}/rest/v1/company_profiles?select=company_name,logo_data_url&company_name=ilike.*Asad*&limit=1`,
      {
        headers: {
          apikey: serviceRoleKey,
          Authorization: `Bearer ${serviceRoleKey}`,
        },
      },
    );
    const rows = response.ok ? ((await response.json()) as CompanyProfileRow[]) : [];
    const profile = rows[0];
    return json({
      branding: {
        companyName: String(profile?.company_name || "Asad Otomotiv"),
        logoDataUrl: String(profile?.logo_data_url || ""),
        label: "Admin Workspace",
      },
    });
  } catch {
    return json({
      branding: {
        companyName: "Asad Otomotiv",
        logoDataUrl: "",
        label: "Admin Workspace",
      },
    });
  }
};

export const config: Config = {
  path: "/api/admin-login-branding",
  method: "GET",
};
