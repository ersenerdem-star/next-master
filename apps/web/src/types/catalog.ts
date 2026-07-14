import type { CatalogLifecycleStatus } from "../domain/shared/lifecycle";
import type { CatalogMarketSegment } from "../domain/shared/catalogSegments";

export type CatalogRow = {
  total_count: number | null;
  product_id: string;
  product_code: string;
  brand: string;
  image_url?: string;
  market_segment: CatalogMarketSegment | null;
  description: string;
  oem_no: string;
  vehicle: string;
  hs_code: string;
  origin: string;
  weight_kg: number | null;
  lifecycle_status: CatalogLifecycleStatus | null;
  lifecycle_note: string;
  ean?: string;
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

export type CatalogIntegritySummary = {
  total_products: number;
  projected_products: number;
  clear_count: number;
  incomplete_count: number;
  conflict_count: number;
  pending_count: number;
  failed_count: number;
  last_evaluated_at: string | null;
  backfill_status: "queued" | "running" | "completed" | "failed";
  backfill_queued_products: number;
  backfill_updated_at: string | null;
  backfill_error: string | null;
};
