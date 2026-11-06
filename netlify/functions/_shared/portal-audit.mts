import { buildRestUrl, serviceRoleHeaders } from "./http.mts";
import { isIP } from "node:net";

type PortalAuditEventInput = {
  organizationId?: string | null;
  inviteId?: string | null;
  partyType?: string | null;
  email?: string | null;
  eventType: string;
  status?: "ok" | "failed" | "rate_limited";
  details?: Record<string, unknown>;
  ipAddress?: string | null;
  countryCode?: string | null;
  countrySource?: "netlify_geo" | null;
};

function firstForwardedIp(req: Request) {
  const forwarded = String(req.headers.get("x-forwarded-for") || "").trim();
  if (!forwarded) return "";
  return forwarded.split(",")[0]?.trim() || "";
}

export async function writePortalAuditEvent(
  req: Request,
  supabaseUrl: string,
  serviceRoleKey: string,
  input: PortalAuditEventInput,
) {
  try {
    const contextIp = String(input.ipAddress || "").trim();
    const ipAddress = Object.prototype.hasOwnProperty.call(input, "ipAddress")
      ? isIP(contextIp) ? contextIp : null
      : firstForwardedIp(req) || null;
    const country = String(input.countryCode || "").trim().toUpperCase();
    const countryCode = /^[A-Z]{2}$/.test(country) && country !== "ZZ" && country !== "XX"
      && input.countrySource === "netlify_geo" ? country : null;
    const response = await fetch(buildRestUrl(supabaseUrl, "portal_audit_logs", {}), {
      method: "POST",
      signal: AbortSignal.timeout(2_500),
      headers: {
        ...serviceRoleHeaders(serviceRoleKey),
        Prefer: "return=minimal",
      },
      body: JSON.stringify([
        {
          organization_id: input.organizationId || null,
          invite_id: input.inviteId || null,
          party_type: input.partyType || null,
          email: String(input.email || "").trim().toLowerCase() || null,
          event_type: input.eventType,
          status: input.status || "ok",
          ip_address: ipAddress,
          ...(Object.prototype.hasOwnProperty.call(input, "countryCode") ? {
            country_code: countryCode,
            country_source: countryCode ? "netlify_geo" : null,
          } : {}),
          user_agent: String(req.headers.get("user-agent") || "").trim() || null,
          details: input.details || {},
        },
      ]),
    });
    if (!response.ok) {
      await response.text().catch(() => "");
    }
  } catch {
    // Audit logging must never block portal flow.
  }
}
