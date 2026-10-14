const STAGING_TARGET = "kaxsqafdevabkxofwdod";
const PRODUCTION_TARGET = "zjgueqijumzlfioihnkt";
const PRODUCTION_PORTAL_ORIGIN = "https://portal.next-master.com";
const PRODUCTION_HISTORY_DATABASE = "nm_catalog_production_history";

function exactSupabaseOrigin(value, projectRef) {
  try {
    const url = new URL(String(value || ""));
    return url.origin === `https://${projectRef}.supabase.co`
      && url.pathname === "/" && !url.search && !url.hash
      && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function requireCatalogWorkerTarget(env = process.env) {
  if (!env.SUPABASE_URL) throw new Error("CATALOG_SUPABASE_URL_REQUIRED");
  const stagingTarget = String(env.NM_FULL_STAGING_TARGET || "");
  const productionTarget = String(env.NM_PRODUCTION_TARGET || "");
  let environment;
  if (stagingTarget === STAGING_TARGET && !productionTarget
    && exactSupabaseOrigin(env.SUPABASE_URL, STAGING_TARGET)) {
    environment = "staging";
  } else if (productionTarget === PRODUCTION_TARGET && !stagingTarget
    && env.NM_PRODUCTION_PORTAL_ORIGIN === PRODUCTION_PORTAL_ORIGIN
    && exactSupabaseOrigin(env.SUPABASE_URL, PRODUCTION_TARGET)) {
    if (env.CATALOG_IMPORT_SERVICE_ENABLED !== "1"
      || env.CATALOG_STORAGE_IMPORT_PRODUCTION_ENABLED !== "1") {
      throw new Error("CATALOG_PRODUCTION_IMPORT_NOT_ENABLED");
    }
    environment = "production";
  } else {
    throw new Error("CATALOG_IMPORT_TARGET_MISMATCH");
  }
  if (!env.SUPABASE_SERVICE_ROLE_KEY) throw new Error("CATALOG_SUPABASE_SERVICE_ROLE_REQUIRED");
  if (!env.DBOS_SYSTEM_DATABASE_URL) throw new Error("CATALOG_DBOS_SYSTEM_DATABASE_REQUIRED");
  if (environment === "production") {
    let historyUrl;
    try { historyUrl = new URL(env.DBOS_SYSTEM_DATABASE_URL); } catch {
      throw new Error("CATALOG_PRODUCTION_HISTORY_REQUIRED");
    }
    if (!["postgres:", "postgresql:"].includes(historyUrl.protocol)
      || historyUrl.pathname !== `/${PRODUCTION_HISTORY_DATABASE}`
      || env.CATALOG_IMPORT_SERVICE_HISTORY_CONFIRMED !== "1") {
      throw new Error("CATALOG_PRODUCTION_HISTORY_REQUIRED");
    }
  }
  return environment;
}
