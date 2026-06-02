import type { Config, Context } from "@netlify/functions";
import { requireCallerProfile } from "./_shared/auth.mts";
import { buildRestUrl, getJson, json, serviceRoleHeaders } from "./_shared/http.mts";
import { sanitizeUserFacingError } from "./_shared/user-message.mts";

type PortalInviteRow = {
  id: string;
  organization_id: string;
  party_type: "customer" | "vendor";
  party_name: string;
  customer_id?: string | null;
  vendor_id?: string | null;
  email: string;
  contact_name: string | null;
  status: "draft" | "invited" | "active" | "disabled";
  invite_token_hash: string | null;
};

type EmailTemplateRow = {
  subject: string | null;
  body: string | null;
};

type OutboundEmailRow = {
  id: string;
};

const PORTAL_INVITE_SELECT =
  "id,organization_id,party_type,party_name,customer_id,vendor_id,email,contact_name,status,invite_token_hash,updated_at";

const DEFAULT_TEMPLATES = {
  customer_portal_invite: {
    subject: "Portal access for {{party_name}}",
    body:
      "Hello {{contact_name}},\n\nYour customer portal access is ready for {{party_name}}.\n\nPortal link: {{portal_link}}\nPassword: Use the password set by your admin.\n\nYou can review account balance, invoices, payments, and orders based on your permissions.\n\nRegards,\n{{company_name}}",
  },
  vendor_portal_invite: {
    subject: "Vendor portal access for {{party_name}}",
    body:
      "Hello {{contact_name}},\n\nYour vendor portal access is ready for {{party_name}}.\n\nPortal link: {{portal_link}}\nPassword: Use the password set by your admin.\n\nYou can review purchase orders, bills, and payment activity based on your permissions.\n\nRegards,\n{{company_name}}",
  },
} as const;

function hasConfiguredPortalPassword(invite: PortalInviteRow | null | undefined) {
  if (!invite) return false;
  return String(invite.status || "").trim().toLowerCase() === "active" && Boolean(String(invite.invite_token_hash || "").trim());
}

function hasPortalScope(invite: PortalInviteRow | null | undefined) {
  if (!invite) return false;
  if (invite.party_type === "customer") {
    return Boolean(String(invite.customer_id || "").trim());
  }
  if (invite.party_type === "vendor") {
    return Boolean(String(invite.vendor_id || "").trim());
  }
  return false;
}

function renderTemplate(input: string, values: Record<string, string>) {
  return input.replace(/\{\{(.*?)\}\}/g, (_, rawKey: string) => values[rawKey.trim()] ?? "");
}

async function upsertOutboundEmail(input: {
  supabaseUrl: string;
  serviceRoleKey: string;
  organizationId: string;
  templateKey: string;
  recipientType: "customer" | "vendor";
  recipientName: string;
  recipientEmail: string;
  relatedId: string;
  subject: string;
  body: string;
}) {
  const existing = await getJson<Array<{ id: string }>>(
    buildRestUrl(input.supabaseUrl, "outbound_emails", {
      select: "id",
      organization_id: `eq.${input.organizationId}`,
      template_key: `eq.${input.templateKey}`,
      related_type: "eq.portal_invite",
      related_id: `eq.${input.relatedId}`,
      recipient_email: `eq.${input.recipientEmail}`,
      limit: "1",
    }),
    {
      headers: serviceRoleHeaders(input.serviceRoleKey),
    },
  ).catch(() => []);

  const payload = {
    organization_id: input.organizationId,
    template_key: input.templateKey,
    recipient_type: input.recipientType,
    recipient_name: input.recipientName,
    recipient_email: input.recipientEmail,
    subject: input.subject,
    body: input.body,
    related_type: "portal_invite",
    related_id: input.relatedId,
    status: "queued",
    sent_at: null,
    updated_at: new Date().toISOString(),
  };

  if (existing[0]?.id) {
    const response = await fetch(buildRestUrl(input.supabaseUrl, "outbound_emails", { id: `eq.${existing[0].id}` }), {
      method: "PATCH",
      headers: serviceRoleHeaders(input.serviceRoleKey),
      body: JSON.stringify(payload),
    });
    if (!response.ok) {
      throw new Error("Portal invite queue update failed.");
    }
    return { id: existing[0].id } satisfies OutboundEmailRow;
  }

  const response = await fetch(buildRestUrl(input.supabaseUrl, "outbound_emails", { select: "id" }), {
    method: "POST",
    headers: {
      ...serviceRoleHeaders(input.serviceRoleKey),
      Prefer: "return=representation",
    },
    body: JSON.stringify([payload]),
  });
  const data = (await response.json().catch(() => [])) as Array<{ id?: string }>;
  if (!response.ok || !data[0]?.id) {
    throw new Error("Portal invite queue create failed.");
  }
  return { id: String(data[0].id) } satisfies OutboundEmailRow;
}

async function patchOutboundEmailStatus(supabaseUrl: string, serviceRoleKey: string, id: string, status: "sent" | "failed") {
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
    throw new Error("Portal invite email status update failed.");
  }
}

async function patchPortalInviteSent(supabaseUrl: string, serviceRoleKey: string, invite: PortalInviteRow) {
  const response = await fetch(buildRestUrl(supabaseUrl, "portal_invites", { id: `eq.${invite.id}` }), {
    method: "PATCH",
    headers: serviceRoleHeaders(serviceRoleKey),
    body: JSON.stringify({
      status: invite.status === "active" ? "active" : "invited",
      last_sent_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }),
  });
  if (!response.ok) {
    throw new Error("Portal invite sent marker update failed.");
  }
}

function matchesPortalInviteScope(
  invite: PortalInviteRow,
  partyType: string,
  email: string,
  customerId: string,
  vendorId: string,
) {
  if (invite.party_type !== partyType) return false;
  if (String(invite.email || "").trim().toLowerCase() !== email) return false;
  if (partyType === "customer" && customerId) {
    return String(invite.customer_id || "").trim() === customerId;
  }
  if (partyType === "vendor" && vendorId) {
    return String(invite.vendor_id || "").trim() === vendorId;
  }
  return true;
}

async function resolvePortalInviteForSend(input: {
  supabaseUrl: string;
  serviceRoleKey: string;
  organizationId: string;
  portalInviteId: string;
  email: string;
  partyType: string;
  customerId: string;
  vendorId: string;
}) {
  const directInvite =
    (
      await getJson<Array<PortalInviteRow>>(
        buildRestUrl(input.supabaseUrl, "portal_invites", {
          select: PORTAL_INVITE_SELECT,
          organization_id: `eq.${input.organizationId}`,
          id: `eq.${input.portalInviteId}`,
          limit: "1",
        }),
        {
          headers: serviceRoleHeaders(input.serviceRoleKey),
        },
      ).catch(() => [])
    )[0] || null;

  if (directInvite && directInvite.status !== "disabled") {
    return directInvite;
  }

  if (!input.email || !input.partyType) return directInvite;

  const candidateInvites = await getJson<Array<PortalInviteRow>>(
    buildRestUrl(input.supabaseUrl, "portal_invites", {
      select: PORTAL_INVITE_SELECT,
      organization_id: `eq.${input.organizationId}`,
      email: `eq.${input.email}`,
      party_type: `eq.${input.partyType}`,
      order: "updated_at.desc",
      limit: "20",
    }),
    {
      headers: serviceRoleHeaders(input.serviceRoleKey),
    },
  ).catch(() => []);

  return (
    candidateInvites.find(
      (invite) =>
        invite.status !== "disabled" &&
        matchesPortalInviteScope(invite, input.partyType, input.email, input.customerId, input.vendorId),
    ) || directInvite
  );
}

export default async (req: Request, _context: Context) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const caller = await requireCallerProfile(req, ["superadmin", "admin", "sales"]);
    if ("error" in caller) return json({ error: caller.error }, caller.status);

    const payload = await req.json().catch(() => ({}));
    const portalInviteId = String(payload?.portalInviteId || "").trim();
    const companyName = String(payload?.companyName || "").trim() || "Next Master";
    const portalBaseUrl = String(payload?.portalBaseUrl || "").trim();
    const email = String(payload?.email || "").trim().toLowerCase();
    const partyType = String(payload?.partyType || "").trim().toLowerCase();
    const customerId = String(payload?.customerId || "").trim();
    const vendorId = String(payload?.vendorId || "").trim();
    if (!portalInviteId || !portalBaseUrl) {
      return json({ error: "Portal invite id and portal base URL are required." }, 400);
    }

    const invite = await resolvePortalInviteForSend({
      supabaseUrl: caller.supabaseUrl,
      serviceRoleKey: caller.serviceRoleKey,
      organizationId: caller.profile.organization_id,
      portalInviteId,
      email,
      partyType,
      customerId,
      vendorId,
    });

    if (!invite || invite.status === "disabled") {
      return json({ error: "Portal invite not found or disabled." }, 404);
    }
    if (!hasPortalScope(invite)) {
      return json({ error: "Portal invite is missing customer or vendor scope. Save portal access again." }, 409);
    }
    if (!hasConfiguredPortalPassword(invite)) {
      return json({ error: "Set a portal password before sending access." }, 400);
    }

    const templateKey = invite.party_type === "vendor" ? "vendor_portal_invite" : "customer_portal_invite";
    const templateRows = await getJson<Array<EmailTemplateRow>>(
      buildRestUrl(caller.supabaseUrl, "email_templates", {
        select: "subject,body",
        organization_id: `eq.${caller.profile.organization_id}`,
        template_key: `eq.${templateKey}`,
        limit: "1",
      }),
      {
        headers: serviceRoleHeaders(caller.serviceRoleKey),
      },
    ).catch(() => []);

    const template = templateRows[0] || DEFAULT_TEMPLATES[templateKey];
    const portalLink = `${portalBaseUrl.replace(/\/$/, "")}/portal?email=${encodeURIComponent(invite.email)}`;
    const variables = {
      party_name: invite.party_name,
      contact_name: String(invite.contact_name || invite.party_name || "").trim(),
      portal_link: portalLink,
      company_name: companyName,
    };
    const subject = renderTemplate(String(template.subject || DEFAULT_TEMPLATES[templateKey].subject), variables);
    const body = renderTemplate(String(template.body || DEFAULT_TEMPLATES[templateKey].body), variables);

    const queued = await upsertOutboundEmail({
      supabaseUrl: caller.supabaseUrl,
      serviceRoleKey: caller.serviceRoleKey,
      organizationId: caller.profile.organization_id,
      templateKey,
      recipientType: invite.party_type,
      recipientName: invite.party_name,
      recipientEmail: invite.email,
      relatedId: invite.id,
      subject,
      body,
    });

    await patchPortalInviteSent(caller.supabaseUrl, caller.serviceRoleKey, invite);
    return json({ ok: true, sent: false, queued: true, queuedEmailId: queued.id });
  } catch (error) {
    return json({ error: sanitizeUserFacingError(error, "Portal invite send failed") }, 500);
  }
};

export const config: Config = {
  path: "/api/send-portal-invite",
  method: "POST",
};
