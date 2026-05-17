import type { QuoteBuilderLine } from "./quoteBuilder";

export type LocalSalesOrderStatus = "draft" | "confirmed";
export type LocalInvoiceStatus = "draft" | "confirmed" | "open" | "paid" | "void";
export type LocalBillStatus = "draft" | "confirmed" | "paid" | "void";
export type LocalPaymentReceivedStatus = "draft" | "confirmed" | "void";
export type LocalPaymentMadeStatus = "draft" | "confirmed" | "void";

export type LocalSalesOrder = {
  id: string;
  sales_order_no: string;
  customer_name: string;
  seller_company: string;
  purchase_company: string;
  quote_date: string;
  currency: string;
  customer_type: "A" | "B" | "C" | "Other";
  shipping_cost: number;
  discount_amount: number;
  supplier_mode: string;
  preferred_supplier: string;
  seller_info: string;
  buyer_info: string;
  delivery_term: string;
  payment_terms: string;
  packing_details: string;
  notes: string;
  status: LocalSalesOrderStatus;
  purchase_total: number;
  sales_total: number;
  profit_total: number;
  margin_percent: number;
  source_channel?: "internal" | "portal";
  portal_invite_id?: string | null;
  portal_submitted_at?: string | null;
  portal_seen_at?: string | null;
  created_at: string;
  updated_at: string;
  confirmed_at?: string | null;
  lines: QuoteBuilderLine[];
};

export type LocalPurchaseOrderLine = {
  sales_order_id: string;
  sales_order_no: string;
  product_code: string;
  old_code: string;
  brand: string;
  description: string;
  qty: number;
  oem_no: string;
  supplier_name: string;
  buy_price: number;
  line_total: number;
  origin: string;
  notes: string;
};

export type LocalPurchaseOrder = {
  id: string;
  supplier_name: string;
  supplier_key: string;
  purchase_company: string;
  sales_order_id: string;
  sales_order_no: string;
  customer_name: string;
  status: "draft" | "confirmed" | "open" | "closed";
  currency: string;
  created_at: string;
  updated_at: string;
  total_amount: number;
  line_count: number;
  lines: LocalPurchaseOrderLine[];
};

export type LocalBillLine = {
  purchase_order_id: string;
  purchase_order_no: string;
  product_code: string;
  old_code: string;
  brand: string;
  description: string;
  qty: number;
  oem_no: string;
  supplier_name: string;
  buy_price: number;
  line_total: number;
  origin: string;
  notes: string;
};

export type LocalBill = {
  id: string;
  purchase_order_id: string;
  purchase_order_no: string;
  supplier_name: string;
  purchase_company: string;
  currency: string;
  status: LocalBillStatus;
  bill_date: string;
  due_date: string;
  payment_terms: string;
  notes: string;
  subtotal: number;
  shipping_cost: number;
  discount_amount: number;
  total_amount: number;
  created_at: string;
  updated_at: string;
  lines: LocalBillLine[];
};

export type LocalInvoiceLine = {
  sales_order_id: string;
  sales_order_no: string;
  product_code: string;
  old_code: string;
  brand: string;
  description: string;
  qty: number;
  oem_no: string;
  hs_code: string;
  weight_kg: number | null;
  supplier_name: string;
  buy_price: number;
  sell_price: number;
  purchase_total: number;
  sales_total: number;
  profit_total: number;
  margin_percent: number;
  origin: string;
  notes: string;
};

export type LocalInvoice = {
  id: string;
  sales_order_id: string;
  sales_order_no: string;
  customer_name: string;
  seller_company: string;
  purchase_company: string;
  currency: string;
  status: LocalInvoiceStatus;
  quote_date: string;
  delivery_term: string;
  payment_terms: string;
  due_date: string;
  contract_nr: string;
  packing_details: string;
  notes: string;
  subtotal: number;
  discount_amount: number;
  shipping_cost: number;
  total_amount: number;
  purchase_total: number;
  profit_total: number;
  margin_percent: number;
  created_at: string;
  updated_at: string;
  lines: LocalInvoiceLine[];
};

export type LocalPaymentReceived = {
  id: string;
  invoice_id: string;
  invoice_no: string;
  customer_name: string;
  currency: string;
  received_date: string;
  amount: number;
  method: string;
  reference_no: string;
  notes: string;
  status: LocalPaymentReceivedStatus;
  created_at: string;
  updated_at: string;
};

export type LocalPaymentMade = {
  id: string;
  bill_id: string;
  bill_no: string;
  supplier_name: string;
  purchase_company: string;
  currency: string;
  payment_date: string;
  amount: number;
  method: string;
  reference_no: string;
  notes: string;
  status: LocalPaymentMadeStatus;
  created_at: string;
  updated_at: string;
};
