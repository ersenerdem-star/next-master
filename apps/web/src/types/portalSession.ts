type PortalAccessState = {
  can_view_account: boolean;
  can_view_invoices: boolean;
  can_view_payments: boolean;
  can_view_orders: boolean;
};

type PortalInviteSnapshot = {
  id: string;
  party_type: "customer" | "vendor";
  party_name: string;
  email: string;
  contact_name: string;
  status: string;
  access: PortalAccessState;
};

type PortalCompanyProfile = {
  id?: string;
  company_name?: string;
  email?: string;
  phone?: string;
  website?: string;
  address?: string;
  bank_details?: string;
  tax_office?: string;
  tax_number?: string;
  footer_note?: string;
  logo_data_url?: string;
};

export type PortalBranding = {
  companyProfile: PortalCompanyProfile | null;
  portalLabel: string;
  partyName: string;
};

type PortalPartyProfile = {
  id?: string;
  display_name?: string;
  company_name?: string;
  email?: string;
  work_phone?: string;
  mobile_phone?: string;
  billing_address?: string;
  shipping_address?: string;
  currency?: string;
  payment_terms?: string;
  contract_nr?: string;
  remarks?: string;
};

type PortalAccountRow = {
  document_no: string;
  document_type: string;
  document_date: string;
  due_date: string;
  status: string;
  amount: number;
  currency: string;
  subtotal?: number;
  discount?: number;
  shipping?: number;
  total?: number;
};

type PortalOrderRow = {
  id: string;
  sales_order_no?: string;
  purchase_order_no?: string;
  customer_name?: string;
  supplier_name?: string;
  status: string;
  quote_date?: string;
  updated_at?: string;
  currency: string;
  sales_total?: number;
  total_amount?: number;
  line_count?: number;
  source_channel?: string;
  portal_submitted_at?: string | null;
  portal_seen_at?: string | null;
  delivery_term?: string;
  payment_terms?: string;
  packing_details?: string;
  notes?: string;
  discount_amount?: number;
  shipping_cost?: number;
  purchase_total?: number;
  profit_total?: number;
  margin_percent?: number;
  lines?: PortalDocumentLine[];
};

type PortalInvoiceRow = {
  id: string;
  sales_order_no?: string;
  purchase_order_no?: string;
  customer_name?: string;
  supplier_name?: string;
  status: string;
  quote_date?: string;
  bill_date?: string;
  due_date?: string;
  payment_terms?: string;
  delivery_term?: string;
  contract_nr?: string;
  packing_details?: string;
  notes?: string;
  subtotal?: number;
  discount_amount?: number;
  shipping_cost?: number;
  purchase_total?: number;
  profit_total?: number;
  margin_percent?: number;
  total_amount: number;
  currency: string;
  lines?: PortalDocumentLine[];
};

type PortalCreditRow = {
  id: string;
  credit_note_no?: string;
  vendor_credit_no?: string;
  customer_name?: string;
  supplier_name?: string;
  status: string;
  credit_date?: string;
  due_date?: string;
  notes?: string;
  total_amount: number;
  currency: string;
};

type PortalDocumentLine = {
  code?: string;
  requested_code?: string;
  old_code?: string;
  brand?: string;
  description?: string;
  qty: number;
  oem_no?: string;
  hs_code?: string;
  origin?: string;
  weight_kg?: number | null;
  supplier_name?: string;
  buy_price?: number | null;
  sell_price?: number | null;
  purchase_total?: number | null;
  sales_total?: number | null;
  line_total?: number | null;
  price_date?: string;
  notes?: string;
  lifecycle_status?: "active" | "discontinued" | null;
  lifecycle_note?: string | null;
  lifecycle_warning?: string | null;
};

type PortalPaymentRow = {
  id: string;
  invoice_no?: string;
  bill_no?: string;
  customer_name?: string;
  supplier_name?: string;
  status: string;
  received_date?: string;
  payment_date?: string;
  method?: string;
  reference_no?: string;
  amount: number;
  currency: string;
};

export type PortalSnapshot = {
  invite: PortalInviteSnapshot;
  companyProfile: PortalCompanyProfile | null;
  customer: PortalPartyProfile | null;
  vendor: PortalPartyProfile | null;
  availableBrands: string[];
  salesOrders: PortalOrderRow[];
  purchaseOrders: PortalOrderRow[];
  invoices: PortalInvoiceRow[];
  bills: PortalInvoiceRow[];
  creditNotes: PortalCreditRow[];
  vendorCredits: PortalCreditRow[];
  paymentsReceived: PortalPaymentRow[];
  paymentsMade: PortalPaymentRow[];
  accountSummary: {
    currency: string;
    totalDocuments: number;
    totalAmount: number;
    documentAmount: number;
    creditAmount: number;
    paymentAmount: number;
    openAmount: number;
    paymentCount: number;
  };
  pricingProfile: {
    currency: string;
    payment_terms?: string;
    contract_nr?: string;
    price_list_type?: "" | "A" | "B" | "C" | "Other";
    portal_c_price_mode?: "standard" | "prefer_c_when_available";
  } | null;
  accountRows: PortalAccountRow[];
};

export type PortalCredentials = {
  email: string;
  password?: string;
  token?: string;
  sessionToken?: string;
};
