import { buildRestUrl, serviceRoleHeaders } from "./http.mts";

type PortalAuditEventInput = {
  organizationId?: string | null;
  inviteId?: string | null;
  partyType?: string | null;
  email?: string | null;
  eventType: string;
  status?: "ok" | "failed" | "rate_limited";
  details?: Record<string, unknown>;
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
    const response = await fetch(buildRestUrl(supabaseUrl, "portal_audit_logs", {}), {
      method: "POST",
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
          ip_address: firstForwardedIp(req) || null,
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
