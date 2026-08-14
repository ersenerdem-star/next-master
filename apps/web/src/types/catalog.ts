import type { CatalogLifecycleStatus } from "../domain/shared/lifecycle";
import type { CatalogMarketSegment } from "../domain/shared/catalogSegments";

export type CatalogRow = {
  total_count: number | null;
  has_more?: boolean;
  product_id: string;
  product_code: string;
  brand: string;
  image_url?: string;
  ean?: string;
  market_segment: CatalogMarketSegment | null;
  description: string;
  description_tr?: string;
  oem_no: string;
  vehicle: string;
  vehicle_model?: string;
  hs_code: string;
  origin: string;
  weight_kg: number | null;
  lifecycle_status: CatalogLifecycleStatus | null;
  lifecycle_note: string;
  integrity_status?: CatalogIntegrityStatus;
  critical_missing_fields?: string[];
  optional_missing_fields?: string[];
  conflict_fields?: string[];
  pending_conflict_count?: number;
  last_evaluated_at?: string | null;
  integrity_last_error?: string | null;
  replacement_old_code?: string | null;
  replacement_code?: string | null;
  replacement_reason?: string | null;
  replacement_warning?: string | null;
};

export type CatalogIntegrityStatus = "unknown" | "queued" | "evaluating" | "clear" | "incomplete" | "conflict" | "failed";

export type CatalogIntegrityFilter = "" | "conflict" | "incomplete" | "missing_ean" | "pending" | "failed";

export type CatalogIntegrityInitializationState = "not_initialized" | "partial" | "running" | "completed" | "failed";

export type CatalogIntegritySummary = {
  total_products: number;
  projected_products: number;
  evaluated_products: number;
  clear_count: number;
  incomplete_count: number;
  conflict_count: number;
  pending_count: number;
  queue_depth: number;
  failed_count: number;
  evaluation_coverage_percent: number;
  data_completeness_percent: number;
  missing_description_count: number;
  missing_origin_count: number;
  missing_hs_code_count: number;
  missing_weight_count: number;
  missing_ean_count: number;
  missing_oem_count: number;
  missing_vehicle_count: number;
  missing_image_count: number;
  last_catalog_change_at: string | null;
  last_evaluated_at: string | null;
  backfill_status: "queued" | "running" | "completed" | "failed";
  backfill_queued_products: number;
  backfill_updated_at: string | null;
  backfill_error: string | null;
  initialization_state: CatalogIntegrityInitializationState;
};

export type CatalogOperationsBrandStatus = {
  brand_id: string;
  brand: string;
  total_products: number;
  complete_count: number;
  incomplete_count: number;
  data_completeness_percent: number;
  missing_ean_count: number;
  missing_oem_count: number;
  missing_vehicle_count: number;
  missing_image_count: number;
  missing_description_count: number;
  missing_description_tr_count: number;
  missing_vehicle_model_count: number;
  missing_market_segment_count: number;
  last_catalog_change_at: string | null;
  projection_updated_at: string | null;
};
