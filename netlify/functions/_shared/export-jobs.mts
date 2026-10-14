import { readSupplierCommercialTerms } from "../../../apps/web/src/domain/shared/supplierCommercialTerms.ts";
import * as XLSX from "xlsx";
import { createHash } from "node:crypto";
import { assertCompleteExport, advanceExportPage } from "../../../shared/export-integrity.mjs";
import { getJson, json, readJson, sendJson, serviceRoleHeaders } from "./http.mts";
import type { AppCaller } from "./app-auth.mts";
import { claimRemainingExportJob, startExportJobHeartbeat, assertAndTouchExportJobLease } from "./admin-export-worker.mts";
import { createCsvExportStream, createXlsxExportStream, type StreamingExportWriter } from "./admin-export-stream.mts";
import {
  resolvePortalPriceListExportContext,
  type PortalInviteRow,
  type PortalPriceListExportContext,
} from "./portal-orders.mts";

export const EXPORT_STORAGE_BUCKET = "app-exports";
const EXPORT_JOB_TTL_DAYS = 7;
const EXPORT_REQUEST_TIMEOUT_MS = 45_000;
const EXPORT_STORAGE_TIMEOUT_MS = 45_000;
const EXPORT_ARTIFACT_PART_BYTES = 40 * 1024 * 1024;

export type ExportJobRow = {
  id: string;
  organization_id: string;
  requested_by: string | null;
  audience: "admin" | "portal" | "system";
  export_type: string;
  status: "queued" | "running" | "finalized" | "failed" | "expired";
  scope: Record<string, unknown>;
  cache_key: string;
  data_version: string;
  file_name: string | null;
  content_type: string | null;
  storage_bucket: string | null;
  storage_path: string | null;
  row_count: number;
  byte_size: number;
  progress_total: number | null;
  progress_done: number;
  progress_message: string | null;
  error_message: string | null;
  started_at: string | null;
  finalized_at: string | null;
  failed_at: string | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
};

export type ExportJobPublicStatus = {
  id: string;
  exportType: string;
  status: ExportJobRow["status"];
  fileName: string | null;
  rowCount: number;
  byteSize: number;
  progressDone: number;
  progressTotal: number | null;
  progressMessage: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  finalizedAt: string | null;
  cached: boolean;
};

export type AdminPriceListExportInput = {
  brandId: string;
  brandName?: string;
  priceListType: "A" | "B";
  marginPercent: number;
};

export type PortalPriceListExportInput = {
  brand: string;
};

export type CatalogExportInput = {
  brandId?: string;
  brandName: string;
  marketSegment?: string | null;
  format: "csv" | "xlsx";
};

export type CatalogMasterExportInput = {
  brandId?: string;
  brandName: string;
  search?: string | null;
  scope: "priced" | "catalog";
  marginA?: number | null;
  marginB?: number | null;
};

export type SupplierPriceListExportInput = {
  supplierId: string;
  brandName: string;
  search?: string | null;
  freshness?: string | null;
  format?: "csv";
};

type BrandRow = {
  id?: string | null;
  name?: string | null;
};

type CompactAdminPriceRow = [
  string | null,
  string | null,
  string | null,
  string | null,
  string | null,
  string | null,
  number | string | null,
  string | null,
  number | string | null,
  string | null,
  string | null,
  string | null,
];

type AdminPriceListWorkbookRow = {
  productCode: string;
  brand: string;
  description: string;
  oemNo: string;
  hsCode: string;
  origin: string;
  weightKg: number | string | null;
  priceListType: "A" | "B";
  salesPrice: number | string | null;
  priceDate: string | null;
  lifecycleStatus: string;
  lifecycleNote: string;
};

type AdminPriceListPageRow = AdminPriceListWorkbookRow & {
  normalizedCode: string;
  totalCount: number | null;
};

type CatalogExportWorkbookRow = {
  productId: string;
  totalCount: number | null;
  productCode: string;
  brand: string;
  ean: string;
  description: string;
  descriptionTr: string;
  oemNo: string;
  vehicle: string;
  vehicleModel: string;
  hsCode: string;
  origin: string;
  marketSegment: string;
  weightKg: number | string | null;
  imageUrl: string;
  lifecycleStatus: string;
  lifecycleNote: string;
};

type CatalogMasterExportWorkbookRow = {
  cursorCode: string;
  cursorId: string | null;
  totalCount: number | null;
  productId: string;
  productCode: string;
  brand: string;
  description: string;
  oemNo: string;
  hsCode: string;
  origin: string;
  weightKg: number | string | null;
  cheapestSupplier: string;
  cheapestPrice: number | string | null;
  secondSupplierName: string;
  secondPrice: number | string | null;
  priceGap: number | string | null;
  priceGapPercent: number | string | null;
  priceDate: string;
  salesA: number | string | null;
  salesB: number | string | null;
  supplierCount: number | string | null;
  catalogStatus: string;
  notes: string;
  hasNotes: boolean;
};

const CATALOG_EXPORT_HEADERS = [
  "Product_Code",
  "Brand",
  "EAN",
  "Product_Name",
  "Product_Name_TR",
  "OEM_No",
  "Vehicle",
  "Vehicle_Model",
  "HS_Code",
  "Origin",
  "Market_Segment",
  "Weight_kg",
  "Image_URL",
  "Lifecycle_Status",
  "Lifecycle_Note",
] as const;

const CATALOG_MASTER_EXPORT_HEADERS = [
  "Product_Code",
  "Brand",
  "Product_Name",
  "OEM_No",
  "HS_Code",
  "Origin",
  "Weight_kg",
  "Cheapest_Supplier",
  "Cheapest_EUR",
  "Second_Supplier",
  "Second_EUR",
  "Price_Gap_EUR",
  "Price_Gap_Percent",
  "Price_Date",
  "A_Sales_EUR",
  "B_Sales_EUR",
  "Supplier_Count",
  "Catalog_Status",
  "Notes",
] as const;

// Excel worksheets support at most 1,048,576 rows including the header. Keep
// one row for the header and fail closed at the native file limit rather than
// silently truncating a large export.
const CATALOG_MASTER_EXPORT_MAX_ROWS = 1_048_575;
const ADMIN_PRICE_LIST_EXPORT_MAX_ROWS = 1_048_575;
const CATALOG_EXPORT_MAX_ROWS = 1_048_575;
// Supabase Data API responses are capped by the project API max rows setting
// (commonly 1,000). Keep RPC export pages at 1,000 so the cursor loop advances
// through every page instead of treating the first capped response as complete.
const ADMIN_PRICE_LIST_EXPORT_PAGE_SIZE = 1_000;
const PORTAL_PRICE_LIST_EXPORT_MAX_ROWS = 100_000;
const PORTAL_PRICE_LIST_EXPORT_PAGE_SIZE = 1_000;
const EXPORT_SIGNED_URL_TTL_SECONDS = 5 * 60;

export function toPublicExportJobStatus(job: ExportJobRow, cached = false): ExportJobPublicStatus {
  const expired = !isExportJobUnexpired(job);
  const incomplete = job.status === "finalized" && isIncompleteFinalizedExportJob(job);
  return {
    id: job.id,
    exportType: job.export_type,
    status: expired ? "expired" : incomplete ? "failed" : job.status,
    fileName: job.file_name,
    rowCount: Number(job.row_count || 0),
    byteSize: Number(job.byte_size || 0),
    progressDone: Number(job.progress_done || 0),
    progressTotal: job.progress_total == null ? null : Number(job.progress_total),
    progressMessage: job.progress_message,
    errorMessage: expired ? "Export expired. Start a new download." : incomplete ? "Export file is incomplete. Start a new download." : job.error_message,
    createdAt: job.created_at,
    updatedAt: job.updated_at,
    finalizedAt: job.finalized_at,
    cached,
  };
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`)
    .join(",")}}`;
}

function hashObject(value: unknown) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function normalizeExportVersionTimestamp(value: unknown) {
  const raw = String(value ?? "").trim();
  const timestamp = Date.parse(raw);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : raw;
}

function encodeStoragePath(path: string) {
  return path
    .split("/")
    .filter(Boolean)
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function sanitizeDownloadFileName(value: string) {
  return (
    String(value || "")
      .trim()
      .replace(/[^a-z0-9._-]+/gi, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 140) || "export"
  );
}

function sanitizeSheetName(value: string) {
  return (
    String(value || "Export")
      .replace(/[\\/?*[\]:]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 31) || "Export"
  );
}

function normalizeAdminExportProductCode(productCode: string, brandName = "") {
  const raw = String(productCode || "").trim();
  if (!raw) return "";
  const brandKey = String(brandName || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
  if (["bosch", "hella", "hengst", "knorr", "knorrbremse", "lemforder", "mahle", "mann", "mannfilter", "sachs", "wabco"].includes(brandKey)) {
    return raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  }
  return raw;
}

async function fetchWithTimeout(url: string, init: RequestInit & { timeoutMs?: number }) {
  const { timeoutMs, signal, ...requestInit } = init;
  const controller = timeoutMs && !signal ? new AbortController() : null;
  const timeout = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    return await fetch(url, {
      ...requestInit,
      signal: signal || controller?.signal,
    });
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function rpcJson<T>(supabaseUrl: string, serviceRoleKey: string, name: string, payload: Record<string, unknown>, timeoutMs = EXPORT_REQUEST_TIMEOUT_MS) {
  return sendJson<T>(`${supabaseUrl}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: serviceRoleHeaders(serviceRoleKey),
    body: JSON.stringify(payload),
    timeoutMs,
  });
}

async function fetchJobRows(supabaseUrl: string, serviceRoleKey: string, query: string) {
  return getJson<ExportJobRow[]>(`${supabaseUrl}/rest/v1/app_export_jobs?${query}`, {
    headers: serviceRoleHeaders(serviceRoleKey),
    timeoutMs: 10_000,
  });
}

export function isExportJobUnexpired(job: ExportJobRow) {
  const expiresAt = Date.parse(String(job.expires_at || ""));
  return Number.isFinite(expiresAt) && expiresAt > Date.now();
}

function isIncompleteFinalizedExportJob(job: ExportJobRow) {
  if (job.status !== "finalized") return false;
  const rowCount = Number(job.row_count || 0);
  const progressTotal = Number(job.progress_total);
  const byteSize = Number(job.byte_size);
  return !Number.isSafeInteger(rowCount) || rowCount < 1
    || !Number.isSafeInteger(progressTotal) || progressTotal < 1
    || rowCount !== progressTotal || !Number.isSafeInteger(byteSize) || byteSize < 1
    || /limited to/i.test(job.progress_message || "")
    || !job.storage_bucket || !job.storage_path || !job.file_name || !job.content_type;
}

type ReadyExportJob = ExportJobRow & {
  storage_bucket: string;
  storage_path: string;
  file_name: string;
  content_type: string;
};

export function assertExportArtifactReady(job: ExportJobRow): asserts job is ReadyExportJob {
  if (job.status !== "finalized") throw new Error("Export file is not ready yet.");
  if (!isExportJobUnexpired(job)) throw new Error("Export expired. Start a new download.");
  if (isIncompleteFinalizedExportJob(job)) throw new Error("Export file is incomplete. Start a new download.");
  // The V3 writer splits large exports across Excel sheets; a download is not
  // subject to the single-sheet 1,048,575-row limit once the receipt is sealed.
  assertCompleteExport(Number(job.row_count), Number(job.progress_total), 10_000_000);
}

export async function fetchExportJobById(supabaseUrl: string, serviceRoleKey: string, organizationId: string, jobId: string) {
  const rows = await fetchJobRows(
    supabaseUrl,
    serviceRoleKey,
    new URLSearchParams({
      select: "*",
      id: `eq.${jobId}`,
      organization_id: `eq.${organizationId}`,
      limit: "1",
    }).toString(),
  );
  return rows[0] || null;
}

async function findReusableExportJob(supabaseUrl: string, serviceRoleKey: string, organizationId: string, exportType: string, cacheKey: string) {
  const now = new Date().toISOString();
  const base = {
    select: "*",
    organization_id: `eq.${organizationId}`,
    export_type: `eq.${exportType}`,
    cache_key: `eq.${cacheKey}`,
    expires_at: `gt.${now}`,
    order: "updated_at.desc",
    limit: "1",
  };
  const activeRows = await fetchJobRows(
    supabaseUrl,
    serviceRoleKey,
    new URLSearchParams({
      ...base,
      status: "in.(queued,running)",
    }).toString(),
  );
  if (activeRows[0]) return { job: activeRows[0], cached: false };

  const finalizedRows = await fetchJobRows(
    supabaseUrl,
    serviceRoleKey,
    new URLSearchParams({
      ...base,
      status: "eq.finalized",
      order: "finalized_at.desc",
    }).toString(),
  );
  const finalizedJob = finalizedRows[0];
  if (finalizedJob?.storage_path) {
    if (isIncompleteFinalizedExportJob(finalizedJob)) {
      await patchExportJob(supabaseUrl, serviceRoleKey, finalizedJob.id, {
        status: "expired",
        expires_at: new Date().toISOString(),
        progress_message: "Expired incomplete export cache; regenerating full export.",
      });
      return null;
    }
    return { job: finalizedJob, cached: true };
  }
  return null;
}

async function insertExportJob(
  supabaseUrl: string,
  serviceRoleKey: string,
  input: {
    organizationId: string;
    requestedBy?: string | null;
    exportType: string;
    audience: "admin" | "portal" | "system";
    scope: Record<string, unknown>;
    cacheKey: string;
    dataVersion: string;
    progressMessage: string;
  },
) {
  const expiresAt = new Date(Date.now() + EXPORT_JOB_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const rows = await sendJson<ExportJobRow[]>(`${supabaseUrl}/rest/v1/app_export_jobs?select=*`, {
    method: "POST",
    headers: {
      ...serviceRoleHeaders(serviceRoleKey),
      Prefer: "return=representation",
    },
    body: JSON.stringify({
      organization_id: input.organizationId,
      requested_by: input.requestedBy || null,
      audience: input.audience,
      export_type: input.exportType,
      status: "queued",
      scope: input.scope,
      cache_key: input.cacheKey,
      data_version: input.dataVersion,
      progress_message: input.progressMessage,
      progress_done: 0,
      progress_total: null,
      expires_at: expiresAt,
    }),
    timeoutMs: 10_000,
  });
  return rows[0];
}

async function patchExportJob(supabaseUrl: string, serviceRoleKey: string, jobId: string, patch: Partial<ExportJobRow>, leaseStartedAt?: string) {
  const query = new URLSearchParams({ id: `eq.${jobId}`, select: "*" });
  if (leaseStartedAt) {
    query.set("status", "eq.running");
    query.set("started_at", `eq.${leaseStartedAt}`);
  }
  const rows = await sendJson<ExportJobRow[]>(`${supabaseUrl}/rest/v1/app_export_jobs?${query}`, {
    method: "PATCH",
    headers: {
      ...serviceRoleHeaders(serviceRoleKey),
      Prefer: "return=representation",
    },
    body: JSON.stringify(patch),
    timeoutMs: 10_000,
  });
  if (leaseStartedAt && !rows.length) throw new Error("ADMIN_EXPORT_LEASE_LOST");
  return rows[0] || null;
}

function coerceAdminPriceRows(payload: unknown): AdminPriceListWorkbookRow[] {
  if (!Array.isArray(payload)) return [];
  return payload
    .map((raw) => {
      if (!Array.isArray(raw)) return null;
      const row = raw as CompactAdminPriceRow;
      const productCode = String(row[0] || "").trim();
      const brand = String(row[1] || "").trim();
      if (!productCode || !brand) return null;
      return {
        productCode,
        brand,
        description: String(row[2] || ""),
        oemNo: String(row[3] || ""),
        hsCode: String(row[4] || ""),
        origin: String(row[5] || ""),
        weightKg: row[6] == null ? null : row[6],
        priceListType: String(row[7] || "A").toUpperCase() === "B" ? "B" : "A",
        salesPrice: row[8] == null ? null : row[8],
        priceDate: row[9] == null ? null : String(row[9]),
        lifecycleStatus: String(row[10] || "active"),
        lifecycleNote: String(row[11] || ""),
      } satisfies AdminPriceListWorkbookRow;
    })
    .filter(Boolean) as AdminPriceListWorkbookRow[];
}

function coerceFastExportRows(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object" && Array.isArray((payload as { data?: unknown[] }).data)) {
    return (payload as { data: unknown[] }).data;
  }
  return [];
}

function readFastExportValue(row: unknown, compactIndex: number, objectKey: string) {
  if (Array.isArray(row)) return row[compactIndex];
  if (row && typeof row === "object") return (row as Record<string, unknown>)[objectKey];
  return null;
}

const coercePortalFastExportRows = coerceFastExportRows;
const readPortalFastExportValue = readFastExportValue;

function mapAdminPriceListPageRows(payload: unknown, brandName: string, fallbackPriceListType: "A" | "B"): AdminPriceListPageRow[] {
  return coerceFastExportRows(payload).reduce<AdminPriceListPageRow[]>((mappedRows, row) => {
    const normalizedCode = String(readFastExportValue(row, 0, "normalized_code") || "").trim();
    const productCode = String(readFastExportValue(row, 1, "product_code") || "").trim();
    const brand = String(readFastExportValue(row, 2, "brand") || brandName).trim() || brandName;
    if (!normalizedCode || !productCode || !brand) return mappedRows;
    const priceListType = String(readFastExportValue(row, 8, "price_list_type") || fallbackPriceListType).toUpperCase() === "B" ? "B" : "A";
    const totalCountValue = readFastExportValue(row, 13, "total_count");
    const totalCount = totalCountValue == null ? null : Number(totalCountValue);
    mappedRows.push({
      normalizedCode,
      productCode,
      brand,
      description: String(readFastExportValue(row, 3, "description") || ""),
      oemNo: String(readFastExportValue(row, 4, "oem_no") || ""),
      hsCode: String(readFastExportValue(row, 5, "hs_code") || ""),
      origin: String(readFastExportValue(row, 6, "origin") || ""),
      weightKg: readFastExportValue(row, 7, "weight_kg") as number | string | null,
      priceListType,
      salesPrice: readFastExportValue(row, 9, "sales_price") as number | string | null,
      priceDate: readFastExportValue(row, 10, "price_date") == null ? null : String(readFastExportValue(row, 10, "price_date")),
      lifecycleStatus: String(readFastExportValue(row, 11, "lifecycle_status") || "active"),
      lifecycleNote: String(readFastExportValue(row, 12, "lifecycle_note") || ""),
      totalCount: totalCount == null || !Number.isFinite(totalCount) ? null : totalCount,
    });
    return mappedRows;
  }, []);
}

function coerceCatalogExportRows(payload: unknown): CatalogExportWorkbookRow[] {
  if (!Array.isArray(payload)) return [];
  return payload
    .map((raw) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
      const row = raw as Record<string, unknown>;
      const productCode = String(row.product_code || "").trim();
      const brand = String(row.brand || "").trim();
      if (!productCode || !brand) return null;
      return {
        productId: String(row.product_id || ""),
        totalCount: row.total_count == null ? null : Number(row.total_count),
        productCode,
        brand,
        ean: String(row.ean || ""),
        description: String(row.description || ""),
        descriptionTr: String(row.description_tr || ""),
        oemNo: String(row.oem_no || ""),
        vehicle: String(row.vehicle || ""),
        vehicleModel: String(row.vehicle_model || ""),
        hsCode: String(row.hs_code || ""),
        origin: String(row.origin || ""),
        marketSegment: String(row.market_segment || ""),
        weightKg: row.weight_kg == null ? null : row.weight_kg as number | string,
        imageUrl: String(row.image_url || ""),
        lifecycleStatus: String(row.lifecycle_status || "active"),
        lifecycleNote: String(row.lifecycle_note || ""),
      } satisfies CatalogExportWorkbookRow;
    })
    .filter(Boolean) as CatalogExportWorkbookRow[];
}

function coerceCatalogMasterExportRows(payload: unknown): CatalogMasterExportWorkbookRow[] {
  if (!Array.isArray(payload)) return [];
  return payload
    .map((raw) => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
      const row = raw as Record<string, unknown>;
      const productCode = String(row.product_code || "").trim();
      const brand = String(row.brand || "").trim();
      if (!productCode || !brand) return null;
      return {
        cursorCode: String(row.cursor_code || ""),
        cursorId: row.cursor_id == null ? null : String(row.cursor_id),
        totalCount: row.total_count == null ? null : Number(row.total_count),
        productId: String(row.product_id || ""),
        productCode,
        brand,
        description: String(row.description || ""),
        oemNo: String(row.oem_no || ""),
        hsCode: String(row.hs_code || ""),
        origin: String(row.origin || ""),
        weightKg: row.weight_kg == null ? null : (row.weight_kg as number | string),
        cheapestSupplier: String(row.cheapest_supplier || ""),
        cheapestPrice: row.cheapest_price == null ? null : (row.cheapest_price as number | string),
        secondSupplierName: String(row.second_supplier_name || ""),
        secondPrice: row.second_price == null ? null : (row.second_price as number | string),
        priceGap: row.price_gap == null ? null : (row.price_gap as number | string),
        priceGapPercent: row.price_gap_percent == null ? null : (row.price_gap_percent as number | string),
        priceDate: String(row.price_date || ""),
        salesA: row.sales_a == null ? null : (row.sales_a as number | string),
        salesB: row.sales_b == null ? null : (row.sales_b as number | string),
        supplierCount: row.supplier_count == null ? null : (row.supplier_count as number | string),
        catalogStatus: String(row.catalog_status || ""),
        notes: String(row.notes || ""),
        hasNotes: Boolean(row.has_notes),
      } satisfies CatalogMasterExportWorkbookRow;
    })
    .filter(Boolean) as CatalogMasterExportWorkbookRow[];
}

function buildAdminPriceListWorkbook(rows: AdminPriceListWorkbookRow[], brandName: string, priceListType: "A" | "B") {
  const sheetRows: Array<Array<string | number | null>> = [
    [
      "New_Code",
      "Old_Codes",
      "Brand",
      "Product_Name",
      "OEM_No",
      "HS_Code",
      "Origin",
      "Weight_kg",
      "Price_List_Type",
      "Sales_Price_EUR",
      "Price_Date",
      "Lifecycle_Status",
      "Lifecycle_Note",
    ],
    ...rows.map((row) => [
      normalizeAdminExportProductCode(row.productCode, row.brand || brandName),
      "",
      row.brand || brandName,
      row.description || "",
      row.oemNo || "",
      row.hsCode || "",
      row.origin || "",
      row.weightKg ?? "",
      `${row.priceListType || priceListType} Price List`,
      row.salesPrice ?? "",
      row.priceDate || "",
      row.lifecycleStatus || "active",
      row.lifecycleNote || "",
    ]),
  ];
  const worksheet = XLSX.utils.aoa_to_sheet(sheetRows);
  worksheet["!cols"] = [
    { wch: 22 },
    { wch: 16 },
    { wch: 18 },
    { wch: 44 },
    { wch: 32 },
    { wch: 14 },
    { wch: 12 },
    { wch: 12 },
    { wch: 18 },
    { wch: 16 },
    { wch: 14 },
    { wch: 16 },
    { wch: 28 },
  ];
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, sanitizeSheetName(`${brandName} ${priceListType}`));
  return XLSX.write(workbook, {
    bookType: "xlsx",
    type: "buffer",
    compression: true,
  }) as Buffer;
}

function createAdminPriceListWorksheet() {
  const worksheet = XLSX.utils.aoa_to_sheet([
    [
      "New_Code",
      "Old_Codes",
      "Brand",
      "Product_Name",
      "OEM_No",
      "HS_Code",
      "Origin",
      "Weight_kg",
      "Price_List_Type",
      "Sales_Price_EUR",
      "Price_Date",
      "Lifecycle_Status",
      "Lifecycle_Note",
    ],
  ]);
  worksheet["!cols"] = [
    { wch: 22 },
    { wch: 16 },
    { wch: 18 },
    { wch: 44 },
    { wch: 32 },
    { wch: 14 },
    { wch: 12 },
    { wch: 12 },
    { wch: 18 },
    { wch: 16 },
    { wch: 14 },
    { wch: 16 },
    { wch: 28 },
  ];
  return worksheet;
}

function appendAdminPriceListWorksheetRows(
  worksheet: XLSX.WorkSheet,
  rows: AdminPriceListPageRow[],
  brandName: string,
  priceListType: "A" | "B",
) {
  XLSX.utils.sheet_add_aoa(
    worksheet,
    rows.map((row) => [
      normalizeAdminExportProductCode(row.productCode, row.brand || brandName),
      "",
      row.brand || brandName,
      row.description || "",
      row.oemNo || "",
      row.hsCode || "",
      row.origin || "",
      row.weightKg ?? "",
      `${row.priceListType || priceListType} Price List`,
      row.salesPrice ?? "",
      row.priceDate || "",
      row.lifecycleStatus || "active",
      row.lifecycleNote || "",
    ]),
    { origin: -1 },
  );
}

function buildAdminPriceListWorkbookFromWorksheet(worksheet: XLSX.WorkSheet, brandName: string, priceListType: "A" | "B") {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, sanitizeSheetName(`${brandName} ${priceListType}`));
  return XLSX.write(workbook, {
    bookType: "xlsx",
    type: "buffer",
    compression: true,
  }) as Buffer;
}

function normalizePortalExportProductCode(productCode: string, brandName = "") {
  const raw = String(productCode || "").trim();
  if (!raw) return "";
  const brandKey = String(brandName || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (["bosch", "hella", "hengst", "knorr", "knorrbremse", "lemforder", "mahle", "mann", "mannfilter", "sachs", "wabco"].includes(brandKey)) {
    return raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  }
  return raw;
}

type PortalPriceListPageRow = {
  normalizedCode: string;
  productCode: string;
  brand: string;
  description: string;
  priceListType: "A" | "B" | "Other";
  salesPrice: number | string | null;
  priceDate: string | null;
  lifecycleStatus: "active" | "discontinued";
  lifecycleNote: string | null;
  totalCount: number | null;
};

function createPortalPriceListWorksheet(currency: string) {
  const worksheet = XLSX.utils.aoa_to_sheet([["Part_No", "Description", `Price_${currency || "EUR"}`, "Price_Date", "Lifecycle"]]);
  worksheet["!cols"] = [
    { wch: 22 },
    { wch: 44 },
    { wch: 14 },
    { wch: 14 },
    { wch: 24 },
  ];
  return worksheet;
}

function appendPortalPriceListWorksheetRows(
  worksheet: XLSX.WorkSheet,
  rows: PortalPriceListPageRow[],
  brandName: string,
) {
  XLSX.utils.sheet_add_aoa(
    worksheet,
    rows.map((row) => [
      normalizePortalExportProductCode(row.productCode, row.brand || brandName),
      row.description || "",
      row.salesPrice ?? "",
      row.priceDate || "",
      row.lifecycleStatus === "discontinued" ? row.lifecycleNote || "Discontinued" : "Active",
    ]),
    { origin: -1 },
  );
}

function buildPortalPriceListWorkbookFromWorksheet(worksheet: XLSX.WorkSheet, brandName: string) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, sanitizeSheetName(`${brandName} Price List`));
  return XLSX.write(workbook, {
    bookType: "xlsx",
    type: "buffer",
    compression: true,
  }) as Buffer;
}

function normalizePortalPriceListType(value: unknown): "A" | "B" | "Other" {
  const normalized = String(value || "").trim().toUpperCase();
  if (normalized === "B") return "B";
  if (normalized === "A") return "A";
  return "Other";
}

function mapPortalPriceListPageRows(payload: unknown, brandName: string): PortalPriceListPageRow[] {
  return coercePortalFastExportRows(payload).reduce<PortalPriceListPageRow[]>((mappedRows, row) => {
    const productCode = String(readPortalFastExportValue(row, 1, "product_code") || "").trim();
    const normalizedCode = String(readPortalFastExportValue(row, 0, "normalized_code") || "").trim();
    if (!productCode || !normalizedCode) return mappedRows;
    const lifecycleStatus = String(readPortalFastExportValue(row, 7, "lifecycle_status") || "active").trim().toLowerCase();
    const totalCountValue = readPortalFastExportValue(row, 9, "total_count");
    const totalCount = totalCountValue == null ? null : Number(totalCountValue);
    mappedRows.push({
      normalizedCode,
      productCode,
      brand: String(readPortalFastExportValue(row, 2, "brand") || brandName).trim() || brandName,
      description: String(readPortalFastExportValue(row, 3, "description") || ""),
      priceListType: normalizePortalPriceListType(readPortalFastExportValue(row, 4, "price_list_type")),
      salesPrice: readPortalFastExportValue(row, 5, "sales_price") as number | string | null,
      priceDate: readPortalFastExportValue(row, 6, "price_date") == null ? null : String(readPortalFastExportValue(row, 6, "price_date")),
      lifecycleStatus: lifecycleStatus === "discontinued" ? "discontinued" : "active",
      lifecycleNote: String(readPortalFastExportValue(row, 8, "lifecycle_note") || "").trim() || null,
      totalCount: totalCount == null || !Number.isFinite(totalCount) ? null : totalCount,
    });
    return mappedRows;
  }, []);
}

async function fetchPortalPriceListFastPage(input: {
  supabaseUrl: string;
  serviceRoleKey: string;
  organizationId: string;
  brandId: string;
  priceListType: "A" | "B" | "Other";
  marginPercent: number;
  afterNormalizedCode: string;
}) {
  const payload = await rpcJson<unknown>(
    input.supabaseUrl,
    input.serviceRoleKey,
    "cloud_portal_customer_price_list_page_fast",
    {
      input_organization_id: input.organizationId,
      input_brand_id: input.brandId,
      input_price_list_type: input.priceListType === "B" ? "B" : "A",
      input_margin_percent: Number.isFinite(input.marginPercent) ? input.marginPercent : 0,
      input_after_product_code: null,
      input_after_normalized_code: input.afterNormalizedCode || null,
      input_page_size: PORTAL_PRICE_LIST_EXPORT_PAGE_SIZE,
    },
    EXPORT_REQUEST_TIMEOUT_MS,
  );
  return mapPortalPriceListPageRows(payload, "");
}

async function fetchAdminPriceListFastPage(input: {
  supabaseUrl: string;
  serviceRoleKey: string;
  organizationId: string;
  brandId: string;
  brandName: string;
  priceListType: "A" | "B";
  marginPercent: number;
  afterNormalizedCode: string;
}) {
  const payload = await rpcJson<unknown>(
    input.supabaseUrl,
    input.serviceRoleKey,
    "cloud_admin_price_list_page_fast",
    {
      input_organization_id: input.organizationId,
      input_brand_id: input.brandId,
      input_price_list_type: input.priceListType,
      input_margin: Number.isFinite(input.marginPercent) ? input.marginPercent : 0,
      input_after_product_code: null,
      input_after_normalized_code: input.afterNormalizedCode || null,
      input_page_size: ADMIN_PRICE_LIST_EXPORT_PAGE_SIZE,
    },
    EXPORT_REQUEST_TIMEOUT_MS,
  );
  return mapAdminPriceListPageRows(payload, input.brandName, input.priceListType);
}

function catalogExportSheetRows(rows: CatalogExportWorkbookRow[]) {
  return [
    [...CATALOG_EXPORT_HEADERS],
    ...rows.map((row) => [
      normalizeAdminExportProductCode(row.productCode, row.brand),
      row.brand,
      row.ean,
      row.description,
      row.descriptionTr,
      row.oemNo,
      row.vehicle,
      row.vehicleModel,
      row.hsCode,
      row.origin,
      row.marketSegment,
      row.weightKg ?? "",
      row.imageUrl,
      row.lifecycleStatus || "active",
      row.lifecycleNote,
    ]),
  ];
}

function catalogMasterExportSheetRows(rows: CatalogMasterExportWorkbookRow[]) {
  return [
    [...CATALOG_MASTER_EXPORT_HEADERS],
    ...rows.map((row) => [
      normalizeAdminExportProductCode(row.productCode, row.brand),
      row.brand,
      row.description,
      row.oemNo,
      row.hsCode,
      row.origin,
      row.weightKg ?? "",
      row.cheapestSupplier,
      row.cheapestPrice ?? "",
      row.secondSupplierName,
      row.secondPrice ?? "",
      row.priceGap ?? "",
      row.priceGapPercent ?? "",
      row.priceDate,
      row.salesA ?? "",
      row.salesB ?? "",
      row.supplierCount ?? "",
      row.catalogStatus,
      row.notes,
    ]),
  ];
}

async function uploadExportArtifact(
  supabaseUrl: string,
  serviceRoleKey: string,
  input: {
    bucket: string;
    path: string;
    contentType: string;
    body: Buffer;
  },
) {
  const response = await fetchWithTimeout(`${supabaseUrl}/storage/v1/object/${encodeURIComponent(input.bucket)}/${encodeStoragePath(input.path)}`, {
    method: "POST",
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": input.contentType,
      "Cache-Control": "private, max-age=604800",
      "x-upsert": "true",
    },
    body: input.body,
    timeoutMs: EXPORT_STORAGE_TIMEOUT_MS,
  });
  if (!response.ok) {
    const data = await readJson<{ error?: string; message?: string }>(response);
    throw new Error(data.message || data.error || `Storage upload failed: ${response.status}`);
  }
}

export async function downloadExportArtifact(supabaseUrl: string, serviceRoleKey: string, job: ExportJobRow) {
  assertExportArtifactReady(job);
  if (job.scope.artifactParts !== undefined) {
    throw new Error("Multipart export requires signed-part download.");
  }
  const response = await fetchWithTimeout(`${supabaseUrl}/storage/v1/object/${encodeURIComponent(job.storage_bucket)}/${encodeStoragePath(job.storage_path)}`, {
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
    },
    timeoutMs: EXPORT_STORAGE_TIMEOUT_MS,
  });
  if (!response.ok) {
    const data = await readJson<{ error?: string; message?: string }>(response);
    throw new Error(data.message || data.error || `Export file download failed: ${response.status}`);
  }
  if (!response.body) throw new Error("Export file download returned no content.");
  return new Response(response.body, {
    status: 200,
    headers: {
      "Content-Type": job.content_type,
      "Content-Disposition": `attachment; filename="${sanitizeDownloadFileName(job.file_name)}"`,
      "Cache-Control": "no-store",
      "X-Export-Job-Id": job.id,
      "X-Export-Row-Count": String(job.row_count || 0),
      "X-Export-Byte-Size": String(job.byte_size || 0),
    },
  });
}

export async function createExportArtifactSignedDownload(
  supabaseUrl: string,
  serviceRoleKey: string,
  job: ExportJobRow,
) {
  assertExportArtifactReady(job);

  const rawParts = job.scope.artifactParts;
  const multipart = rawParts !== undefined;
  let artifacts: Array<{ path: string; byteSize: number }> = [{ path: job.storage_path, byteSize: Number(job.byte_size) }];
  if (multipart) {
    if (!Array.isArray(rawParts) || rawParts.length < 2) throw new Error("Export artifact parts are invalid.");
    const prefix = job.storage_path.slice(0, job.storage_path.lastIndexOf("/") + 1);
    const paths = new Set<string>();
    let totalBytes = 0;
    artifacts = rawParts.map((part: unknown) => {
      const value = part as { path?: unknown; byteSize?: unknown } | null;
      const path = value?.path;
      const byteSize = value?.byteSize;
      if (typeof path !== "string" || !path.startsWith(`${job.organization_id}/`) || !path.startsWith(prefix)
        || /[\\\u0000-\u001f\u007f]/.test(path) || path.split("/").some((segment) => !segment || segment === "." || segment === "..")
        || paths.has(path) || typeof byteSize !== "number" || !Number.isSafeInteger(byteSize) || byteSize <= 0) {
        throw new Error("Export artifact parts are invalid.");
      }
      paths.add(path);
      totalBytes += byteSize;
      return { path, byteSize };
    });
    if (artifacts[0].path !== job.storage_path || !Number.isSafeInteger(totalBytes) || totalBytes !== Number(job.byte_size)) {
      throw new Error("Export artifact parts do not match the complete file size.");
    }
  }

  const storageBaseUrl = `${supabaseUrl.replace(/\/+$/, "")}/storage/v1`;
  const response = await fetchWithTimeout(
    `${storageBaseUrl}/object/sign/${encodeURIComponent(job.storage_bucket)}`,
    {
      method: "POST",
      headers: serviceRoleHeaders(serviceRoleKey),
      // The single-object endpoint signs decodeURI(request.url), which leaves
      // reserved path octets such as %2B encoded in its JWT claim. Passing the
      // raw path in JSON makes the batch endpoint sign the stored object name.
      body: JSON.stringify({ expiresIn: EXPORT_SIGNED_URL_TTL_SECONDS, paths: artifacts.map((artifact) => artifact.path) }),
      timeoutMs: EXPORT_STORAGE_TIMEOUT_MS,
    },
  );
  type SignedStorageResponse = { path?: string; signedURL?: string; signedUrl?: string; error?: string | null; message?: string };
  const data = await readJson<SignedStorageResponse[] | SignedStorageResponse>(response);
  if (!response.ok) {
    const errorData = Array.isArray(data) ? data[0] : data;
    throw new Error(errorData?.message || errorData?.error || `Export signed URL failed: ${response.status}`);
  }

  if (!Array.isArray(data) || data.length !== artifacts.length) throw new Error("Export signed URL response is invalid.");
  const signedByPath = new Map<string, SignedStorageResponse>();
  for (const artifact of data) {
    if (!artifact || artifact.error || typeof artifact.path !== "string" || signedByPath.has(artifact.path)
      || !artifacts.some((part) => part.path === artifact.path)) {
      throw new Error(artifact?.error || "Export signed URL response is invalid.");
    }
    signedByPath.set(artifact.path, artifact);
  }
  const signedParts = artifacts.map((part) => {
    const artifact = signedByPath.get(part.path)!;
    const signedPath = String(artifact.signedURL || artifact.signedUrl || "").trim();
    if (!signedPath) throw new Error("Export signed URL response is missing.");
    // Storage may return raw reserved characters in this path. Build the URL
    // from the verified artifact path so '?' or '#' cannot swallow the token,
    // and already escaped response octets cannot be encoded twice.
    const tokenQueryIndex = signedPath.lastIndexOf("?token=");
    const token = tokenQueryIndex < 0 ? "" : new URLSearchParams(signedPath.slice(tokenQueryIndex + 1)).get("token");
    if (!token) throw new Error("Export signed URL response is missing its token.");
    const signedUrl = new URL(`${storageBaseUrl}/object/sign/${encodeURIComponent(job.storage_bucket)}/${encodeStoragePath(part.path)}`);
    signedUrl.searchParams.set("token", token);
    signedUrl.searchParams.set("download", sanitizeDownloadFileName(job.file_name));
    return { signedUrl: signedUrl.toString(), byteSize: part.byteSize };
  });
  return {
    signedUrl: signedParts[0].signedUrl,
    ...(multipart ? { parts: signedParts } : {}),
    fileName: sanitizeDownloadFileName(job.file_name),
    contentType: job.content_type,
    rowCount: Number(job.row_count || 0),
    byteSize: Number(job.byte_size || 0),
    expiresIn: EXPORT_SIGNED_URL_TTL_SECONDS,
  };
}

async function resolveAdminPriceListBrand(supabaseUrl: string, serviceRoleKey: string, organizationId: string, brandId: string) {
  const rows = await getJson<BrandRow[]>(
    `${supabaseUrl}/rest/v1/brands?select=id,name&id=eq.${encodeURIComponent(brandId)}&organization_id=eq.${encodeURIComponent(organizationId)}&limit=1`,
    {
      headers: serviceRoleHeaders(serviceRoleKey),
      timeoutMs: 10_000,
    },
  );
  const row = rows[0];
  if (!row?.id) throw new Error("Brand not found for this organization.");
  return { id: String(row.id), name: String(row.name || "") };
}

async function resolveCatalogExportBrand(
  supabaseUrl: string,
  serviceRoleKey: string,
  organizationId: string,
  input: { brandId?: string | null; brandName?: string | null },
) {
  const brandId = String(input.brandId || "").trim();
  if (brandId) return resolveAdminPriceListBrand(supabaseUrl, serviceRoleKey, organizationId, brandId);
  const brandName = String(input.brandName || "").trim();
  if (!brandName) throw new Error("Brand is required for catalog export.");
  const params = new URLSearchParams({
    select: "id,name",
    organization_id: `eq.${organizationId}`,
    name: `eq.${brandName}`,
    limit: "1",
  });
  let rows = await getJson<BrandRow[]>(`${supabaseUrl}/rest/v1/brands?${params.toString()}`, {
    headers: serviceRoleHeaders(serviceRoleKey),
    timeoutMs: 10_000,
  });
  if (!rows[0]?.id) {
    const fallbackParams = new URLSearchParams({
      select: "id,name",
      organization_id: `eq.${organizationId}`,
      name: `ilike.${brandName}`,
      limit: "1",
    });
    rows = await getJson<BrandRow[]>(`${supabaseUrl}/rest/v1/brands?${fallbackParams.toString()}`, {
      headers: serviceRoleHeaders(serviceRoleKey),
      timeoutMs: 10_000,
    });
  }
  const row = rows[0];
  if (!row?.id) throw new Error(`Brand not found: ${brandName}`);
  return { id: String(row.id), name: String(row.name || brandName) };
}

async function getAdminPriceListDataVersion(supabaseUrl: string, serviceRoleKey: string, organizationId: string, brandId: string) {
  const version = await rpcJson<string>(
    supabaseUrl,
    serviceRoleKey,
    "get_admin_price_list_export_version",
    {
      input_organization_id: organizationId,
      input_brand_id: brandId,
    },
    15_000,
  );
  return String(version || "");
}

async function getPortalPriceListDataVersion(
  supabaseUrl: string,
  serviceRoleKey: string,
  context: PortalPriceListExportContext,
  invite: PortalInviteRow,
) {
  const baseDataVersion = await getAdminPriceListDataVersion(supabaseUrl, serviceRoleKey, context.organizationId, context.brandId);
  return hashObject({
    baseDataVersion,
    customerId: context.customerId,
    priceListType: context.priceListType,
    effectiveMarginA: context.effectiveMarginA,
    effectiveMarginB: context.effectiveMarginB,
    cPriceListIds: context.cPriceListIds,
    inviteUpdatedAt: normalizeExportVersionTimestamp(invite.updated_at || ""),
  });
}

async function getCatalogExportDataVersion(supabaseUrl: string, serviceRoleKey: string, organizationId: string, brandId: string, marketSegment: string) {
  const version = await rpcJson<string>(
    supabaseUrl,
    serviceRoleKey,
    "get_catalog_export_version",
    {
      input_organization_id: organizationId,
      input_brand_id: brandId,
      input_market_segment: marketSegment,
    },
    15_000,
  );
  return String(version || "");
}

async function getCatalogMasterExportDataVersion(supabaseUrl: string, serviceRoleKey: string, organizationId: string, brandId: string, scope: string) {
  const version = await rpcJson<string>(
    supabaseUrl,
    serviceRoleKey,
    "get_catalog_master_export_version",
    {
      input_organization_id: organizationId,
      input_brand_id: brandId,
      input_scope: scope,
    },
    15_000,
  );
  return String(version || "");
}

async function getSupplierPriceExportDataVersion(
  supabaseUrl: string,
  serviceRoleKey: string,
  organizationId: string,
  supplierId: string,
  brandId: string,
) {
  const version = await rpcJson<string>(supabaseUrl, serviceRoleKey, "get_supplier_price_export_version", {
    input_organization_id: organizationId,
    input_supplier_id: supplierId,
    input_brand_id: brandId,
  }, 15_000);
  return String(version || "");
}

const PORTAL_EXPORT_INVITE_SELECT =
  "id,organization_id,party_type,party_name,customer_id,vendor_id,seller_company_profile_id,email,contact_name,status,invite_token_hash,expires_at,access_can_view_account,access_can_view_invoices,access_can_view_payments,access_can_view_orders,allowed_brand_ids,updated_at";

function isPortalInviteUsableForExport(invite: PortalInviteRow & { expires_at?: string | null }) {
  const status = String(invite.status || "").trim().toLowerCase();
  if (status !== "active" && status !== "invited") return false;
  const expiresAt = String(invite.expires_at || "").trim();
  if (!expiresAt) return true;
  const timestamp = Date.parse(expiresAt);
  return Number.isFinite(timestamp) && timestamp > Date.now();
}

async function fetchPortalInviteForExport(supabaseUrl: string, serviceRoleKey: string, organizationId: string, inviteId: string) {
  const params = new URLSearchParams({
    select: PORTAL_EXPORT_INVITE_SELECT,
    id: `eq.${inviteId}`,
    organization_id: `eq.${organizationId}`,
    limit: "1",
  });
  const rows = await getJson<Array<PortalInviteRow & { expires_at?: string | null }>>(`${supabaseUrl}/rest/v1/portal_invites?${params.toString()}`, {
    headers: serviceRoleHeaders(serviceRoleKey),
    timeoutMs: 10_000,
  });
  const invite = rows[0] || null;
  if (!invite || !isPortalInviteUsableForExport(invite)) {
    throw new Error("Portal session is no longer active.");
  }
  return invite;
}

export function assertPortalExportJobForInvite(job: ExportJobRow, invite: PortalInviteRow) {
  const scope = job.scope || {};
  const inviteId = String(scope.inviteId || "");
  const customerId = String(scope.customerId || "");
  const brandId = String(scope.brandId || "");
  const allowedBrandIds = Array.isArray(invite.allowed_brand_ids) ? invite.allowed_brand_ids.map(String) : [];
  if (job.audience !== "portal" || job.export_type !== "portal_price_list"
    || job.organization_id !== invite.organization_id || !isPortalInviteUsableForExport(invite)
    || invite.party_type !== "customer" || !invite.access_can_view_orders || !brandId
    || (allowedBrandIds.length > 0 && !allowedBrandIds.includes(brandId))) {
    throw new Error("Export job not found.");
  }
  if (inviteId !== String(invite.id || "") || customerId !== String(invite.customer_id || "")) {
    throw new Error("Export job not found.");
  }
}

export async function assertPortalExportJobCurrentContext(
  supabaseUrl: string,
  serviceRoleKey: string,
  job: ExportJobRow,
  invite: PortalInviteRow,
) {
  assertPortalExportJobForInvite(job, invite);
  // Legacy files may contain a retired C price or an obsolete account margin.
  // Require regeneration under the current published-price contract.
  if (job.scope?.schemaVersion !== 4) {
    throw new Error("Customer price export is outdated. Start a new export.");
  }
  const context = await resolvePortalPriceListExportContext(
    supabaseUrl, serviceRoleKey, invite, String(job.scope.brandName || ""),
  );
  assertPortalExportJobPricingContext(job, invite, context);
  const currentDataVersion = await getPortalPriceListDataVersion(supabaseUrl, serviceRoleKey, context, invite);
  if (currentDataVersion !== job.data_version) {
    throw new Error("Customer prices changed. Start a new export.");
  }
}

export function assertPortalExportJobPricingContext(
  job: ExportJobRow,
  invite: PortalInviteRow,
  context: PortalPriceListExportContext,
) {
  const margin = context.priceListType === "B" ? context.effectiveMarginB : context.effectiveMarginA;
  if (context.currency !== "EUR" || job.scope.currency !== "EUR") {
    throw new Error("Customer price export requires an EUR account until currency conversion is available.");
  }
  if (context.organizationId !== job.organization_id || context.inviteId !== invite.id
    || context.customerId !== job.scope.customerId || context.brandId !== job.scope.brandId
    || context.priceListType !== job.scope.priceListType || margin !== job.scope.marginPercent) {
    throw new Error("Customer price settings changed. Start a new export.");
  }
}

export async function startAdminPriceListExport(
  supabaseUrl: string,
  serviceRoleKey: string,
  caller: AppCaller,
  input: AdminPriceListExportInput,
) {
  const brandId = String(input.brandId || "").trim();
  if (!brandId) throw new Error("Select a brand before download.");
  const priceListType: "A" | "B" = input.priceListType === "B" ? "B" : "A";
  const marginPercent = Number.isFinite(input.marginPercent) ? Number(input.marginPercent) : 0;
  const brand = await resolveAdminPriceListBrand(supabaseUrl, serviceRoleKey, caller.organizationId, brandId);
  const dataVersion = await getAdminPriceListDataVersion(supabaseUrl, serviceRoleKey, caller.organizationId, brand.id);
  const exportType = "admin_price_list";
  const scope = {
    brandId: brand.id,
    brandName: brand.name || input.brandName || "",
    priceListType,
    marginPercent,
    format: "xlsx",
    schemaVersion: 4,
  };
  const cacheKey = hashObject({
    exportType,
    organizationId: caller.organizationId,
    scope,
    dataVersion,
  });
  const reusable = await findReusableExportJob(supabaseUrl, serviceRoleKey, caller.organizationId, exportType, cacheKey);
  if (reusable) return reusable;

  const job = await insertExportJob(supabaseUrl, serviceRoleKey, {
    organizationId: caller.organizationId,
    requestedBy: caller.id,
    audience: "admin",
    exportType,
    scope,
    cacheKey,
    dataVersion,
    progressMessage: `Queued ${brand.name || "brand"} ${priceListType} price-list export.`,
  });
  return { job, cached: false };
}

export async function startPortalPriceListExport(
  supabaseUrl: string,
  serviceRoleKey: string,
  invite: PortalInviteRow,
  input: PortalPriceListExportInput,
) {
  const requestedBrand = String(input.brand || "").trim();
  if (!requestedBrand) throw new Error("Select a brand before downloading the price list.");
  const context = await resolvePortalPriceListExportContext(supabaseUrl, serviceRoleKey, invite, requestedBrand);
  if (context.currency !== "EUR") {
    throw new Error("Customer price export requires an EUR account until currency conversion is available.");
  }
  if (context.priceListType !== "A" && context.priceListType !== "B" && context.priceListType !== "Other") {
    throw new Error("Customer price list type is no longer supported.");
  }
  const priceListType: "A" | "B" | "Other" = context.priceListType;
  const marginPercent = priceListType === "B" ? context.effectiveMarginB : context.effectiveMarginA;
  if (!Number.isFinite(marginPercent)) throw new Error("Customer price margin is missing.");
  const dataVersion = await getPortalPriceListDataVersion(supabaseUrl, serviceRoleKey, context, invite);
  const exportType = "portal_price_list";
  const scope = {
    inviteId: context.inviteId,
    customerId: context.customerId,
    brandId: context.brandId,
    brandName: context.brandName,
    priceListType,
    currency: context.currency,
    marginPercent,
    format: "xlsx",
    schemaVersion: 4,
  };
  const cacheKey = hashObject({
    exportType,
    organizationId: context.organizationId,
    scope,
    dataVersion,
  });
  const reusable = await findReusableExportJob(supabaseUrl, serviceRoleKey, context.organizationId, exportType, cacheKey);
  if (reusable) {
    assertPortalExportJobForInvite(reusable.job, invite);
    return reusable;
  }

  const job = await insertExportJob(supabaseUrl, serviceRoleKey, {
    organizationId: context.organizationId,
    requestedBy: null,
    audience: "portal",
    exportType,
    scope,
    cacheKey,
    dataVersion,
    progressMessage: `Queued ${context.brandName} customer price-list export.`,
  });
  return { job, cached: false };
}

export async function startCatalogExport(
  supabaseUrl: string,
  serviceRoleKey: string,
  caller: AppCaller,
  input: CatalogExportInput,
) {
  const format = input.format === "xlsx" ? "xlsx" : "csv";
  const marketSegment = String(input.marketSegment || "").trim();
  const brand = await resolveCatalogExportBrand(supabaseUrl, serviceRoleKey, caller.organizationId, input);
  const dataVersion = await getCatalogExportDataVersion(supabaseUrl, serviceRoleKey, caller.organizationId, brand.id, marketSegment);
  const exportType = "catalog_export";
  const scope = {
    brandId: brand.id,
    brandName: brand.name || input.brandName || "",
    marketSegment,
    format,
    schemaVersion: 4,
  };
  const cacheKey = hashObject({
    exportType,
    organizationId: caller.organizationId,
    scope,
    dataVersion,
  });
  const reusable = await findReusableExportJob(supabaseUrl, serviceRoleKey, caller.organizationId, exportType, cacheKey);
  if (reusable) return reusable;

  const job = await insertExportJob(supabaseUrl, serviceRoleKey, {
    organizationId: caller.organizationId,
    requestedBy: caller.id,
    audience: "admin",
    exportType,
    scope,
    cacheKey,
    dataVersion,
    progressMessage: `Queued ${brand.name || "brand"} catalog export.`,
  });
  return { job, cached: false };
}

export async function startCatalogMasterExport(
  supabaseUrl: string,
  serviceRoleKey: string,
  caller: AppCaller,
  input: CatalogMasterExportInput,
) {
  const scope = input.scope === "catalog" ? "catalog" : "priced";
  const search = String(input.search || "").trim();
  const parsedMarginA = Number(input.marginA ?? 0.1);
  const parsedMarginB = Number(input.marginB ?? 0.15);
  const marginA = Number.isFinite(parsedMarginA) ? parsedMarginA : 0.1;
  const marginB = Number.isFinite(parsedMarginB) ? parsedMarginB : 0.15;
  const brand = await resolveCatalogExportBrand(supabaseUrl, serviceRoleKey, caller.organizationId, input);
  const dataVersion = await getCatalogMasterExportDataVersion(supabaseUrl, serviceRoleKey, caller.organizationId, brand.id, scope);
  const exportType = "catalog_master";
  const scopePayload = {
    brandId: brand.id,
    brandName: brand.name || input.brandName || "",
    search,
    scope,
    marginA,
    marginB,
    format: "xlsx",
    maxRows: CATALOG_MASTER_EXPORT_MAX_ROWS,
    schemaVersion: 5,
  };
  const cacheKey = hashObject({
    exportType,
    organizationId: caller.organizationId,
    scope: scopePayload,
    dataVersion,
  });
  const reusable = await findReusableExportJob(supabaseUrl, serviceRoleKey, caller.organizationId, exportType, cacheKey);
  if (reusable) return reusable;

  const job = await insertExportJob(supabaseUrl, serviceRoleKey, {
    organizationId: caller.organizationId,
    requestedBy: caller.id,
    audience: "admin",
    exportType,
    scope: scopePayload,
    cacheKey,
    dataVersion,
    progressMessage: `Queued ${brand.name || "brand"} master export.`,
  });
  return { job, cached: false };
}

export async function startSupplierPriceListExport(
  supabaseUrl: string,
  serviceRoleKey: string,
  caller: AppCaller,
  input: SupplierPriceListExportInput,
) {
  const supplierId = String(input.supplierId || "").trim();
  const brand = await resolveCatalogExportBrand(supabaseUrl, serviceRoleKey, caller.organizationId, { brandName: input.brandName });
  if (!supplierId) throw new Error("Select a supplier before download.");
  const supplierRows = await getJson<Array<{ id?: string; name?: string }>>(
    `${supabaseUrl}/rest/v1/suppliers?select=id,name&id=eq.${encodeURIComponent(supplierId)}&organization_id=eq.${encodeURIComponent(caller.organizationId)}&limit=1`,
    { headers: serviceRoleHeaders(serviceRoleKey), timeoutMs: 10_000 },
  );
  if (!supplierRows[0]?.id) throw new Error("Supplier not found for this organization.");
  const search = String(input.search || "").trim();
  const freshness = String(input.freshness || "all").trim().toLowerCase() || "all";
  if (!["all", "fresh", "aging", "stale", "unknown"].includes(freshness)) throw new Error("Invalid freshness filter.");
  const dataVersion = await getSupplierPriceExportDataVersion(supabaseUrl, serviceRoleKey, caller.organizationId, supplierId, brand.id);
  const exportType = "supplier_price_list";
  const scope = {
    supplierId,
    supplierName: String(supplierRows[0].name || "Supplier"),
    brandId: brand.id,
    brandName: brand.name,
    search,
    freshness,
    format: "csv",
    schemaVersion: 3,
  };
  const cacheKey = hashObject({ exportType, organizationId: caller.organizationId, scope, dataVersion });
  const reusable = await findReusableExportJob(supabaseUrl, serviceRoleKey, caller.organizationId, exportType, cacheKey);
  if (reusable) return reusable;
  const job = await insertExportJob(supabaseUrl, serviceRoleKey, {
    organizationId: caller.organizationId,
    requestedBy: caller.id,
    audience: "admin",
    exportType,
    scope,
    cacheKey,
    dataVersion,
    progressMessage: `Queued ${brand.name || "brand"} supplier price export.`,
  });
  return { job, cached: false };
}

export async function runAdminPriceListExportJob(
  supabaseUrl: string,
  serviceRoleKey: string,
  jobId: string,
) {
  const job = await fetchJobRows(
    supabaseUrl,
    serviceRoleKey,
    new URLSearchParams({
      select: "*",
      id: `eq.${jobId}`,
      limit: "1",
    }).toString(),
  ).then((rows) => rows[0] || null);
  if (!job || job.status === "finalized") return;

  if (job.export_type !== "admin_price_list" || job.audience !== "admin") throw new Error("Unsupported admin price export job.");
  const scope = job.scope || {};
  const brandId = String(scope.brandId || "");
  const brandName = String(scope.brandName || "Price List");
  const priceListType: "A" | "B" = String(scope.priceListType || "A").toUpperCase() === "B" ? "B" : "A";
  const marginPercent = Number(scope.marginPercent || 0);
  const startedAt = new Date().toISOString();
  await patchExportJob(supabaseUrl, serviceRoleKey, job.id, {
    status: "running",
    started_at: startedAt,
    progress_done: 0,
    progress_total: null,
    progress_message: "Loading compact price rows from rollups.",
    error_message: null,
  });

  try {
    const worksheet = createAdminPriceListWorksheet();
    let rowCount = 0;
    let progressTotal: number | null = null;
    let afterNormalizedCode = "";

    while (rowCount < ADMIN_PRICE_LIST_EXPORT_MAX_ROWS) {
      const pageRows = await fetchAdminPriceListFastPage({
        supabaseUrl,
        serviceRoleKey,
        organizationId: job.organization_id,
        brandId,
        brandName,
        priceListType,
        marginPercent,
        afterNormalizedCode,
      });
      if (!pageRows.length) break;

      const page = advanceExportPage(pageRows, afterNormalizedCode, progressTotal);
      appendAdminPriceListWorksheetRows(worksheet, pageRows, brandName, priceListType);
      rowCount += pageRows.length;
      progressTotal = page.total;
      afterNormalizedCode = page.cursor;

      await patchExportJob(supabaseUrl, serviceRoleKey, job.id, {
        progress_done: rowCount,
        progress_total: progressTotal,
        row_count: rowCount,
        progress_message: `Prepared ${rowCount.toLocaleString("en-US")}${progressTotal ? ` / ${progressTotal.toLocaleString("en-US")}` : ""} admin price rows.`,
      });

      if (progressTotal != null && rowCount >= progressTotal) break;
    }

    if (!rowCount) {
      throw new Error(`Price list is not available for ${brandName}.`);
    }
    assertCompleteExport(rowCount, progressTotal, ADMIN_PRICE_LIST_EXPORT_MAX_ROWS);
    const expectedRows = progressTotal!;
    await patchExportJob(supabaseUrl, serviceRoleKey, job.id, {
      progress_done: rowCount,
      progress_total: expectedRows,
      row_count: rowCount,
      progress_message: `Building XLSX workbook for ${rowCount.toLocaleString("en-US")} rows.`,
    });
    const workbook = buildAdminPriceListWorkbookFromWorksheet(worksheet, brandName, priceListType);
    const stamp = new Date().toISOString().slice(0, 10).replaceAll("-", "");
    const fileName = `${sanitizeDownloadFileName(`price-list-${brandName}-${priceListType}-${stamp}`)}.xlsx`;
    const storagePath = `${job.organization_id}/admin-price-list/${job.cache_key}/${fileName}`;
    const contentType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    await uploadExportArtifact(supabaseUrl, serviceRoleKey, {
      bucket: EXPORT_STORAGE_BUCKET,
      path: storagePath,
      contentType,
      body: workbook,
    });
    await patchExportJob(supabaseUrl, serviceRoleKey, job.id, {
      status: "finalized",
      finalized_at: new Date().toISOString(),
      file_name: fileName,
      content_type: contentType,
      storage_bucket: EXPORT_STORAGE_BUCKET,
      storage_path: storagePath,
      row_count: rowCount,
      byte_size: workbook.byteLength,
      progress_done: rowCount,
      progress_total: rowCount,
      progress_message: "Export file is ready.",
    });
  } catch (error) {
    await patchExportJob(supabaseUrl, serviceRoleKey, job.id, {
      status: "failed",
      failed_at: new Date().toISOString(),
      error_message: error instanceof Error ? error.message : String(error || "Export failed."),
      progress_message: "Export failed.",
    }).catch((patchError) => console.error("failed to mark export failed", patchError));
    throw error;
  }
}

export async function runPortalPriceListExportJob(
  supabaseUrl: string,
  serviceRoleKey: string,
  jobId: string,
) {
  const job = await fetchJobRows(
    supabaseUrl,
    serviceRoleKey,
    new URLSearchParams({
      select: "*",
      id: `eq.${jobId}`,
      limit: "1",
    }).toString(),
  ).then((rows) => rows[0] || null);
  if (!job || job.status === "finalized") return;
  if (job.export_type !== "portal_price_list" || job.audience !== "portal") {
    throw new Error("Unsupported portal export job.");
  }

  const scope = job.scope || {};
  const inviteId = String(scope.inviteId || "");
  const brandId = String(scope.brandId || "");
  const brandName = String(scope.brandName || "");
  const priceListType = normalizePortalPriceListType(scope.priceListType);
  const currency = String(scope.currency || "EUR").trim() || "EUR";
  const marginPercent = Number(scope.marginPercent || 0);
  if (!inviteId || !brandId || !brandName || !Number.isFinite(marginPercent)) throw new Error("Portal export job is missing its scope.");

  const startedAt = new Date().toISOString();
  await patchExportJob(supabaseUrl, serviceRoleKey, job.id, {
    status: "running",
    started_at: job.started_at || startedAt,
    progress_done: 0,
    progress_total: null,
    progress_message: "Building customer price rows from published prices.",
    error_message: null,
  });

  try {
    const invite = await fetchPortalInviteForExport(supabaseUrl, serviceRoleKey, job.organization_id, inviteId);
    await assertPortalExportJobCurrentContext(supabaseUrl, serviceRoleKey, job, invite);
    let rowCount = 0;
    let progressTotal: number | null = null;
    let workbook: Buffer;

    {
      const worksheet = createPortalPriceListWorksheet(currency);
      let afterNormalizedCode = "";

      while (rowCount < PORTAL_PRICE_LIST_EXPORT_MAX_ROWS) {
        const pageRows = await fetchPortalPriceListFastPage({
          supabaseUrl,
          serviceRoleKey,
          organizationId: job.organization_id,
          brandId,
          priceListType,
          marginPercent,
          afterNormalizedCode,
        });
        if (!pageRows.length) break;

        const page = advanceExportPage(pageRows, afterNormalizedCode, progressTotal);
        appendPortalPriceListWorksheetRows(worksheet, pageRows, brandName);
        rowCount += pageRows.length;
        progressTotal = page.total;
        afterNormalizedCode = page.cursor;

        await patchExportJob(supabaseUrl, serviceRoleKey, job.id, {
          progress_done: rowCount,
          progress_total: progressTotal,
          row_count: rowCount,
          progress_message: `Prepared ${rowCount.toLocaleString("en-US")}${progressTotal ? ` / ${progressTotal.toLocaleString("en-US")}` : ""} customer price rows.`,
        });

        if (progressTotal != null && rowCount >= progressTotal) break;
      }

      if (!rowCount) {
        throw new Error(`Price list is not available for ${brandName}.`);
      }
      assertCompleteExport(rowCount, progressTotal, PORTAL_PRICE_LIST_EXPORT_MAX_ROWS);
      workbook = buildPortalPriceListWorkbookFromWorksheet(worksheet, brandName);
    }

    const stamp = new Date().toISOString().slice(0, 10).replaceAll("-", "");
    const fileName = `${sanitizeDownloadFileName(`portal-price-list-${brandName}-${priceListType}-${stamp}`)}.xlsx`;
    const storagePath = `${job.organization_id}/portal-price-list/${job.cache_key}/${fileName}`;
    const contentType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    await uploadExportArtifact(supabaseUrl, serviceRoleKey, {
      bucket: EXPORT_STORAGE_BUCKET,
      path: storagePath,
      contentType,
      body: workbook,
    });
    await patchExportJob(supabaseUrl, serviceRoleKey, job.id, {
      status: "finalized",
      finalized_at: new Date().toISOString(),
      file_name: fileName,
      content_type: contentType,
      storage_bucket: EXPORT_STORAGE_BUCKET,
      storage_path: storagePath,
      row_count: rowCount,
      byte_size: workbook.byteLength,
      progress_done: rowCount,
      progress_total: progressTotal ?? rowCount,
      progress_message: "Export file is ready.",
    });
  } catch (error) {
    await patchExportJob(supabaseUrl, serviceRoleKey, job.id, {
      status: "failed",
      failed_at: new Date().toISOString(),
      error_message: error instanceof Error ? error.message : String(error || "Export failed."),
      progress_message: "Export failed.",
    }).catch((patchError) => console.error("failed to mark portal export failed", patchError));
    throw error;
  }
}

type SupplierPriceExportPageRow = {
  total_count?: number | string | null;
  price_id?: string | null;
  product_code?: string | null;
  brand?: string | null;
  description?: string | null;
  oem_no?: string | null;
  buy_price?: number | string | null;
  currency?: string | null;
  price_date?: string | null;
  moq?: number | string | null;
  order_multiple?: number | string | null;
  stock_qty?: number | string | null;
  valid_to?: string | null;
  lead_time_days?: number | string | null;
  notes?: string | null;
  freshness?: string | null;
};

async function fetchSupplierPriceExportPage(input: {
  supabaseUrl: string;
  serviceRoleKey: string;
  organizationId: string;
  supplierId: string;
  brandId: string;
  search: string;
  freshness: string;
  afterProductCode: string | null;
  afterId: string | null;
  pageSize: number;
  includeCommercialTerms: boolean;
}) {
  const payload = await rpcJson<unknown>(input.supabaseUrl, input.serviceRoleKey, input.includeCommercialTerms ? "cloud_supplier_price_export_commercial_chunk_v3" : "cloud_supplier_price_export_chunk_v3", {
    input_organization_id: input.organizationId,
    input_supplier_id: input.supplierId,
    input_brand_id: input.brandId,
    input_search: input.search,
    input_freshness: input.freshness,
    input_after_product_code: input.afterProductCode,
    input_after_id: input.afterId,
    input_page_size: input.pageSize,
  }, EXPORT_REQUEST_TIMEOUT_MS);
  if (!Array.isArray(payload) || payload.some((row) => !row || typeof row !== "object" || Array.isArray(row))) {
    throw new Error("Invalid supplier price export page.");
  }
  return payload as SupplierPriceExportPageRow[];
}

type RemainingAdminExportType = "supplier_price_list" | "catalog_export" | "catalog_master";

function verifiedSourceTotal(value: unknown, previousTotal: number | null, rowLimit: number) {
  const total = value == null ? previousTotal : Number(value);
  if (total == null || !Number.isSafeInteger(total) || total < 1) {
    throw new Error("Export row count could not be verified. No complete file is available.");
  }
  if (previousTotal != null && total !== previousTotal) throw new Error("Export data changed during pagination. Retry with a fresh snapshot.");
  assertCompleteExport(total, total, rowLimit);
  return total;
}

function compareExportCursor(left: readonly [string, string | null], right: readonly [string, string | null]) {
  return Buffer.compare(Buffer.from(left[0], "utf8"), Buffer.from(right[0], "utf8"))
    || Buffer.compare(Buffer.from(left[1] || "", "utf8"), Buffer.from(right[1] || "", "utf8"));
}

async function runPagedRemainingAdminExportJob(
  supabaseUrl: string,
  serviceRoleKey: string,
  jobId: string,
  exportType: RemainingAdminExportType,
) {
  const candidate = await fetchJobRows(supabaseUrl, serviceRoleKey, new URLSearchParams({ select: "*", id: `eq.${jobId}`, limit: "1" }).toString()).then((rows) => rows[0] || null);
  if (!candidate || candidate.status === "finalized") return;
  if (candidate.export_type !== exportType || candidate.audience !== "admin") throw new Error("Unsupported admin export job.");
  const job = await claimRemainingExportJob(supabaseUrl, serviceRoleKey, candidate);
  if (!job) return;
  const leaseStartedAt = job.started_at!;
  const stopHeartbeat = startExportJobHeartbeat(supabaseUrl, serviceRoleKey, job.id, leaseStartedAt);
  const patch = (values: Partial<ExportJobRow>) => patchExportJob(supabaseUrl, serviceRoleKey, job.id, values, leaseStartedAt);
  let writer: StreamingExportWriter | null = null;
  try {
    const scope = job.scope || {};
    const brandId = String(scope.brandId || "");
    const brandName = String(scope.brandName || "Brand");
    const supplierId = String(scope.supplierId || "");
    const supplierName = String(scope.supplierName || "Supplier");
    const search = String(scope.search || "");
    const freshness = String(scope.freshness || "all");
    const marketSegment = String(scope.marketSegment || "");
    const exportScope = String(scope.scope || "priced") === "catalog" ? "catalog" : "priced";
    const marginA = Number(scope.marginA ?? 0.1);
    const marginB = Number(scope.marginB ?? 0.15);
    const format = exportType === "catalog_master" || (exportType === "catalog_export" && scope.format === "xlsx") ? "xlsx" : "csv";
    if (!brandId || (exportType === "supplier_price_list" && !supplierId)) throw new Error("Export job is missing its supplier or brand scope.");
    const includeSupplierTerms = exportType === "supplier_price_list" && Number(scope.schemaVersion || 2) >= 3;
    const headers = exportType === "supplier_price_list"
      ? ["Supplier", "Product_Code", "Brand", "Product_Name", "OEM_No", "Buy_Price_EUR", "Price_Date", "MOQ", "Order_Multiple", "Lead_Time_Days", "Notes", ...(includeSupplierTerms ? ["Stock_Qty", "Valid_To"] : [])]
      : exportType === "catalog_export" ? CATALOG_EXPORT_HEADERS : CATALOG_MASTER_EXPORT_HEADERS;
    writer = format === "csv"
      ? await createCsvExportStream(headers, { bom: true })
      : await createXlsxExportStream(headers, sanitizeSheetName(`${brandName} ${exportType === "catalog_master" ? "Master" : "Catalog"}`));
    let rowCount = 0;
    let totalCount: number | null = null;
    let afterCode: string | null = null;
    let afterId: string | null = null;
    let previousCursor: readonly [string, string | null] | null = null;
    await patch({ progress_done: 0, progress_total: null, row_count: 0, progress_message: "Loading export rows in keyset batches.", error_message: null });
    while (rowCount < CATALOG_EXPORT_MAX_ROWS) {
      const pageSize = totalCount != null && totalCount > 10_000 ? 5_000 : 1_000;
      let sheetRows: unknown[][];
      let cursors: Array<readonly [string, string | null]>;
      let nextCode: string | null = null;
      let nextId: string | null = null;
      let pageTotal: unknown;
      if (exportType === "supplier_price_list") {
        const page = await fetchSupplierPriceExportPage({ supabaseUrl, serviceRoleKey, organizationId: job.organization_id, supplierId, brandId, search, freshness, afterProductCode: afterCode, afterId, pageSize, includeCommercialTerms: includeSupplierTerms });
        if (!page.length) break;
        pageTotal = page[0].total_count;
        cursors = page.map((r) => [String(r.product_code), String(r.price_id)]);
        const last = page.at(-1)!;
        nextCode = String(last.product_code || "");
        nextId = String(last.price_id || "");
        if (page.some((r) => !r.product_code || !r.price_id || !r.brand)) throw new Error("Invalid supplier export source row.");
        sheetRows = page.map((r) => {
          const terms = includeSupplierTerms ? readSupplierCommercialTerms(r) : null;
          return [supplierName, normalizeAdminExportProductCode(String(r.product_code), String(r.brand || brandName)), String(r.brand || brandName), r.description || "", r.oem_no || "", r.buy_price ?? "", r.price_date || "", r.moq ?? "", r.order_multiple ?? "", r.lead_time_days ?? "", r.notes || "", ...(terms ? [terms.stock_qty ?? "", terms.valid_to ?? ""] : [])];
        });
      } else if (exportType === "catalog_export") {
        const payload = await rpcJson<unknown>(supabaseUrl, serviceRoleKey, "cloud_catalog_export_chunk_v3", {
          input_organization_id: job.organization_id, input_brand_id: brandId, input_market_segment: marketSegment,
          input_after_id: afterId, input_page_size: pageSize,
        }, EXPORT_REQUEST_TIMEOUT_MS);
        if (!Array.isArray(payload)) throw new Error("Invalid catalog export page.");
        if (!payload.length) break;
        const page = coerceCatalogExportRows(payload);
        if (page.length !== payload.length || page.some((r) => !r.productId)) throw new Error("Invalid catalog export source row.");
        pageTotal = page[0].totalCount;
        cursors = page.map((r) => ["", r.productId]);
        nextId = page.at(-1)!.productId;
        sheetRows = catalogExportSheetRows(page).slice(1);
      } else {
        const payload = await rpcJson<unknown>(supabaseUrl, serviceRoleKey, "cloud_catalog_master_export_chunk_v3", {
          input_organization_id: job.organization_id, input_brand_id: brandId, input_scope: exportScope, input_search: search,
          input_after_code: afterCode, input_after_id: afterId, input_page_size: pageSize,
          input_margin_a: marginA, input_margin_b: marginB,
        }, EXPORT_REQUEST_TIMEOUT_MS);
        if (!Array.isArray(payload)) throw new Error("Invalid master export page.");
        if (!payload.length) break;
        const page = coerceCatalogMasterExportRows(payload);
        if (page.length !== payload.length || page.some((r) => !r.cursorCode)) throw new Error("Invalid master export source row.");
        pageTotal = page[0].totalCount;
        cursors = page.map((r) => [r.cursorCode, r.cursorId]);
        nextCode = page.at(-1)!.cursorCode;
        nextId = page.at(-1)!.cursorId;
        sheetRows = catalogMasterExportSheetRows(page).slice(1);
      }
      totalCount = verifiedSourceTotal(pageTotal, totalCount, CATALOG_EXPORT_MAX_ROWS);
      for (const cursor of cursors) {
        if (previousCursor && compareExportCursor(previousCursor, cursor) >= 0) throw new Error("Export cursor did not advance uniquely. Refresh the export snapshot.");
        previousCursor = cursor;
      }
      afterCode = nextCode;
      afterId = nextId;
      rowCount += sheetRows.length;
      if (rowCount > totalCount) throw new Error("Export source returned more rows than its verified count.");
      await writer.append(sheetRows);
      await patch({ progress_done: rowCount, progress_total: totalCount, row_count: rowCount, progress_message: `Prepared ${rowCount.toLocaleString("en-US")} / ${totalCount.toLocaleString("en-US")} export rows.` });
      if (rowCount === totalCount || sheetRows.length < pageSize) break;
    }
    assertCompleteExport(rowCount, totalCount, CATALOG_EXPORT_MAX_ROWS);
    const currentVersion = exportType === "supplier_price_list"
      ? await getSupplierPriceExportDataVersion(supabaseUrl, serviceRoleKey, job.organization_id, supplierId, brandId)
      : exportType === "catalog_export"
        ? await getCatalogExportDataVersion(supabaseUrl, serviceRoleKey, job.organization_id, brandId, marketSegment)
        : await getCatalogMasterExportDataVersion(supabaseUrl, serviceRoleKey, job.organization_id, brandId, exportScope);
    if (!job.data_version || currentVersion !== job.data_version) throw new Error("Export source changed during preparation. Retry with a fresh snapshot.");
    const body = await writer.finish();
    const stamp = new Date().toISOString().slice(0, 10).replaceAll("-", "");
    const stem = exportType === "supplier_price_list" ? `supplier-${supplierName}-${brandName}-${stamp}`
      : exportType === "catalog_export" ? `catalog-${brandName}-${stamp}` : `master-${brandName}-${exportScope}-${stamp}`;
    const fileName = `${sanitizeDownloadFileName(stem)}.${format}`;
    const folder = exportType === "supplier_price_list" ? "supplier-price" : exportType === "catalog_export" ? "catalog-export" : "catalog-master";
    const attemptFolder = createHash("sha256").update(leaseStartedAt).digest("hex").slice(0, 24);
    const storagePath = `${job.organization_id}/${folder}/${job.cache_key}/${attemptFolder}/${fileName}`;
    const contentType = format === "csv" ? "text/csv" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    await patch({ byte_size: body.byteLength, progress_message: "Saving the complete export file." });
    const artifactParts: Array<{ path: string; byteSize: number }> = [];
    if (body.byteLength > EXPORT_ARTIFACT_PART_BYTES) {
      const partCount = Math.ceil(body.byteLength / EXPORT_ARTIFACT_PART_BYTES);
      for (let offset = 0, part = 1; offset < body.byteLength; offset += EXPORT_ARTIFACT_PART_BYTES, part += 1) {
        const chunk = body.subarray(offset, Math.min(offset + EXPORT_ARTIFACT_PART_BYTES, body.byteLength));
        const path = `${storagePath}.part-${String(part).padStart(3, "0")}`;
        await assertAndTouchExportJobLease(supabaseUrl, serviceRoleKey, job.id, leaseStartedAt);
        await uploadExportArtifact(supabaseUrl, serviceRoleKey, { bucket: EXPORT_STORAGE_BUCKET, path, contentType: "application/octet-stream", body: chunk });
        artifactParts.push({ path, byteSize: chunk.byteLength });
        await patch({ progress_message: `Saving export file part ${part} of ${partCount}.` });
      }
    } else {
      await assertAndTouchExportJobLease(supabaseUrl, serviceRoleKey, job.id, leaseStartedAt);
      await uploadExportArtifact(supabaseUrl, serviceRoleKey, { bucket: EXPORT_STORAGE_BUCKET, path: storagePath, contentType, body });
    }
    await stopHeartbeat();
    const finalizedScope = { ...scope };
    delete finalizedScope.artifactParts;
    if (artifactParts.length) finalizedScope.artifactParts = artifactParts;
    await patch({ status: "finalized", finalized_at: new Date().toISOString(), file_name: fileName, content_type: contentType,
      scope: finalizedScope, storage_bucket: EXPORT_STORAGE_BUCKET, storage_path: artifactParts[0]?.path || storagePath,
      row_count: rowCount, byte_size: body.byteLength,
      progress_done: rowCount, progress_total: totalCount, progress_message: "Export file is ready." });
  } catch (error) {
    await stopHeartbeat().catch(() => {});
    await patch({ status: "failed", failed_at: new Date().toISOString(), error_message: error instanceof Error ? error.message : String(error || "Export failed."), progress_message: "Export failed." })
      .catch((patchError) => console.error("failed to mark admin export failed", patchError));
    throw error;
  } finally {
    await stopHeartbeat().catch(() => {});
    await writer?.cleanup().catch((cleanupError) => console.error("failed to clean export temp file", cleanupError));
  }
}

export async function runSupplierPriceListExportJob(supabaseUrl: string, serviceRoleKey: string, jobId: string) {
  return runPagedRemainingAdminExportJob(supabaseUrl, serviceRoleKey, jobId, "supplier_price_list");
}

export async function runCatalogExportJob(supabaseUrl: string, serviceRoleKey: string, jobId: string) {
  return runPagedRemainingAdminExportJob(supabaseUrl, serviceRoleKey, jobId, "catalog_export");
}

export async function runCatalogMasterExportJob(supabaseUrl: string, serviceRoleKey: string, jobId: string) {
  return runPagedRemainingAdminExportJob(supabaseUrl, serviceRoleKey, jobId, "catalog_master");
}

export function exportJson(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return json(body, status, {
    "Cache-Control": "no-store",
    ...headers,
  });
}
