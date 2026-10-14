import { PROD_REF, V3_REF } from "./v3-export-dispatch.mts";

export function isRemainingAdminExportType(type: string) {
  return ["catalog_export", "catalog_master", "supplier_price_list"].includes(type);
}

export function remainingAdminExportsEnabled(read: (name: string) => string | undefined = name => Netlify.env.get(name)) {
  const url = read("SUPABASE_URL");
  if (url === `https://${V3_REF}.supabase.co`) return !read("NM_PRODUCTION_TARGET")
    && (!read("NM_FULL_STAGING_TARGET") || read("NM_FULL_STAGING_TARGET") === V3_REF);
  return url === `https://${PROD_REF}.supabase.co`
    && read("NM_PRODUCTION_TARGET") === PROD_REF
    && !read("NM_FULL_STAGING_TARGET")
    && read("NM_PRODUCTION_ADMIN_EXPORT_ENABLED") === "1"
    && read("NM_PRODUCTION_EXPORT_PAUSED") === "0";
}

export const remainingAdminExportPauseMessage = "Admin exports are temporarily paused for this environment.";

export function assertRemainingAdminExportsEnabled() {
  if (!remainingAdminExportsEnabled()) throw new Error(remainingAdminExportPauseMessage);
}
