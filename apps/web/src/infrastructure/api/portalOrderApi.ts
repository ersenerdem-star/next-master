import type { PortalCredentials, PortalSnapshot } from "../../types/portalSession";

export type PortalCatalogSearchItem = {
  code: string;
  brand: string;
  description: string;
  oem_no: string;
  tariff: string;
  origin: string;
  weight_kg: number | null;
  image_url: string;
  sell_price: number | null;
  currency: string;
  supplier_name: string;
  lifecycle_status?: "active" | "discontinued" | null;
  lifecycle_note?: string | null;
  lifecycle_warning?: string | null;
};

export type PortalOrderInputRow = {
  code: string;
  brand: string;
  qty: number;
};

export type PortalPreparedLine = {
  lineId: string;
  requestedCode: string;
  resolvedCode: string;
  brand: string;
  description: string;
  qty: number;
  oem_no: string;
  hs_code: string;
  origin: string;
  weight_kg: number | null;
  image_url: string;
  supplier_name: string;
  buy_price: number | null;
  sell_price: number | null;
  c_sell_price: number | null;
  price_date: string;
  notes: string;
  found: boolean;
  codeChanged: boolean;
  codeChangeWarning: string;
  lifecycle_status?: "active" | "discontinued" | null;
  lifecycle_note?: string | null;
  lifecycle_warning?: string | null;
};

type PortalOrderResponse = {
  ok?: boolean;
  error?: string;
  items?: PortalCatalogSearchItem[];
  lines?: PortalPreparedLine[];
  pricingProfile?: PortalSnapshot["pricingProfile"];
  snapshot?: PortalSnapshot;
  orderId?: string;
  priceListType?: "A" | "B" | "C" | "Other";
  currency?: string;
  rows?: Array<{
    product_code: string;
    brand: string;
    description: string;
    oem_no: string;
    hs_code: string;
    origin: string;
    weight_kg: number | null;
    price_list_type: "A" | "B" | "C" | "Other";
    sales_price: number | null;
    lifecycle_status: "active" | "discontinued";
    lifecycle_note: string | null;
  }>;
};

async function postPortalOrderJson(path: string, payload: Record<string, unknown>) {
  const response = await fetch(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
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

export async function searchPortalCatalogItems(credentials: PortalCredentials, query: string, brand: string) {
  const data = await postPortalOrderJson("/api/portal-order-search", {
    ...credentials,
    query,
    brand,
  });
  return data.items || [];
}

export async function preparePortalOrderLines(credentials: PortalCredentials, rows: PortalOrderInputRow[]) {
  const data = await postPortalOrderJson("/api/portal-order-prepare", {
    ...credentials,
    rows,
  });
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
) {
  const data = await postPortalOrderJson("/api/portal-order-submit", {
    ...credentials,
    ...input,
  });
  if (!data.snapshot) throw new Error("Portal order save did not return refreshed portal snapshot");
  return {
    snapshot: data.snapshot,
    orderId: data.orderId || "",
  };
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
