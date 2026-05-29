import type { Config, Context } from "@netlify/functions";
import { buildRestUrl, getJson, json, readJson, sendJson, serviceRoleHeaders } from "./_shared/http.mts";
import { resolveCaller } from "./_shared/app-auth.mts";
import { canAccessOperationsModules } from "./_shared/roles.mts";
import { sanitizeUserFacingError } from "./_shared/user-message.mts";

type WarehouseRow = {
  id?: string | null;
  organization_id?: string | null;
  warehouse_code?: string | null;
  warehouse_name?: string | null;
  warehouse_kind?: string | null;
  fulfillment_model?: string | null;
  outsource_partner_name?: string | null;
  external_sync_enabled?: boolean | null;
  external_api_provider?: string | null;
  external_api_url?: string | null;
  external_location_code?: string | null;
  external_auth_type?: string | null;
  external_api_token_env?: string | null;
  external_last_sync_at?: string | null;
  external_last_sync_status?: string | null;
  external_last_sync_message?: string | null;
};

type InventoryMovementRow = {
  product_code?: string | null;
  old_code?: string | null;
  brand?: string | null;
  description?: string | null;
  origin?: string | null;
  qty_in?: number | string | null;
  qty_out?: number | string | null;
  unit_cost?: number | string | null;
};

type ExternalStockItem = {
  brand: string;
  product_code: string;
  old_code: string;
  description: string;
  origin: string;
  qty_on_hand: number;
  unit_cost: number;
};

type CurrentStockState = {
  brand: string;
  product_code: string;
  old_code: string;
  description: string;
  origin: string;
  qty_on_hand: number;
  unit_cost: number;
};

type SyncRunSummary = {
  fetchedItemCount: number;
  acceptedItemCount: number;
  adjustmentCount: number;
  zeroedItemCount: number;
  invalidItemCount: number;
};

const WAREHOUSE_SELECT = [
  "id",
  "organization_id",
  "warehouse_code",
  "warehouse_name",
  "warehouse_kind",
  "fulfillment_model",
  "outsource_partner_name",
  "external_sync_enabled",
  "external_api_provider",
  "external_api_url",
  "external_location_code",
  "external_auth_type",
  "external_api_token_env",
  "external_last_sync_at",
  "external_last_sync_status",
  "external_last_sync_message",
].join(",");

function normalizeText(value: unknown) {
  return String(value || "").trim();
}

function normalizeCode(value: unknown) {
  return normalizeText(value).toUpperCase();
}

function toNumber(value: unknown) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const normalized = String(value || "").replace(",", ".").trim();
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function stockKey(input: { brand?: unknown; product_code?: unknown; old_code?: unknown }) {
  return `${normalizeCode(input.brand)}::${normalizeCode(input.product_code)}::${normalizeCode(input.old_code)}`;
}

function pickFirst(row: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = row[key];
    if (value != null && String(value).trim()) return value;
  }
  return "";
}

function pickFirstNumber(row: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = toNumber(row[key]);
    if (value || value === 0) return value;
  }
  return 0;
}

function extractExternalRows(payload: unknown) {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === "object") {
    const container = payload as Record<string, unknown>;
    const candidates = ["items", "data", "rows", "stock", "results"];
    for (const key of candidates) {
      if (Array.isArray(container[key])) return container[key] as unknown[];
    }
  }
  return [];
}

function parseExternalStockItems(payload: unknown) {
  const rawRows = extractExternalRows(payload);
  const invalidRows: Array<{ index: number; reason: string }> = [];
  const aggregated = new Map<string, ExternalStockItem>();

  rawRows.forEach((entry, index) => {
    if (!entry || typeof entry !== "object") {
      invalidRows.push({ index, reason: "Row is not an object" });
      return;
    }
    const row = entry as Record<string, unknown>;
    const brand = normalizeText(pickFirst(row, ["brand", "brand_name", "manufacturer"]));
    const productCode = normalizeText(pickFirst(row, ["product_code", "code", "sku", "item_code", "part_no"]));
    const qtyOnHand = pickFirstNumber(row, ["qty_on_hand", "on_hand_qty", "qty", "quantity", "stock", "available_qty"]);
    if (!brand || !productCode) {
      invalidRows.push({ index, reason: "Brand or product code missing" });
      return;
    }
    if (!Number.isFinite(qtyOnHand) || qtyOnHand < 0) {
      invalidRows.push({ index, reason: "Quantity is invalid" });
      return;
    }

    const item: ExternalStockItem = {
      brand,
      product_code: productCode,
      old_code: normalizeText(pickFirst(row, ["old_code", "reference_code", "legacy_code"])),
      description: normalizeText(pickFirst(row, ["description", "name", "product_name"])),
      origin: normalizeText(pickFirst(row, ["origin", "country_of_origin"])),
      qty_on_hand: qtyOnHand,
      unit_cost: pickFirstNumber(row, ["unit_cost", "cost", "average_cost"]),
    };
    const key = stockKey(item);
    const current = aggregated.get(key);
    if (current) {
      current.qty_on_hand += item.qty_on_hand;
      if (!current.description && item.description) current.description = item.description;
      if (!current.origin && item.origin) current.origin = item.origin;
      if (!current.old_code && item.old_code) current.old_code = item.old_code;
      if (!current.unit_cost && item.unit_cost) current.unit_cost = item.unit_cost;
      return;
    }
    aggregated.set(key, item);
  });

  return {
    fetchedItemCount: rawRows.length,
    invalidRows,
    items: [...aggregated.values()],
  };
}

async function fetchWarehouse(
  supabaseUrl: string,
  serviceRoleKey: string,
  organizationId: string,
  warehouseId: string,
) {
  const rows = await getJson<WarehouseRow[]>(
    buildRestUrl(supabaseUrl, "warehouses", {
      select: WAREHOUSE_SELECT,
      organization_id: `eq.${organizationId}`,
      id: `eq.${warehouseId}`,
      limit: "1",
    }),
    {
      headers: serviceRoleHeaders(serviceRoleKey),
    },
  );
  return rows[0] || null;
}

async function createSyncRun(
  supabaseUrl: string,
  serviceRoleKey: string,
  warehouse: WarehouseRow,
  requestUrl: string,
) {
  const payload = {
    organization_id: warehouse.organization_id,
    warehouse_id: warehouse.id,
    warehouse_code: warehouse.warehouse_code || "",
    warehouse_name: warehouse.warehouse_name || "",
    outsource_partner_name: warehouse.outsource_partner_name || "",
    external_api_provider: warehouse.external_api_provider || "",
    request_url: requestUrl,
    status: "started",
    message: "External warehouse sync started.",
    started_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const rows = await sendJson<Array<{ id?: string | null }>>(
    `${supabaseUrl}/rest/v1/warehouse_external_sync_runs`,
    {
      method: "POST",
      headers: {
        ...serviceRoleHeaders(serviceRoleKey),
        Prefer: "return=representation",
      },
      body: JSON.stringify(payload),
    },
  );
  return String(rows?.[0]?.id || "");
}

async function finalizeSyncRun(
  supabaseUrl: string,
  serviceRoleKey: string,
  runId: string,
  status: "success" | "failed",
  summary: Partial<SyncRunSummary>,
  message: string,
) {
  if (!runId) return;
  await sendJson<unknown>(
    `${supabaseUrl}/rest/v1/warehouse_external_sync_runs?id=eq.${encodeURIComponent(runId)}`,
    {
      method: "PATCH",
      headers: {
        ...serviceRoleHeaders(serviceRoleKey),
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        status,
        fetched_item_count: summary.fetchedItemCount || 0,
        accepted_item_count: summary.acceptedItemCount || 0,
        adjustment_count: summary.adjustmentCount || 0,
        zeroed_item_count: summary.zeroedItemCount || 0,
        invalid_item_count: summary.invalidItemCount || 0,
        message,
        summary,
        finished_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }),
    },
  );
}

async function updateWarehouseSyncState(
  supabaseUrl: string,
  serviceRoleKey: string,
  warehouseId: string,
  status: "success" | "failed",
  message: string,
) {
  await sendJson<unknown>(
    `${supabaseUrl}/rest/v1/warehouses?id=eq.${encodeURIComponent(warehouseId)}`,
    {
      method: "PATCH",
      headers: {
        ...serviceRoleHeaders(serviceRoleKey),
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        external_last_sync_at: new Date().toISOString(),
        external_last_sync_status: status,
        external_last_sync_message: message,
        updated_at: new Date().toISOString(),
      }),
    },
  );
}

function compileExternalApiUrl(template: string, warehouse: WarehouseRow) {
  const replacements: Record<string, string> = {
    location_code: encodeURIComponent(normalizeText(warehouse.external_location_code)),
    warehouse_code: encodeURIComponent(normalizeText(warehouse.warehouse_code)),
    warehouse_name: encodeURIComponent(normalizeText(warehouse.warehouse_name)),
    partner_name: encodeURIComponent(normalizeText(warehouse.outsource_partner_name)),
  };
  return normalizeText(template).replace(/\{\{\s*(location_code|warehouse_code|warehouse_name|partner_name)\s*\}\}/gi, (_, key: string) => replacements[key.toLowerCase()] || "");
}

async function fetchCurrentStockState(
  supabaseUrl: string,
  serviceRoleKey: string,
  organizationId: string,
  warehouseId: string,
) {
  const rows: InventoryMovementRow[] = [];
  const pageSize = 1000;
  let offset = 0;

  while (true) {
    const page = await getJson<InventoryMovementRow[]>(
      buildRestUrl(supabaseUrl, "inventory_movements", {
        select: "product_code,old_code,brand,description,origin,qty_in,qty_out,unit_cost",
        organization_id: `eq.${organizationId}`,
        warehouse_id: `eq.${warehouseId}`,
        order: "moved_at.asc",
        limit: String(pageSize),
        offset: String(offset),
      }),
      {
        headers: serviceRoleHeaders(serviceRoleKey),
      },
    );
    rows.push(...page);
    if (page.length < pageSize) break;
    offset += pageSize;
  }

  const byKey = new Map<string, CurrentStockState>();
  for (const row of rows) {
    const key = stockKey({
      brand: row.brand,
      product_code: row.product_code,
      old_code: row.old_code,
    });
    const current = byKey.get(key) || {
      brand: normalizeText(row.brand),
      product_code: normalizeText(row.product_code),
      old_code: normalizeText(row.old_code),
      description: normalizeText(row.description),
      origin: normalizeText(row.origin),
      qty_on_hand: 0,
      unit_cost: 0,
    };
    current.qty_on_hand += toNumber(row.qty_in) - toNumber(row.qty_out);
    if (!current.description && row.description) current.description = normalizeText(row.description);
    if (!current.origin && row.origin) current.origin = normalizeText(row.origin);
    if (toNumber(row.unit_cost) > 0) current.unit_cost = toNumber(row.unit_cost);
    byKey.set(key, current);
  }
  return byKey;
}

async function insertAdjustmentMovements(
  supabaseUrl: string,
  serviceRoleKey: string,
  organizationId: string,
  warehouse: WarehouseRow,
  runId: string,
  desiredItems: ExternalStockItem[],
  currentStock: Map<string, CurrentStockState>,
) {
  const desiredByKey = new Map<string, ExternalStockItem>();
  desiredItems.forEach((item) => desiredByKey.set(stockKey(item), item));

  const allKeys = new Set<string>([...desiredByKey.keys(), ...currentStock.keys()]);
  const documentNo = `SYNC-${normalizeText(warehouse.warehouse_code) || "WH"}-${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "")}`;
  const movementPayload: Array<Record<string, unknown>> = [];
  let zeroedItemCount = 0;

  for (const key of allKeys) {
    const desired = desiredByKey.get(key);
    const current = currentStock.get(key);
    const desiredQty = desired?.qty_on_hand || 0;
    const currentQty = current?.qty_on_hand || 0;
    const delta = desiredQty - currentQty;
    if (Math.abs(delta) < 0.0001) continue;
    if (!desired && currentQty > 0) zeroedItemCount += 1;

    const unitCost = desired?.unit_cost || current?.unit_cost || 0;
    const metadata = desired || current;
    movementPayload.push({
      organization_id: organizationId,
      warehouse_id: warehouse.id,
      warehouse_code: warehouse.warehouse_code || "",
      warehouse_name: warehouse.warehouse_name || "",
      movement_type: "adjustment",
      document_type: "warehouse_api_sync",
      document_id: runId,
      document_no: documentNo,
      related_party: warehouse.outsource_partner_name || warehouse.external_api_provider || "External Warehouse API",
      product_code: metadata?.product_code || "",
      old_code: metadata?.old_code || "",
      brand: metadata?.brand || "",
      description: metadata?.description || "",
      qty_in: delta > 0 ? delta : 0,
      qty_out: delta < 0 ? Math.abs(delta) : 0,
      unit_cost: unitCost,
      total_cost: Math.abs(delta) * unitCost,
      origin: metadata?.origin || "",
      notes: `External API stock sync ${runId}`,
      moved_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  }

  if (movementPayload.length) {
    await sendJson<unknown>(`${supabaseUrl}/rest/v1/inventory_movements`, {
      method: "POST",
      headers: {
        ...serviceRoleHeaders(serviceRoleKey),
        Prefer: "return=minimal",
      },
      body: JSON.stringify(movementPayload),
    });
  }

  return {
    adjustmentCount: movementPayload.length,
    zeroedItemCount,
  };
}

async function refetchWarehouse(
  supabaseUrl: string,
  serviceRoleKey: string,
  organizationId: string,
  warehouseId: string,
) {
  return await fetchWarehouse(supabaseUrl, serviceRoleKey, organizationId, warehouseId);
}

export default async (req: Request, _context: Context) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const supabaseUrl = Netlify.env.get("SUPABASE_URL");
  const supabaseAnonKey = Netlify.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Netlify.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !supabaseAnonKey || !serviceRoleKey) {
    return json({ error: "System configuration is incomplete." }, 500);
  }

  let runId = "";
  let warehouse: WarehouseRow | null = null;

  try {
    const caller = await resolveCaller(req, supabaseUrl, supabaseAnonKey, serviceRoleKey);
    if (!canAccessOperationsModules(caller.role)) {
      return json({ error: "This operation area is not enabled for your user. Ask superadmin to open purchase or warehouse permissions if needed." }, 403);
    }

    const body = await readJson<{ warehouseId?: string }>(req);
    const warehouseId = normalizeText(body?.warehouseId);
    if (!warehouseId) {
      return json({ error: "Select a warehouse first." }, 400);
    }

    warehouse = await fetchWarehouse(supabaseUrl, serviceRoleKey, caller.organizationId, warehouseId);
    if (!warehouse?.id) {
      return json({ error: "Warehouse was not found." }, 404);
    }
    if (normalizeText(warehouse.warehouse_kind) !== "outsourced") {
      return json({ error: "This warehouse is not configured as outsourced." }, 400);
    }
    if (normalizeText(warehouse.fulfillment_model) === "dropship") {
      return json({ error: "Dropship warehouses do not keep stock snapshots. API stock sync is disabled for this warehouse." }, 400);
    }
    if (!warehouse.external_sync_enabled) {
      return json({ error: "External sync is not enabled for this warehouse." }, 400);
    }
    const rawUrl = compileExternalApiUrl(String(warehouse.external_api_url || ""), warehouse);
    if (!rawUrl) {
      return json({ error: "External API URL is missing on this warehouse." }, 400);
    }

    runId = await createSyncRun(supabaseUrl, serviceRoleKey, warehouse, rawUrl);

    const headers: Record<string, string> = {
      Accept: "application/json",
      "X-Location-Code": normalizeText(warehouse.external_location_code),
      "X-Warehouse-Code": normalizeText(warehouse.warehouse_code),
    };
    if (normalizeText(warehouse.external_auth_type) === "bearer_env") {
      const envKey = normalizeText(warehouse.external_api_token_env);
      if (!envKey) {
        throw new Error("External API token env name is missing.");
      }
      const token = Netlify.env.get(envKey);
      if (!token) {
        throw new Error(`External API token env ${envKey} is not configured.`);
      }
      headers.Authorization = `Bearer ${token}`;
    }

    const externalResponse = await fetch(rawUrl, { headers });
    const externalPayload = await readJson<unknown>(externalResponse);
    if (!externalResponse.ok) {
      const message =
        (typeof externalPayload === "object" && externalPayload && "error" in (externalPayload as Record<string, unknown>)
          ? String((externalPayload as Record<string, unknown>).error || "")
          : "") || `External warehouse API request failed: ${externalResponse.status}`;
      throw new Error(message);
    }

    const parsed = parseExternalStockItems(externalPayload);
    const currentStock = await fetchCurrentStockState(supabaseUrl, serviceRoleKey, caller.organizationId, warehouseId);
    const adjustments = await insertAdjustmentMovements(
      supabaseUrl,
      serviceRoleKey,
      caller.organizationId,
      warehouse,
      runId,
      parsed.items,
      currentStock,
    );

    const summary: SyncRunSummary = {
      fetchedItemCount: parsed.fetchedItemCount,
      acceptedItemCount: parsed.items.length,
      adjustmentCount: adjustments.adjustmentCount,
      zeroedItemCount: adjustments.zeroedItemCount,
      invalidItemCount: parsed.invalidRows.length,
    };
    const message = `External warehouse sync completed. ${summary.adjustmentCount} adjustment movement(s) posted.`;
    await finalizeSyncRun(supabaseUrl, serviceRoleKey, runId, "success", summary, message);
    await updateWarehouseSyncState(supabaseUrl, serviceRoleKey, warehouseId, "success", message);
    const refreshedWarehouse = await refetchWarehouse(supabaseUrl, serviceRoleKey, caller.organizationId, warehouseId);

    return json({
      ok: true,
      warehouse: refreshedWarehouse,
      summary,
    });
  } catch (error) {
    const message = sanitizeUserFacingError(error, "Warehouse API sync failed");
    if (runId) {
      await finalizeSyncRun(
        supabaseUrl as string,
        serviceRoleKey as string,
        runId,
        "failed",
        {
          fetchedItemCount: 0,
          acceptedItemCount: 0,
          adjustmentCount: 0,
          zeroedItemCount: 0,
          invalidItemCount: 0,
        },
        message,
      ).catch(() => undefined);
    }
    if (warehouse?.id) {
      await updateWarehouseSyncState(
        supabaseUrl as string,
        serviceRoleKey as string,
        String(warehouse.id),
        "failed",
        message,
      ).catch(() => undefined);
    }
    return json({ error: message }, 400);
  }
};

export const config: Config = {
  path: "/api/admin-sync-warehouse-stock",
  method: "POST",
};
