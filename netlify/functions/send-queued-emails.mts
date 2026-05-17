import type { Config, Context } from "@netlify/functions";
import { requireCallerProfile } from "./_shared/auth.mts";
import { buildRestUrl, getJson, json, serviceRoleHeaders } from "./_shared/http.mts";

type OutboundEmailRow = {
  id: string;
  organization_id: string;
  template_key: string;
  recipient_type: "customer" | "vendor" | "internal";
  recipient_name: string;
  recipient_email: string;
  subject: string;
  body: string;
  related_type: string;
  related_id: string;
  status: "draft" | "queued" | "sent" | "failed";
};

async function sendWithResend(apiKey: string, from: string, row: OutboundEmailRow) {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: row.recipient_email,
      subject: row.subject,
      text: row.body,
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data?.message || `Resend failed: ${response.status}`);
  }
  return data;
}

async function patchEmailStatus(supabaseUrl: string, serviceRoleKey: string, id: string, status: "sent" | "failed") {
  const payload =
    status === "sent"
      ? { status, sent_at: new Date().toISOString(), updated_at: new Date().toISOString() }
      : { status, updated_at: new Date().toISOString() };

  const response = await fetch(buildRestUrl(supabaseUrl, "outbound_emails", { id: `eq.${id}` }), {
    method: "PATCH",
    headers: serviceRoleHeaders(serviceRoleKey),
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data?.message || `Outbound email status patch failed: ${response.status}`);
  }
}

export default async (req: Request, _context: Context) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const caller = await requireCallerProfile(req, ["admin", "sales"]);
    if ("error" in caller) return json({ error: caller.error }, caller.status);

    const resendApiKey = Netlify.env.get("RESEND_API_KEY");
    const emailFrom = Netlify.env.get("EMAIL_FROM");
    if (!resendApiKey || !emailFrom) {
      return json({ error: "Missing email delivery environment variables" }, 500);
    }

    const payload = await req.json().catch(() => ({}));
    const emailIds = Array.isArray(payload?.emailIds)
      ? payload.emailIds.map((value: unknown) => String(value || "").trim()).filter(Boolean)
      : [];

    const params: Record<string, string> = {
      select:
        "id,organization_id,template_key,recipient_type,recipient_name,recipient_email,subject,body,related_type,related_id,status",
      organization_id: `eq.${caller.profile.organization_id}`,
      status: "eq.queued",
      order: "updated_at.asc",
      limit: "25",
    };
    if (emailIds.length) params.id = `in.(${emailIds.join(",")})`;

    const queued = await getJson<Array<OutboundEmailRow>>(buildRestUrl(caller.supabaseUrl, "outbound_emails", params), {
      headers: serviceRoleHeaders(caller.serviceRoleKey),
    });

    let sentCount = 0;
    let failedCount = 0;
    const sentIds: string[] = [];
    const failedIds: string[] = [];

    for (const row of queued) {
      try {
        await sendWithResend(resendApiKey, emailFrom, row);
        await patchEmailStatus(caller.supabaseUrl, caller.serviceRoleKey, row.id, "sent");
        sentCount += 1;
        sentIds.push(row.id);
      } catch {
        await patchEmailStatus(caller.supabaseUrl, caller.serviceRoleKey, row.id, "failed");
        failedCount += 1;
        failedIds.push(row.id);
      }
    }

    return json({
      ok: true,
      processed: queued.length,
      sentCount,
      failedCount,
      sentIds,
      failedIds,
    });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Queued email send failed" }, 500);
  }
};

export const config: Config = {
  path: "/api/send-queued-emails",
  method: "POST",
};
