import { supabaseClient } from "./supabaseClient";
import { downloadUrl } from "../../shared/xlsx";
import { sanitizeUserFacingMessage } from "../../shared/userMessage";

export type ExportJobStatus = {
  id: string;
  exportType: string;
  status: "queued" | "running" | "finalized" | "failed" | "expired";
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

type ExportJobResponse = {
  ok?: boolean;
  job?: ExportJobStatus;
  error?: string;
};

type ExportDownloadResponse = {
  ok?: boolean;
  signedUrl?: string;
  url?: string;
  fileName?: string;
  rowCount?: number;
  byteSize?: number;
  expiresIn?: number;
  error?: string;
};

type AdminPriceListExportInput = {
  brandId: string;
  brandName: string;
  priceListType: "A" | "B";
  marginPercent: number;
};

type CatalogExportInput = {
  brandId?: string;
  brandName: string;
  marketSegment?: string;
  format: "csv" | "xlsx";
};

type MasterExportInput = {
  brandId: string;
  brandName: string;
  search: string;
  scope: "priced" | "catalog";
  marginA: number;
  marginB: number;
};

const EXPORT_STATUS_TIMEOUT_MS = 180_000;
const EXPORT_STATUS_POLL_MS = 1_200;

async function getAccessToken() {
  const { data, error } = await supabaseClient.auth.getSession();
  if (error) throw new Error(sanitizeUserFacingMessage(error.message, "Your session has expired. Sign in again."));
  const token = String(data.session?.access_token || "");
  if (!token) throw new Error("Your session has expired. Sign in again.");
  return token;
}

async function postExportJson(path: string, body: Record<string, unknown>) {
  const accessToken = await getAccessToken();
  const response = await fetch(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  });
  const data = (await response.json().catch(() => ({}))) as ExportJobResponse;
  if (!response.ok) {
    throw new Error(sanitizeUserFacingMessage(data.error || `Export request failed: ${response.status}`, "The export request could not be completed right now."));
  }
  if (!data.job) {
    throw new Error("Export job response is missing.");
  }
  return data.job;
}

async function postExportDownloadJson(path: string, body: Record<string, unknown>) {
  const accessToken = await getAccessToken();
  const response = await fetch(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  });
  const data = (await response.json().catch(() => ({}))) as ExportDownloadResponse;
  if (!response.ok) {
    throw new Error(sanitizeUserFacingMessage(data.error || `Export download failed: ${response.status}`, "The export file could not be downloaded right now."));
  }
  const signedUrl = String(data.signedUrl || data.url || "").trim();
  if (!signedUrl) throw new Error("Export download link is missing.");
  return {
    signedUrl,
    fileName: data.fileName || "export.xlsx",
    rowCount: Number(data.rowCount || 0),
    byteSize: Number(data.byteSize || 0),
    expiresIn: Number(data.expiresIn || 0),
  };
}

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export function describeExportJobStatus(job: ExportJobStatus) {
  const rowInfo = job.rowCount ? ` · ${job.rowCount.toLocaleString("en-US")} rows` : "";
  if (job.status === "finalized") return `Export file is ready${rowInfo}.`;
  if (job.status === "failed") return job.errorMessage || "Export failed.";
  if (job.status === "running") return job.progressMessage || `Preparing export${rowInfo}.`;
  return job.progressMessage || "Export queued.";
}

export async function startAdminPriceListExport(input: AdminPriceListExportInput) {
  return postExportJson("/api/admin-export-start", {
    exportType: "admin_price_list",
    brandId: input.brandId,
    brandName: input.brandName,
    priceListType: input.priceListType,
    marginPercent: input.marginPercent,
  });
}

export async function startCatalogExport(input: CatalogExportInput) {
  return postExportJson("/api/admin-export-start", {
    exportType: "catalog_export",
    brandId: input.brandId || "",
    brandName: input.brandName,
    marketSegment: input.marketSegment || "",
    format: input.format,
  });
}

export async function startMasterExport(input: MasterExportInput) {
  return postExportJson("/api/admin-export-start", {
    exportType: "catalog_master",
    brandId: input.brandId,
    brandName: input.brandName,
    search: input.search || "",
    scope: input.scope === "catalog" ? "catalog" : "priced",
    marginA: input.marginA,
    marginB: input.marginB,
  });
}

export async function getExportJobStatus(jobId: string) {
  return postExportJson("/api/admin-export-status", { jobId });
}

export async function downloadExportJob(jobId: string) {
  const result = await postExportDownloadJson("/api/admin-export-download", { jobId });
  await downloadUrl(result.fileName, result.signedUrl);
  return result;
}

export async function waitForExportJob(
  initialJob: ExportJobStatus,
  onProgress?: (job: ExportJobStatus) => void,
) {
  let job = initialJob;
  const startedAt = Date.now();
  onProgress?.(job);
  while (job.status === "queued" || job.status === "running") {
    if (Date.now() - startedAt > EXPORT_STATUS_TIMEOUT_MS) {
      throw new Error("Export is still preparing in the background. Try download again in a moment.");
    }
    await delay(EXPORT_STATUS_POLL_MS);
    job = await getExportJobStatus(job.id);
    onProgress?.(job);
  }
  if (job.status !== "finalized") {
    throw new Error(job.errorMessage || "Export failed.");
  }
  return job;
}
