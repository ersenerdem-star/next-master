export type PortalPartyType = "customer" | "vendor";
export type PortalInviteStatus = "draft" | "invited" | "active" | "disabled";

export type PortalAccess = {
  can_view_account: boolean;
  can_view_invoices: boolean;
  can_view_payments: boolean;
  can_view_orders: boolean;
};

export type PortalInvite = {
  id: string;
  party_type: PortalPartyType;
  party_name: string;
  customer_id: string;
  vendor_id: string;
  email: string;
  contact_name: string;
  status: PortalInviteStatus;
  invite_token: string;
  last_sent_at: string;
  expires_at: string;
  created_at: string;
  updated_at: string;
  has_password?: boolean;
  access: PortalAccess;
};
