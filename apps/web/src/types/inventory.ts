export type PurchaseReceiveStatus = "draft" | "posted" | "void";

export type PurchaseReceiveLine = {
  product_code: string;
  old_code: string;
  brand: string;
  description: string;
  qty_ordered: number;
  qty_received: number;
  qty_remaining_before: number;
  unit_cost: number;
  line_total: number;
  origin: string;
  notes: string;
};

export type PurchaseReceive = {
  id: string;
  purchase_order_id: string;
  purchase_order_no: string;
  supplier_name: string;
  warehouse_id: string;
  warehouse_code: string;
  warehouse_name: string;
  status: PurchaseReceiveStatus;
  received_date: string;
  notes: string;
  total_qty: number;
  total_amount: number;
  created_at: string;
  updated_at: string;
  lines: PurchaseReceiveLine[];
};

export type InventoryMovement = {
  id: string;
  warehouse_id: string;
  warehouse_code: string;
  warehouse_name: string;
  movement_type: "purchase_receive" | "transfer_in" | "transfer_out" | "adjustment";
  document_type: string;
  document_id: string;
  document_no: string;
  related_party: string;
  product_code: string;
  old_code: string;
  brand: string;
  description: string;
  qty_in: number;
  qty_out: number;
  unit_cost: number;
  total_cost: number;
  origin: string;
  notes: string;
  moved_at: string;
  created_at: string;
  updated_at: string;
};

export type WarehouseOnHandRow = {
  warehouse_id: string;
  warehouse_code: string;
  warehouse_name: string;
  region: string;
  sku_count: number;
  on_hand_qty: number;
  reserved_qty: number;
  available_qty: number;
};

export type WarehouseStockItem = {
  warehouse_id: string;
  warehouse_code: string;
  warehouse_name: string;
  brand: string;
  product_code: string;
  old_code: string;
  description: string;
  origin: string;
  on_hand_qty: number;
  available_qty: number;
  average_cost: number;
  stock_value: number;
  last_moved_at: string;
};

export type StockTransferStatus = "draft" | "posted" | "void";

export type StockTransferLine = {
  product_code: string;
  old_code: string;
  brand: string;
  description: string;
  qty_transferred: number;
  unit_cost: number;
  line_total: number;
  origin: string;
  notes: string;
};

export type StockTransfer = {
  id: string;
  transfer_no: string;
  source_warehouse_id: string;
  source_warehouse_code: string;
  source_warehouse_name: string;
  target_warehouse_id: string;
  target_warehouse_code: string;
  target_warehouse_name: string;
  status: StockTransferStatus;
  transfer_date: string;
  notes: string;
  total_qty: number;
  total_amount: number;
  created_at: string;
  updated_at: string;
  lines: StockTransferLine[];
};
