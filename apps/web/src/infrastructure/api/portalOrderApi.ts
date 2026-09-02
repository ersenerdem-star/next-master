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

export type PortalPreparedLine = {
  lineId: string;
  requestedCode: string;
  resolvedCode: string;
  brand: string;
  market_segment: string | null;
  description: string;
  qty: number;
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
};

type PortalRequestOptions = {
  signal?: AbortSignal;
};

const PORTAL_ORDER_REQUEST_TIMEOUT_MS = 25_000;

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

export async function downloadPortalPriceList(credentials: PortalCredentials, brand: string) {
  const data = await postPortalOrderJson("/api/portal-price-list", {
    ...credentials,
    brand,
  });
  return {
    priceListType: data.priceListType || "A",
    currency: data.currency || "EUR",
    rows: data.rows || [],
  };
}
