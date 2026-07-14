import type { CatalogIntegrityInitializationState, CatalogIntegritySummary } from "../types/catalog";

function toCount(value: unknown) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toBackfillStatus(value: unknown): CatalogIntegritySummary["backfill_status"] {
  return value === "running" || value === "completed" || value === "failed" ? value : "queued";
}

export function deriveCatalogIntegrityInitializationState(input: {
  backfill_status: CatalogIntegritySummary["backfill_status"];
  backfill_updated_at: string | null;
  projected_products: number;
}): CatalogIntegrityInitializationState {
  if (input.backfill_status === "failed") return "failed";
  if (input.backfill_status === "completed") return "completed";
  if (input.backfill_status === "running") return "running";
  if (!input.backfill_updated_at && input.projected_products === 0) return "not_initialized";
  return "partial";
}

export function shouldDisplayCatalogIntegrityCounts(state: CatalogIntegrityInitializationState) {
  return state !== "not_initialized" && state !== "partial";
}

export function mapCatalogIntegritySummary(data: Record<string, unknown> | null | undefined): CatalogIntegritySummary {
  const projectedProducts = toCount(data?.projected_products);
  const backfillStatus = toBackfillStatus(data?.backfill_status);
  const backfillUpdatedAt = data?.backfill_updated_at ? String(data.backfill_updated_at) : null;
  const initializationState = deriveCatalogIntegrityInitializationState({
    backfill_status: backfillStatus,
    backfill_updated_at: backfillUpdatedAt,
    projected_products: projectedProducts,
  });

  return {
    total_products: shouldDisplayCatalogIntegrityCounts(initializationState) ? toCount(data?.total_products) : null,
    projected_products: projectedProducts,
    clear_count: toCount(data?.clear_count),
    incomplete_count: toCount(data?.incomplete_count),
    conflict_count: toCount(data?.conflict_count),
    pending_count: toCount(data?.pending_count),
    failed_count: toCount(data?.failed_count),
    last_evaluated_at: data?.last_evaluated_at ? String(data.last_evaluated_at) : null,
    backfill_status: backfillStatus,
    backfill_queued_products: toCount(data?.backfill_queued_products),
    backfill_updated_at: backfillUpdatedAt,
    backfill_error: data?.backfill_error ? String(data.backfill_error) : null,
    initialization_state: initializationState,
  };
}
