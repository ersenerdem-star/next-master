type CatalogImportBrowserTarget = {
  enabled: string | undefined;
  productionEnabled: string | undefined;
  productionTarget: string | undefined;
  supabaseUrl: string | undefined;
  browserOrigin: string | undefined;
};

function exactSupabaseOrigin(value: string | undefined, projectRef: string) {
  try {
    const url = new URL(value || "");
    return url.origin === `https://${projectRef}.supabase.co`
      && url.pathname === "/" && !url.search && !url.hash
      && !url.username && !url.password;
  } catch {
    return false;
  }
}

// This controls which UI is offered. The authenticated app gateway separately
// checks its own Supabase target and production opt-in before any Storage RPC.
export function catalogStorageImportBrowserEnabled(config: CatalogImportBrowserTarget): boolean {
  if (config.enabled !== "1") return false;
  if (config.browserOrigin === "https://next-master-v3-staging-20261006.netlify.app"
    && !config.productionTarget) {
    return exactSupabaseOrigin(config.supabaseUrl, "kaxsqafdevabkxofwdod");
  }
  return config.browserOrigin === "https://portal.next-master.com"
    && config.productionEnabled === "1"
    && config.productionTarget === "zjgueqijumzlfioihnkt"
    && exactSupabaseOrigin(config.supabaseUrl, "zjgueqijumzlfioihnkt");
}
