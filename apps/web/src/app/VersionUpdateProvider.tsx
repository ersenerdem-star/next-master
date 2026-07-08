import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useI18n } from "../i18n/I18nProvider";

type BuildMetadata = {
  appId: string;
  appVersion: string;
  buildVersion: string;
  gitSha: string;
  deployId: string;
  builtAt: string;
  apiContractVersion: string;
  minSupportedVersion?: string;
  forceReload?: boolean;
  environment: string;
  branch?: string;
  deployUrl?: string;
  siteUrl?: string;
};

type VersionDecision =
  | { status: "current"; deployed: BuildMetadata | null; reason: string; checkedAt: number }
  | { status: "stale"; deployed: BuildMetadata; reason: string; checkedAt: number }
  | { status: "check-failed"; deployed: null; reason: string; checkedAt: number; error: string }
  | { status: "reload-blocked"; deployed: BuildMetadata; reason: string; checkedAt: number };

type VersionUpdateContextValue = {
  localVersion: BuildMetadata;
  decision: VersionDecision | null;
  checkForUpdate: (reason?: string) => Promise<VersionDecision>;
  requireFreshClient: (reason?: string) => Promise<void>;
  reloadNow: () => Promise<void>;
};

const VERSION_JSON_PATH = "/version.json";
const NORMAL_CHECK_THROTTLE_MS = 60 * 1000;
const CRITICAL_CHECK_THROTTLE_MS = 15 * 1000;
const CHECK_INTERVAL_MS = 5 * 60 * 1000;
const RELOAD_LOOP_WINDOW_MS = 60 * 1000;
const RELOAD_STORAGE_KEY = "next-master-last-version-reload";
const SENSITIVE_API_PATHS = new Set([
  "/api/admin-create-user",
  "/api/admin-delete-user",
  "/api/admin-force-signout",
  "/api/admin-reset-password",
  "/api/admin-sync-brand-catalog",
  "/api/admin-sync-warehouse-stock",
  "/api/admin-test-email",
  "/api/admin-update-user",
  "/api/admin-warehouse-stock-clients",
  "/api/portal-logout",
  "/api/portal-order-delete",
  "/api/portal-order-prepare",
  "/api/portal-order-submit",
  "/api/portal-password-reset-confirm",
  "/api/portal-password-reset-request",
  "/api/portal-price-list",
  "/api/send-portal-invite",
  "/api/send-queued-emails",
  "/api/warehouse-order-submit",
]);
const SENSITIVE_APP_RPC_NAMES = new Set([
  "begin_supplier_price_import",
  "bulk_import_catalog",
  "bulk_import_supplier_prices",
  "cloud_master_export",
  "cloud_master_priced_export_page_fast",
  "deactivate_supplier_prices_by_filter",
  "fail_supplier_price_import",
  "finalize_supplier_price_import",
  "queue_supplier_price_catalog_sync",
  "queue_supplier_price_rollups_refresh",
  "stage_supplier_price_import_chunk",
]);
const SENSITIVE_APP_ADMIN_ACTIONS = new Set([
  "clearPassword",
  "delete",
  "issueToken",
  "markSent",
  "rotate",
  "save",
  "setPassword",
  "setStatus",
  "upsert",
]);
const SENSITIVE_RPC_PREFIXES = [
  "apply_",
  "bulk_",
  "create_",
  "delete_",
  "deactivate_",
  "generate_",
  "import_",
  "insert_",
  "queue_",
  "refresh_",
  "save_",
  "set_",
  "submit_",
  "sync_",
  "update_",
  "upsert_",
];

const localVersion: BuildMetadata = {
  appId: __APP_BUILD_META__.appId || "shared",
  appVersion: __APP_BUILD_META__.appVersion || "0.0.0",
  buildVersion: __APP_BUILD_META__.buildVersion || __APP_BUILD_META__.gitSha || __APP_BUILD_META__.commit || "local",
  gitSha: __APP_BUILD_META__.gitSha || __APP_BUILD_META__.commit || "local",
  deployId: __APP_BUILD_META__.deployId || "",
  builtAt: __APP_BUILD_META__.builtAt || "",
  apiContractVersion: __APP_BUILD_META__.apiContractVersion || "2026-06-30",
  minSupportedVersion: __APP_BUILD_META__.minSupportedVersion || "",
  forceReload: Boolean(__APP_BUILD_META__.forceReload),
  environment: __APP_BUILD_META__.environment || __APP_BUILD_META__.context || "local",
  branch: __APP_BUILD_META__.branch || "",
  deployUrl: __APP_BUILD_META__.deployUrl || "",
  siteUrl: __APP_BUILD_META__.siteUrl || "",
};

const VersionUpdateContext = createContext<VersionUpdateContextValue | null>(null);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeMetadata(value: unknown): BuildMetadata | null {
  if (!isRecord(value)) return null;
  const buildVersion = String(value.buildVersion || value.gitSha || value.commit || "").trim();
  const gitSha = String(value.gitSha || value.commit || "").trim();
  const builtAt = String(value.builtAt || "").trim();
  const appVersion = String(value.appVersion || "").trim();
  const apiContractVersion = String(value.apiContractVersion || "").trim();
  if (!buildVersion || !gitSha || !builtAt || !appVersion || !apiContractVersion) return null;
  return {
    appId: String(value.appId || "shared"),
    appVersion,
    buildVersion,
    gitSha,
    deployId: String(value.deployId || ""),
    builtAt,
    apiContractVersion,
    minSupportedVersion: String(value.minSupportedVersion || ""),
    forceReload: value.forceReload === true,
    environment: String(value.environment || value.context || ""),
    branch: String(value.branch || ""),
    deployUrl: String(value.deployUrl || ""),
    siteUrl: String(value.siteUrl || ""),
  };
}

function compareVersions(deployed: BuildMetadata) {
  if (deployed.forceReload) return "force-reload";
  if (deployed.appId && localVersion.appId && deployed.appId !== localVersion.appId && deployed.appId !== "shared") {
    return "app-id-mismatch";
  }
  if (deployed.apiContractVersion !== localVersion.apiContractVersion) return "api-contract-mismatch";
  if (deployed.minSupportedVersion && deployed.minSupportedVersion !== localVersion.buildVersion && deployed.buildVersion !== localVersion.buildVersion) {
    return "min-supported-version-mismatch";
  }
  if (deployed.buildVersion !== localVersion.buildVersion) return "build-version-mismatch";
  if (deployed.gitSha && localVersion.gitSha && deployed.gitSha !== localVersion.gitSha) return "git-sha-mismatch";
  return "";
}

function readReloadMarker() {
  try {
    const raw = window.localStorage.getItem(RELOAD_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as { buildVersion?: string; at?: number }) : null;
  } catch {
    return null;
  }
}

function writeReloadMarker(buildVersion: string) {
  try {
    window.localStorage.setItem(RELOAD_STORAGE_KEY, JSON.stringify({ buildVersion, at: Date.now() }));
  } catch {
    // Best effort only.
  }
}

function shouldBlockReloadLoop(buildVersion: string) {
  const marker = readReloadMarker();
  return marker?.buildVersion === buildVersion && typeof marker.at === "number" && Date.now() - marker.at < RELOAD_LOOP_WINDOW_MS;
}

async function clearAppOwnedCaches() {
  if (typeof window === "undefined") return;
  if ("caches" in window) {
    try {
      const names = await window.caches.keys();
      await Promise.all(names.map((name) => window.caches.delete(name)));
    } catch {
      // Cache cleanup must not prevent the hard reload path.
    }
  }
  if ("serviceWorker" in navigator) {
    try {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map((registration) => registration.unregister().catch(() => undefined)));
    } catch {
      // Service worker cleanup is best-effort; stale PWA workers must not prevent reload.
    }
  }
}

function buildReloadUrl(targetVersion: string) {
  const nextUrl = new URL(window.location.href);
  nextUrl.searchParams.set("__nm_version", targetVersion);
  return nextUrl.toString();
}

function getFetchMethod(input: RequestInfo | URL, init?: RequestInit) {
  return String(init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
}

function getFetchUrl(input: RequestInfo | URL) {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function readJsonBodyValue(init: RequestInit | undefined, key: string) {
  const body = init?.body;
  if (typeof body !== "string") return undefined;
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    return parsed[key];
  } catch {
    return undefined;
  }
}

function isSensitiveRpcName(name: unknown) {
  const normalized = String(name || "");
  if (!normalized) return true;
  return SENSITIVE_APP_RPC_NAMES.has(normalized) || SENSITIVE_RPC_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function isSensitiveAppAdminAction(action: unknown) {
  const normalized = String(action || "");
  if (!normalized) return true;
  return SENSITIVE_APP_ADMIN_ACTIONS.has(normalized);
}

function isSensitiveSupabaseCall(url: URL) {
  const pathname = url.pathname;
  if (pathname.startsWith("/auth/v1/")) return false;
  if (pathname.includes("/rpc/")) {
    const rpcName = pathname.split("/rpc/")[1]?.split("/")[0] || "";
    return isSensitiveRpcName(rpcName);
  }
  return pathname.startsWith("/rest/v1/") || pathname.startsWith("/storage/v1/");
}

function shouldGateFetch(input: RequestInfo | URL, init?: RequestInit) {
  if (typeof window === "undefined") return false;
  const method = getFetchMethod(input, init);
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return false;
  const parsed = new URL(getFetchUrl(input), window.location.origin);
  if (parsed.pathname === VERSION_JSON_PATH) return false;
  if (parsed.hostname.endsWith(".supabase.co")) return isSensitiveSupabaseCall(parsed);
  if (parsed.origin !== window.location.origin) return false;
  if (parsed.pathname === "/api/app-rpc") {
    return isSensitiveRpcName(readJsonBodyValue(init, "name"));
  }
  if (parsed.pathname === "/api/app-admin-records") {
    return isSensitiveAppAdminAction(readJsonBodyValue(init, "action"));
  }
  return SENSITIVE_API_PATHS.has(parsed.pathname);
}

export function VersionUpdateProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const [decision, setDecision] = useState<VersionDecision | null>(null);
  const [reloading, setReloading] = useState(false);
  const decisionRef = useRef<VersionDecision | null>(null);
  const lastCheckAtRef = useRef(0);
  const checkInFlightRef = useRef<Promise<VersionDecision> | null>(null);
  const originalFetchRef = useRef<typeof window.fetch | null>(null);

  const setNextDecision = useCallback((nextDecision: VersionDecision) => {
    decisionRef.current = nextDecision;
    setDecision(nextDecision);
  }, []);

  const fetchDeployedVersion = useCallback(async () => {
    const fetchImpl = originalFetchRef.current || window.fetch.bind(window);
    const versionUrl = `${VERSION_JSON_PATH}?_=${Date.now()}`;
    const response = await fetchImpl(versionUrl, {
      cache: "no-store",
      headers: {
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
      },
    });
    if (!response.ok) throw new Error(`Version metadata failed: ${response.status}`);
    const metadata = normalizeMetadata(await response.json());
    if (!metadata) throw new Error("Version metadata shape is invalid");
    return metadata;
  }, []);

  const checkForUpdate = useCallback(
    async (reason = "manual", options?: { throttleMs?: number }) => {
      const throttleMs = options?.throttleMs ?? NORMAL_CHECK_THROTTLE_MS;
      const now = Date.now();
      if (throttleMs > 0 && decisionRef.current && now - lastCheckAtRef.current < throttleMs) {
        return decisionRef.current;
      }
      if (checkInFlightRef.current) return checkInFlightRef.current;

      const checkPromise = (async () => {
        try {
          const deployed = await fetchDeployedVersion();
          lastCheckAtRef.current = Date.now();
          const mismatchReason = compareVersions(deployed);
          const nextDecision: VersionDecision = mismatchReason
            ? { status: "stale", deployed, reason: mismatchReason, checkedAt: lastCheckAtRef.current }
            : { status: "current", deployed, reason, checkedAt: lastCheckAtRef.current };
          setNextDecision(nextDecision);
          return nextDecision;
        } catch (caught) {
          lastCheckAtRef.current = Date.now();
          const nextDecision: VersionDecision = {
            status: "check-failed",
            deployed: null,
            reason,
            checkedAt: lastCheckAtRef.current,
            error: caught instanceof Error ? caught.message : String(caught || "Version check failed"),
          };
          setNextDecision(nextDecision);
          return nextDecision;
        } finally {
          checkInFlightRef.current = null;
        }
      })();

      checkInFlightRef.current = checkPromise;
      return checkPromise;
    },
    [fetchDeployedVersion, setNextDecision],
  );

  const performHardReload = useCallback(
    async (deployed: BuildMetadata) => {
      if (shouldBlockReloadLoop(deployed.buildVersion)) {
        const blockedDecision: VersionDecision = {
          status: "reload-blocked",
          deployed,
          reason: "reload-loop-prevented",
          checkedAt: Date.now(),
        };
        setNextDecision(blockedDecision);
        return;
      }

      setReloading(true);
      writeReloadMarker(deployed.buildVersion);
      await clearAppOwnedCaches();
      window.location.replace(buildReloadUrl(deployed.buildVersion));
    },
    [setNextDecision],
  );

  const requireFreshClient = useCallback(
    async (reason = "critical-action") => {
      const currentDecision = await checkForUpdate(reason, { throttleMs: CRITICAL_CHECK_THROTTLE_MS });
      if (currentDecision.status === "stale") {
        await performHardReload(currentDecision.deployed);
        throw new Error(t("common.updateRequiredForAction"));
      }
      if (currentDecision.status === "reload-blocked") {
        throw new Error(t("common.updateReloadLoopBlocked"));
      }
    },
    [checkForUpdate, performHardReload, t],
  );

  const reloadNow = useCallback(async () => {
    const currentDecision = decisionRef.current?.status === "stale" || decisionRef.current?.status === "reload-blocked"
      ? decisionRef.current
      : await checkForUpdate("manual-reload", { throttleMs: 0 });
    if (currentDecision.status === "stale" || currentDecision.status === "reload-blocked") {
      await performHardReload(currentDecision.deployed);
      return;
    }
    window.location.reload();
  }, [checkForUpdate, performHardReload]);

  useEffect(() => {
    void checkForUpdate("startup", { throttleMs: 0 });

    const handleFocus = () => {
      void checkForUpdate("focus");
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void checkForUpdate("visibility");
      }
    };
    const handlePageShow = (event: PageTransitionEvent) => {
      if (event.persisted) {
        void checkForUpdate("bfcache", { throttleMs: 0 });
      }
    };
    const intervalId = window.setInterval(() => {
      void checkForUpdate("interval");
    }, CHECK_INTERVAL_MS);

    window.addEventListener("focus", handleFocus);
    window.addEventListener("pageshow", handlePageShow);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("focus", handleFocus);
      window.removeEventListener("pageshow", handlePageShow);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [checkForUpdate]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const originalFetch = window.fetch.bind(window);
    originalFetchRef.current = originalFetch;
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      if (shouldGateFetch(input, init)) {
        await requireFreshClient("critical-fetch");
      }
      return originalFetch(input, init);
    };

    return () => {
      window.fetch = originalFetch;
      if (originalFetchRef.current === originalFetch) {
        originalFetchRef.current = null;
      }
    };
  }, [requireFreshClient]);

  const value = useMemo<VersionUpdateContextValue>(
    () => ({
      localVersion,
      decision,
      checkForUpdate: (reason?: string) => checkForUpdate(reason, { throttleMs: 0 }),
      requireFreshClient,
      reloadNow,
    }),
    [checkForUpdate, decision, reloadNow, requireFreshClient],
  );

  const showStaleBanner = decision?.status === "stale" || decision?.status === "reload-blocked";
  const showCheckWarning = decision?.status === "check-failed";
  const deployed = showStaleBanner ? decision.deployed : null;
  const localShort = localVersion.gitSha.slice(0, 8);
  const deployedShort = deployed?.gitSha.slice(0, 8) || "";

  return (
    <VersionUpdateContext.Provider value={value}>
      {children}
      {showStaleBanner ? (
        <div className="version-update-banner" role="alert">
          <div className="version-update-banner__body">
            <strong>{decision.status === "reload-blocked" ? t("common.updateReloadBlockedTitle") : t("common.updateAvailableTitle")}</strong>
            <span>
              {decision.status === "reload-blocked"
                ? t("common.updateReloadBlockedBody")
                : t("common.updateAvailableBody", { current: localShort, latest: deployedShort })}
            </span>
          </div>
          <button type="button" className="version-update-banner__button" onClick={() => void reloadNow()} disabled={reloading}>
            {reloading ? t("common.reloading") : t("common.reloadNow")}
          </button>
        </div>
      ) : null}
      {showCheckWarning ? (
        <div className="version-update-banner version-update-banner--muted" role="status">
          <div className="version-update-banner__body">
            <strong>{t("common.versionCheckFailedTitle")}</strong>
            <span>{t("common.versionCheckFailedBody")}</span>
          </div>
          <button type="button" className="version-update-banner__button" onClick={() => void checkForUpdate("manual", { throttleMs: 0 })}>
            {t("common.retry")}
          </button>
        </div>
      ) : null}
    </VersionUpdateContext.Provider>
  );
}

export function useVersionUpdate() {
  const context = useContext(VersionUpdateContext);
  if (!context) throw new Error("useVersionUpdate must be used inside VersionUpdateProvider");
  return context;
}
