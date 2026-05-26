import { useEffect, useMemo, useState } from "react";
import {
  buildPurchaseReceiveDraft,
  createStockTransferDraft,
  fetchInventoryMovements,
  fetchPurchaseReceives,
  fetchStockTransfers,
  fetchWarehouseOnHand,
  fetchWarehouseStockItems,
  postPurchaseReceive,
  postStockTransfer,
  type PurchaseReceiveDraft,
  type StockTransferDraft,
  type StockTransferDraftLine,
} from "../../infrastructure/api/inventoryApi";
import { fetchPurchaseOrders } from "../../infrastructure/api/ordersApi";
import { createEmptyWarehouse, fetchWarehouses, upsertWarehouse } from "../../infrastructure/api/warehousesApi";
import type { InventoryMovement, PurchaseReceive, StockTransfer, WarehouseOnHandRow, WarehouseStockItem } from "../../types/inventory";
import type { LocalPurchaseOrder } from "../../types/orders";
import type { Warehouse } from "../../types/warehouses";
import { useActionFeedback } from "../components/common/ActionFeedback";
import { Button } from "../components/common/Button";
import { DataTable } from "../components/common/DataTable";
import { Input } from "../components/common/Input";
import { SectionCard } from "../components/common/SectionCard";
import { Select } from "../components/common/Select";
import { BrandPill } from "../components/common/BrandPill";
import { includesLooseText } from "../../domain/shared/normalize";

type InventoryTab = "Warehouses" | "Purchase Receives" | "Stock Movements" | "On Hand" | "Transfers";

type InventoryPageProps = {
  initialTab?: InventoryTab;
  selectedWarehouseId?: string;
  stockSearch?: string;
};

function formatMoney(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number(value || 0));
}

function formatDate(value: string) {
  return value ? value.slice(0, 10) : "-";
}

function parseNumberInput(value: string) {
  const normalized = value.replace(",", ".").trim();
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function cloneDraft(draft: PurchaseReceiveDraft): PurchaseReceiveDraft {
  return {
    ...draft,
    lines: draft.lines.map((line) => ({ ...line })),
  };
}

function cloneTransferDraft(draft: StockTransferDraft): StockTransferDraft {
  return {
    ...draft,
    lines: draft.lines.map((line) => ({ ...line })),
  };
}

function transferLineKey(line: {
  brand?: string;
  product_code?: string;
  old_code?: string;
}) {
  return `${String(line.brand || "").trim().toLowerCase()}::${String(line.product_code || "").trim().toLowerCase()}::${String(line.old_code || "").trim().toLowerCase()}`;
}

export function InventoryPage({ initialTab = "Warehouses", selectedWarehouseId: selectedWarehouseIdProp = "", stockSearch: stockSearchProp = "" }: InventoryPageProps) {
  const actionFeedback = useActionFeedback();
  const [activeTab, setActiveTab] = useState<InventoryTab>(initialTab);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [purchaseOrders, setPurchaseOrders] = useState<LocalPurchaseOrder[]>([]);
  const [purchaseReceives, setPurchaseReceives] = useState<PurchaseReceive[]>([]);
  const [movementRows, setMovementRows] = useState<InventoryMovement[]>([]);
  const [onHandRows, setOnHandRows] = useState<WarehouseOnHandRow[]>([]);
  const [onHandStockRows, setOnHandStockRows] = useState<WarehouseStockItem[]>([]);
  const [onHandStockSearch, setOnHandStockSearch] = useState("");
  const [sourceStockRows, setSourceStockRows] = useState<WarehouseStockItem[]>([]);
  const [stockTransfers, setStockTransfers] = useState<StockTransfer[]>([]);
  const [selectedWarehouseId, setSelectedWarehouseId] = useState("");
  const [selectedReceiveId, setSelectedReceiveId] = useState("");
  const [draft, setDraft] = useState<Warehouse | null>(null);
  const [saving, setSaving] = useState(false);
  const [receiveWarehouseId, setReceiveWarehouseId] = useState("");
  const [movementWarehouseId, setMovementWarehouseId] = useState("");
  const [onHandWarehouseId, setOnHandWarehouseId] = useState("");
  const [transferSourceId, setTransferSourceId] = useState("");
  const [transferTargetId, setTransferTargetId] = useState("");
  const [transferSearch, setTransferSearch] = useState("");
  const [loadingOrders, setLoadingOrders] = useState(false);
  const [loadingReceives, setLoadingReceives] = useState(false);
  const [loadingMovements, setLoadingMovements] = useState(false);
  const [loadingOnHand, setLoadingOnHand] = useState(false);
  const [loadingOnHandStock, setLoadingOnHandStock] = useState(false);
  const [loadingTransferStock, setLoadingTransferStock] = useState(false);
  const [loadingTransfers, setLoadingTransfers] = useState(false);
  const [postingReceive, setPostingReceive] = useState(false);
  const [postingTransfer, setPostingTransfer] = useState(false);
  const [showWarehouseEditor, setShowWarehouseEditor] = useState(false);
  const [receiveDraft, setReceiveDraft] = useState<PurchaseReceiveDraft | null>(null);
  const [transferDraft, setTransferDraft] = useState<StockTransferDraft | null>(null);

  async function reloadWarehouses() {
    const warehouseRows = await fetchWarehouses();
    setWarehouses(warehouseRows);
    return warehouseRows;
  }

  async function reloadOnHand(currentWarehouses: Warehouse[]) {
    setLoadingOnHand(true);
    try {
      const rows = await fetchWarehouseOnHand(currentWarehouses);
      setOnHandRows(rows);
      return rows;
    } finally {
      setLoadingOnHand(false);
    }
  }

  async function reloadOnHandStock(warehouseId?: string) {
    setLoadingOnHandStock(true);
    try {
      const rows = await fetchWarehouseStockItems(warehouseId);
      setOnHandStockRows(rows);
      return rows;
    } finally {
      setLoadingOnHandStock(false);
    }
  }

  async function reloadPurchaseOrders() {
    setLoadingOrders(true);
    try {
      const rows = await fetchPurchaseOrders();
      setPurchaseOrders(rows);
      return rows;
    } finally {
      setLoadingOrders(false);
    }
  }

  async function reloadPurchaseReceives() {
    setLoadingReceives(true);
    try {
      const rows = await fetchPurchaseReceives();
      setPurchaseReceives(rows);
      return rows;
    } finally {
      setLoadingReceives(false);
    }
  }

  async function reloadMovements(warehouseId?: string) {
    setLoadingMovements(true);
    try {
      const rows = await fetchInventoryMovements(warehouseId);
      setMovementRows(rows);
      return rows;
    } finally {
      setLoadingMovements(false);
    }
  }

  async function reloadTransferStock(warehouseId?: string) {
    setLoadingTransferStock(true);
    try {
      const rows = await fetchWarehouseStockItems(warehouseId);
      setSourceStockRows(rows);
      return rows;
    } finally {
      setLoadingTransferStock(false);
    }
  }

  async function reloadTransfers() {
    setLoadingTransfers(true);
    try {
      const rows = await fetchStockTransfers();
      setStockTransfers(rows);
      return rows;
    } finally {
      setLoadingTransfers(false);
    }
  }

  useEffect(() => {
    let cancelled = false;

    async function run() {
      try {
        const warehouseRows = await fetchWarehouses();
        if (cancelled) return;
        setWarehouses(warehouseRows);

        const firstWarehouse = warehouseRows[0] || createEmptyWarehouse();
        setSelectedWarehouseId(firstWarehouse.id);
        setDraft(firstWarehouse);
        setShowWarehouseEditor(false);
        setReceiveWarehouseId(warehouseRows[0]?.id || "");
        setMovementWarehouseId(warehouseRows[0]?.id || "");
        setOnHandWarehouseId("");
        setTransferSourceId(warehouseRows[0]?.id || "");
        setTransferTargetId(warehouseRows[1]?.id || warehouseRows[0]?.id || "");

        if (warehouseRows.length) {
          const onHand = await fetchWarehouseOnHand(warehouseRows);
          if (!cancelled) setOnHandRows(onHand);
        } else if (!cancelled) {
          setOnHandRows([]);
        }
      } catch (caught) {
        if (!cancelled) {
          actionFeedback.fail(caught instanceof Error ? caught.message : "Inventory load failed");
        }
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [actionFeedback]);

  useEffect(() => {
    if (initialTab) setActiveTab(initialTab);
  }, [initialTab]);

  useEffect(() => {
    if (!selectedWarehouseIdProp) return;
    setSelectedWarehouseId(selectedWarehouseIdProp);
    setOnHandWarehouseId(selectedWarehouseIdProp);
    setMovementWarehouseId(selectedWarehouseIdProp);
    setActiveTab("On Hand");
  }, [selectedWarehouseIdProp]);

  useEffect(() => {
    setOnHandStockSearch(stockSearchProp);
    if (stockSearchProp) setActiveTab("On Hand");
  }, [stockSearchProp]);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      if (activeTab !== "Purchase Receives") return;
      try {
        const [orders, receives] = await Promise.all([reloadPurchaseOrders(), reloadPurchaseReceives()]);
        if (cancelled) return;
        if (!selectedReceiveId && orders[0]) {
          setSelectedReceiveId(orders[0].id);
        } else if (selectedReceiveId && !orders.some((row) => row.id === selectedReceiveId)) {
          setSelectedReceiveId(orders[0]?.id || "");
        }
        if (!receiveWarehouseId && warehouses[0]) {
          setReceiveWarehouseId(warehouses[0].id);
        }
        setPurchaseReceives(receives);
      } catch (caught) {
        if (!cancelled) {
          actionFeedback.fail(caught instanceof Error ? caught.message : "Purchase receive load failed");
        }
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [actionFeedback, activeTab]);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      if (activeTab !== "Stock Movements") return;
      try {
        const rows = await fetchInventoryMovements(movementWarehouseId || undefined);
        if (!cancelled) setMovementRows(rows);
      } catch (caught) {
        if (!cancelled) {
          actionFeedback.fail(caught instanceof Error ? caught.message : "Inventory movements load failed");
        }
      } finally {
        if (!cancelled) setLoadingMovements(false);
      }
    }

    setLoadingMovements(true);
    void run();
    return () => {
      cancelled = true;
    };
  }, [actionFeedback, activeTab, movementWarehouseId]);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      if (activeTab !== "On Hand" && activeTab !== "Warehouses") return;
      if (!warehouses.length) {
        setOnHandRows([]);
        return;
      }
      try {
        setLoadingOnHand(true);
        const rows = await fetchWarehouseOnHand(warehouses);
        if (!cancelled) setOnHandRows(rows);
      } catch (caught) {
        if (!cancelled) {
          actionFeedback.fail(caught instanceof Error ? caught.message : "On hand inventory load failed");
        }
      } finally {
        if (!cancelled) setLoadingOnHand(false);
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [actionFeedback, activeTab, warehouses]);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      if (activeTab !== "On Hand") return;
      try {
        const rows = await fetchWarehouseStockItems(onHandWarehouseId || undefined);
        if (!cancelled) setOnHandStockRows(rows);
      } catch (caught) {
        if (!cancelled) {
          actionFeedback.fail(caught instanceof Error ? caught.message : "On hand stock detail load failed");
        }
      } finally {
        if (!cancelled) setLoadingOnHandStock(false);
      }
    }

    setLoadingOnHandStock(true);
    void run();
    return () => {
      cancelled = true;
    };
  }, [actionFeedback, activeTab, onHandWarehouseId]);

  const warehouseColumns = useMemo(
    () => [
      { key: "code", header: "Code", render: (row: Warehouse) => row.warehouse_code || "-" },
      { key: "name", header: "Warehouse", render: (row: Warehouse) => row.warehouse_name || "-" },
      { key: "region", header: "Region", render: (row: Warehouse) => row.region || "-" },
      { key: "status", header: "Status", render: (row: Warehouse) => (row.is_active ? "Active" : "Closed") },
    ],
    [],
  );

  const warehouseOptions = useMemo(
    () => [{ value: "", label: "Select warehouse" }, ...warehouses.map((row) => ({ value: row.id, label: `${row.warehouse_code} · ${row.warehouse_name}` }))],
    [warehouses],
  );

  const warehouseFilterOptions = useMemo(
    () => [{ value: "", label: "All Warehouses" }, ...warehouses.map((row) => ({ value: row.id, label: `${row.warehouse_code} · ${row.warehouse_name}` }))],
    [warehouses],
  );

  const selectedReceiveWarehouse = useMemo(
    () => warehouses.find((row) => row.id === receiveWarehouseId) || null,
    [receiveWarehouseId, warehouses],
  );

  const selectedTransferSourceWarehouse = useMemo(
    () => warehouses.find((row) => row.id === transferSourceId) || null,
    [transferSourceId, warehouses],
  );

  const selectedTransferTargetWarehouse = useMemo(
    () => warehouses.find((row) => row.id === transferTargetId) || null,
    [transferTargetId, warehouses],
  );

  const receiveCandidates = useMemo(
    () =>
      purchaseOrders.filter((row) => {
        if (!["confirmed", "open", "draft"].includes(row.status)) return false;
        const draftView = buildPurchaseReceiveDraft(row, null, purchaseReceives);
        return draftView.lines.some((line) => line.qty_remaining_before > 0);
      }),
    [purchaseOrders, purchaseReceives],
  );

  const selectedReceive = useMemo(
    () => receiveCandidates.find((row) => row.id === selectedReceiveId) || receiveCandidates[0] || null,
    [receiveCandidates, selectedReceiveId],
  );

  const selectedOrderReceives = useMemo(
    () => purchaseReceives.filter((receive) => receive.purchase_order_id === selectedReceive?.id),
    [purchaseReceives, selectedReceive?.id],
  );

  useEffect(() => {
    if (!receiveCandidates.length) {
      setSelectedReceiveId("");
      return;
    }
    if (!selectedReceiveId || !receiveCandidates.some((row) => row.id === selectedReceiveId)) {
      setSelectedReceiveId(receiveCandidates[0].id);
    }
  }, [receiveCandidates, selectedReceiveId]);

  useEffect(() => {
    if (!selectedReceive) {
      setReceiveDraft(null);
      return;
    }
    setReceiveDraft(buildPurchaseReceiveDraft(selectedReceive, selectedReceiveWarehouse, purchaseReceives));
  }, [purchaseReceives, selectedReceive, selectedReceiveWarehouse]);

  useEffect(() => {
    setTransferDraft((current) => {
      const base = current || createStockTransferDraft(selectedTransferSourceWarehouse, selectedTransferTargetWarehouse);
      return {
        ...base,
        source_warehouse_id: selectedTransferSourceWarehouse?.id || "",
        source_warehouse_code: selectedTransferSourceWarehouse?.warehouse_code || "",
        source_warehouse_name: selectedTransferSourceWarehouse?.warehouse_name || "",
        target_warehouse_id: selectedTransferTargetWarehouse?.id || "",
        target_warehouse_code: selectedTransferTargetWarehouse?.warehouse_code || "",
        target_warehouse_name: selectedTransferTargetWarehouse?.warehouse_name || "",
      };
    });
  }, [selectedTransferSourceWarehouse, selectedTransferTargetWarehouse]);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      if (activeTab !== "Transfers") return;
      try {
        const [stockRows, transferRows] = await Promise.all([
          reloadTransferStock(transferSourceId || undefined),
          reloadTransfers(),
        ]);
        if (cancelled) return;
        setSourceStockRows(stockRows);
        setStockTransfers(transferRows);
      } catch (caught) {
        if (!cancelled) {
          actionFeedback.fail(caught instanceof Error ? caught.message : "Transfer inventory load failed");
        }
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [actionFeedback, activeTab, transferSourceId]);

  const movementColumns = useMemo(
    () => [
      { key: "date", header: "Date", render: (row: InventoryMovement) => formatDate(row.moved_at) },
      { key: "warehouse", header: "Warehouse", render: (row: InventoryMovement) => row.warehouse_name || row.warehouse_code || "-" },
      { key: "type", header: "Type", render: (row: InventoryMovement) => row.movement_type },
      { key: "document", header: "Document", render: (row: InventoryMovement) => row.document_no || row.document_type || "-" },
      { key: "party", header: "Related Party", render: (row: InventoryMovement) => row.related_party || "-" },
      { key: "brand", header: "Brand", render: (row: InventoryMovement) => <BrandPill brand={row.brand} compact /> },
      { key: "code", header: "Code", render: (row: InventoryMovement) => row.product_code || row.old_code || "-" },
      { key: "description", header: "Description", render: (row: InventoryMovement) => row.description || "-" },
      { key: "qtyin", header: "Qty In", render: (row: InventoryMovement) => row.qty_in.toLocaleString("en-US") },
      { key: "qtyout", header: "Qty Out", render: (row: InventoryMovement) => row.qty_out.toLocaleString("en-US") },
      { key: "cost", header: "Total Cost", render: (row: InventoryMovement) => formatMoney(row.total_cost) },
    ],
    [],
  );

  const onHandColumns = useMemo(
    () => [
      { key: "code", header: "Code", render: (row: WarehouseOnHandRow) => row.warehouse_code || "-" },
      { key: "name", header: "Warehouse", render: (row: WarehouseOnHandRow) => row.warehouse_name || "-" },
      { key: "region", header: "Region", render: (row: WarehouseOnHandRow) => row.region || "-" },
      { key: "sku", header: "SKU Count", render: (row: WarehouseOnHandRow) => row.sku_count.toLocaleString("en-US") },
      { key: "onhand", header: "On Hand", render: (row: WarehouseOnHandRow) => row.on_hand_qty.toLocaleString("en-US") },
      { key: "reserved", header: "Reserved", render: (row: WarehouseOnHandRow) => row.reserved_qty.toLocaleString("en-US") },
      { key: "available", header: "Available", render: (row: WarehouseOnHandRow) => row.available_qty.toLocaleString("en-US") },
    ],
    [],
  );

  const visibleOnHandRows = useMemo(
    () => (onHandWarehouseId ? onHandRows.filter((row) => row.warehouse_id === onHandWarehouseId) : onHandRows),
    [onHandRows, onHandWarehouseId],
  );

  const visibleOnHandStockRows = useMemo(
    () => {
      const scopedRows = onHandWarehouseId ? onHandStockRows.filter((row) => row.warehouse_id === onHandWarehouseId) : onHandStockRows;
      const needle = onHandStockSearch.trim().toLowerCase();
      if (!needle) return scopedRows;
      return scopedRows.filter((row) => includesLooseText(`${row.brand} ${row.product_code} ${row.old_code} ${row.description} ${row.origin}`, needle));
    },
    [onHandStockRows, onHandWarehouseId, onHandStockSearch],
  );

  const filteredTransferStockRows = useMemo(() => {
    const normalized = transferSearch.trim().toLowerCase();
    const rows = transferSourceId ? sourceStockRows.filter((row) => row.warehouse_id === transferSourceId) : sourceStockRows;
    if (!normalized) return rows;
    return rows.filter((row) => includesLooseText([row.brand, row.product_code, row.old_code, row.description, row.origin].join(" "), normalized));
  }, [sourceStockRows, transferSearch, transferSourceId]);

  const transferHistoryColumns = useMemo(
    () => [
      { key: "date", header: "Date", render: (row: StockTransfer) => formatDate(row.transfer_date) },
      { key: "transfer", header: "Transfer No", render: (row: StockTransfer) => row.transfer_no || row.id },
      { key: "source", header: "Source", render: (row: StockTransfer) => row.source_warehouse_name || row.source_warehouse_code || "-" },
      { key: "target", header: "Target", render: (row: StockTransfer) => row.target_warehouse_name || row.target_warehouse_code || "-" },
      { key: "qty", header: "Qty", render: (row: StockTransfer) => row.total_qty.toLocaleString("en-US") },
      { key: "amount", header: "Value", render: (row: StockTransfer) => formatMoney(row.total_amount) },
      { key: "status", header: "Status", render: (row: StockTransfer) => row.status.toUpperCase() },
    ],
    [],
  );

  const receiveDraftTotals = useMemo(() => {
    const lines = receiveDraft?.lines || [];
    return {
      qty: lines.reduce((sum, line) => sum + line.qty_received, 0),
      amount: lines.reduce((sum, line) => sum + line.line_total, 0),
    };
  }, [receiveDraft]);

  const transferDraftTotals = useMemo(() => {
    const lines = transferDraft?.lines || [];
    return {
      qty: lines.reduce((sum, line) => sum + line.qty_transferred, 0),
      amount: lines.reduce((sum, line) => sum + line.line_total, 0),
    };
  }, [transferDraft]);

  const onHandStockColumns = useMemo(
    () => [
      { key: "brand", header: "Brand", render: (row: WarehouseStockItem) => <BrandPill brand={row.brand} compact /> },
      { key: "code", header: "Code", render: (row: WarehouseStockItem) => row.product_code || row.old_code || "-" },
      { key: "description", header: "Description", render: (row: WarehouseStockItem) => row.description || "-" },
      { key: "origin", header: "Origin", render: (row: WarehouseStockItem) => row.origin || "-" },
      { key: "onhand", header: "On Hand", render: (row: WarehouseStockItem) => row.on_hand_qty.toLocaleString("en-US") },
      { key: "available", header: "Available", render: (row: WarehouseStockItem) => row.available_qty.toLocaleString("en-US") },
      { key: "avgcost", header: "Avg Cost", render: (row: WarehouseStockItem) => formatMoney(row.average_cost) },
      { key: "value", header: "Stock Value", render: (row: WarehouseStockItem) => formatMoney(row.stock_value) },
      { key: "last", header: "Last Move", render: (row: WarehouseStockItem) => formatDate(row.last_moved_at) },
    ],
    [],
  );

  function selectWarehouse(row: Warehouse) {
    setSelectedWarehouseId(row.id);
    setDraft(row);
    setShowWarehouseEditor(true);
  }

  function handleNewWarehouse() {
    const next = createEmptyWarehouse(warehouses);
    setSelectedWarehouseId(next.id);
    setDraft(next);
    setShowWarehouseEditor(true);
  }

  async function handleSave() {
    if (!draft) return;
    if (!draft.warehouse_code.trim() || !draft.warehouse_name.trim()) {
      actionFeedback.fail("Warehouse code and warehouse name are required.");
      return;
    }
    try {
      setSaving(true);
      actionFeedback.begin(`Saving warehouse ${draft.warehouse_name || draft.warehouse_code}...`);
      const saved = await upsertWarehouse(draft);
      const rows = await reloadWarehouses();
      setSelectedWarehouseId(saved.id);
      setDraft(saved);
      setReceiveWarehouseId((current) => current || saved.id);
      setMovementWarehouseId((current) => current || saved.id);
      setTransferSourceId((current) => current || saved.id);
      setTransferTargetId((current) => current || saved.id);
      await reloadOnHand(rows);
      actionFeedback.succeed(`Warehouse ${saved.warehouse_name} saved.`);
    } catch (caught) {
      actionFeedback.fail(caught instanceof Error ? caught.message : "Warehouse save failed");
    } finally {
      setSaving(false);
    }
  }

  function handleCloseWarehouseEditor() {
    setShowWarehouseEditor(false);
    if (selectedWarehouseId) {
      const current = warehouses.find((item) => item.id === selectedWarehouseId);
      if (current) setDraft(current);
    }
  }

  function handleReceiveDraftLineChange(lineKey: string, field: "qty_received" | "notes", value: string) {
    setReceiveDraft((current) => {
      if (!current) return current;
      const next = cloneDraft(current);
      next.lines = next.lines.map((line) => {
        if (line.key !== lineKey) return line;
        if (field === "notes") {
          return { ...line, notes: value };
        }
        const capped = Math.max(0, Math.min(line.qty_remaining_before, parseNumberInput(value)));
        return {
          ...line,
          qty_received: capped,
          line_total: capped * line.unit_cost,
        };
      });
      return next;
    });
  }

  async function handlePostReceive() {
    if (!receiveDraft || !selectedReceive) return;
    try {
      setPostingReceive(true);
      actionFeedback.begin(`Posting purchase receive for ${receiveDraft.purchase_order_no}...`);
      await postPurchaseReceive(receiveDraft, selectedReceive);
      const [orders, receives, movements] = await Promise.all([
        reloadPurchaseOrders(),
        reloadPurchaseReceives(),
        reloadMovements(movementWarehouseId || undefined),
      ]);
      const warehouseRows = warehouses.length ? warehouses : await reloadWarehouses();
      await Promise.all([reloadOnHand(warehouseRows), reloadOnHandStock(onHandWarehouseId || undefined)]);
      if (!orders.some((row) => row.id === selectedReceive.id)) {
        setSelectedReceiveId(orders[0]?.id || "");
      }
      setPurchaseReceives(receives);
      setMovementRows(movements);
      actionFeedback.succeed(`Purchase receive for ${receiveDraft.purchase_order_no} posted to stock.`);
    } catch (caught) {
      actionFeedback.fail(caught instanceof Error ? caught.message : "Purchase receive post failed");
    } finally {
      setPostingReceive(false);
    }
  }

  function handleAddTransferItem(item: WarehouseStockItem) {
    setTransferDraft((current) => {
      const base = current || createStockTransferDraft(selectedTransferSourceWarehouse, selectedTransferTargetWarehouse);
      const key = transferLineKey(item);
      if (base.lines.some((line) => line.key === key)) return base;
      const next = cloneTransferDraft(base);
      next.lines.push({
        key,
        product_code: item.product_code,
        old_code: item.old_code,
        brand: item.brand,
        description: item.description,
        qty_transferred: item.on_hand_qty > 0 ? 1 : 0,
        available_qty: item.available_qty,
        unit_cost: item.average_cost,
        line_total: item.average_cost,
        origin: item.origin,
        notes: "",
      });
      return next;
    });
  }

  function handleTransferDraftLineChange(lineKey: string, field: "qty_transferred" | "notes", value: string) {
    setTransferDraft((current) => {
      if (!current) return current;
      const next = cloneTransferDraft(current);
      next.lines = next.lines.map((line) => {
        if (line.key !== lineKey) return line;
        if (field === "notes") return { ...line, notes: value };
        const capped = Math.max(0, Math.min(line.available_qty, parseNumberInput(value)));
        return {
          ...line,
          qty_transferred: capped,
          line_total: capped * line.unit_cost,
        };
      });
      return next;
    });
  }

  function handleRemoveTransferLine(lineKey: string) {
    setTransferDraft((current) => {
      if (!current) return current;
      const next = cloneTransferDraft(current);
      next.lines = next.lines.filter((line) => line.key !== lineKey);
      return next;
    });
  }

  function handleClearTransferDraft() {
    setTransferDraft(createStockTransferDraft(selectedTransferSourceWarehouse, selectedTransferTargetWarehouse));
    setTransferSearch("");
  }

  async function handlePostTransfer() {
    if (!transferDraft) return;
    try {
      setPostingTransfer(true);
      actionFeedback.begin(`Posting stock transfer ${transferDraft.transfer_no}...`);
      await postStockTransfer(transferDraft);
      const warehouseRows = warehouses.length ? warehouses : await reloadWarehouses();
      const [stockRows, transferRows, movementRows, onHand] = await Promise.all([
        reloadTransferStock(transferSourceId || undefined),
        reloadTransfers(),
        reloadMovements(movementWarehouseId || undefined),
        reloadOnHand(warehouseRows),
      ]);
      const onHandStock = await reloadOnHandStock(onHandWarehouseId || undefined);
      setSourceStockRows(stockRows);
      setStockTransfers(transferRows);
      setMovementRows(movementRows);
      setOnHandRows(onHand);
      setOnHandStockRows(onHandStock);
      setTransferDraft(createStockTransferDraft(selectedTransferSourceWarehouse, selectedTransferTargetWarehouse));
      actionFeedback.succeed(`Stock transfer ${transferDraft.transfer_no} posted.`);
    } catch (caught) {
      actionFeedback.fail(caught instanceof Error ? caught.message : "Stock transfer post failed");
    } finally {
      setPostingTransfer(false);
    }
  }

  return (
    <div className="page-stack">
      <div className="module-tabs">
        {(["Warehouses", "Purchase Receives", "Stock Movements", "On Hand", "Transfers"] as InventoryTab[]).map((tab) => (
          <button key={tab} className={`module-tab${activeTab === tab ? " active" : ""}`} onClick={() => setActiveTab(tab)}>
            {tab}
          </button>
        ))}
      </div>

      {activeTab === "Warehouses" ? (
        <div className="page-stack">
          <SectionCard title="Warehouses">
            <div className="toolbar">
              <Button className="button--compact" onClick={handleNewWarehouse}>
                + Add Warehouse
              </Button>
            </div>
            <div className="meta-row">
              <span>{warehouses.length.toLocaleString("en-US")} warehouses</span>
              <span>{loadingOnHand ? "Loading live warehouse counts..." : "Open a warehouse to edit setup and review current item count."}</span>
            </div>
            {warehouses.length ? (
              <div className="warehouse-list-grid">
                {onHandRows.map((warehouse) => (
                  <button
                    key={warehouse.warehouse_id}
                    className={`warehouse-card${selectedWarehouseId === warehouse.warehouse_id ? " active" : ""}`}
                    onClick={() => {
                      const base = warehouses.find((item) => item.id === warehouse.warehouse_id);
                      if (base) selectWarehouse(base);
                    }}
                  >
                    <div className="warehouse-card__top">
                      <div>
                        <strong>{warehouse.warehouse_name || warehouse.warehouse_code}</strong>
                        <div className="warehouse-card__code">{warehouse.warehouse_code || "-"}</div>
                      </div>
                      <span className={`mark-badge ${warehouses.find((item) => item.id === warehouse.warehouse_id)?.is_active ? "mark-badge--success" : ""}`}>
                        {warehouses.find((item) => item.id === warehouse.warehouse_id)?.is_active ? "ACTIVE" : "CLOSED"}
                      </span>
                    </div>
                    <div className="warehouse-card__meta">{warehouse.region || "-"}</div>
                    <div className="warehouse-card__stats">
                      <span>{warehouse.sku_count.toLocaleString("en-US")} items</span>
                      <span>{warehouse.on_hand_qty.toLocaleString("en-US")} on hand</span>
                    </div>
                  </button>
                ))}
              </div>
            ) : (
              <div className="empty-state">No warehouses yet.</div>
            )}
          </SectionCard>

          {showWarehouseEditor && draft ? (
            <SectionCard title="Warehouse Setup">
              <div className="toolbar">
                <Button variant="secondary" onClick={handleCloseWarehouseEditor}>
                  Exit
                </Button>
                <Button onClick={() => void handleSave()} busy={saving} busyLabel="Saving...">
                  Save
                </Button>
              </div>
              <div className="customers-edit-card customers-edit-card--narrow">
                <div className="customers-form-row">
                  <div className="customers-form-row__label">Warehouse Code</div>
                  <div className="customers-field-wrap customers-field-wrap--medium">
                    <Input value={draft.warehouse_code} onChange={(value) => setDraft((current) => (current ? { ...current, warehouse_code: value } : current))} />
                  </div>
                </div>
                <div className="customers-form-row">
                  <div className="customers-form-row__label">Warehouse Name</div>
                  <div className="customers-field-wrap customers-field-wrap--wide">
                    <Input value={draft.warehouse_name} onChange={(value) => setDraft((current) => (current ? { ...current, warehouse_name: value } : current))} />
                  </div>
                </div>
                <div className="customers-form-row">
                  <div className="customers-form-row__label">Region</div>
                  <div className="customers-field-wrap customers-field-wrap--wide">
                    <Input value={draft.region} onChange={(value) => setDraft((current) => (current ? { ...current, region: value } : current))} />
                  </div>
                </div>
                <div className="customers-form-row customers-form-row--top">
                  <div className="customers-form-row__label">Address</div>
                  <div className="customers-field-wrap customers-field-wrap--full">
                    <label className="field customer-field">
                      <textarea className="field__input field__input--textarea" value={draft.address} onChange={(event) => setDraft((current) => (current ? { ...current, address: event.target.value } : current))} />
                    </label>
                  </div>
                </div>
                <div className="customers-form-row">
                  <div className="customers-form-row__label">Status</div>
                  <div className="customers-field-wrap customers-field-wrap--medium">
                    <label className="field customer-field">
                      <select className="field__input" value={draft.is_active ? "active" : "closed"} onChange={(event) => setDraft((current) => (current ? { ...current, is_active: event.target.value === "active" } : current))}>
                        <option value="active">Active</option>
                        <option value="closed">Closed</option>
                      </select>
                    </label>
                  </div>
                </div>
              </div>
            </SectionCard>
          ) : null}
        </div>
      ) : null}

      {activeTab === "Purchase Receives" ? (
        <div className="customers-shell">
          <aside className="customers-sidebar">
            <div className="customers-sidebar__header">
              <h3>Purchase Receives</h3>
            </div>
            <div className="customers-list">
              {loadingOrders || loadingReceives ? <div className="empty-state">Loading purchase receives...</div> : null}
              {!loadingOrders && !loadingReceives && receiveCandidates.length ? (
                receiveCandidates.map((purchaseOrder) => {
                  const summaryDraft = buildPurchaseReceiveDraft(purchaseOrder, null, purchaseReceives);
                  const remainingQty = summaryDraft.lines.reduce((sum, line) => sum + line.qty_remaining_before, 0);
                  return (
                    <button
                      key={purchaseOrder.id}
                      className={`customers-list__item${selectedReceive?.id === purchaseOrder.id ? " active" : ""}`}
                      onClick={() => setSelectedReceiveId(purchaseOrder.id)}
                    >
                      <strong>{purchaseOrder.id}</strong>
                      <span>{purchaseOrder.supplier_name} · {purchaseOrder.status}</span>
                      <span>{remainingQty.toLocaleString("en-US")} qty remaining</span>
                    </button>
                  );
                })
              ) : null}
              {!loadingOrders && !loadingReceives && !receiveCandidates.length ? <div className="empty-state">No purchase orders ready for receiving.</div> : null}
            </div>
          </aside>

          <section className="customers-editor">
            <div className="customers-editor__header">
              <h2>Receive Into Warehouse</h2>
              <div className="toolbar">
                <Select value={receiveWarehouseId} options={warehouseOptions} onChange={setReceiveWarehouseId} />
                <Button onClick={() => void handlePostReceive()} busy={postingReceive} busyLabel="Posting...">
                  Put to Stock
                </Button>
              </div>
            </div>
            {selectedReceive && receiveDraft ? (
              <div className="page-stack">
                <div className="settings-grid settings-stats-grid">
                  <div className="settings-item">
                    <span className="settings-label">Purchase Order</span>
                    <strong>{selectedReceive.id}</strong>
                  </div>
                  <div className="settings-item">
                    <span className="settings-label">Supplier</span>
                    <strong>{selectedReceive.supplier_name}</strong>
                  </div>
                  <div className="settings-item">
                    <span className="settings-label">Target Warehouse</span>
                    <strong>{selectedReceiveWarehouse?.warehouse_name || "-"}</strong>
                  </div>
                  <div className="settings-item">
                    <span className="settings-label">Currency</span>
                    <strong>{selectedReceive.currency}</strong>
                  </div>
                  <div className="settings-item">
                    <span className="settings-label">Receive Qty</span>
                    <strong>{receiveDraftTotals.qty.toLocaleString("en-US")}</strong>
                  </div>
                  <div className="settings-item">
                    <span className="settings-label">Receive Amount</span>
                    <strong>{formatMoney(receiveDraftTotals.amount)}</strong>
                  </div>
                </div>

                <SectionCard title="Receive Lines">
                  <div className="table-wrap">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>Code</th>
                          <th>Brand</th>
                          <th>Description</th>
                          <th>Ordered</th>
                          <th>Remaining</th>
                          <th>Receive Now</th>
                          <th>Unit Cost</th>
                          <th>Line Total</th>
                        </tr>
                      </thead>
                      <tbody>
                        {receiveDraft.lines.map((line) => (
                          <tr key={line.key}>
                            <td>{line.product_code || line.old_code || "-"}</td>
                            <td>{line.brand || "-"}</td>
                            <td>{line.description || "-"}</td>
                            <td>{line.qty_ordered.toLocaleString("en-US")}</td>
                            <td>{line.qty_remaining_before.toLocaleString("en-US")}</td>
                            <td>
                              <label className="field">
                                <input
                                  className="field__input inventory-number-input"
                                  type="number"
                                  min="0"
                                  step="0.01"
                                  max={line.qty_remaining_before}
                                  value={String(line.qty_received)}
                                  onChange={(event) => handleReceiveDraftLineChange(line.key, "qty_received", event.target.value)}
                                />
                              </label>
                            </td>
                            <td>{formatMoney(line.unit_cost)}</td>
                            <td>{formatMoney(line.line_total)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </SectionCard>

                <SectionCard title="Receive Posting">
                  <div className="customers-form-row customers-form-row--top">
                    <div className="customers-form-row__label">Notes</div>
                    <div className="customers-field-wrap customers-field-wrap--full">
                      <label className="field customer-field">
                        <textarea
                          className="field__input field__input--textarea"
                          value={receiveDraft.notes}
                          onChange={(event) =>
                            setReceiveDraft((current) => (current ? { ...current, notes: event.target.value } : current))
                          }
                        />
                      </label>
                    </div>
                  </div>
                </SectionCard>

                <SectionCard title="Receive History">
                  <DataTable
                    rows={selectedOrderReceives}
                    columns={[
                      { key: "id", header: "Receive No", render: (row: PurchaseReceive) => row.id },
                      { key: "date", header: "Date", render: (row: PurchaseReceive) => formatDate(row.received_date) },
                      { key: "warehouse", header: "Warehouse", render: (row: PurchaseReceive) => row.warehouse_name || row.warehouse_code || "-" },
                      { key: "qty", header: "Qty", render: (row: PurchaseReceive) => row.total_qty.toLocaleString("en-US") },
                      { key: "amount", header: "Amount", render: (row: PurchaseReceive) => formatMoney(row.total_amount) },
                      { key: "status", header: "Status", render: (row: PurchaseReceive) => row.status.toUpperCase() },
                    ]}
                    emptyText="No posted receives yet."
                  />
                </SectionCard>
              </div>
            ) : (
              <SectionCard title="Purchase Receives">
                <div className="empty-state">No purchase order selected.</div>
              </SectionCard>
            )}
          </section>
        </div>
      ) : null}

      {activeTab === "Stock Movements" ? (
        <div className="page-stack">
          <SectionCard title="Stock Movements">
            <div className="toolbar toolbar--wrap">
              <Select value={movementWarehouseId} options={warehouseFilterOptions} onChange={setMovementWarehouseId} />
            </div>
            <div className="meta-row">
              <span>{movementRows.length.toLocaleString("en-US")} movement rows</span>
              <span>{loadingMovements ? "Refreshing movement ledger..." : "Live stock ledger created by posted purchase receives."}</span>
            </div>
            <DataTable rows={movementRows} columns={movementColumns} emptyText="No stock movement rows yet." />
          </SectionCard>
        </div>
      ) : null}

      {activeTab === "On Hand" ? (
        <div className="page-stack">
          <SectionCard title="On Hand">
            <div className="toolbar toolbar--wrap">
              <Select value={onHandWarehouseId} options={warehouseFilterOptions} onChange={setOnHandWarehouseId} />
            </div>
            <div className="meta-row">
              <span>{visibleOnHandRows.length.toLocaleString("en-US")} warehouse snapshots</span>
              <span>{loadingOnHand ? "Rebuilding on hand quantities..." : "Current on hand is computed from posted warehouse movements."}</span>
            </div>
            <DataTable rows={visibleOnHandRows} columns={onHandColumns} emptyText="No warehouse inventory snapshot yet." />
          </SectionCard>
          <SectionCard title="Warehouse Stock Detail">
            <div className="toolbar toolbar--wrap">
              <Input value={onHandStockSearch} onChange={setOnHandStockSearch} placeholder="Search code, description, brand" />
            </div>
            <div className="meta-row">
              <span>{visibleOnHandStockRows.length.toLocaleString("en-US")} stock rows</span>
              <span>
                {loadingOnHandStock
                  ? "Refreshing item-level stock detail..."
                  : onHandWarehouseId
                    ? "Item-level stock detail for the selected warehouse."
                    : "Select a warehouse above to narrow the stock detail."}
              </span>
            </div>
            <DataTable rows={visibleOnHandStockRows} columns={onHandStockColumns} emptyText="No item-level stock detail for the current selection." />
          </SectionCard>
        </div>
      ) : null}

      {activeTab === "Transfers" ? (
        <div className="page-stack">
          <SectionCard title="Transfers">
            <div className="page-stack">
              <div className="settings-grid">
                <Select label="Source Warehouse" value={transferSourceId} options={warehouseOptions} onChange={setTransferSourceId} />
                <Select label="Target Warehouse" value={transferTargetId} options={warehouseOptions} onChange={setTransferTargetId} />
              </div>

              <div className="toolbar toolbar--wrap">
                <Input label="Search Source Stock" value={transferSearch} onChange={setTransferSearch} placeholder="Code, description, brand" />
                <Button variant="secondary" onClick={handleClearTransferDraft}>
                  Clear Draft
                </Button>
                <Button onClick={() => void handlePostTransfer()} busy={postingTransfer} busyLabel="Posting...">
                  Post Transfer
                </Button>
              </div>

              <div className="settings-grid settings-stats-grid">
                <div className="settings-item">
                  <span className="settings-label">Transfer No</span>
                  <strong>{transferDraft?.transfer_no || "-"}</strong>
                </div>
                <div className="settings-item">
                  <span className="settings-label">Draft Lines</span>
                  <strong>{transferDraft?.lines.length.toLocaleString("en-US") || "0"}</strong>
                </div>
                <div className="settings-item">
                  <span className="settings-label">Transfer Qty</span>
                  <strong>{transferDraftTotals.qty.toLocaleString("en-US")}</strong>
                </div>
                <div className="settings-item">
                  <span className="settings-label">Transfer Value</span>
                  <strong>{formatMoney(transferDraftTotals.amount)}</strong>
                </div>
              </div>

              <SectionCard title="Source Stock">
                <div className="meta-row">
                  <span>{filteredTransferStockRows.length.toLocaleString("en-US")} source stock rows</span>
                  <span>{loadingTransferStock ? "Refreshing source warehouse stock..." : "Select a source row to add it into the transfer draft."}</span>
                </div>
                <DataTable
                  rows={filteredTransferStockRows}
                  columns={[
                    { key: "brand", header: "Brand", render: (row: WarehouseStockItem) => <BrandPill brand={row.brand} compact /> },
                    { key: "code", header: "Code", render: (row: WarehouseStockItem) => row.product_code || row.old_code || "-" },
                    { key: "description", header: "Description", render: (row: WarehouseStockItem) => row.description || "-" },
                    { key: "origin", header: "Origin", render: (row: WarehouseStockItem) => row.origin || "-" },
                    { key: "qty", header: "Available Qty", render: (row: WarehouseStockItem) => row.available_qty.toLocaleString("en-US") },
                    { key: "cost", header: "Avg Cost", render: (row: WarehouseStockItem) => formatMoney(row.average_cost) },
                    {
                      key: "action",
                      header: "Action",
                      render: (row: WarehouseStockItem) => (
                        <Button className="button--compact" variant="secondary" onClick={() => handleAddTransferItem(row)}>
                          Add
                        </Button>
                      ),
                    },
                  ]}
                  emptyText="No available stock in the selected source warehouse."
                />
              </SectionCard>

              <SectionCard title="Transfer Draft">
                {transferDraft?.lines.length ? (
                  <div className="table-wrap">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>Code</th>
                          <th>Brand</th>
                          <th>Description</th>
                          <th>Available</th>
                          <th>Transfer Qty</th>
                          <th>Unit Cost</th>
                          <th>Line Total</th>
                          <th>Action</th>
                        </tr>
                      </thead>
                      <tbody>
                        {transferDraft.lines.map((line) => (
                          <tr key={line.key}>
                            <td>{line.product_code || line.old_code || "-"}</td>
                            <td>{line.brand || "-"}</td>
                            <td>{line.description || "-"}</td>
                            <td>{line.available_qty.toLocaleString("en-US")}</td>
                            <td>
                              <label className="field">
                                <input
                                  className="field__input inventory-number-input"
                                  type="number"
                                  min="0"
                                  step="0.01"
                                  max={line.available_qty}
                                  value={String(line.qty_transferred)}
                                  onChange={(event) => handleTransferDraftLineChange(line.key, "qty_transferred", event.target.value)}
                                />
                              </label>
                            </td>
                            <td>{formatMoney(line.unit_cost)}</td>
                            <td>{formatMoney(line.line_total)}</td>
                            <td>
                              <Button className="button--compact" variant="secondary" onClick={() => handleRemoveTransferLine(line.key)}>
                                Remove
                              </Button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="empty-state">No transfer lines yet.</div>
                )}
              </SectionCard>

              <SectionCard title="Transfer Posting">
                <div className="customers-form-row">
                  <div className="customers-form-row__label">Transfer Date</div>
                  <div className="customers-field-wrap customers-field-wrap--medium">
                    <Input
                      type="date"
                      value={transferDraft?.transfer_date || ""}
                      onChange={(value) => setTransferDraft((current) => (current ? { ...current, transfer_date: value } : current))}
                    />
                  </div>
                </div>
                <div className="customers-form-row customers-form-row--top">
                  <div className="customers-form-row__label">Notes</div>
                  <div className="customers-field-wrap customers-field-wrap--full">
                    <label className="field customer-field">
                      <textarea
                        className="field__input field__input--textarea"
                        value={transferDraft?.notes || ""}
                        onChange={(event) => setTransferDraft((current) => (current ? { ...current, notes: event.target.value } : current))}
                      />
                    </label>
                  </div>
                </div>
              </SectionCard>

              <SectionCard title="Transfer History">
                <div className="meta-row">
                  <span>{stockTransfers.length.toLocaleString("en-US")} transfer records</span>
                  <span>{loadingTransfers ? "Refreshing transfer history..." : "Posted transfers create paired outbound and inbound warehouse movements."}</span>
                </div>
                <DataTable rows={stockTransfers} columns={transferHistoryColumns} emptyText="No stock transfers posted yet." />
              </SectionCard>
            </div>
          </SectionCard>
        </div>
      ) : null}
    </div>
  );
}
