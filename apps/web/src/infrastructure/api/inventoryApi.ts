import type { LocalPurchaseOrder } from "../../types/orders";
import type { InventoryMovement, PurchaseReceive, PurchaseReceiveLine, WarehouseOnHandRow } from "../../types/inventory";
import type { Warehouse } from "../../types/warehouses";
import { supabaseClient } from "./supabaseClient";
import { getCurrentOrgId } from "./organizationApi";
import { upsertPurchaseOrder } from "./ordersApi";

const PURCHASE_RECEIVE_COLUMNS = [
  "id",
  "purchase_order_id",
  "purchase_order_no",
  "supplier_name",
  "warehouse_id",
  "warehouse_code",
  "warehouse_name",
  "status",
  "received_date",
  "notes",
  "total_qty",
  "total_amount",
  "created_at",
  "updated_at",
  "lines",
].join(",");

const INVENTORY_MOVEMENT_COLUMNS = [
  "id",
  "warehouse_id",
  "warehouse_code",
  "warehouse_name",
  "movement_type",
  "document_type",
  "document_id",
  "document_no",
  "related_party",
  "product_code",
  "old_code",
  "brand",
  "description",
  "qty_in",
  "qty_out",
  "unit_cost",
  "total_cost",
  "origin",
  "notes",
  "moved_at",
  "created_at",
  "updated_at",
].join(",");

function nowIso() {
  return new Date().toISOString();
}

function toNumber(value: unknown) {
  return Number(value ?? 0) || 0;
}

function roundQty(value: number) {
  return Math.round(value * 100) / 100;
}

function receiveLineKey(line: {
  product_code?: string;
  old_code?: string;
  brand?: string;
}) {
  return `${String(line.brand || "").trim().toLowerCase()}::${String(line.product_code || "").trim().toLowerCase()}::${String(line.old_code || "").trim().toLowerCase()}`;
}

function mapPurchaseReceiveRow(row: Record<string, unknown>): PurchaseReceive {
  return {
    id: String(row.id || ""),
    purchase_order_id: String(row.purchase_order_id || ""),
    purchase_order_no: String(row.purchase_order_no || ""),
    supplier_name: String(row.supplier_name || ""),
    warehouse_id: String(row.warehouse_id || ""),
    warehouse_code: String(row.warehouse_code || ""),
    warehouse_name: String(row.warehouse_name || ""),
    status: String(row.status || "posted") as PurchaseReceive["status"],
    received_date: String(row.received_date || ""),
    notes: String(row.notes || ""),
    total_qty: toNumber(row.total_qty),
    total_amount: toNumber(row.total_amount),
    created_at: String(row.created_at || ""),
    updated_at: String(row.updated_at || ""),
    lines: Array.isArray(row.lines) ? (row.lines as PurchaseReceive["lines"]) : [],
  };
}

function mapInventoryMovementRow(row: Record<string, unknown>): InventoryMovement {
  return {
    id: String(row.id || ""),
    warehouse_id: String(row.warehouse_id || ""),
    warehouse_code: String(row.warehouse_code || ""),
    warehouse_name: String(row.warehouse_name || ""),
    movement_type: String(row.movement_type || "purchase_receive") as InventoryMovement["movement_type"],
    document_type: String(row.document_type || ""),
    document_id: String(row.document_id || ""),
    document_no: String(row.document_no || ""),
    related_party: String(row.related_party || ""),
    product_code: String(row.product_code || ""),
    old_code: String(row.old_code || ""),
    brand: String(row.brand || ""),
    description: String(row.description || ""),
    qty_in: toNumber(row.qty_in),
    qty_out: toNumber(row.qty_out),
    unit_cost: toNumber(row.unit_cost),
    total_cost: toNumber(row.total_cost),
    origin: String(row.origin || ""),
    notes: String(row.notes || ""),
    moved_at: String(row.moved_at || ""),
    created_at: String(row.created_at || ""),
    updated_at: String(row.updated_at || ""),
  };
}

export type PurchaseReceiveDraftLine = PurchaseReceiveLine & {
  key: string;
};

export type PurchaseReceiveDraft = {
  purchase_order_id: string;
  purchase_order_no: string;
  supplier_name: string;
  warehouse_id: string;
  warehouse_code: string;
  warehouse_name: string;
  received_date: string;
  notes: string;
  lines: PurchaseReceiveDraftLine[];
};

export async function fetchPurchaseReceives(): Promise<PurchaseReceive[]> {
  const organizationId = await getCurrentOrgId();
  const { data, error } = await supabaseClient
    .from("purchase_receives")
    .select(PURCHASE_RECEIVE_COLUMNS)
    .eq("organization_id", organizationId)
    .order("updated_at", { ascending: false });

  if (error) throw new Error(error.message || "Purchase receives load failed");
  return ((data || []) as unknown as Record<string, unknown>[]).map(mapPurchaseReceiveRow);
}

export async function fetchInventoryMovements(warehouseId?: string): Promise<InventoryMovement[]> {
  const organizationId = await getCurrentOrgId();
  let query = supabaseClient
    .from("inventory_movements")
    .select(INVENTORY_MOVEMENT_COLUMNS)
    .eq("organization_id", organizationId)
    .order("moved_at", { ascending: false });

  if (warehouseId) query = query.eq("warehouse_id", warehouseId);

  const { data, error } = await query;
  if (error) throw new Error(error.message || "Inventory movements load failed");
  return ((data || []) as unknown as Record<string, unknown>[]).map(mapInventoryMovementRow);
}

export async function fetchWarehouseOnHand(warehouses: Warehouse[]): Promise<WarehouseOnHandRow[]> {
  const movements = await fetchInventoryMovements();
  const byWarehouse = new Map<string, { sku: Set<string>; onHand: number }>();

  movements.forEach((movement) => {
    const current = byWarehouse.get(movement.warehouse_id) || { sku: new Set<string>(), onHand: 0 };
    current.sku.add(`${movement.brand}::${movement.product_code}`);
    current.onHand += toNumber(movement.qty_in) - toNumber(movement.qty_out);
    byWarehouse.set(movement.warehouse_id, current);
  });

  return warehouses.map((warehouse) => {
    const current = byWarehouse.get(warehouse.id);
    const onHand = roundQty(current?.onHand || 0);
    return {
      warehouse_id: warehouse.id,
      warehouse_code: warehouse.warehouse_code,
      warehouse_name: warehouse.warehouse_name,
      region: warehouse.region,
      sku_count: current?.sku.size || 0,
      on_hand_qty: onHand,
      reserved_qty: 0,
      available_qty: onHand,
    };
  });
}

export function buildPurchaseReceiveDraft(
  order: LocalPurchaseOrder,
  warehouse: Warehouse | null,
  existingReceives: PurchaseReceive[],
): PurchaseReceiveDraft {
  const receivedMap = new Map<string, number>();
  existingReceives
    .filter((receive) => receive.purchase_order_id === order.id && receive.status === "posted")
    .forEach((receive) => {
      receive.lines.forEach((line) => {
        const key = receiveLineKey(line);
        receivedMap.set(key, roundQty((receivedMap.get(key) || 0) + toNumber(line.qty_received)));
      });
    });

  return {
    purchase_order_id: order.id,
    purchase_order_no: order.id,
    supplier_name: order.supplier_name,
    warehouse_id: warehouse?.id || "",
    warehouse_code: warehouse?.warehouse_code || "",
    warehouse_name: warehouse?.warehouse_name || "",
    received_date: nowIso().slice(0, 10),
    notes: "",
    lines: order.lines.map((line) => {
      const key = receiveLineKey(line);
      const orderedQty = roundQty(toNumber(line.qty));
      const alreadyReceived = roundQty(receivedMap.get(key) || 0);
      const remaining = Math.max(0, roundQty(orderedQty - alreadyReceived));
      return {
        key,
        product_code: line.product_code,
        old_code: line.old_code,
        brand: line.brand,
        description: line.description,
        qty_ordered: orderedQty,
        qty_received: remaining,
        qty_remaining_before: remaining,
        unit_cost: roundQty(toNumber(line.buy_price)),
        line_total: roundQty(remaining * toNumber(line.buy_price)),
        origin: line.origin || "",
        notes: line.notes || "",
      };
    }),
  };
}

export async function postPurchaseReceive(input: PurchaseReceiveDraft, order: LocalPurchaseOrder): Promise<PurchaseReceive> {
  const organizationId = await getCurrentOrgId();
  const postedLines = input.lines
    .map((line) => ({
      ...line,
      qty_received: roundQty(toNumber(line.qty_received)),
      line_total: roundQty(toNumber(line.qty_received) * toNumber(line.unit_cost)),
    }))
    .filter((line) => line.qty_received > 0);

  if (!input.warehouse_id) throw new Error("Select a warehouse first.");
  if (!postedLines.length) throw new Error("Enter at least one received quantity.");

  const payload = {
    organization_id: organizationId,
    purchase_order_id: input.purchase_order_id,
    purchase_order_no: input.purchase_order_no,
    supplier_name: input.supplier_name,
    warehouse_id: input.warehouse_id,
    warehouse_code: input.warehouse_code,
    warehouse_name: input.warehouse_name,
    status: "posted",
    received_date: input.received_date,
    notes: input.notes,
    total_qty: roundQty(postedLines.reduce((sum, line) => sum + line.qty_received, 0)),
    total_amount: roundQty(postedLines.reduce((sum, line) => sum + line.line_total, 0)),
    lines: postedLines,
    created_at: nowIso(),
    updated_at: nowIso(),
  };

  const { data, error } = await supabaseClient
    .from("purchase_receives")
    .insert(payload)
    .select(PURCHASE_RECEIVE_COLUMNS)
    .single();

  if (error) throw new Error(error.message || "Purchase receive post failed");
  const postedReceiveRow = data as unknown as Record<string, unknown>;
  const postedReceiveId = String(postedReceiveRow.id || "");

  const movementPayload = postedLines.map((line) => ({
    organization_id: organizationId,
    warehouse_id: input.warehouse_id,
    warehouse_code: input.warehouse_code,
    warehouse_name: input.warehouse_name,
    movement_type: "purchase_receive",
    document_type: "Purchase Receive",
    document_id: postedReceiveId,
    document_no: postedReceiveId,
    related_party: input.supplier_name,
    product_code: line.product_code,
    old_code: line.old_code,
    brand: line.brand,
    description: line.description,
    qty_in: line.qty_received,
    qty_out: 0,
    unit_cost: line.unit_cost,
    total_cost: line.line_total,
    origin: line.origin,
    notes: line.notes || input.notes || "",
    moved_at: `${input.received_date}T00:00:00.000Z`,
    created_at: nowIso(),
    updated_at: nowIso(),
  }));

  const { error: movementError } = await supabaseClient.from("inventory_movements").insert(movementPayload);
  if (movementError) throw new Error(movementError.message || "Inventory movement post failed");

  const receives = await fetchPurchaseReceives();
  const finalDraft = buildPurchaseReceiveDraft(order, { id: input.warehouse_id, warehouse_code: input.warehouse_code, warehouse_name: input.warehouse_name, region: "", address: "", is_active: true, created_at: "", updated_at: "" }, receives);
  const fullyReceived = finalDraft.lines.every((line) => line.qty_remaining_before <= 0);

  if (fullyReceived) {
    await upsertPurchaseOrder({
      ...order,
      status: "closed",
      updated_at: nowIso(),
    });
  }

  return mapPurchaseReceiveRow(postedReceiveRow);
}
