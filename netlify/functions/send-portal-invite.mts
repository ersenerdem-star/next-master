import type { Config, Context } from "@netlify/functions";
import { requireCallerProfile } from "./_shared/auth.mts";
import { buildRestUrl, getJson, json, serviceRoleHeaders } from "./_shared/http.mts";
import { sanitizeUserFacingError } from "./_shared/user-message.mts";
import { resolvePortalSellerDomainForSeller } from "./_shared/portal-tenant.mts";

type PortalInviteRow = {
  id: string;
  organization_id: string;
  party_type: "customer" | "vendor";
  party_name: string;
  customer_id?: string | null;
  vendor_id?: string | null;
  seller_company_profile_id?: string | null;
  email: string;
  contact_name: string | null;
  status: "draft" | "invited" | "active" | "disabled";
  invite_token_hash: string | null;
};

type EmailTemplateRow = {
  template_key?: string | null;
  subject: string | null;
  body: string | null;
};

type OutboundEmailRow = {
  id: string;
};

const PORTAL_INVITE_SELECT =
  "id,organization_id,party_type,party_name,customer_id,vendor_id,seller_company_profile_id,email,contact_name,status,invite_token_hash,updated_at";

type InviteLocale = "en" | "tr" | "de" | "ru";

const DEFAULT_TEMPLATES: Record<"customer_portal_invite" | "vendor_portal_invite", Record<InviteLocale, { subject: string; body: string }>> = {
  customer_portal_invite: {
    en: {
      subject: "Secure portal access for {{party_name}}",
      body:
        "Dear {{contact_name}},\n\nWe are pleased to confirm that your secure customer portal access for {{party_name}} is ready.\n\nPortal: {{portal_link}}\n\nPlease use the password provided by your account administrator. For your security, do not share your password or this message.\n\nThrough the portal you can review your account information, orders, invoices, payments, and the product information available to your account.\n\nIf you did not expect this invitation, please contact your account representative before signing in.\n\nKind regards,\n{{seller_portal_label}}\n{{company_name}}",
    },
    tr: {
      subject: "Güvenli portal erişiminiz hazır — {{party_name}}",
      body:
        "Sayın {{contact_name}},\n\n{{party_name}} için güvenli müşteri portalı erişiminiz hazırdır.\n\nPortal bağlantısı: {{portal_link}}\n\nLütfen hesap yöneticiniz tarafından belirlenen şifreyi kullanın. Güvenliğiniz için şifrenizi veya bu mesajı başkalarıyla paylaşmayın.\n\nPortal üzerinden hesabınıza tanımlı bilgileri, siparişleri, faturaları, ödemeleri ve erişiminize açık ürün bilgilerini inceleyebilirsiniz.\n\nBu daveti beklemiyorsanız giriş yapmadan önce hesap temsilcinizle iletişime geçin.\n\nSaygılarımızla,\n{{seller_portal_label}}\n{{company_name}}",
    },
    de: {
      subject: "Sicherer Portalzugang für {{party_name}}",
      body:
        "Guten Tag {{contact_name}},\n\nIhr sicherer Kundenportal-Zugang für {{party_name}} ist jetzt eingerichtet.\n\nPortal: {{portal_link}}\n\nBitte verwenden Sie das von Ihrem Administrator festgelegte Passwort. Geben Sie Ihr Passwort und diese Nachricht aus Sicherheitsgründen nicht weiter.\n\nIm Portal können Sie die für Ihr Konto verfügbaren Kontoinformationen, Bestellungen, Rechnungen, Zahlungen und Produktinformationen einsehen.\n\nWenn Sie diese Einladung nicht erwartet haben, wenden Sie sich bitte vor der Anmeldung an Ihren Ansprechpartner.\n\nMit freundlichen Grüßen,\n{{seller_portal_label}}\n{{company_name}}",
    },
    ru: {
      subject: "Безопасный доступ к порталу — {{party_name}}",
      body:
        "Здравствуйте, {{contact_name}}!\n\nВаш безопасный доступ к клиентскому порталу {{party_name}} готов.\n\nПортал: {{portal_link}}\n\nИспользуйте пароль, установленный администратором вашей учетной записи. В целях безопасности не передавайте пароль или это сообщение другим лицам.\n\nВ портале доступны данные вашей учетной записи, заказы, счета, платежи и информация о товарах в соответствии с предоставленными правами доступа.\n\nЕсли вы не ожидали это приглашение, свяжитесь с вашим менеджером до входа в систему.\n\nС уважением,\n{{seller_portal_label}}\n{{company_name}}",
    },
  },
  vendor_portal_invite: {
    en: {
      subject: "Secure supplier portal access for {{party_name}}",
      body:
        "Dear {{contact_name}},\n\nYour secure supplier portal access for {{party_name}} is ready.\n\nPortal: {{portal_link}}\n\nPlease use the password provided by your account administrator. For your security, do not share your password or this message.\n\nThe portal provides access to the purchasing and payment information permitted for your account.\n\nIf you did not expect this invitation, please contact your account representative before signing in.\n\nKind regards,\n{{seller_portal_label}}\n{{company_name}}",
    },
    tr: {
      subject: "Güvenli tedarikçi portalı erişiminiz hazır — {{party_name}}",
      body:
        "Sayın {{contact_name}},\n\n{{party_name}} için güvenli tedarikçi portalı erişiminiz hazırdır.\n\nPortal bağlantısı: {{portal_link}}\n\nLütfen hesap yöneticiniz tarafından belirlenen şifreyi kullanın. Güvenliğiniz için şifrenizi veya bu mesajı başkalarıyla paylaşmayın.\n\nPortal üzerinden hesabınıza tanımlı satın alma ve ödeme bilgilerine erişebilirsiniz.\n\nBu daveti beklemiyorsanız giriş yapmadan önce hesap temsilcinizle iletişime geçin.\n\nSaygılarımızla,\n{{seller_portal_label}}\n{{company_name}}",
    },
    de: {
      subject: "Sicherer Lieferantenportal-Zugang für {{party_name}}",
      body:
        "Guten Tag {{contact_name}},\n\nIhr sicherer Lieferantenportal-Zugang für {{party_name}} ist jetzt eingerichtet.\n\nPortal: {{portal_link}}\n\nBitte verwenden Sie das von Ihrem Administrator festgelegte Passwort. Geben Sie Ihr Passwort und diese Nachricht aus Sicherheitsgründen nicht weiter.\n\nIm Portal stehen Ihnen die für Ihr Konto freigegebenen Einkaufs- und Zahlungsinformationen zur Verfügung.\n\nWenn Sie diese Einladung nicht erwartet haben, wenden Sie sich bitte vor der Anmeldung an Ihren Ansprechpartner.\n\nMit freundlichen Grüßen,\n{{seller_portal_label}}\n{{company_name}}",
    },
    ru: {
      subject: "Безопасный доступ поставщика к порталу — {{party_name}}",
      body:
        "Здравствуйте, {{contact_name}}!\n\nВаш безопасный доступ поставщика к порталу {{party_name}} готов.\n\nПортал: {{portal_link}}\n\nИспользуйте пароль, установленный администратором вашей учетной записи. В целях безопасности не передавайте пароль или это сообщение другим лицам.\n\nВ портале доступны разрешенные для вашей учетной записи закупочные и платежные данные.\n\nЕсли вы не ожидали это приглашение, свяжитесь с вашим менеджером до входа в систему.\n\nС уважением,\n{{seller_portal_label}}\n{{company_name}}",
    },
  },
};

function normalizeInviteLocale(value: unknown): InviteLocale {
  const language = String(value || "").trim().toLowerCase();
  if (language === "tr" || language.startsWith("turk") || language.includes("türk")) return "tr";
  if (language === "de" || language.startsWith("germ") || language.includes("deutsch")) return "de";
  if (language === "ru" || language.startsWith("russ") || language.includes("рус")) return "ru";
  return "en";
}

async function resolveRecipientLocale(input: {
  supabaseUrl: string;
  serviceRoleKey: string;
  organizationId: string;
  partyType: "customer" | "vendor";
  customerId: string;
  vendorId: string;
}) {
  const table = input.partyType === "customer" ? "customers" : "vendors";
  const id = input.partyType === "customer" ? input.customerId : input.vendorId;
  if (!id) return "en" satisfies InviteLocale;

  const rows = await getJson<Array<{ language?: string | null }>>(
    buildRestUrl(input.supabaseUrl, table, {
      select: "language",
      organization_id: `eq.${input.organizationId}`,
      id: `eq.${id}`,
      limit: "1",
    }),
    { headers: serviceRoleHeaders(input.serviceRoleKey) },
  ).catch(() => []);

  return normalizeInviteLocale(rows[0]?.language);
}

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
    const inviteLocale = await resolveRecipientLocale({
      supabaseUrl: caller.supabaseUrl,
      serviceRoleKey: caller.serviceRoleKey,
      organizationId: caller.profile.organization_id,
      partyType: invite.party_type,
      customerId: String(invite.customer_id || "").trim(),
      vendorId: String(invite.vendor_id || "").trim(),
    });

    // A locale-specific admin template can override the built-in corporate copy.
    // If it does not exist, the existing base template remains authoritative.
    const localizedTemplateRows = await getJson<Array<EmailTemplateRow>>(
      buildRestUrl(caller.supabaseUrl, "email_templates", {
        select: "template_key,subject,body",
        organization_id: `eq.${caller.profile.organization_id}`,
        template_key: `eq.${`${templateKey}.${inviteLocale}`}`,
        limit: "1",
      }),
      {
        headers: serviceRoleHeaders(caller.serviceRoleKey),
      },
    ).catch(() => []);
    const baseTemplateRows = localizedTemplateRows.length
      ? []
      : await getJson<Array<EmailTemplateRow>>(
          buildRestUrl(caller.supabaseUrl, "email_templates", {
            select: "template_key,subject,body",
            organization_id: `eq.${caller.profile.organization_id}`,
            template_key: `eq.${templateKey}`,
            limit: "1",
          }),
          {
            headers: serviceRoleHeaders(caller.serviceRoleKey),
          },
        ).catch(() => []);
    const fallbackTemplate = DEFAULT_TEMPLATES[templateKey][inviteLocale];
    // The legacy base template is English-only. It may be used for English,
    // but it must never override a recipient's Turkish, German, or Russian copy.
    const template = localizedTemplateRows[0] || (inviteLocale === "en" ? baseTemplateRows[0] : null) || fallbackTemplate;
    const sellerDomain =
      invite.party_type === "customer" && invite.seller_company_profile_id
        ? await resolvePortalSellerDomainForSeller(
            caller.supabaseUrl,
            caller.serviceRoleKey,
            caller.profile.organization_id,
            invite.seller_company_profile_id,
          ).catch(() => null)
        : null;
    const portalOrigin = sellerDomain?.hostname
      ? `https://${sellerDomain.hostname}`
      : portalBaseUrl.replace(/\/$/, "");
    const portalLink = `${portalOrigin}/portal?email=${encodeURIComponent(invite.email)}`;
    const variables = {
      party_name: invite.party_name,
      contact_name: String(invite.contact_name || invite.party_name || "").trim(),
      portal_link: portalLink,
      company_name: companyName,
      seller_portal_label: String(sellerDomain?.portal_label || companyName).trim(),
      language: inviteLocale,
    };
    const subject = renderTemplate(String(template.subject || fallbackTemplate.subject), variables);
    const body = renderTemplate(String(template.body || fallbackTemplate.body), variables);

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
