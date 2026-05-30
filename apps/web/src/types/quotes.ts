export type QuoteSummary = {
  quote_id: string;
  parent_quote_id: string | null;
  quote_no: string;
  revision_no: number;
  quote_date: string | null;
  customer_name: string | null;
  currency: string | null;
  status: string | null;
  total_quantity: number | null;
  purchase_total: number | null;
  sales_total: number | null;
  profit_total: number | null;
  general_amount: number | null;
  created_by_name: string | null;
  created_by_email: string | null;
  updated_at: string | null;
};

export type QuoteLine = {
  id?: string;
  line_no?: number;
  product_code?: string | null;
  old_code?: string | null;
  brand_text?: string | null;
  description?: string | null;
  qty?: number | null;
  buy_price?: number | null;
  sell_price?: number | null;
  supplier_name?: string | null;
  price_date?: string | null;
  notes?: string | null;
  oem_no?: string | null;
  hs_code?: string | null;
  origin?: string | null;
  weight_kg?: number | null;
  c_sell_price?: number | null;
  lifecycle_status?: "active" | "discontinued" | null;
  lifecycle_note?: string | null;
  lifecycle_warning?: string | null;
};

export type QuoteDetail = {
  quote: Record<string, unknown> | null;
  lines: QuoteLine[];
};
