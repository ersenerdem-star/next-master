import { callAppRpc } from "./appRpcApi";
import { getCurrentOrgId } from "./organizationApi";
import { supabaseClient } from "./supabaseClient";
import type {
  SupplierBrandSummaryRow,
  SupplierOperationsReadyStatus,
  SupplierOperationsStatus,
  SupplierOperationsStatusRow,
  SupplierPriceRow,
  SupplierSummary,
} from "../../types/suppliers";
import { buildLooseOriginalNumberPattern, normalizeBrandName, normalizeOriginalNumberSearch, normalizePartCode } from "../../domain/shared/normalize";

type SupplierSearchMode = "strict" | "loose";

function shouldRunLooseOriginalNumberSearch(search: string) {
  return normalizeOriginalNumberSearch(search).length >= 6;
}

function buildSupplierSearchOr(search: string, normalizedSearch: string, mode: SupplierSearchMode) {
  const normalizedOriginalSearch = normalizeOriginalNumberSearch(search);
  const looseOriginalPattern = buildLooseOriginalNumberPattern(search);
  const clauses = [
    `product_code.ilike.%${search}%`,
    `description.ilike.%${search}%`,
    `oem_no.ilike.%${search}%`,
  ];
  if (normalizedSearch.length >= 3) {
    clauses.push(
      `normalized_code.eq.${normalizedSearch}`,
      `normalized_oem.eq.${normalizedSearch}`,
      `normalized_code.like.${normalizedSearch}%`,
      `normalized_oem.like.${normalizedSearch}%`,
    );
  }
  if (mode === "loose" && looseOriginalPattern.length >= 6) {
    clauses.push(`oem_no.ilike.%${looseOriginalPattern}%`);
  }
  if (mode === "loose" && normalizedOriginalSearch.length >= 6) {
    clauses.push(
      `normalized_oem.like.%${normalizedOriginalSearch}%`,
    );
  }
  return clauses.join(",");
}

type SupplierPriceImportRunRow = {
  id: string;
  supplier_id: string;
  brand_id: string;
  status: string;
  started_at: string | null;
  finished_at: string | null;
  error_message: string | null;
  staged_rows: number;
  processed_rows: number | null;
  catalog_synced: number | null;
  catalog_sync_status: string | null;
  catalog_sync_error_message: string | null;
};

type SupplierPriceRollupRefreshRun = {
  id: string;
  organization_id: string | null;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  status: string;
  error_message: string | null;
  supplier_price_rollups_count: number | null;
};

function normalizeOperationsStatus(value: string | null | undefined, fallback: SupplierOperationsStatus = "idle"): SupplierOperationsStatus {
  const normalized = String(value || "").trim().toLowerCase();
  switch (normalized) {
    case "running":
    case "finalizing":
      return "running";
    case "failed":
      return "failed";
    case "finalized":
    case "succeeded":
      return "completed";
    case "pending":
      return "pending";
    case "idle":
      return "idle";
    default:
      return fallback;
  }
}

function durationBetween(startedAt: string | null | undefined, finishedAt: string | null | undefined) {
  const start = startedAt ? new Date(startedAt).getTime() : NaN;
  const finish = finishedAt ? new Date(finishedAt).getTime() : NaN;
  if (!Number.isFinite(start)) return null;
  const resolvedFinish = Number.isFinite(finish) ? finish : Date.now();
  return Math.max(0, resolvedFinish - start);
}

function latestTimestamp(left: string | null | undefined, right: string | null | undefined) {
  const leftTime = left ? new Date(left).getTime() : NaN;
  const rightTime = right ? new Date(right).getTime() : NaN;
  if (!Number.isFinite(leftTime) && !Number.isFinite(rightTime)) return null;
  if (!Number.isFinite(rightTime)) return left || null;
  if (!Number.isFinite(leftTime)) return right || null;
  return rightTime >= leftTime ? right || null : left || null;
}

function latestTimestampSource(
  left: { at: string | null | undefined; source: string },
  right: { at: string | null | undefined; source: string },
): { at: string | null; source: "supplier import" | "rollup refresh" | null } {
  const leftTime = left.at ? new Date(left.at).getTime() : NaN;
  const rightTime = right.at ? new Date(right.at).getTime() : NaN;
  if (!Number.isFinite(leftTime) && !Number.isFinite(rightTime)) {
    return { at: null, source: null };
  }
  if (!Number.isFinite(rightTime)) return { at: left.at || null, source: left.source as "supplier import" | "rollup refresh" | null };
  if (!Number.isFinite(leftTime)) return { at: right.at || null, source: right.source as "supplier import" | "rollup refresh" | null };
  return rightTime >= leftTime
    ? { at: right.at || null, source: right.source as "supplier import" | "rollup refresh" | null }
    : { at: left.at || null, source: left.source as "supplier import" | "rollup refresh" | null };
}

async function fetchLatestSupplierImportRuns(inputOrganizationId: string) {
  const { data, error } = await supabaseClient
    .from("supplier_price_import_runs")
    .select(
      "id,supplier_id,brand_id,status,started_at,finished_at,error_message,staged_rows,processed_rows,catalog_synced,catalog_sync_status,catalog_sync_error_message",
    )
    .eq("organization_id", inputOrganizationId)
    .order("started_at", { ascending: false });

  if (error) {
    throw new Error(error.message || "Supplier import status load failed");
  }

  return (data || []) as SupplierPriceImportRunRow[];
}

async function fetchLatestSupplierPriceRollupRefreshRun(inputStartedAfter = "") {
  const data = await callAppRpc<SupplierPriceRollupRefreshRun | null>("get_latest_supplier_price_rollup_refresh_run", {
    started_after: inputStartedAfter,
  });
  return data || null;
}

export async function queueSupplierPriceCatalogSync(runId: string) {
  return callAppRpc<{ queued?: boolean; status?: string; catalog_sync_status?: string; run_id?: string }>(
    "queue_supplier_price_catalog_sync",
    { input_run_id: runId },
  );
}

export async function queueSupplierPriceRollupRefresh() {
  return callAppRpc<{ queued?: boolean; status?: string; run_id?: string }>("queue_supplier_price_rollups_refresh", {});
}

export async function retrySupplierPriceImportFinalize(runId: string) {
  const batchSize = 2000;
  let latest: { status?: string; has_more?: boolean } | null = null;

  for (let attempt = 0; attempt < 100; attempt += 1) {
    latest = await callAppRpc<{ status?: string; has_more?: boolean }>("finalize_supplier_price_import_batch", {
      input_run_id: runId,
      input_batch_size: batchSize,
    });

    const status = String(latest?.status || "");
    if (status === "finalized" || status === "succeeded" || latest?.has_more === false) {
      return latest;
    }
  }

  throw new Error("Supplier import finalization is still processing. Please retry.");
}

export async function fetchCloudSupplierOperationsStatusAll(inputSuppliers?: SupplierSummary[]): Promise<SupplierOperationsStatusRow[]> {
  const suppliers = inputSuppliers?.length ? inputSuppliers : await fetchCloudSuppliers();
  const brandSummaryRows = suppliers.length ? await fetchCloudSupplierBrandSummaryAll(suppliers) : [];
  if (!brandSummaryRows.length) {
    return [];
  }

  const organizationId = await getCurrentOrgId();
  const [importRuns, rollupRun] = await Promise.all([
    fetchLatestSupplierImportRuns(organizationId),
    fetchLatestSupplierPriceRollupRefreshRun(),
  ]);
  const { data: brandRows, error: brandRowsError } = await supabaseClient
    .from("brands")
    .select("id,name")
    .eq("organization_id", organizationId);

  if (brandRowsError) {
    throw new Error(brandRowsError.message || "Brand load failed");
  }

  const brandIdByName = new Map<string, string>();
  for (const row of (brandRows || []) as Array<{ id?: string | null; name?: string | null }>) {
    const name = String(row.name || "").trim().toLowerCase();
    const id = String(row.id || "").trim();
    if (name && id && !brandIdByName.has(name)) {
      brandIdByName.set(name, id);
    }
  }

  const latestImportByScope = new Map<string, SupplierPriceImportRunRow>();
  for (const run of importRuns) {
    const key = `${run.supplier_id}:${run.brand_id}`;
    if (!latestImportByScope.has(key)) {
      latestImportByScope.set(key, run);
    }
  }

  const rollupStatus = normalizeOperationsStatus(rollupRun?.status, rollupRun ? "pending" : "pending");
  const rollupDurationMs = typeof rollupRun?.duration_ms === "number" && Number.isFinite(rollupRun.duration_ms) ? rollupRun.duration_ms : null;

  const mappedRows = brandSummaryRows.map((row) => {
    const brandId = brandIdByName.get(row.brand.trim().toLowerCase()) || null;
    const scopeKey = brandId ? `${row.supplier_id}:${brandId}` : null;
    const importRun = scopeKey ? latestImportByScope.get(scopeKey) : null;
    const importStatus = normalizeOperationsStatus(importRun?.status, importRun ? "running" : "idle");
    const catalogSyncStatus = normalizeOperationsStatus(importRun?.catalog_sync_status, importRun ? "pending" : "pending");
    const supplierImportCompleted = importStatus === "completed";
    const catalogSyncCompleted = catalogSyncStatus === "completed";
    const rollupCompleted = rollupStatus === "completed";
    const customerPriceStatus: SupplierOperationsReadyStatus =
      supplierImportCompleted && catalogSyncCompleted && rollupCompleted ? "ready" : "waiting";
    const lastSuccessfulImportAt = importStatus === "completed" ? importRun?.finished_at || importRun?.started_at || null : null;
    const lastSuccessfulRollupAt = rollupStatus === "completed" ? rollupRun?.finished_at || rollupRun?.started_at || null : null;
    const lastSuccessfulSource = latestTimestampSource(
      { at: lastSuccessfulImportAt, source: "supplier import" },
      { at: lastSuccessfulRollupAt, source: "rollup refresh" },
    );
    const lastSuccessfulRefreshAt = latestTimestamp(lastSuccessfulImportAt, lastSuccessfulRollupAt);
    const customerPriceWaitingMessage = customerPriceStatus === "ready"
      ? null
      : !supplierImportCompleted
        ? "Waiting for supplier import to complete."
        : !catalogSyncCompleted
          ? "Waiting for catalog sync to complete."
          : !rollupCompleted
            ? "Waiting for rollup refresh to complete."
            : "Waiting for the latest refresh to settle.";

    return {
      ...row,
      brand_id: brandId,
      supplier_import_run_id: importRun?.id || null,
      supplier_import_status: importStatus,
      supplier_import_started_at: importRun?.started_at || null,
      supplier_import_finished_at: importRun?.finished_at || null,
      supplier_import_duration_ms: durationBetween(importRun?.started_at || null, importRun?.finished_at || null),
      supplier_import_staged_rows: Number(importRun?.staged_rows || 0),
      supplier_import_processed_rows: Number(importRun?.processed_rows ?? importRun?.staged_rows ?? 0),
      supplier_import_error_message: importStatus === "failed" ? importRun?.error_message || "Supplier import failed." : null,
      catalog_sync_status: catalogSyncStatus,
      catalog_sync_error_message: catalogSyncStatus === "failed" ? importRun?.catalog_sync_error_message || "Catalog sync failed." : null,
      rollup_refresh_run_id: rollupRun?.id || null,
      rollup_refresh_status: rollupStatus,
      rollup_refresh_started_at: rollupRun?.started_at || null,
      rollup_refresh_finished_at: rollupRun?.finished_at || null,
      rollup_refresh_duration_ms: rollupDurationMs,
      rollup_refresh_error_message: rollupStatus === "failed" ? rollupRun?.error_message || "Rollup refresh failed." : null,
      customer_price_status: customerPriceStatus,
      customer_price_waiting_message: customerPriceWaitingMessage,
      last_successful_refresh_at: lastSuccessfulRefreshAt,
      last_successful_refresh_source: lastSuccessfulSource.source,
    };
  });

  return mappedRows.sort((left, right) => {
    const severity = (row: SupplierOperationsStatusRow) => {
      if (row.supplier_import_status === "failed" || row.catalog_sync_status === "failed" || row.rollup_refresh_status === "failed") return 0;
      if (row.supplier_import_status === "running" || row.catalog_sync_status === "running" || row.rollup_refresh_status === "running") return 1;
      if (row.supplier_import_status === "pending" || row.catalog_sync_status === "pending" || row.rollup_refresh_status === "pending") return 2;
      if (row.customer_price_status === "waiting") return 3;
      if (row.supplier_import_status === "idle") return 4;
      return 5;
    };

    const leftSeverity = severity(left);
    const rightSeverity = severity(right);
    if (leftSeverity !== rightSeverity) return leftSeverity - rightSeverity;
    const supplierCompare = left.supplier_name.localeCompare(right.supplier_name);
    if (supplierCompare !== 0) return supplierCompare;
    return left.brand.localeCompare(right.brand);
  });
}

export async function fetchCloudSuppliers(): Promise<SupplierSummary[]> {
  const data = await callAppRpc<SupplierSummary[]>("list_cloud_suppliers");
  return (data || []) as SupplierSummary[];
}

export async function fetchCloudSupplierBrandSummary(inputSupplierId: string | null): Promise<SupplierBrandSummaryRow[]> {
  const data = await callAppRpc<SupplierBrandSummaryRow[]>("cloud_supplier_brand_summary", {
    input_supplier_id: inputSupplierId,
  });

  return (data || []) as SupplierBrandSummaryRow[];
}

export async function fetchCloudSupplierBrandSummaryAll(inputSuppliers?: SupplierSummary[]): Promise<SupplierBrandSummaryRow[]> {
  const suppliers = inputSuppliers?.length ? inputSuppliers : await fetchCloudSuppliers();
  const batches = await Promise.allSettled(
    suppliers.map((supplier) => fetchCloudSupplierBrandSummary(supplier.supplier_id)),
  );
  const rows = batches.flatMap((result) => (result.status === "fulfilled" ? result.value : []));

  return rows.sort((a, b) => a.supplier_name.localeCompare(b.supplier_name) || b.part_count - a.part_count || a.brand.localeCompare(b.brand));
}

type SupplierPriceParams = {
  supplierId: string;
  search: string;
  freshness: string;
  page?: number;
  pageSize?: number;
};

export async function fetchCloudSupplierPrices({
  supplierId,
  search,
  freshness,
  page = 1,
  pageSize = 50,
}: SupplierPriceParams): Promise<SupplierPriceRow[]> {
  const data = await callAppRpc<SupplierPriceRow[]>("cloud_supplier_price_page", {
    input_supplier_id: supplierId,
    input_search: search,
    input_page: page,
    input_page_size: pageSize,
    input_freshness: freshness,
  });

  return (data || []) as SupplierPriceRow[];
}

export async function fetchCloudSupplierPricesAcrossSuppliers(input: {
  suppliers: SupplierSummary[];
  search: string;
  freshness: string;
  pageSizePerSupplier?: number;
}): Promise<SupplierPriceRow[]> {
  const search = input.search.trim();
  if (!search) {
    throw new Error("Search is required when All suppliers is selected");
  }

  const activeSuppliers = (input.suppliers || []).filter((supplier) => supplier.is_active);
  const pageSizePerSupplier = Math.min(Math.max(input.pageSizePerSupplier || 10, 1), 50);
  const normalizedSearch = normalizePartCode(search) || search;

  const results = await Promise.allSettled(
    activeSuppliers.map(async (supplier) => {
      const rows = await fetchCloudSupplierPrices({
        supplierId: supplier.supplier_id,
        search,
        freshness: input.freshness,
        page: 1,
        pageSize: pageSizePerSupplier,
      });
      return { supplier, rows };
    }),
  );

  const merged: SupplierPriceRow[] = [];
  for (const result of results) {
    if (result.status !== "fulfilled") continue;
    const { supplier, rows } = result.value;
    if (rows.length) {
      merged.push(
        ...rows.map((row) => ({
          ...row,
          supplier_name: supplier.name,
          is_placeholder: false,
        })),
      );
      continue;
    }
    if (input.freshness === "all") {
      merged.push({
        total_count: 0,
        price_id: `missing-${supplier.supplier_id}-${normalizedSearch}`,
        supplier_name: supplier.name,
        product_code: search,
        brand: null,
        description: null,
        oem_no: null,
        buy_price: null,
        currency: null,
        price_date: null,
        moq: null,
        lead_time_days: null,
        notes: null,
        freshness: "no price",
        is_placeholder: true,
      });
    }
  }

  merged.sort((left, right) => {
    const leftRank = left.buy_price == null ? 1 : 0;
    const rightRank = right.buy_price == null ? 1 : 0;
    if (leftRank !== rightRank) return leftRank - rightRank;
    const supplierCompare = String(left.supplier_name || "").localeCompare(String(right.supplier_name || ""));
    if (supplierCompare !== 0) return supplierCompare;
    const priceCompare = Number(left.buy_price ?? Number.MAX_SAFE_INTEGER) - Number(right.buy_price ?? Number.MAX_SAFE_INTEGER);
    if (priceCompare !== 0) return priceCompare;
    return String(left.product_code || "").localeCompare(String(right.product_code || ""));
  });

  const totalCount = merged.length;
  return merged.map((row) => ({
    ...row,
    total_count: totalCount,
  }));
}

export async function deleteSupplierBrandSummaryRow(input: { supplierId: string; brand: string }) {
  const data = await callAppRpc<number>("deactivate_supplier_prices_by_filter", {
    input_supplier_id: input.supplierId,
    input_brand: normalizeBrandName(input.brand),
    input_price_date: null,
    input_search: "",
  });

  return Number(data || 0);
}

export async function fetchSupplierExportRows(input: { supplierId: string; brandName: string; search?: string }) {
  if (!input.supplierId) {
    throw new Error("Supplier is required for supplier export");
  }
  const brandName = normalizeBrandName(input.brandName);
  if (!brandName) {
    throw new Error("Brand is required for supplier export");
  }

  const { data: brandRow, error: brandError } = await supabaseClient
    .from("brands")
    .select("id,name")
    .ilike("name", brandName)
    .limit(1)
    .maybeSingle();

  if (brandError) {
    throw new Error(brandError.message || "Brand lookup failed");
  }
  if (!brandRow?.id) {
    throw new Error(`Brand not found: ${brandName}`);
  }

  const allRows: SupplierPriceRow[] = [];
  let from = 0;
  const pageSize = 1000;

  while (true) {
    const search = input.search?.trim();
    const normalizedSearch = normalizePartCode(search || "");
    const buildQuery = (mode: SupplierSearchMode) => {
      let query = supabaseClient
        .from("supplier_prices")
        .select("id,product_code,description,oem_no,buy_price,currency,valid_from,moq,lead_time_days,notes")
        .eq("supplier_id", input.supplierId)
        .eq("brand_id", brandRow.id)
        .eq("is_active", true)
        .order("product_code", { ascending: true })
        .range(from, from + pageSize - 1);

      if (search) {
        query = query.or(buildSupplierSearchOr(search, normalizedSearch, mode));
      }

      return query;
    };

    let { data, error } = await buildQuery("strict");
    if (!error && search && shouldRunLooseOriginalNumberSearch(search) && !(data || []).length) {
      ({ data, error } = await buildQuery("loose"));
    }
    if (error) {
      throw new Error(error.message || "Supplier export load failed");
    }

    const batch = (data || []).map((row) => ({
      total_count: 0,
      price_id: row.id as string,
      product_code: row.product_code as string,
      brand: brandRow.name as string,
      description: (row.description as string | null) || "",
      oem_no: (row.oem_no as string | null) || "",
      buy_price: (row.buy_price as number | null) ?? null,
      currency: (row.currency as string | null) || "EUR",
      price_date: (row.valid_from as string | null) || "",
      moq: (row.moq as number | null) ?? null,
      lead_time_days: (row.lead_time_days as number | null) ?? null,
      notes: (row.notes as string | null) || "",
      freshness: null,
    })) as SupplierPriceRow[];

    allRows.push(...batch);
    if (batch.length < pageSize) break;
    from += pageSize;
  }

  return allRows;
}
