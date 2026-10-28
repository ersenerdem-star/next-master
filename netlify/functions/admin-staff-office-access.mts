import type { Config, Context } from "@netlify/functions";
import { isIP } from "node:net";
import { requireCallerProfile } from "./_shared/auth.mts";
import { buildRestUrl, getJson, json, sendJson, serviceRoleHeaders } from "./_shared/http.mts";
import { sanitizeUserFacingError } from "./_shared/user-message.mts";

const isUuid = (value: unknown) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ""));

export default async (req: Request, context: Context) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    const caller = await requireCallerProfile(req, ["superadmin"]);
    if ("error" in caller) return json({ error: caller.error }, caller.status);
    const payload = await req.json().catch(() => ({}));
    const userId = String(payload.userId || "").trim();
    if (!isUuid(userId)) return json({ error: "Geçerli bir personel seçin." }, 400);
    const target = await getJson<Array<{ id: string; role: string; department: string }>>(
      buildRestUrl(caller.supabaseUrl, "profiles", {
        select: "id,role,department",
        id: `eq.${userId}`,
        organization_id: `eq.${caller.profile.organization_id}`,
        limit: "1",
      }),
      { headers: serviceRoleHeaders(caller.serviceRoleKey) },
    );
    if (!target[0]) return json({ error: "Personel bu kuruluşta bulunamadı." }, 404);

    const action = String(payload.action || "get").toLowerCase();
    if (action === "get") {
      const rows = await getJson<Array<{ enabled: boolean; allowed_ips: string[] }>>(
        buildRestUrl(caller.supabaseUrl, "staff_office_access", { select: "enabled,allowed_ips", profile_id: `eq.${userId}`, limit: "1" }),
        { headers: serviceRoleHeaders(caller.serviceRoleKey) },
      );
      const currentIp = isIP(context.ip || "") ? context.ip : "";
      return json({ ok: true, userId, enabled: rows[0]?.enabled === true, allowedIps: rows[0]?.allowed_ips || [], currentIp });
    }
    if (action !== "save") return json({ error: "Unsupported action" }, 400);
    if (["admin", "superadmin"].includes(target[0].role) || !["sales", "purchasing"].includes(target[0].department)) {
      return json({ error: "Ofis IP kuralı yalnızca satış veya satın alma personeline uygulanabilir." }, 400);
    }
    if (!Array.isArray(payload.allowedIps)) return json({ error: "IP listesi geçersiz." }, 400);
    const allowedIps = [...new Set(payload.allowedIps.map((value: unknown) => String(value || "").trim()).filter(Boolean))];
    if (allowedIps.length > 12 || allowedIps.some((ip) => isIP(ip) === 0)) {
      return json({ error: "En fazla 12 geçerli IPv4 veya IPv6 adresi girin; IP aralığı kullanmayın." }, 400);
    }
    const enabled = payload.enabled === true;
    if (enabled && !allowedIps.length) return json({ error: "Etkinleştirmeden önce en az bir ofis IP adresi girin." }, 400);
    await sendJson<unknown>(buildRestUrl(caller.supabaseUrl, "staff_office_access", { on_conflict: "profile_id" }), {
      method: "POST",
      headers: { ...serviceRoleHeaders(caller.serviceRoleKey), Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify({ profile_id: userId, enabled, allowed_ips: allowedIps, updated_at: new Date().toISOString() }),
    });
    return json({ ok: true, userId, enabled, allowedIps });
  } catch (error) {
    return json({ error: sanitizeUserFacingError(error, "Ofis erişim ayarı kaydedilemedi.") }, 500);
  }
};

export const config: Config = { path: "/api/admin-staff-office-access", method: "POST" };
