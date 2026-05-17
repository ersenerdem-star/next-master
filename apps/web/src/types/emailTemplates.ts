export type EmailTemplateKey = "customer_portal_invite" | "vendor_portal_invite" | "vendor_purchase_order_confirmed";

export type OutboundEmailStatus = "draft" | "queued" | "sent" | "failed";

export type EmailTemplate = {
  id: string;
  template_key: EmailTemplateKey;
  template_name: string;
  subject: string;
  body: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

export type OutboundEmail = {
  id: string;
  template_key: string;
  recipient_type: "customer" | "vendor" | "internal";
  recipient_name: string;
  recipient_email: string;
  subject: string;
  body: string;
  related_type: string;
  related_id: string;
  status: OutboundEmailStatus;
  sent_at: string;
  created_at: string;
  updated_at: string;
};
