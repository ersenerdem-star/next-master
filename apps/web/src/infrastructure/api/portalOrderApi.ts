import type { PortalCredentials, PortalSnapshot } from "../../types/portalSession";

export type PortalCatalogSearchItem = {
  code: string;
  brand: string;
  market_segment: string | null;
  description: string;
  oem_no: string;
  vehicle: string;
  tariff: string;
  origin: string;
  weight_kg: number | null;
  image_url: string;
  sell_price: number | null;
  currency: string;
  lifecycle_status?: "active" | "discontinued" | null;
  lifecycle_note?: string | null;
  lifecycle_warning?: string | null;
  replacement_old_code?: string | null;
  replacement_code?: string | null;
  replacement_reason?: string | null;
  replacement_warning?: string | null;
  recommendation_reason?: string | null;
  available_qty?: number | null;
};

export type PortalSearchField = "part_number" | "oem" | "vehicle" | "description";

export type PortalOrderInputRow = {
  code: string;
  brand: string;
  qty: number;
  market_segment?: string | null;
};

export type PortalExportJobStatus = {
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

export type PortalPreparedLine = {
  lineId: string;
  requestedCode: string;
  resolvedCode: string;
  brand: string;
  market_segment: string | null;
  description: string;
  qty: number;
  requested_qty?: number | null;
  moq?: number | null;
  order_multiple?: number | null;
  quantity_adjusted?: boolean;
  quantity_adjustment_note?: string | null;
  oem_no: string;
  hs_code: string;
  origin: string;
  weight_kg: number | null;
  image_url: string;
  sell_price: number | null;
  c_sell_price: number | null;
  price_date: string;
  found: boolean;
  codeChanged: boolean;
  codeChangeWarning: string;
  lifecycle_status?: "active" | "discontinued" | null;
  lifecycle_note?: string | null;
  lifecycle_warning?: string | null;
  replacement_old_code?: string | null;
  replacement_code?: string | null;
  replacement_reason?: string | null;
  replacement_warning?: string | null;
};

type PortalOrderResponse = {
  ok?: boolean;
  error?: string;
  items?: PortalCatalogSearchItem[];
  recommendations?: PortalCatalogSearchItem[];
  lines?: PortalPreparedLine[];
  pricingProfile?: PortalSnapshot["pricingProfile"];
  snapshot?: PortalSnapshot;
  order?: PortalSnapshot["salesOrders"][number];
  orderId?: string;
  priceListType?: "A" | "B" | "C" | "Other";
  currency?: string;
  rows?: Array<{
    product_code: string;
    brand: string;
    description: string;
    price_list_type: "A" | "B" | "C" | "Other";
    sales_price: number | null;
    price_date: string | null;
    lifecycle_status: "active" | "discontinued";
    lifecycle_note: string | null;
  }>;
  rowsCompact?: Array<[string, string, string, "A" | "B" | "C" | "Other", number | null, string | null, "active" | "discontinued", string | null]>;
  job?: PortalExportJobStatus;
  signedUrl?: string;
  url?: string;
  fallbackUrl?: string;
  fileName?: string;
  rowCount?: number;
  byteSize?: number;
  expiresIn?: number;
};

type PortalRequestOptions = {
  signal?: AbortSignal;
};

// Large customer price lists are generated from a paged server-side rollup.
// Keep enough time for the first cold page while still failing predictably.
const PORTAL_ORDER_REQUEST_TIMEOUT_MS = 90_000;

async function postPortalOrderJson(path: string, payload: Record<string, unknown>, options: PortalRequestOptions = {}) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), PORTAL_ORDER_REQUEST_TIMEOUT_MS);
  const abortFromCaller = () => controller.abort();
  if (options.signal) {
    if (options.signal.aborted) controller.abort();
    else options.signal.addEventListener("abort", abortFromCaller, { once: true });
  }

  let response: Response;
  try {
    response = await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  } catch (caught) {
    if (controller.signal.aborted && !options.signal?.aborted) {
      throw new Error("Portal request timed out. Please try again.");
    }
    throw caught;
  } finally {
    window.clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abortFromCaller);
  }
  const data = (await response.json().catch(() => ({}))) as PortalOrderResponse;
  if (!response.ok) {
    throw new Error(
      data.error ||
        (response.status === 502
          ? "Portal request timed out while pricing items. Retry the action. Large imports are processed in smaller batches."
          : `Portal request failed: ${response.status}`),
    );
  }
  return data;
}

export async function searchPortalCatalogItems(
  credentials: PortalCredentials,
  query: string,
  brand: string,
  searchField: PortalSearchField = "part_number",
  options: PortalRequestOptions = {},
) {
  const data = await postPortalOrderJson("/api/portal-order-search", {
    ...credentials,
    query,
    brand,
    searchField,
  }, options);
  return {
    items: data.items || [],
    recommendations: data.recommendations || [],
  };
}

export async function preparePortalOrderLines(credentials: PortalCredentials, rows: PortalOrderInputRow[], options: PortalRequestOptions = {}) {
  const data = await postPortalOrderJson("/api/portal-order-prepare", {
    ...credentials,
    rows,
  }, options);
  return {
    lines: data.lines || [],
    pricingProfile: data.pricingProfile || null,
  };
}

export async function submitPortalOrder(
  credentials: PortalCredentials,
  input: {
    orderId?: string;
    salesOrderNo?: string;
    mode: "draft" | "confirm";
    deliveryTerm: string;
    paymentTerms: string;
    packingDetails: string;
    notes: string;
    rows: PortalOrderInputRow[];
  },
  options: PortalRequestOptions = {},
) {
  const data = await postPortalOrderJson("/api/portal-order-submit", {
    ...credentials,
    ...input,
  }, options);
  if (!data.snapshot && !data.order) throw new Error("Portal order save did not return a persisted order");
  return {
    snapshot: data.snapshot || null,
    order: data.order || null,
    orderId: data.orderId || "",
  };
}

export async function fetchPortalSalesOrderDetail(credentials: PortalCredentials, orderId: string, options: PortalRequestOptions = {}) {
  const data = await postPortalOrderJson("/api/portal-order-detail", {
    ...credentials,
    orderId,
  }, options);
  return data.order || null;
}

export async function deletePortalDraftOrder(credentials: PortalCredentials, orderId: string) {
  const data = await postPortalOrderJson("/api/portal-order-delete", {
    ...credentials,
    orderId,
  });
  if (!data.snapshot) throw new Error("Portal draft delete did not return refreshed portal snapshot");
  return {
    snapshot: data.snapshot,
    orderId: data.orderId || orderId,
  };
}

const PORTAL_EXPORT_STATUS_TIMEOUT_MS = 30 * 60 * 1000;
// The worker updates durable progress at page boundaries. Polling more often
// than the worker can publish only adds load to the portal; two to three
// seconds still keeps the progress message responsive for customers.
const PORTAL_EXPORT_STATUS_POLL_MS = 3_000;
const PORTAL_EXPORT_START_RETRY_MS = 800;

function isRetryablePortalExportRequestError(error: unknown) {
  const message = String(error instanceof Error ? error.message : error || "");
  return /Portal request failed: (?:502|503|504)\b/.test(message)
    || /Portal request timed out/i.test(message);
}

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export function describePortalExportJobStatus(job: PortalExportJobStatus) {
  const rowInfo = job.rowCount ? ` · ${job.rowCount.toLocaleString("en-US")} rows` : "";
  if (job.status === "finalized") return `Price list file is ready${rowInfo}.`;
  if (job.status === "failed") return job.errorMessage || "Price list export failed.";
  if (job.status === "running") return job.progressMessage || `Preparing price list${rowInfo}.`;
  return job.progressMessage || "Price list export queued.";
}

export async function startPortalPriceListExport(credentials: PortalCredentials, brand: string) {
  const payload = {
    ...credentials,
    exportType: "portal_price_list",
    brand,
  };
  let data: PortalOrderResponse;
  try {
    data = await postPortalOrderJson("/api/portal-export-start", payload);
  } catch (error) {
    // Starting is idempotent by cache key. If the edge response is lost after
    // the server created the durable job, one bounded retry recovers that same
    // job instead of making the customer repeat the operation manually.
    if (!isRetryablePortalExportRequestError(error)) throw error;
    await delay(PORTAL_EXPORT_START_RETRY_MS);
    data = await postPortalOrderJson("/api/portal-export-start", payload);
  }
  // The export is idempotent by organization, customer, brand and pricing
  // snapshot. If the edge response is lost after the server creates the job,
  // retry once so the active or finalized job is returned instead of showing
  // a false "job response is missing" error to the customer.
  if (!data.job) {
    await delay(PORTAL_EXPORT_START_RETRY_MS);
    data = await postPortalOrderJson("/api/portal-export-start", payload);
  }
  if (!data.job) throw new Error("Portal export job response is missing.");
  return data.job;
}

export async function getPortalExportJobStatus(credentials: PortalCredentials, jobId: string) {
  const data = await postPortalOrderJson("/api/portal-export-status", {
    ...credentials,
    jobId,
  });
  if (!data.job) throw new Error("Portal export status response is missing.");
  return data.job;
}

export async function downloadPortalExportJob(credentials: PortalCredentials, jobId: string) {
  const data = await postPortalOrderJson("/api/portal-export-download", {
    ...credentials,
    jobId,
  });
  const signedUrl = String(data.signedUrl || data.url || "").trim();
  if (!signedUrl) throw new Error("Portal price list download link is missing.");
  return {
    signedUrl,
    fallbackUrl: data.fallbackUrl || "",
    fileName: data.fileName || "portal-price-list.xlsx",
    rowCount: Number(data.rowCount || 0),
    byteSize: Number(data.byteSize || 0),
    expiresIn: Number(data.expiresIn || 0),
  };
}

export class PortalExportStillPreparingError extends Error {
  readonly job: PortalExportJobStatus;

  constructor(job: PortalExportJobStatus) {
    super("Price list is still preparing in the background. Click Download Excel again later to resume the same export.");
    this.name = "PortalExportStillPreparingError";
    this.job = job;
  }
}

export async function waitForPortalExportJob(
  credentials: PortalCredentials,
  initialJob: PortalExportJobStatus,
  onProgress?: (job: PortalExportJobStatus) => void,
) {
  let job = initialJob;
  let transientStatusFailures = 0;
  const startedAt = Date.now();
  onProgress?.(job);
  while (job.status === "queued" || job.status === "running") {
    if (Date.now() - startedAt > PORTAL_EXPORT_STATUS_TIMEOUT_MS) {
      // The server keeps the durable job after the browser stops waiting. One
      // final status read avoids reporting a timeout just as the file becomes
      // ready; the next click reuses this job through the idempotent start API.
      job = await getPortalExportJobStatus(credentials, job.id).catch(() => job);
      onProgress?.(job);
      if (job.status === "queued" || job.status === "running") {
        throw new PortalExportStillPreparingError(job);
      }
      break;
    }
    await delay(PORTAL_EXPORT_STATUS_POLL_MS);
    try {
      job = await getPortalExportJobStatus(credentials, job.id);
      transientStatusFailures = 0;
    } catch (error) {
      // A gateway timeout must not turn a durable background export into a
      // false failed operation. Keep the same job id and retry a few times;
      // the server-side worker continues independently of this browser poll.
      if (!isRetryablePortalExportRequestError(error) || transientStatusFailures >= 3) throw error;
      transientStatusFailures += 1;
      await delay(Math.min(8_000, 1_000 * (2 ** transientStatusFailures)));
      continue;
    }
    onProgress?.(job);
  }
  if (job.status !== "finalized") {
    throw new Error(job.errorMessage || "Price list export failed.");
  }
  return job;
}
