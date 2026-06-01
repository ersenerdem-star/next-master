import type { LocalPurchaseOrder } from "../../types/orders";
import type { PortalInvite } from "../../types/portal";
import type { EmailTemplate, EmailTemplateKey, OutboundEmail } from "../../types/emailTemplates";
import { getCurrentOrgId } from "./organizationApi";
import { fetchPortalInvites } from "./portalInvitesApi";
import { supabaseClient } from "./supabaseClient";

const EMAIL_TEMPLATE_COLUMNS = [
  "id",
  "template_key",
  "template_name",
  "subject",
  "body",
  "is_active",
  "created_at",
  "updated_at",
].join(",");

const OUTBOUND_EMAIL_COLUMNS = [
  "id",
  "template_key",
  "recipient_type",
  "recipient_name",
  "recipient_email",
  "subject",
  "body",
  "related_type",
  "related_id",
  "status",
  "sent_at",
  "created_at",
  "updated_at",
].join(",");

const DEFAULT_TEMPLATES: Record<EmailTemplateKey, Pick<EmailTemplate, "template_name" | "subject" | "body">> = {
  customer_portal_invite: {
    template_name: "Customer Portal Invite",
    subject: "Portal access for {{party_name}}",
    body:
      "Hello {{contact_name}},\n\nYour customer portal access is ready for {{party_name}}.\n\nPortal link: {{portal_link}}\nPassword: Use the password set by your admin.\n\nYou can review account balance, invoices, payments, and orders based on your permissions.\n\nRegards,\n{{company_name}}",
  },
  vendor_portal_invite: {
    template_name: "Vendor Portal Invite",
    subject: "Vendor portal access for {{party_name}}",
    body:
      "Hello {{contact_name}},\n\nYour vendor portal access is ready for {{party_name}}.\n\nPortal link: {{portal_link}}\nPassword: Use the password set by your admin.\n\nYou can review purchase orders, bills, and payment activity based on your permissions.\n\nRegards,\n{{company_name}}",
  },
  vendor_purchase_order_confirmed: {
    template_name: "Vendor Purchase Order Confirmed",
    subject: "Purchase order {{purchase_order_no}} confirmed",
    body:
      "Hello {{vendor_name}},\n\nPurchase order {{purchase_order_no}} is confirmed.\nCustomer: {{customer_name}}\nPurchase company: {{purchase_company}}\nCurrency: {{currency}}\nTotal amount: {{total_amount}}\n\nPortal link: {{portal_link}}\nPassword: Use the password set by your admin.\n\nPlease review and proceed.\n\nRegards,\n{{company_name}}",
  },
  internal_user_welcome: {
    template_name: "Internal User Welcome",
    subject: "Set your password for {{company_name}}",
    body:
      "Hello {{full_name}},\n\nYour user account is ready.\n\nUser email: {{user_email}}\nLogin link: {{login_link}}\nSet password link: {{set_password_link}}\n\nOpen the set password link first and define your own password. After that, use the login link to sign in.\n\nRegards,\n{{company_name}}",
  },
};

function mapEmailTemplateRow(row: Record<string, unknown>): EmailTemplate {
  return {
    id: String(row.id || ""),
    template_key: String(row.template_key || "customer_portal_invite") as EmailTemplateKey,
    template_name: String(row.template_name || ""),
    subject: String(row.subject || ""),
    body: String(row.body || ""),
    is_active: Boolean(row.is_active),
    created_at: String(row.created_at || ""),
    updated_at: String(row.updated_at || ""),
  };
}

function mapOutboundEmailRow(row: Record<string, unknown>): OutboundEmail {
  return {
    id: String(row.id || ""),
    template_key: String(row.template_key || ""),
    recipient_type: String(row.recipient_type || "internal") as OutboundEmail["recipient_type"],
    recipient_name: String(row.recipient_name || ""),
    recipient_email: String(row.recipient_email || ""),
    subject: String(row.subject || ""),
    body: String(row.body || ""),
    related_type: String(row.related_type || ""),
    related_id: String(row.related_id || ""),
    status: String(row.status || "queued") as OutboundEmail["status"],
    sent_at: String(row.sent_at || ""),
    created_at: String(row.created_at || ""),
    updated_at: String(row.updated_at || ""),
  };
}

function renderTemplate(input: string, values: Record<string, string>) {
  return input.replace(/\{\{(.*?)\}\}/g, (_, rawKey: string) => {
    const key = rawKey.trim();
    return values[key] ?? "";
  });
}

async function ensureDefaultEmailTemplates() {
  const organizationId = await getCurrentOrgId();
  const { data, error } = await supabaseClient.from("email_templates").select(EMAIL_TEMPLATE_COLUMNS).eq("organization_id", organizationId);
  if (error) throw new Error(error.message || "Email templates load failed");

  const rows = ((data || []) as unknown as Record<string, unknown>[]).map(mapEmailTemplateRow);
  const existingKeys = new Set(rows.map((row) => row.template_key));
  const missingKeys = (Object.keys(DEFAULT_TEMPLATES) as EmailTemplateKey[]).filter((key) => !existingKeys.has(key));

  if (!missingKeys.length) return rows;

  const payload = missingKeys.map((key) => ({
    organization_id: organizationId,
    template_key: key,
    template_name: DEFAULT_TEMPLATES[key].template_name,
    subject: DEFAULT_TEMPLATES[key].subject,
    body: DEFAULT_TEMPLATES[key].body,
    is_active: true,
  }));

  const { data: inserted, error: insertError } = await supabaseClient.from("email_templates").insert(payload).select(EMAIL_TEMPLATE_COLUMNS);
  if (insertError) throw new Error(insertError.message || "Default email templates create failed");

  return [...rows, ...(((inserted || []) as unknown as Record<string, unknown>[]).map(mapEmailTemplateRow))].sort((a, b) =>
    a.template_name.localeCompare(b.template_name, "en"),
  );
}

async function queueOutboundEmail(input: {
  templateKey: EmailTemplateKey;
  recipientType: OutboundEmail["recipient_type"];
  recipientName: string;
  recipientEmail: string;
  relatedType: string;
  relatedId: string;
  subject: string;
  body: string;
}) {
  const organizationId = await getCurrentOrgId();
  const payload = {
    organization_id: organizationId,
    template_key: input.templateKey,
    recipient_type: input.recipientType,
    recipient_name: input.recipientName,
    recipient_email: input.recipientEmail,
    subject: input.subject,
    body: input.body,
    related_type: input.relatedType,
    related_id: input.relatedId,
    status: "queued",
    sent_at: null,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabaseClient
    .from("outbound_emails")
    .upsert(payload, { onConflict: "organization_id,template_key,related_type,related_id,recipient_email" })
    .select(OUTBOUND_EMAIL_COLUMNS)
    .single();

  if (error) throw new Error(error.message || "Outbound email queue failed");
  return mapOutboundEmailRow(data as unknown as Record<string, unknown>);
}

export async function fetchEmailTemplates(): Promise<EmailTemplate[]> {
  const rows = await ensureDefaultEmailTemplates();
  return rows.sort((a, b) => a.template_name.localeCompare(b.template_name, "en"));
}

export async function upsertEmailTemplate(template: EmailTemplate): Promise<EmailTemplate> {
  const organizationId = await getCurrentOrgId();
  const payload = {
    organization_id: organizationId,
    template_key: template.template_key,
    template_name: template.template_name.trim(),
    subject: template.subject,
    body: template.body,
    is_active: template.is_active,
    updated_at: new Date().toISOString(),
  };

  const { data, error } = await supabaseClient
    .from("email_templates")
    .upsert({ id: template.id || undefined, ...payload }, { onConflict: "organization_id,template_key" })
    .select(EMAIL_TEMPLATE_COLUMNS)
    .single();

  if (error) throw new Error(error.message || "Email template save failed");
  return mapEmailTemplateRow(data as unknown as Record<string, unknown>);
}

export async function fetchOutboundEmails(): Promise<OutboundEmail[]> {
  const organizationId = await getCurrentOrgId();
  const { data, error } = await supabaseClient
    .from("outbound_emails")
    .select(OUTBOUND_EMAIL_COLUMNS)
    .eq("organization_id", organizationId)
    .order("updated_at", { ascending: false })
    .limit(100);

  if (error) throw new Error(error.message || "Outbound emails load failed");
  return ((data || []) as unknown as Record<string, unknown>[]).map(mapOutboundEmailRow);
}

export async function setOutboundEmailStatus(emailIds: string[], status: OutboundEmail["status"]) {
  const organizationId = await getCurrentOrgId();
  const ids = emailIds.map((item) => item.trim()).filter(Boolean);
  if (!ids.length) return;

  const { error } = await supabaseClient
    .from("outbound_emails")
    .update({
      status,
      updated_at: new Date().toISOString(),
      ...(status === "queued" ? { sent_at: null } : {}),
    })
    .eq("organization_id", organizationId)
    .in("id", ids);

  if (error) throw new Error(error.message || "Outbound email status update failed");
}

export async function deliverQueuedEmails(emailIds: string[] = []) {
  const {
    data: { session },
  } = await supabaseClient.auth.getSession();
  const accessToken = session?.access_token;
  if (!accessToken) throw new Error("No active session for queued email delivery.");

  const response = await fetch("/api/send-queued-emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ emailIds }),
  });

  const data = (await response.json().catch(() => ({}))) as {
    error?: string;
    sentCount?: number;
    failedCount?: number;
    processed?: number;
    sentIds?: string[];
    failedIds?: string[];
  };

  if (!response.ok) {
    const fallback =
      response.status === 404
        ? "Email delivery function is not available on this runtime. Use Netlify dev or deployed app."
        : `Queued email send failed: ${response.status}`;
    throw new Error(data.error || fallback);
  }

  return {
    processed: Number(data.processed || 0),
    sentCount: Number(data.sentCount || 0),
    failedCount: Number(data.failedCount || 0),
    sentIds: data.sentIds || [],
    failedIds: data.failedIds || [],
  };
}

export async function sendPortalInviteEmail(
  portalInviteId: string,
  companyName: string,
  portalBaseUrl: string,
  invite?: {
    email?: string;
    party_type?: string;
    customer_id?: string;
    vendor_id?: string;
  },
) {
  const {
    data: { session },
  } = await supabaseClient.auth.getSession();
  const accessToken = session?.access_token;
  if (!accessToken) throw new Error("No active session for portal invite delivery.");

  const response = await fetch("/api/send-portal-invite", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      portalInviteId,
      companyName,
      portalBaseUrl,
      email: String(invite?.email || "").trim().toLowerCase(),
      partyType: String(invite?.party_type || "").trim().toLowerCase(),
      customerId: String(invite?.customer_id || "").trim(),
      vendorId: String(invite?.vendor_id || "").trim(),
    }),
  });

  const data = (await response.json().catch(() => ({}))) as {
    ok?: boolean;
    error?: string;
    sent?: boolean;
    queuedEmailId?: string;
  };

  if (!response.ok) {
    const fallback =
      response.status === 404
        ? "Portal invite delivery function is not available on this runtime. Use deployed app."
        : `Portal invite send failed: ${response.status}`;
    throw new Error(data.error || fallback);
  }

  return {
    sent: Boolean(data.sent),
    queuedEmailId: String(data.queuedEmailId || ""),
  };
}

export async function queuePortalInviteEmail(portalInvite: PortalInvite, companyName: string, portalBaseUrl: string) {
  const templates = await fetchEmailTemplates();
  const templateKey: EmailTemplateKey = portalInvite.party_type === "vendor" ? "vendor_portal_invite" : "customer_portal_invite";
  const template = templates.find((item) => item.template_key === templateKey);
  if (!template) throw new Error(`Email template not found: ${templateKey}`);

  const portalLink = `${portalBaseUrl.replace(/\/$/, "")}/portal?email=${encodeURIComponent(portalInvite.email)}`;
  const variables = {
    party_name: portalInvite.party_name,
    contact_name: portalInvite.contact_name || portalInvite.party_name,
    portal_link: portalLink,
    invite_token: "",
    company_name: companyName,
  };

  return queueOutboundEmail({
    templateKey,
    recipientType: portalInvite.party_type,
    recipientName: portalInvite.party_name,
    recipientEmail: portalInvite.email,
    relatedType: "portal_invite",
    relatedId: portalInvite.id,
    subject: renderTemplate(template.subject, variables),
    body: renderTemplate(template.body, variables),
  });
}

export async function queueVendorPurchaseOrderEmail(purchaseOrder: LocalPurchaseOrder, companyName: string, portalBaseUrl: string) {
  const vendorInvites = (await fetchPortalInvites()).filter(
    (item) => item.party_type === "vendor" && item.party_name.trim().toLowerCase() === purchaseOrder.supplier_name.trim().toLowerCase() && item.status !== "disabled",
  );
  const vendorInvite = vendorInvites[0];
  if (!vendorInvite?.email) {
    throw new Error(`No vendor portal email configured for ${purchaseOrder.supplier_name}.`);
  }
  if (!vendorInvite.has_password) {
    throw new Error(`Portal password is not configured for ${purchaseOrder.supplier_name}.`);
  }

  const templates = await fetchEmailTemplates();
  const template = templates.find((item) => item.template_key === "vendor_purchase_order_confirmed");
  if (!template) throw new Error("Vendor purchase order email template not found.");

  const portalLink = `${portalBaseUrl.replace(/\/$/, "")}/portal?email=${encodeURIComponent(vendorInvite.email)}`;
  const variables = {
    vendor_name: purchaseOrder.supplier_name,
    purchase_order_no: purchaseOrder.id,
    customer_name: purchaseOrder.customer_name || "",
    purchase_company: purchaseOrder.purchase_company || "",
    currency: purchaseOrder.currency || "EUR",
    total_amount: Number(purchaseOrder.total_amount || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    portal_link: portalLink,
    invite_token: "",
    company_name: companyName,
  };

  return queueOutboundEmail({
    templateKey: "vendor_purchase_order_confirmed",
    recipientType: "vendor",
    recipientName: purchaseOrder.supplier_name,
    recipientEmail: vendorInvite.email,
    relatedType: "purchase_order",
    relatedId: purchaseOrder.id,
    subject: renderTemplate(template.subject, variables),
    body: renderTemplate(template.body, variables),
  });
}
