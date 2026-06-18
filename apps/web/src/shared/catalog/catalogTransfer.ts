export type CatalogTransferPayload = {
  product_code: string;
  requested_code?: string | null;
  brand: string;
  description: string;
  oem_no: string;
  hs_code: string;
  origin: string;
  weight_kg: number | null;
  lifecycle_status?: string | null;
  lifecycle_note?: string | null;
  replacement_warning?: string | null;
};

export type AppNavigationDetail = {
  page: "Sales" | "Purchases";
};

export const APP_NAVIGATION_EVENT = "next-master:navigate";
export const PENDING_CATALOG_SALES_ITEM_KEY = "next-master:pending-catalog-sales-item";
export const PENDING_CATALOG_PURCHASE_ITEM_KEY = "next-master:pending-catalog-purchase-item";

export function dispatchAppNavigation(detail: AppNavigationDetail) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<AppNavigationDetail>(APP_NAVIGATION_EVENT, { detail }));
}

export function storeCatalogTransfer(key: string, payload: CatalogTransferPayload) {
  if (typeof window === "undefined") return;
  window.sessionStorage.setItem(key, JSON.stringify(payload));
}

export function consumeCatalogTransfer(key: string): CatalogTransferPayload | null {
  if (typeof window === "undefined") return null;
  const raw = window.sessionStorage.getItem(key);
  if (!raw) return null;
  window.sessionStorage.removeItem(key);
  try {
    const parsed = JSON.parse(raw) as CatalogTransferPayload;
    if (!parsed?.product_code || !parsed?.brand) return null;
    return parsed;
  } catch {
    return null;
  }
}
