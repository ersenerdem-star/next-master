export type SupplierSummary = {
  supplier_id: string;
  name: string;
  is_active: boolean;
  line_count: number;
  latest_price_date: string | null;
  old_or_unknown_count: number;
};

export type SupplierPriceRow = {
  total_count: number;
  price_id: string;
  supplier_name?: string | null;
  product_code: string;
  brand: string | null;
  description: string | null;
  oem_no: string | null;
  buy_price: number | null;
  currency: string | null;
  price_date: string | null;
  moq: number | null;
  lead_time_days: number | null;
  notes: string | null;
  freshness: string | null;
  is_placeholder?: boolean;
};

export type SupplierBrandSummaryRow = {
  supplier_id: string;
  supplier_name: string;
  brand: string;
  part_count: number;
  line_count: number;
  latest_price_date: string | null;
  oldest_price_date: string | null;
};
