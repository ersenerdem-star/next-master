import type { Warehouse } from "../../types/warehouses";
import { supabaseClient } from "./supabaseClient";
import { getCurrentOrgId, isUuid } from "./organizationApi";

const WAREHOUSE_COLUMNS = [
  "id",
  "warehouse_code",
  "warehouse_name",
  "region",
  "address",
  "is_active",
  "created_at",
  "updated_at",
].join(",");

let warehousesCacheOrgId = "";
let warehousesCacheValue: Warehouse[] | null = null;
let warehousesCachePromise: Promise<Warehouse[]> | null = null;

function clearWarehousesCache() {
  warehousesCacheValue = null;
  warehousesCachePromise = null;
}

function mapWarehouseRow(row: Record<string, unknown>): Warehouse {
  return {
    id: String(row.id || ""),
    warehouse_code: String(row.warehouse_code || ""),
    warehouse_name: String(row.warehouse_name || ""),
    region: String(row.region || ""),
    address: String(row.address || ""),
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
    is_active: input.is_active,
    created_at: input.created_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

export function createEmptyWarehouse(existingRows: Warehouse[] = []): Warehouse {
  return {
    id: `WH-${Date.now()}`,
    warehouse_code: `WH-${String(existingRows.length + 1).padStart(2, "0")}`,
    warehouse_name: "",
    region: "",
    address: "",
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
    const { data, error } = await supabaseClient
      .from("warehouses")
      .select(WAREHOUSE_COLUMNS)
      .eq("organization_id", organizationId)
      .order("warehouse_name", { ascending: true });

      if (error) throw new Error(error.message || "Warehouses load failed");
      const rows = ((data || []) as unknown as Record<string, unknown>[]).map(mapWarehouseRow);
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
  if (isUuid(input.id)) {
    const { data, error } = await supabaseClient
      .from("warehouses")
      .update(payload)
      .eq("organization_id", organizationId)
      .eq("id", input.id)
      .select(WAREHOUSE_COLUMNS)
      .single();
    if (error) throw new Error(error.message || "Warehouse save failed");
    clearWarehousesCache();
    return mapWarehouseRow(data as unknown as Record<string, unknown>);
  }

  const { data, error } = await supabaseClient
    .from("warehouses")
    .insert(payload)
    .select(WAREHOUSE_COLUMNS)
    .single();
  if (error) throw new Error(error.message || "Warehouse create failed");
  clearWarehousesCache();
  return mapWarehouseRow(data as unknown as Record<string, unknown>);
}
