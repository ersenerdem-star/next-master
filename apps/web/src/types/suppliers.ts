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

export type SupplierOperationsStatus = "idle" | "pending" | "running" | "failed" | "completed";

export type SupplierOperationsReadyStatus = "ready" | "waiting";

export type SupplierOperationsStatusRow = SupplierBrandSummaryRow & {
  brand_id: string | null;
  supplier_import_run_id: string | null;
  supplier_import_status: SupplierOperationsStatus;
  supplier_import_started_at: string | null;
  supplier_import_finished_at: string | null;
  supplier_import_duration_ms: number | null;
  supplier_import_staged_rows: number;
  supplier_import_processed_rows: number;
  supplier_import_error_message: string | null;
  catalog_sync_status: SupplierOperationsStatus;
  catalog_sync_error_message: string | null;
  rollup_refresh_run_id: string | null;
  rollup_refresh_status: SupplierOperationsStatus;
  rollup_refresh_started_at: string | null;
  rollup_refresh_finished_at: string | null;
  rollup_refresh_duration_ms: number | null;
  rollup_refresh_error_message: string | null;
  customer_price_status: SupplierOperationsReadyStatus;
  customer_price_waiting_message: string | null;
  last_successful_refresh_at: string | null;
  last_successful_refresh_source: "supplier import" | "rollup refresh" | null;
};
