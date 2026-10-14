const STAGING_TARGET = "kaxsqafdevabkxofwdod";
const PRODUCTION_TARGET = "zjgueqijumzlfioihnkt";
const PRODUCTION_PORTAL_ORIGIN = "https://portal.next-master.com";

export type CatalogImportTargetConfig = {
  supabaseUrl: string;
  storageImportEnabled: string | undefined;
  stagingTarget: string | undefined;
  productionTarget: string | undefined;
  productionPortalOrigin: string | undefined;
  productionImportEnabled: string | undefined;
  requestUrl: string;
};

function exactSupabaseOrigin(value: string, projectRef: string) {
  try {
    const url = new URL(value);
    return url.origin === `https://${projectRef}.supabase.co`
      && url.pathname === "/" && !url.search && !url.hash
      && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function catalogStorageImportTargetEnabled(config: CatalogImportTargetConfig): boolean {
  if (config.storageImportEnabled !== "1") return false;
  if (config.stagingTarget === STAGING_TARGET && !config.productionTarget) {
    return exactSupabaseOrigin(config.supabaseUrl, STAGING_TARGET);
  }
  if (config.productionTarget !== PRODUCTION_TARGET || config.stagingTarget
    || config.productionImportEnabled !== "1"
    || config.productionPortalOrigin !== PRODUCTION_PORTAL_ORIGIN
    || !exactSupabaseOrigin(config.supabaseUrl, PRODUCTION_TARGET)) return false;
  try {
    return new URL(config.requestUrl).origin === PRODUCTION_PORTAL_ORIGIN;
  } catch {
    return false;
  }
}
