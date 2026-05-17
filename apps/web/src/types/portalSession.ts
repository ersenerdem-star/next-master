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
  price_list_type?: string;
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
  total_amount: number;
  currency: string;
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
  salesOrders: PortalOrderRow[];
  purchaseOrders: PortalOrderRow[];
  invoices: PortalInvoiceRow[];
  bills: PortalInvoiceRow[];
  paymentsReceived: PortalPaymentRow[];
  paymentsMade: PortalPaymentRow[];
  accountSummary: {
    currency: string;
    totalDocuments: number;
    totalAmount: number;
    openAmount: number;
    paymentCount: number;
  };
  accountRows: PortalAccountRow[];
};

export type PortalCredentials = {
  email: string;
  token: string;
};
