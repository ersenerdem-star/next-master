import { sanitizeUserFacingMessage } from "../../shared/userMessage";
import { stageCatalogImportOnly, type CatalogImportStageOnlyResult } from "./importApi";
import { supabaseClient } from "./supabaseClient";

export type BilsteinGroupProductStageInput = {
  brand: "FEBI" | "BLUE_PRINT";
  page?: number;
  maxItems?: number;
  onProgress?: (input: { processedChunks: number; totalChunks: number; processedRows: number; totalRows: number }) => void;
};

type BilsteinGroupProductStageSourceResponse = {
  brand: string;
  rows: Array<Record<string, unknown>>;
  source_scope: Record<string, unknown>;
};

export async function stageBilsteinGroupProducts(
  input: BilsteinGroupProductStageInput,
): Promise<CatalogImportStageOnlyResult> {
  const { data, error } = await supabaseClient.auth.getSession();
  if (error || !data.session?.access_token) {
    throw new Error("Your session has expired. Sign in again.");
  }

  const response = await fetch("/api/catalog/bilstein-group/product-stage", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${data.session.access_token}`,
    },
    body: JSON.stringify({
      brand: input.brand,
      page: input.page ?? 0,
      max_items: input.maxItems ?? 10,
    }),
  });
  const source = (await response.json().catch(() => ({}))) as Partial<BilsteinGroupProductStageSourceResponse> & { error?: string };
  if (!response.ok || !Array.isArray(source.rows) || !source.brand || !source.source_scope) {
    throw new Error(sanitizeUserFacingMessage(source.error || "Provider stage collection failed.", "Provider stage collection failed."));
  }

  return stageCatalogImportOnly(source.rows, {
    brandName: source.brand,
    marketSegment: "aftermarket",
    sourceScope: source.source_scope,
    onProgress: input.onProgress,
  });
}
