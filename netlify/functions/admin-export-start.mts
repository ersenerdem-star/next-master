import type { Config, Context } from "@netlify/functions";
import { getAppAuthStatus, resolveCaller } from "./_shared/app-auth.mts";
import { canAccessOperationsModules } from "./_shared/roles.mts";
import {
  exportJson,
  runAdminPriceListExportJob,
  startAdminPriceListExport,
  startCatalogExport,
  startCatalogMasterExport,
  startSupplierPriceListExport,
  toPublicExportJobStatus,
} from "./_shared/export-jobs.mts";
import { sanitizeUserFacingError } from "./_shared/user-message.mts";
import { dispatchV3PriceExportWorker, isProductionExportPaused, isV3ExportBridgeEnabled } from "./_shared/v3-export-dispatch.mts";
import { dispatchAdminExportWorker } from "./_shared/admin-export-worker.mts";

export default async (req: Request, context: Context) => {
  if (req.method !== "POST") return exportJson({ error: "Method not allowed" }, 405);
  const supabaseUrl = Netlify.env.get("SUPABASE_URL");
  const supabaseAnonKey = Netlify.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Netlify.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !supabaseAnonKey || !serviceRoleKey) {
    return exportJson({ error: "System configuration is incomplete." }, 500);
  }

  try {
    const caller = await resolveCaller(req, supabaseUrl, supabaseAnonKey, serviceRoleKey);
    if (!canAccessOperationsModules(caller.role, caller.department, caller.permissions)) {
      return exportJson({ error: "This export is not enabled for your user." }, 403);
    }
    const body = await req.json().catch(() => ({}));
    const exportType = String(body?.exportType || "").trim();
    if (exportType !== "admin_price_list" && exportType !== "catalog_export" && exportType !== "catalog_master" && exportType !== "supplier_price_list") {
      return exportJson({ error: "Unsupported export type." }, 400);
    }
    if (exportType === "admin_price_list" && isV3ExportBridgeEnabled() && isProductionExportPaused()) {
      return exportJson({ error: "V3 export bridge is temporarily paused while the production safety gate is closed." }, 503, { "Retry-After": "300" });
    }
    const { job, cached } = exportType === "supplier_price_list"
      ? await startSupplierPriceListExport(supabaseUrl, serviceRoleKey, caller, {
          supplierId: String(body?.supplierId || ""),
          brandName: String(body?.brandName || ""),
          search: body?.search == null ? "" : String(body.search),
          freshness: body?.freshness == null ? "all" : String(body.freshness),
          format: "csv",
        })
      : exportType === "catalog_master"
      ? await startCatalogMasterExport(supabaseUrl, serviceRoleKey, caller, {
          brandId: String(body?.brandId || ""),
          brandName: String(body?.brandName || ""),
          search: body?.search == null ? "" : String(body.search),
          scope: String(body?.scope || "priced") === "catalog" ? "catalog" : "priced",
          marginA: Number(body?.marginA ?? 0.1),
          marginB: Number(body?.marginB ?? 0.15),
        })
      : exportType === "catalog_export"
        ? await startCatalogExport(supabaseUrl, serviceRoleKey, caller, {
            brandId: String(body?.brandId || ""),
            brandName: String(body?.brandName || ""),
            marketSegment: body?.marketSegment == null ? "" : String(body.marketSegment),
            format: String(body?.format || "csv") === "xlsx" ? "xlsx" : "csv",
          })
        : await startAdminPriceListExport(supabaseUrl, serviceRoleKey, caller, {
            brandId: String(body?.brandId || ""),
            brandName: String(body?.brandName || ""),
            priceListType: String(body?.priceListType || "A").toUpperCase() === "B" ? "B" : "A",
            marginPercent: Number(body?.marginPercent || 0),
          });

    if (job.status === "queued") {
      context.waitUntil(
        (isV3ExportBridgeEnabled() && exportType === "admin_price_list"
          ? dispatchV3PriceExportWorker(req, job.id)
          : exportType === "catalog_master" || exportType === "catalog_export" || exportType === "supplier_price_list"
          ? dispatchAdminExportWorker(req, job.id)
          : runAdminPriceListExportJob(supabaseUrl, serviceRoleKey, job.id)
        ).catch((error) => {
          console.error("admin export job failed", job.id, error);
        }),
      );
    }

    return exportJson({ ok: true, job: toPublicExportJobStatus(job, cached) });
  } catch (error) {
    const status = getAppAuthStatus(error) || 500;
    return exportJson({ error: sanitizeUserFacingError(error, "Export could not be started.") }, status);
  }
};

export const config: Config = {
  path: "/api/admin-export-start",
};
