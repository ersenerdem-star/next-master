const STORAGE_VERSION_KEY = "next-master-storage-version";
const SALES_ORDER_WORKSPACE_KEY = "next-master-sales-order-workspace";
const CATALOG_CACHE_KEY = "next-master-catalog-cache";
const PORTAL_CACHE_PREFIX = "next-master-portal-cache:";
const WORKSPACE_MAX_AGE_MS = 48 * 60 * 60 * 1000;

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

function removePortalSnapshots(storage: StorageLike) {
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key?.startsWith(PORTAL_CACHE_PREFIX)) keys.push(key);
  }
  keys.forEach((key) => storage.removeItem(key));
}

function clearInvalidSalesOrderWorkspace(storage: StorageLike) {
  const raw = storage.getItem(SALES_ORDER_WORKSPACE_KEY);
  if (!raw) return;
  try {
    const workspace = JSON.parse(raw) as { workbenchMode?: string; quoteBuilderLines?: unknown[]; selectedLocalSalesOrderId?: string; updatedAt?: string };
    const updatedAt = Date.parse(String(workspace.updatedAt || ""));
    const isRecent = Number.isFinite(updatedAt) && Date.now() - updatedAt <= WORKSPACE_MAX_AGE_MS;
    const hasDraft =
      workspace.workbenchMode === "new" &&
      !workspace.selectedLocalSalesOrderId &&
      Array.isArray(workspace.quoteBuilderLines) &&
      workspace.quoteBuilderLines.length > 0 &&
      isRecent;
    if (!hasDraft) storage.removeItem(SALES_ORDER_WORKSPACE_KEY);
  } catch {
    storage.removeItem(SALES_ORDER_WORKSPACE_KEY);
  }
}

/**
 * Reconciles browser-owned caches whenever a new application build starts.
 * Saved new-order drafts survive; historical order identities and catalog
 * result snapshots do not. Portal session drafts remain in sessionStorage.
 */
export function reconcileAppStorage(buildVersion: string) {
  if (typeof window === "undefined") return;
  const version = String(buildVersion || "local").trim() || "local";
  try {
    const previousVersion = window.localStorage.getItem(STORAGE_VERSION_KEY) || "";
    // Run workspace validation on every boot so deletion/expiry is not tied
    // to a deployment. Version changes additionally invalidate result caches.
    clearInvalidSalesOrderWorkspace(window.localStorage);
    removePortalSnapshots(window.localStorage);
    if (previousVersion !== version) {
      window.localStorage.removeItem(CATALOG_CACHE_KEY);
      window.localStorage.setItem(STORAGE_VERSION_KEY, version);
    }
  } catch {
    // Storage is best-effort; runtime data remains server-authoritative.
  }
}
