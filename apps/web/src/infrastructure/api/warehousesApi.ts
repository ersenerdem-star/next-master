import type { Warehouse, WarehouseApiClient, WarehouseApiClientSecret } from "../../types/warehouses";
import { supabaseClient } from "./supabaseClient";
import { getCurrentOrgId, isUuid } from "./organizationApi";

const syncWarehouseStockUrl = import.meta.env.VITE_ADMIN_SYNC_WAREHOUSE_STOCK_URL || "/api/admin-sync-warehouse-stock";
const warehouseApiClientsUrl = import.meta.env.VITE_ADMIN_WAREHOUSE_API_CLIENTS_URL || "/api/admin-warehouse-stock-clients";

const WAREHOUSE_BASE_COLUMNS = [
  "id",
  "warehouse_code",
  "warehouse_name",
  "region",
  "address",
  "is_active",
  "created_at",
  "updated_at",
].join(",");

const WAREHOUSE_EXTENDED_COLUMNS = [
  WAREHOUSE_BASE_COLUMNS,
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

let warehousesCacheOrgId = "";
let warehousesCacheValue: Warehouse[] | null = null;
let warehousesCachePromise: Promise<Warehouse[]> | null = null;

function clearWarehousesCache() {
  warehousesCacheValue = null;
  warehousesCachePromise = null;
}

function isMissingColumnError(message: string) {
  const normalized = String(message || "").toLowerCase();
  return normalized.includes("column") && (normalized.includes("does not exist") || normalized.includes("could not find"));
}

function mapWarehouseRow(row: Record<string, unknown>): Warehouse {
  return {
    id: String(row.id || ""),
    warehouse_code: String(row.warehouse_code || ""),
    warehouse_name: String(row.warehouse_name || ""),
    region: String(row.region || ""),
    address: String(row.address || ""),
    warehouse_kind: String(row.warehouse_kind || "internal").trim().toLowerCase() === "outsourced" ? "outsourced" : "internal",
    fulfillment_model: String(row.fulfillment_model || "stocked").trim().toLowerCase() === "dropship" ? "dropship" : "stocked",
    outsource_partner_name: String(row.outsource_partner_name || ""),
    external_sync_enabled: Boolean(row.external_sync_enabled),
    external_api_provider: String(row.external_api_provider || ""),
    external_api_url: String(row.external_api_url || ""),
    external_location_code: String(row.external_location_code || ""),
    external_auth_type: String(row.external_auth_type || "none").trim().toLowerCase() === "bearer_env" ? "bearer_env" : "none",
    external_api_token_env: String(row.external_api_token_env || ""),
    external_last_sync_at: String(row.external_last_sync_at || ""),
    external_last_sync_status: String(row.external_last_sync_status || ""),
    external_last_sync_message: String(row.external_last_sync_message || ""),
    is_active: Boolean(row.is_active),
    created_at: String(row.created_at || ""),
    updated_at: String(row.updated_at || ""),
  };
}

function mapWarehousePayload(input: Warehouse, organizationId: string) {
  return {
    organization_id: organizationId,
    warehouse_code: input.warehouse_code.trim(),
    warehouse_name: input.warehouse_name.trim(),
    region: input.region.trim(),
    address: input.address.trim(),
    warehouse_kind: input.warehouse_kind,
    fulfillment_model: input.fulfillment_model,
    outsource_partner_name: input.outsource_partner_name.trim(),
    external_sync_enabled: input.external_sync_enabled,
    external_api_provider: input.external_api_provider.trim(),
    external_api_url: input.external_api_url.trim(),
    external_location_code: input.external_location_code.trim(),
    external_auth_type: input.external_auth_type,
    external_api_token_env: input.external_api_token_env.trim(),
    external_last_sync_at: input.external_last_sync_at || null,
    external_last_sync_status: input.external_last_sync_status.trim(),
    external_last_sync_message: input.external_last_sync_message.trim(),
    is_active: input.is_active,
    created_at: input.created_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

function mapWarehouseLegacyPayload(input: Warehouse, organizationId: string) {
  return {
    organization_id: organizationId,
    warehouse_code: input.warehouse_code.trim(),
    warehouse_name: input.warehouse_name.trim(),
    region: input.region.trim(),
    address: input.address.trim(),
    is_active: input.is_active,
    created_at: input.created_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

async function getAccessToken() {
  const { data, error } = await supabaseClient.auth.getSession();
  if (error) throw new Error(error.message || "Your session has expired. Sign in again.");
  const token = String(data.session?.access_token || "");
  if (!token) throw new Error("Your session has expired. Sign in again.");
  return token;
}

function mapWarehouseApiClientRow(row: Record<string, unknown>): WarehouseApiClient {
  return {
    id: String(row.id || ""),
    client_name: String(row.client_name || ""),
    partner_name: String(row.partner_name || ""),
    status: String(row.status || "active").trim().toLowerCase() === "disabled" ? "disabled" : "active",
    include_zero_stock: Boolean(row.include_zero_stock),
    expose_unit_cost: Boolean(row.expose_unit_cost),
    notes: String(row.notes || ""),
    expires_at: String(row.expires_at || ""),
    api_key_prefix: String(row.api_key_prefix || ""),
    last_used_at: String(row.last_used_at || ""),
    last_used_ip: String(row.last_used_ip || ""),
    warehouse_ids: Array.isArray(row.warehouse_ids) ? row.warehouse_ids.map((value) => String(value || "")) : [],
    warehouse_labels: Array.isArray(row.warehouse_labels) ? row.warehouse_labels.map((value) => String(value || "")) : [],
    created_at: String(row.created_at || ""),
    updated_at: String(row.updated_at || ""),
  };
}

export function createEmptyWarehouse(existingRows: Warehouse[] = []): Warehouse {
  return {
    id: `WH-${Date.now()}`,
    warehouse_code: `WH-${String(existingRows.length + 1).padStart(2, "0")}`,
    warehouse_name: "",
    region: "",
    address: "",
    warehouse_kind: "internal",
    fulfillment_model: "stocked",
    outsource_partner_name: "",
    external_sync_enabled: false,
    external_api_provider: "",
    external_api_url: "",
    external_location_code: "",
    external_auth_type: "none",
    external_api_token_env: "",
    external_last_sync_at: "",
    external_last_sync_status: "",
    external_last_sync_message: "",
    is_active: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

export async function fetchWarehouses(): Promise<Warehouse[]> {
  const organizationId = await getCurrentOrgId();
  if (warehousesCacheValue && warehousesCacheOrgId === organizationId) return warehousesCacheValue;
  if (warehousesCachePromise && warehousesCacheOrgId === organizationId) return warehousesCachePromise;

  warehousesCacheOrgId = organizationId;
  warehousesCachePromise = (async () => {
    let data: unknown[] | null = null;
    let error: { message?: string } | null = null;

    ({ data, error } = await supabaseClient
      .from("warehouses")
      .select(WAREHOUSE_EXTENDED_COLUMNS)
      .eq("organization_id", organizationId)
      .order("warehouse_name", { ascending: true }));

    if (error && isMissingColumnError(error.message || "")) {
      ({ data, error } = await supabaseClient
        .from("warehouses")
        .select(WAREHOUSE_BASE_COLUMNS)
        .eq("organization_id", organizationId)
        .order("warehouse_name", { ascending: true }));
    }

    if (error) throw new Error(error.message || "Warehouses load failed");
    const rows = ((data || []) as Record<string, unknown>[]).map(mapWarehouseRow);
    warehousesCacheValue = rows;
    warehousesCachePromise = null;
    return rows;
  })().catch((error) => {
    warehousesCachePromise = null;
    throw error;
  });
  return warehousesCachePromise;
}

export async function upsertWarehouse(input: Warehouse): Promise<Warehouse> {
  const organizationId = await getCurrentOrgId();
  const payload = mapWarehousePayload(input, organizationId);
  const legacyPayload = mapWarehouseLegacyPayload(input, organizationId);

  if (isUuid(input.id)) {
    let data: unknown = null;
    let error: { message?: string } | null = null;

    ({ data, error } = await supabaseClient
      .from("warehouses")
      .update(payload)
      .eq("organization_id", organizationId)
      .eq("id", input.id)
      .select(WAREHOUSE_EXTENDED_COLUMNS)
      .single());

    if (error && isMissingColumnError(error.message || "")) {
      ({ data, error } = await supabaseClient
        .from("warehouses")
        .update(legacyPayload)
        .eq("organization_id", organizationId)
        .eq("id", input.id)
        .select(WAREHOUSE_BASE_COLUMNS)
        .single());
    }

    if (error) throw new Error(error.message || "Warehouse save failed");
    clearWarehousesCache();
    return mapWarehouseRow(data as Record<string, unknown>);
  }

  let data: unknown = null;
  let error: { message?: string } | null = null;

  ({ data, error } = await supabaseClient
    .from("warehouses")
    .insert(payload)
    .select(WAREHOUSE_EXTENDED_COLUMNS)
    .single());

  if (error && isMissingColumnError(error.message || "")) {
    ({ data, error } = await supabaseClient
      .from("warehouses")
      .insert(legacyPayload)
      .select(WAREHOUSE_BASE_COLUMNS)
      .single());
  }

  if (error) throw new Error(error.message || "Warehouse create failed");
  clearWarehousesCache();
  return mapWarehouseRow(data as Record<string, unknown>);
}

export async function syncWarehouseExternalStock(warehouseId: string) {
  const accessToken = await getAccessToken();
  const response = await fetch(syncWarehouseStockUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ warehouseId }),
  });

  const payload = (await response.json().catch(() => ({}))) as {
    error?: string;
    ok?: boolean;
    warehouse?: Record<string, unknown>;
    summary?: {
      fetchedItemCount?: number;
      acceptedItemCount?: number;
      adjustmentCount?: number;
      zeroedItemCount?: number;
      invalidItemCount?: number;
    };
  };

  if (!response.ok) {
    throw new Error(payload.error || "Warehouse API sync failed");
  }

  clearWarehousesCache();
  return {
    warehouse: payload.warehouse ? mapWarehouseRow(payload.warehouse) : null,
    summary: {
      fetchedItemCount: Number(payload.summary?.fetchedItemCount || 0),
      acceptedItemCount: Number(payload.summary?.acceptedItemCount || 0),
      adjustmentCount: Number(payload.summary?.adjustmentCount || 0),
      zeroedItemCount: Number(payload.summary?.zeroedItemCount || 0),
      invalidItemCount: Number(payload.summary?.invalidItemCount || 0),
    },
  };
}

export async function fetchWarehouseApiClients() {
  const accessToken = await getAccessToken();
  const response = await fetch(warehouseApiClientsUrl, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  const payload = (await response.json().catch(() => ({}))) as {
    error?: string;
    clients?: Array<Record<string, unknown>>;
    apiBaseUrl?: string;
    headerName?: string;
  };

  if (!response.ok) {
    throw new Error(payload.error || "Warehouse API clients load failed");
  }

  return {
    clients: Array.isArray(payload.clients) ? payload.clients.map(mapWarehouseApiClientRow) : [],
    apiBaseUrl: String(payload.apiBaseUrl || ""),
    headerName: String(payload.headerName || "x-api-key"),
  };
}

export async function upsertWarehouseApiClient(input: {
  id?: string;
  client_name: string;
  partner_name: string;
  status: "active" | "disabled";
  include_zero_stock: boolean;
  expose_unit_cost: boolean;
  notes: string;
  expires_at: string;
  warehouse_ids: string[];
}) {
  const accessToken = await getAccessToken();
  const response = await fetch(warehouseApiClientsUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      action: "save",
      ...input,
    }),
  });

  const payload = (await response.json().catch(() => ({}))) as {
    error?: string;
    client?: Record<string, unknown>;
    secret?: WarehouseApiClientSecret;
  };

  if (!response.ok) {
    throw new Error(payload.error || "Warehouse API client save failed");
  }

  return {
    client: payload.client ? mapWarehouseApiClientRow(payload.client) : null,
    secret: payload.secret || null,
  };
}

export async function rotateWarehouseApiClientToken(clientId: string) {
  const accessToken = await getAccessToken();
  const response = await fetch(warehouseApiClientsUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      action: "rotate",
      id: clientId,
    }),
  });

  const payload = (await response.json().catch(() => ({}))) as {
    error?: string;
    client?: Record<string, unknown>;
    secret?: WarehouseApiClientSecret;
  };

  if (!response.ok) {
    throw new Error(payload.error || "Warehouse API key rotation failed");
  }

  return {
    client: payload.client ? mapWarehouseApiClientRow(payload.client) : null,
    secret: payload.secret || null,
  };
}

export async function deleteWarehouseApiClient(clientId: string) {
  const accessToken = await getAccessToken();
  const response = await fetch(warehouseApiClientsUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      action: "delete",
      id: clientId,
    }),
  });

  const payload = (await response.json().catch(() => ({}))) as {
    error?: string;
  };

  if (!response.ok) {
    throw new Error(payload.error || "Warehouse API client delete failed");
  }
}
