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
import {
  createEmptyWarehouse,
  deleteWarehouseApiClient,
  fetchWarehouseApiClients,
  fetchWarehouses,
  rotateWarehouseApiClientToken,
  syncWarehouseExternalStock,
  upsertWarehouse,
  upsertWarehouseApiClient,
} from "../../infrastructure/api/warehousesApi";
import type { InventoryMovement, PurchaseReceive, StockTransfer, WarehouseOnHandRow, WarehouseStockItem } from "../../types/inventory";
import type { LocalPurchaseOrder } from "../../types/orders";
import type { Warehouse, WarehouseApiClient, WarehouseApiClientSecret } from "../../types/warehouses";
import { useActionFeedback } from "../components/common/ActionFeedback";
import { Button } from "../components/common/Button";
import { DataTable } from "../components/common/DataTable";
import { Input } from "../components/common/Input";
import { SectionCard } from "../components/common/SectionCard";
import { Select } from "../components/common/Select";
import { BrandPill } from "../components/common/BrandPill";
import { includesLooseText } from "../../domain/shared/normalize";
import { isUuid } from "../../infrastructure/api/organizationApi";
import { useI18n } from "../../i18n/I18nProvider";

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

function createEmptyWarehouseApiClient(warehouses: Warehouse[]): WarehouseApiClient {
  const defaultWarehouseId = warehouses.find((row) => row.is_active && row.fulfillment_model !== "dropship")?.id || "";
  return {
    id: "",
    client_name: "",
    partner_name: "",
    status: "active",
    allowed_ip_list: "",
    require_hmac: true,
    allow_order_submit: false,
    include_zero_stock: false,
    expose_unit_cost: false,
    notes: "",
    expires_at: "",
    api_key_prefix: "",
    last_used_at: "",
    last_used_ip: "",
    warehouse_ids: defaultWarehouseId ? [defaultWarehouseId] : [],
    warehouse_labels: [],
    created_at: "",
    updated_at: "",
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
  const { locale, t } = useI18n();
  const actionFeedback = useActionFeedback();
  const numberLocale = locale === "tr" ? "tr-TR" : "en-US";
  const formatCount = (value: number) => value.toLocaleString(numberLocale);
  const warehouseKindLabel = (value?: string | null) => (value === "outsourced" ? t("inventory.values.outsourced") : t("inventory.values.internal"));
  const fulfillmentLabel = (value?: string | null) => (value === "dropship" ? t("inventory.values.dropship") : t("inventory.values.stocked"));
  const warehouseStatusLabel = (value?: boolean | null) => (value ? t("inventory.values.active") : t("inventory.values.closed"));
  const apiStatusLabel = (value?: string | null) => (value === "disabled" ? t("inventory.values.disabled") : t("inventory.values.active"));
  const apiOrderLabel = (value?: boolean | null) => (value ? t("inventory.values.open") : t("inventory.values.closed"));
  const translateStatus = (value?: string | null) => {
    if (!value) return "-";
    return t(`inventory.statuses.${value}`);
  };
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
  const [syncingWarehouse, setSyncingWarehouse] = useState(false);
  const [showWarehouseEditor, setShowWarehouseEditor] = useState(false);
  const [receiveDraft, setReceiveDraft] = useState<PurchaseReceiveDraft | null>(null);
  const [transferDraft, setTransferDraft] = useState<StockTransferDraft | null>(null);
  const [warehouseApiClients, setWarehouseApiClients] = useState<WarehouseApiClient[]>([]);
  const [warehouseApiBaseUrl, setWarehouseApiBaseUrl] = useState("");
  const [warehouseApiHeaderName, setWarehouseApiHeaderName] = useState("x-api-key");
  const [warehouseApiDraft, setWarehouseApiDraft] = useState<WarehouseApiClient | null>(null);
  const [showWarehouseApiEditor, setShowWarehouseApiEditor] = useState(false);
  const [savingWarehouseApiClient, setSavingWarehouseApiClient] = useState(false);
  const [rotatingWarehouseApiClient, setRotatingWarehouseApiClient] = useState(false);
  const [latestWarehouseApiSecret, setLatestWarehouseApiSecret] = useState<WarehouseApiClientSecret | null>(null);

  async function reloadWarehouses() {
    const warehouseRows = await fetchWarehouses();
    setWarehouses(warehouseRows);
    return warehouseRows;
  }

  async function reloadWarehouseApiClients() {
    const payload = await fetchWarehouseApiClients();
    setWarehouseApiClients(payload.clients);
    setWarehouseApiBaseUrl(payload.apiBaseUrl);
    setWarehouseApiHeaderName(payload.headerName);
    return payload.clients;
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
        const [warehouseRows, warehouseApiPayload] = await Promise.all([
          fetchWarehouses(),
          fetchWarehouseApiClients().catch(() => ({ clients: [], apiBaseUrl: "", headerName: "x-api-key" })),
        ]);
        if (cancelled) return;
        setWarehouses(warehouseRows);
        setWarehouseApiClients(warehouseApiPayload.clients);
        setWarehouseApiBaseUrl(warehouseApiPayload.apiBaseUrl);
        setWarehouseApiHeaderName(warehouseApiPayload.headerName);

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
          actionFeedback.fail(caught instanceof Error ? caught.message : t("inventory.errors.loadFailed"));
        }
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [actionFeedback, t]);

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
          actionFeedback.fail(caught instanceof Error ? caught.message : t("inventory.errors.purchaseReceivesLoadFailed"));
        }
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [actionFeedback, activeTab, t]);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      if (activeTab !== "Stock Movements") return;
      try {
        const rows = await fetchInventoryMovements(movementWarehouseId || undefined);
        if (!cancelled) setMovementRows(rows);
      } catch (caught) {
        if (!cancelled) {
          actionFeedback.fail(caught instanceof Error ? caught.message : t("inventory.errors.movementsLoadFailed"));
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
  }, [actionFeedback, activeTab, movementWarehouseId, t]);

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
          actionFeedback.fail(caught instanceof Error ? caught.message : t("inventory.errors.onHandLoadFailed"));
        }
      } finally {
        if (!cancelled) setLoadingOnHand(false);
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [actionFeedback, activeTab, warehouses, t]);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      if (activeTab !== "On Hand") return;
      try {
        const rows = await fetchWarehouseStockItems(onHandWarehouseId || undefined);
        if (!cancelled) setOnHandStockRows(rows);
      } catch (caught) {
        if (!cancelled) {
          actionFeedback.fail(caught instanceof Error ? caught.message : t("inventory.errors.onHandStockLoadFailed"));
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
  }, [actionFeedback, activeTab, onHandWarehouseId, t]);

  const warehouseColumns = useMemo(
    () => [
      { key: "code", header: t("inventory.table.code"), render: (row: Warehouse) => row.warehouse_code || "-" },
      { key: "name", header: t("inventory.table.warehouse"), render: (row: Warehouse) => row.warehouse_name || "-" },
      { key: "type", header: t("inventory.table.type"), render: (row: Warehouse) => warehouseKindLabel(row.warehouse_kind) },
      { key: "fulfillment", header: t("inventory.table.fulfillment"), render: (row: Warehouse) => fulfillmentLabel(row.fulfillment_model) },
      { key: "region", header: t("inventory.table.region"), render: (row: Warehouse) => row.region || "-" },
      { key: "status", header: t("inventory.table.status"), render: (row: Warehouse) => warehouseStatusLabel(row.is_active) },
    ],
    [t],
  );

  const warehouseKindOptions = useMemo(
    () => [
      { value: "internal", label: t("inventory.values.internalWarehouse") },
      { value: "outsourced", label: t("inventory.values.outsourcedWarehouse") },
    ],
    [t],
  );

  const externalAuthTypeOptions = useMemo(
    () => [
      { value: "none", label: t("inventory.values.noAuth") },
      { value: "bearer_env", label: t("inventory.values.bearerTokenFromEnv") },
    ],
    [t],
  );

  const fulfillmentModelOptions = useMemo(
    () => [
      { value: "stocked", label: t("inventory.values.stockedFulfillment") },
      { value: "dropship", label: t("inventory.values.dropshipFulfillment") },
    ],
    [t],
  );

  const stockedWarehouseOptions = useMemo(
    () => [{ value: "", label: t("inventory.selects.selectWarehouse") }, ...warehouses.filter((row) => row.fulfillment_model !== "dropship").map((row) => ({ value: row.id, label: `${row.warehouse_code} · ${row.warehouse_name}` }))],
    [warehouses, t],
  );

  const warehouseFilterOptions = useMemo(
    () => [{ value: "", label: t("inventory.selects.allWarehouses") }, ...warehouses.map((row) => ({ value: row.id, label: `${row.warehouse_code} · ${row.warehouse_name}` }))],
    [warehouses, t],
  );

  const shareableWarehouses = useMemo(
    () => warehouses.filter((row) => row.is_active && row.fulfillment_model !== "dropship"),
    [warehouses],
  );

  const warehouseApiClientColumns = useMemo(
    () => [
      { key: "client", header: t("inventory.table.client"), render: (row: WarehouseApiClient) => row.client_name || "-" },
      { key: "partner", header: t("inventory.table.partner"), render: (row: WarehouseApiClient) => row.partner_name || "-" },
      { key: "warehouses", header: t("inventory.table.warehouses"), render: (row: WarehouseApiClient) => row.warehouse_labels.length || 0 },
      { key: "order", header: t("inventory.table.orderApi"), render: (row: WarehouseApiClient) => apiOrderLabel(row.allow_order_submit) },
      { key: "status", header: t("inventory.table.status"), render: (row: WarehouseApiClient) => apiStatusLabel(row.status) },
      { key: "key", header: t("inventory.table.keyPrefix"), render: (row: WarehouseApiClient) => row.api_key_prefix || "-" },
      { key: "last", header: t("inventory.table.lastUsed"), render: (row: WarehouseApiClient) => formatDate(row.last_used_at) },
    ],
    [t],
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
          actionFeedback.fail(caught instanceof Error ? caught.message : t("inventory.errors.transferLoadFailed"));
        }
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [actionFeedback, activeTab, transferSourceId, t]);

  const movementColumns = useMemo(
    () => [
      { key: "date", header: t("inventory.table.date"), render: (row: InventoryMovement) => formatDate(row.moved_at) },
      { key: "warehouse", header: t("inventory.table.warehouse"), render: (row: InventoryMovement) => row.warehouse_name || row.warehouse_code || "-" },
      { key: "type", header: t("inventory.table.type"), render: (row: InventoryMovement) => row.movement_type },
      { key: "document", header: t("inventory.table.document"), render: (row: InventoryMovement) => row.document_no || row.document_type || "-" },
      { key: "party", header: t("inventory.table.relatedParty"), render: (row: InventoryMovement) => row.related_party || "-" },
      { key: "brand", header: t("inventory.table.brand"), render: (row: InventoryMovement) => <BrandPill brand={row.brand} compact /> },
      { key: "code", header: t("inventory.table.code"), render: (row: InventoryMovement) => row.product_code || row.old_code || "-" },
      { key: "description", header: t("inventory.table.description"), render: (row: InventoryMovement) => row.description || "-" },
      { key: "qtyin", header: t("inventory.table.qtyIn"), render: (row: InventoryMovement) => formatCount(row.qty_in) },
      { key: "qtyout", header: t("inventory.table.qtyOut"), render: (row: InventoryMovement) => formatCount(row.qty_out) },
      { key: "cost", header: t("inventory.table.totalCost"), render: (row: InventoryMovement) => formatMoney(row.total_cost) },
    ],
    [t, numberLocale],
  );

  const onHandColumns = useMemo(
    () => [
      { key: "code", header: t("inventory.table.code"), render: (row: WarehouseOnHandRow) => row.warehouse_code || "-" },
      { key: "name", header: t("inventory.table.warehouse"), render: (row: WarehouseOnHandRow) => row.warehouse_name || "-" },
      { key: "region", header: t("inventory.table.region"), render: (row: WarehouseOnHandRow) => row.region || "-" },
      { key: "sku", header: t("inventory.table.skuCount"), render: (row: WarehouseOnHandRow) => formatCount(row.sku_count) },
      { key: "onhand", header: t("inventory.table.onHand"), render: (row: WarehouseOnHandRow) => formatCount(row.on_hand_qty) },
      { key: "reserved", header: t("inventory.table.reserved"), render: (row: WarehouseOnHandRow) => formatCount(row.reserved_qty) },
      { key: "available", header: t("inventory.table.available"), render: (row: WarehouseOnHandRow) => formatCount(row.available_qty) },
    ],
    [t, numberLocale],
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
      { key: "date", header: t("inventory.table.date"), render: (row: StockTransfer) => formatDate(row.transfer_date) },
      { key: "transfer", header: t("inventory.table.transferNo"), render: (row: StockTransfer) => row.transfer_no || row.id },
      { key: "source", header: t("inventory.table.source"), render: (row: StockTransfer) => row.source_warehouse_name || row.source_warehouse_code || "-" },
      { key: "target", header: t("inventory.table.target"), render: (row: StockTransfer) => row.target_warehouse_name || row.target_warehouse_code || "-" },
      { key: "qty", header: t("inventory.table.qty"), render: (row: StockTransfer) => formatCount(row.total_qty) },
      { key: "amount", header: t("inventory.table.value"), render: (row: StockTransfer) => formatMoney(row.total_amount) },
      { key: "status", header: t("inventory.table.status"), render: (row: StockTransfer) => translateStatus(row.status) },
    ],
    [t, numberLocale],
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
      { key: "brand", header: t("inventory.table.brand"), render: (row: WarehouseStockItem) => <BrandPill brand={row.brand} compact /> },
      { key: "code", header: t("inventory.table.code"), render: (row: WarehouseStockItem) => row.product_code || row.old_code || "-" },
      { key: "description", header: t("inventory.table.description"), render: (row: WarehouseStockItem) => row.description || "-" },
      { key: "origin", header: t("inventory.table.origin"), render: (row: WarehouseStockItem) => row.origin || "-" },
      { key: "onhand", header: t("inventory.table.onHand"), render: (row: WarehouseStockItem) => formatCount(row.on_hand_qty) },
      { key: "available", header: t("inventory.table.available"), render: (row: WarehouseStockItem) => formatCount(row.available_qty) },
      { key: "avgcost", header: t("inventory.table.avgCost"), render: (row: WarehouseStockItem) => formatMoney(row.average_cost) },
      { key: "value", header: t("inventory.table.stockValue"), render: (row: WarehouseStockItem) => formatMoney(row.stock_value) },
      { key: "last", header: t("inventory.table.lastMove"), render: (row: WarehouseStockItem) => formatDate(row.last_moved_at) },
    ],
    [t, numberLocale],
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
      actionFeedback.fail(t("inventory.errors.warehouseCodeAndNameRequired"));
      return;
    }
    try {
      setSaving(true);
      actionFeedback.begin(t("inventory.status.savingWarehouse", { warehouse: draft.warehouse_name || draft.warehouse_code }));
      const saved = await upsertWarehouse(draft);
      const rows = await reloadWarehouses();
      setSelectedWarehouseId(saved.id);
      setDraft(saved);
      setReceiveWarehouseId((current) => current || saved.id);
      setMovementWarehouseId((current) => current || saved.id);
      setTransferSourceId((current) => current || saved.id);
      setTransferTargetId((current) => current || saved.id);
      await reloadOnHand(rows);
      actionFeedback.succeed(t("inventory.status.warehouseSaved", { warehouse: saved.warehouse_name || saved.warehouse_code }));
    } catch (caught) {
      actionFeedback.fail(caught instanceof Error ? caught.message : t("inventory.errors.warehouseSaveFailed"));
    } finally {
      setSaving(false);
    }
  }

  async function handleSyncWarehouse() {
    if (!draft || !isUuid(draft.id)) {
      actionFeedback.fail(t("inventory.errors.saveWarehouseFirstBeforeSync"));
      return;
    }
    try {
      setSyncingWarehouse(true);
      actionFeedback.begin(t("inventory.status.syncingOutsourcedWarehouse", { warehouse: draft.warehouse_name || draft.warehouse_code }));
      const result = await syncWarehouseExternalStock(draft.id);
      const warehouseRows = await reloadWarehouses();
      const [onHand, movementRows, onHandStockRows] = await Promise.all([
        reloadOnHand(warehouseRows),
        reloadMovements(movementWarehouseId || undefined),
        reloadOnHandStock(onHandWarehouseId || undefined),
      ]);
      const refreshed = result.warehouse || warehouseRows.find((row) => row.id === draft.id) || draft;
      setDraft(refreshed);
      setWarehouses(warehouseRows);
      setOnHandRows(onHand);
      setMovementRows(movementRows);
      setOnHandStockRows(onHandStockRows);
      actionFeedback.succeed(
        t("inventory.status.warehouseSyncComplete", {
          adjustments: formatCount(result.summary.adjustmentCount),
          accepted: formatCount(result.summary.acceptedItemCount),
        }),
      );
    } catch (caught) {
      actionFeedback.fail(caught instanceof Error ? caught.message : t("inventory.errors.warehouseSyncFailed"));
    } finally {
      setSyncingWarehouse(false);
    }
  }

  function handleCloseWarehouseEditor() {
    setShowWarehouseEditor(false);
    if (selectedWarehouseId) {
      const current = warehouses.find((item) => item.id === selectedWarehouseId);
      if (current) setDraft(current);
    }
  }

  function handleNewWarehouseApiClient() {
    setWarehouseApiDraft(createEmptyWarehouseApiClient(shareableWarehouses));
    setLatestWarehouseApiSecret(null);
    setShowWarehouseApiEditor(true);
  }

  function handleSelectWarehouseApiClient(row: WarehouseApiClient) {
    setWarehouseApiDraft(row);
    setLatestWarehouseApiSecret(null);
    setShowWarehouseApiEditor(true);
  }

  function handleCloseWarehouseApiEditor() {
    setShowWarehouseApiEditor(false);
    setLatestWarehouseApiSecret(null);
  }

  function toggleWarehouseApiDraftWarehouse(warehouseId: string, checked: boolean) {
    setWarehouseApiDraft((current) => {
      if (!current) return current;
      const currentIds = new Set(current.warehouse_ids);
      if (checked) currentIds.add(warehouseId);
      else currentIds.delete(warehouseId);
      return {
        ...current,
        warehouse_ids: [...currentIds],
      };
    });
  }

  async function handleSaveWarehouseApiClient() {
    if (!warehouseApiDraft) return;
    if (!warehouseApiDraft.client_name.trim() || !warehouseApiDraft.partner_name.trim()) {
      actionFeedback.fail(t("inventory.errors.clientNameAndPartnerNameRequired"));
      return;
    }
    if (!warehouseApiDraft.warehouse_ids.length) {
      actionFeedback.fail(t("inventory.errors.selectAtLeastOneStockedWarehouse"));
      return;
    }
    try {
      setSavingWarehouseApiClient(true);
      actionFeedback.begin(t("inventory.status.savingApiClient", { client: warehouseApiDraft.client_name || warehouseApiDraft.partner_name }));
      const result = await upsertWarehouseApiClient({
        id: warehouseApiDraft.id || undefined,
        client_name: warehouseApiDraft.client_name,
        partner_name: warehouseApiDraft.partner_name,
        status: warehouseApiDraft.status,
        allowed_ip_list: warehouseApiDraft.allowed_ip_list,
        require_hmac: warehouseApiDraft.require_hmac,
        allow_order_submit: warehouseApiDraft.allow_order_submit,
        include_zero_stock: warehouseApiDraft.include_zero_stock,
        expose_unit_cost: warehouseApiDraft.expose_unit_cost,
        notes: warehouseApiDraft.notes,
        expires_at: warehouseApiDraft.expires_at,
        warehouse_ids: warehouseApiDraft.warehouse_ids,
      });
      const clients = await reloadWarehouseApiClients();
      const saved = result.client || clients.find((row) => row.id === warehouseApiDraft.id) || null;
      if (saved) setWarehouseApiDraft(saved);
      setLatestWarehouseApiSecret(result.secret);
      actionFeedback.succeed(t("inventory.status.apiClientSaved", { client: saved?.client_name || warehouseApiDraft.client_name }));
    } catch (caught) {
      actionFeedback.fail(caught instanceof Error ? caught.message : t("inventory.errors.apiClientSaveFailed"));
    } finally {
      setSavingWarehouseApiClient(false);
    }
  }

  async function handleRotateWarehouseApiClient() {
    if (!warehouseApiDraft?.id || !isUuid(warehouseApiDraft.id)) {
      actionFeedback.fail(t("inventory.errors.saveApiClientFirstBeforeRotate"));
      return;
    }
    try {
      setRotatingWarehouseApiClient(true);
      actionFeedback.begin(t("inventory.status.rotatingApiKey", { client: warehouseApiDraft.client_name || warehouseApiDraft.partner_name }));
      const result = await rotateWarehouseApiClientToken(warehouseApiDraft.id);
      const clients = await reloadWarehouseApiClients();
      const saved = result.client || clients.find((row) => row.id === warehouseApiDraft.id) || null;
      if (saved) setWarehouseApiDraft(saved);
      setLatestWarehouseApiSecret(result.secret);
      actionFeedback.succeed(t("inventory.status.apiKeyRotated"));
    } catch (caught) {
      actionFeedback.fail(caught instanceof Error ? caught.message : t("inventory.errors.apiKeyRotationFailed"));
    } finally {
      setRotatingWarehouseApiClient(false);
    }
  }

  async function handleDeleteWarehouseApiClient() {
    if (!warehouseApiDraft?.id || !isUuid(warehouseApiDraft.id)) {
      handleCloseWarehouseApiEditor();
      return;
    }
    if (!window.confirm(t("inventory.confirm.deleteApiClient", { client: warehouseApiDraft.client_name || warehouseApiDraft.partner_name }))) return;
    try {
      setSavingWarehouseApiClient(true);
      actionFeedback.begin(t("inventory.status.deletingApiClient", { client: warehouseApiDraft.client_name || warehouseApiDraft.partner_name }));
      await deleteWarehouseApiClient(warehouseApiDraft.id);
      await reloadWarehouseApiClients();
      setWarehouseApiDraft(null);
      setLatestWarehouseApiSecret(null);
      setShowWarehouseApiEditor(false);
      actionFeedback.succeed(t("inventory.status.apiClientDeleted"));
    } catch (caught) {
      actionFeedback.fail(caught instanceof Error ? caught.message : t("inventory.errors.apiClientDeleteFailed"));
    } finally {
      setSavingWarehouseApiClient(false);
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
      actionFeedback.begin(t("inventory.status.postingPurchaseReceive", { purchaseOrder: receiveDraft.purchase_order_no }));
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
      actionFeedback.succeed(t("inventory.status.purchaseReceivePosted", { purchaseOrder: receiveDraft.purchase_order_no }));
    } catch (caught) {
      actionFeedback.fail(caught instanceof Error ? caught.message : t("inventory.errors.purchaseReceivePostFailed"));
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
      actionFeedback.begin(t("inventory.status.postingStockTransfer", { transfer: transferDraft.transfer_no }));
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
      actionFeedback.succeed(t("inventory.status.stockTransferPosted", { transfer: transferDraft.transfer_no }));
    } catch (caught) {
      actionFeedback.fail(caught instanceof Error ? caught.message : t("inventory.errors.stockTransferPostFailed"));
    } finally {
      setPostingTransfer(false);
    }
  }

  return (
    <div className="page-stack">
      {activeTab === "Warehouses" ? (
        <div className="page-stack">
          <SectionCard title={t("inventory.sections.warehouses")}>
            <div className="toolbar">
              <Button className="button--compact" onClick={handleNewWarehouse}>
                {t("inventory.actions.addWarehouse")}
              </Button>
            </div>
            <div className="meta-row">
              <span>{t("inventory.status.warehouseCount", { count: formatCount(warehouses.length) })}</span>
              <span>{loadingOnHand ? t("inventory.status.loadingWarehouseCounts") : t("inventory.status.openWarehouseHint")}</span>
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
                        {warehouses.find((item) => item.id === warehouse.warehouse_id)?.is_active ? t("inventory.values.activeUpper") : t("inventory.values.closedUpper")}
                      </span>
                    </div>
                    <div className="warehouse-card__meta">
                      <span>{warehouse.region || "-"}</span>
                      <span>{(warehouses.find((item) => item.id === warehouse.warehouse_id)?.warehouse_kind || "internal") === "outsourced" ? t("inventory.values.outsourcedUpper") : t("inventory.values.internalUpper")}</span>
                      <span>{(warehouses.find((item) => item.id === warehouse.warehouse_id)?.fulfillment_model || "stocked") === "dropship" ? t("inventory.values.dropshipUpper") : t("inventory.values.stockedUpper")}</span>
                    </div>
                    <div className="warehouse-card__stats">
                      <span>{t("inventory.status.itemsCount", { count: formatCount(warehouse.sku_count) })}</span>
                      <span>{t("inventory.status.onHandCount", { count: formatCount(warehouse.on_hand_qty) })}</span>
                    </div>
                  </button>
                ))}
              </div>
            ) : (
              <div className="empty-state">{t("inventory.empty.noWarehouses")}</div>
            )}
          </SectionCard>

          {showWarehouseEditor && draft ? (
            <SectionCard title={t("inventory.sections.warehouseSetup")}>
              <div className="toolbar">
                <Button variant="secondary" onClick={handleCloseWarehouseEditor}>
                  {t("inventory.actions.exit")}
                </Button>
                {draft.warehouse_kind === "outsourced" && draft.fulfillment_model !== "dropship" ? (
                  <Button variant="secondary" onClick={() => void handleSyncWarehouse()} busy={syncingWarehouse} busyLabel={t("inventory.actions.syncing")}>
                    {t("inventory.actions.syncApiStock")}
                  </Button>
                ) : null}
                <Button onClick={() => void handleSave()} busy={saving} busyLabel={t("inventory.actions.saving")}>
                  {t("inventory.actions.save")}
                </Button>
              </div>
              <div className="customers-edit-card customers-edit-card--narrow">
                <div className="customers-form-row">
                  <div className="customers-form-row__label">{t("inventory.labels.warehouseCode")}</div>
                  <div className="customers-field-wrap customers-field-wrap--medium">
                    <Input value={draft.warehouse_code} onChange={(value) => setDraft((current) => (current ? { ...current, warehouse_code: value } : current))} />
                  </div>
                </div>
                <div className="customers-form-row">
                  <div className="customers-form-row__label">{t("inventory.labels.warehouseName")}</div>
                  <div className="customers-field-wrap customers-field-wrap--wide">
                    <Input value={draft.warehouse_name} onChange={(value) => setDraft((current) => (current ? { ...current, warehouse_name: value } : current))} />
                  </div>
                </div>
                <div className="customers-form-row">
                  <div className="customers-form-row__label">{t("inventory.labels.region")}</div>
                  <div className="customers-field-wrap customers-field-wrap--wide">
                    <Input value={draft.region} onChange={(value) => setDraft((current) => (current ? { ...current, region: value } : current))} />
                  </div>
                </div>
                <div className="customers-form-row">
                  <div className="customers-form-row__label">{t("inventory.labels.warehouseType")}</div>
                  <div className="customers-field-wrap customers-field-wrap--medium">
                    <Select
                      value={draft.warehouse_kind}
                      options={warehouseKindOptions}
                      onChange={(value) =>
                        setDraft((current) =>
                          current
                            ? {
                                ...current,
                                warehouse_kind: value === "outsourced" ? "outsourced" : "internal",
                                external_sync_enabled:
                                  value === "outsourced" ? current.external_sync_enabled : false,
                              }
                            : current,
                        )
                      }
                    />
                  </div>
                </div>
                <div className="customers-form-row">
                  <div className="customers-form-row__label">{t("inventory.labels.fulfillmentModel")}</div>
                  <div className="customers-field-wrap customers-field-wrap--medium">
                    <Select
                      value={draft.fulfillment_model}
                      options={fulfillmentModelOptions}
                      onChange={(value) =>
                        setDraft((current) =>
                          current
                            ? {
                                ...current,
                                fulfillment_model: value === "dropship" ? "dropship" : "stocked",
                                external_sync_enabled:
                                  value === "dropship" ? false : current.external_sync_enabled,
                              }
                            : current,
                        )
                      }
                    />
                  </div>
                </div>
                <div className="customers-form-row customers-form-row--top">
                  <div className="customers-form-row__label">{t("inventory.labels.address")}</div>
                  <div className="customers-field-wrap customers-field-wrap--full">
                    <label className="field customer-field">
                      <textarea className="field__input field__input--textarea" value={draft.address} onChange={(event) => setDraft((current) => (current ? { ...current, address: event.target.value } : current))} />
                    </label>
                  </div>
                </div>
                <div className="customers-form-row">
                  <div className="customers-form-row__label">{t("inventory.labels.status")}</div>
                  <div className="customers-field-wrap customers-field-wrap--medium">
                    <label className="field customer-field">
                      <select className="field__input" value={draft.is_active ? "active" : "closed"} onChange={(event) => setDraft((current) => (current ? { ...current, is_active: event.target.value === "active" } : current))}>
                        <option value="active">{t("inventory.values.active")}</option>
                        <option value="closed">{t("inventory.values.closed")}</option>
                      </select>
                    </label>
                  </div>
                </div>
                {draft.fulfillment_model === "dropship" ? (
                  <div className="warning-text">
                    {t("inventory.warnings.dropshipNoStock")}
                  </div>
                ) : null}
                {draft.warehouse_kind === "outsourced" ? (
                  <>
                    <div className="customers-form-row">
                      <div className="customers-form-row__label">{t("inventory.labels.outsourcePartner")}</div>
                      <div className="customers-field-wrap customers-field-wrap--wide">
                        <Input value={draft.outsource_partner_name} onChange={(value) => setDraft((current) => (current ? { ...current, outsource_partner_name: value } : current))} />
                      </div>
                    </div>
                    <div className="customers-form-row">
                      <div className="customers-form-row__label">{t("inventory.labels.apiProvider")}</div>
                      <div className="customers-field-wrap customers-field-wrap--wide">
                        <Input value={draft.external_api_provider} placeholder={t("inventory.placeholders.apiProvider")} onChange={(value) => setDraft((current) => (current ? { ...current, external_api_provider: value } : current))} />
                      </div>
                    </div>
                    <div className="customers-form-row">
                      <div className="customers-form-row__label">{t("inventory.labels.apiUrl")}</div>
                      <div className="customers-field-wrap customers-field-wrap--full">
	                        <Input
	                          value={draft.external_api_url}
	                          placeholder={t("inventory.placeholders.apiUrl")}
	                          onChange={(value) => setDraft((current) => (current ? { ...current, external_api_url: value } : current))}
	                        />
                      </div>
                    </div>
                    <div className="customers-form-row">
                      <div className="customers-form-row__label">{t("inventory.labels.locationCode")}</div>
                      <div className="customers-field-wrap customers-field-wrap--medium">
                        <Input value={draft.external_location_code} onChange={(value) => setDraft((current) => (current ? { ...current, external_location_code: value } : current))} />
                      </div>
                    </div>
                    <div className="customers-form-row">
                      <div className="customers-form-row__label">{t("inventory.labels.authType")}</div>
                      <div className="customers-field-wrap customers-field-wrap--medium">
                        <Select
                          value={draft.external_auth_type}
                          options={externalAuthTypeOptions}
                          onChange={(value) =>
                            setDraft((current) =>
                              current
                                ? {
                                    ...current,
                                    external_auth_type: value === "bearer_env" ? "bearer_env" : "none",
                                    external_api_token_env:
                                      value === "bearer_env" ? current.external_api_token_env : "",
                                  }
                                : current,
                            )
                          }
                        />
                      </div>
                    </div>
                    {draft.external_auth_type === "bearer_env" ? (
                      <div className="customers-form-row">
                        <div className="customers-form-row__label">{t("inventory.labels.tokenEnvName")}</div>
                        <div className="customers-field-wrap customers-field-wrap--medium">
	                          <Input value={draft.external_api_token_env} placeholder={t("inventory.placeholders.tokenEnvName")} onChange={(value) => setDraft((current) => (current ? { ...current, external_api_token_env: value } : current))} />
                        </div>
                      </div>
                    ) : null}
                    {draft.fulfillment_model !== "dropship" ? (
                      <div className="customers-form-row">
                        <div className="customers-form-row__label">{t("inventory.labels.syncMode")}</div>
                        <div className="customers-field-wrap customers-field-wrap--medium">
                          <label className="field customer-field">
                            <select
                              className="field__input"
                              value={draft.external_sync_enabled ? "enabled" : "disabled"}
                              onChange={(event) =>
                                setDraft((current) =>
                                  current
                                    ? { ...current, external_sync_enabled: event.target.value === "enabled" }
                                    : current,
                                )
                              }
                            >
                              <option value="enabled">{t("inventory.values.manualApiSyncEnabled")}</option>
                              <option value="disabled">{t("inventory.values.disabled")}</option>
                            </select>
                          </label>
                        </div>
                      </div>
                    ) : null}
                    <div className="settings-grid settings-stats-grid">
                      <div className="settings-item">
                        <span className="settings-label">{t("inventory.labels.lastSync")}</span>
                        <strong>{draft.external_last_sync_at ? formatDate(draft.external_last_sync_at) : "-"}</strong>
                      </div>
                      <div className="settings-item">
                        <span className="settings-label">{t("inventory.labels.syncStatus")}</span>
                        <strong>{draft.external_last_sync_status || t("inventory.values.notSynced")}</strong>
                      </div>
                      <div className="settings-item">
                        <span className="settings-label">{t("inventory.labels.syncMessage")}</span>
                        <strong>{draft.external_last_sync_message || t("inventory.values.waitingForFirstSync")}</strong>
                      </div>
                    </div>
                    <div className="meta-row">
                      <span>{t("inventory.api.expectedPayload")}</span>
                      <span>{t("inventory.api.supportedFields")}</span>
                    </div>
                  </>
                ) : null}
              </div>
            </SectionCard>
          ) : null}

          <SectionCard title={t("inventory.sections.partnerApiClients")}>
            <div className="toolbar">
              <Button className="button--compact" onClick={handleNewWarehouseApiClient}>
                {t("inventory.actions.addApiClient")}
              </Button>
            </div>
            <div className="meta-row">
              <span>{t("inventory.status.apiClientCount", { count: formatCount(warehouseApiClients.length) })}</span>
              <span>{warehouseApiBaseUrl || t("inventory.status.saveClientToGenerateCredentials")}</span>
            </div>
            <DataTable rows={warehouseApiClients} columns={warehouseApiClientColumns} emptyText={t("inventory.empty.noPartnerApiClients")} onRowClick={handleSelectWarehouseApiClient} />

            {showWarehouseApiEditor && warehouseApiDraft ? (
              <div className="customers-edit-card customers-edit-card--narrow warehouse-api-editor">
                <div className="toolbar">
	                  <Button variant="secondary" onClick={handleCloseWarehouseApiEditor}>
	                    {t("inventory.actions.exit")}
	                  </Button>
	                  {warehouseApiDraft.id ? (
	                    <Button variant="secondary" onClick={() => void handleRotateWarehouseApiClient()} busy={rotatingWarehouseApiClient} busyLabel={t("inventory.actions.rotating")}>
	                      {t("inventory.actions.rotateApiKey")}
	                    </Button>
	                  ) : null}
	                  {warehouseApiDraft.id ? (
	                    <Button variant="secondary" onClick={() => void handleDeleteWarehouseApiClient()} busy={savingWarehouseApiClient} busyLabel={t("inventory.actions.deleting")}>
	                      {t("inventory.actions.delete")}
	                    </Button>
	                  ) : null}
	                  <Button onClick={() => void handleSaveWarehouseApiClient()} busy={savingWarehouseApiClient} busyLabel={t("inventory.actions.saving")}>
	                    {t("inventory.actions.save")}
	                  </Button>
                </div>

                <div className="customers-form-row">
	                  <div className="customers-form-row__label">{t("inventory.labels.clientName")}</div>
                  <div className="customers-field-wrap customers-field-wrap--wide">
                    <Input value={warehouseApiDraft.client_name} onChange={(value) => setWarehouseApiDraft((current) => (current ? { ...current, client_name: value } : current))} />
                  </div>
                </div>
                <div className="customers-form-row">
	                  <div className="customers-form-row__label">{t("inventory.labels.partnerName")}</div>
                  <div className="customers-field-wrap customers-field-wrap--wide">
                    <Input value={warehouseApiDraft.partner_name} onChange={(value) => setWarehouseApiDraft((current) => (current ? { ...current, partner_name: value } : current))} />
                  </div>
                </div>
                <div className="customers-form-row">
	                  <div className="customers-form-row__label">{t("inventory.labels.status")}</div>
                  <div className="customers-field-wrap customers-field-wrap--medium">
                    <Select
	                      value={warehouseApiDraft.status}
	                      options={[
	                        { value: "active", label: t("inventory.values.active") },
	                        { value: "disabled", label: t("inventory.values.disabled") },
	                      ]}
                      onChange={(value) => setWarehouseApiDraft((current) => (current ? { ...current, status: value === "disabled" ? "disabled" : "active" } : current))}
                    />
                  </div>
                </div>
                <div className="customers-form-row">
	                  <div className="customers-form-row__label">{t("inventory.labels.expiresAt")}</div>
                  <div className="customers-field-wrap customers-field-wrap--medium">
                    <Input type="date" value={warehouseApiDraft.expires_at ? warehouseApiDraft.expires_at.slice(0, 10) : ""} onChange={(value) => setWarehouseApiDraft((current) => (current ? { ...current, expires_at: value ? `${value}T23:59:59.000Z` : "" } : current))} />
                  </div>
                </div>

                <div className="customers-form-row customers-form-row--top">
	                  <div className="customers-form-row__label">{t("inventory.labels.allowlistedIps")}</div>
                  <div className="customers-field-wrap customers-field-wrap--full">
                    <label className="field customer-field">
                      <textarea
                        className="field__input field__input--textarea"
                        value={warehouseApiDraft.allowed_ip_list}
                        onChange={(event) => setWarehouseApiDraft((current) => (current ? { ...current, allowed_ip_list: event.target.value } : current))}
                        placeholder={t("inventory.placeholders.allowlistedIps")}
                      />
                    </label>
                  </div>
                </div>

                <div className="customers-form-row customers-form-row--top">
	                  <div className="customers-form-row__label">{t("inventory.labels.allowedWarehouses")}</div>
                  <div className="customers-field-wrap customers-field-wrap--full">
                    <div className="warehouse-api-checkboxes">
                      {shareableWarehouses.map((warehouse) => (
                        <label key={warehouse.id} className="checkbox-field warehouse-api-checkbox">
                          <input
                            type="checkbox"
                            checked={warehouseApiDraft.warehouse_ids.includes(warehouse.id)}
                            onChange={(event) => toggleWarehouseApiDraftWarehouse(warehouse.id, event.target.checked)}
                          />
                          <span>{warehouse.warehouse_code} · {warehouse.warehouse_name}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="warehouse-api-checkboxes">
                  <label className="checkbox-field warehouse-api-checkbox">
                    <input
                      type="checkbox"
                      checked={warehouseApiDraft.require_hmac}
                      onChange={(event) => setWarehouseApiDraft((current) => (current ? { ...current, require_hmac: event.target.checked } : current))}
                    />
	                    <span>{t("inventory.labels.requireHmac")}</span>
                  </label>
                  <label className="checkbox-field warehouse-api-checkbox">
                    <input
                      type="checkbox"
                      checked={warehouseApiDraft.allow_order_submit}
                      onChange={(event) => setWarehouseApiDraft((current) => (current ? { ...current, allow_order_submit: event.target.checked } : current))}
                    />
	                    <span>{t("inventory.labels.openOrderSubmitEndpoint")}</span>
                  </label>
                  <label className="checkbox-field warehouse-api-checkbox">
                    <input
                      type="checkbox"
                      checked={warehouseApiDraft.include_zero_stock}
                      onChange={(event) => setWarehouseApiDraft((current) => (current ? { ...current, include_zero_stock: event.target.checked } : current))}
                    />
	                    <span>{t("inventory.labels.includeZeroStockRows")}</span>
                  </label>
                  <label className="checkbox-field warehouse-api-checkbox">
                    <input
                      type="checkbox"
                      checked={warehouseApiDraft.expose_unit_cost}
                      onChange={(event) => setWarehouseApiDraft((current) => (current ? { ...current, expose_unit_cost: event.target.checked } : current))}
                    />
	                    <span>{t("inventory.labels.exposeUnitCost")}</span>
                  </label>
                </div>

                <div className="customers-form-row customers-form-row--top">
	                  <div className="customers-form-row__label">{t("inventory.labels.notes")}</div>
                  <div className="customers-field-wrap customers-field-wrap--full">
                    <label className="field customer-field">
                      <textarea className="field__input field__input--textarea" value={warehouseApiDraft.notes} onChange={(event) => setWarehouseApiDraft((current) => (current ? { ...current, notes: event.target.value } : current))} />
                    </label>
                  </div>
                </div>

                <div className="settings-grid settings-stats-grid">
                  <div className="settings-item">
	                    <span className="settings-label">{t("inventory.labels.feedUrl")}</span>
                    <strong>{warehouseApiBaseUrl || "-"}</strong>
                  </div>
                  <div className="settings-item">
	                    <span className="settings-label">{t("inventory.labels.orderUrl")}</span>
                    <strong>{warehouseApiBaseUrl ? warehouseApiBaseUrl.replace("/warehouse-stock-feed", "/warehouse-order-submit") : "-"}</strong>
                  </div>
                  <div className="settings-item">
	                    <span className="settings-label">{t("inventory.labels.authHeader")}</span>
                    <strong>{warehouseApiHeaderName}</strong>
                  </div>
                  <div className="settings-item">
	                    <span className="settings-label">{t("inventory.labels.keyPrefix")}</span>
	                    <strong>{warehouseApiDraft.api_key_prefix || t("inventory.values.generatedOnFirstSave")}</strong>
                  </div>
                  <div className="settings-item">
	                    <span className="settings-label">{t("inventory.labels.lastUsed")}</span>
                    <strong>{warehouseApiDraft.last_used_at ? formatDate(warehouseApiDraft.last_used_at) : "-"}</strong>
                  </div>
                </div>

                {latestWarehouseApiSecret ? (
                  <div className="warehouse-api-token">
	                    <strong>{t("inventory.api.copyApiKeyNow")}</strong>
                    <div className="warehouse-api-token__value">{latestWarehouseApiSecret.api_key}</div>
                    <div className="meta-row">
	                      <span>{t("inventory.api.header", { header: latestWarehouseApiSecret.header_name })}</span>
	                      <span>{t("inventory.api.example", { url: latestWarehouseApiSecret.sample_url })}</span>
                    </div>
                    <div className="meta-row">
	                      <span>{t("inventory.api.useKeyAsHmacSecret")}</span>
	                      <span>{t("inventory.api.sendSignatureHeaders")}</span>
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}
          </SectionCard>
        </div>
      ) : null}

      {activeTab === "Purchase Receives" ? (
        <div className="customers-shell">
          <aside className="customers-sidebar">
            <div className="customers-sidebar__header">
	              <h3>{t("inventory.sections.purchaseReceives")}</h3>
            </div>
            <div className="customers-list">
	              {loadingOrders || loadingReceives ? <div className="empty-state">{t("inventory.status.loadingPurchaseReceives")}</div> : null}
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
	                      <span>{purchaseOrder.supplier_name} · {translateStatus(purchaseOrder.status)}</span>
	                      <span>{t("inventory.status.qtyRemaining", { count: formatCount(remainingQty) })}</span>
                    </button>
                  );
                })
              ) : null}
	              {!loadingOrders && !loadingReceives && !receiveCandidates.length ? <div className="empty-state">{t("inventory.empty.noPurchaseOrdersReady")}</div> : null}
            </div>
          </aside>

          <section className="customers-editor">
            <div className="customers-editor__header">
	              <h2>{t("inventory.sections.receiveIntoWarehouse")}</h2>
              <div className="toolbar">
                <Select value={receiveWarehouseId} options={stockedWarehouseOptions} onChange={setReceiveWarehouseId} />
	                <Button onClick={() => void handlePostReceive()} busy={postingReceive} busyLabel={t("inventory.actions.posting")}>
	                  {t("inventory.actions.putToStock")}
	                </Button>
              </div>
            </div>
            {selectedReceive && receiveDraft ? (
              <div className="page-stack">
	                <div className="settings-grid settings-stats-grid">
	                  <div className="settings-item">
	                    <span className="settings-label">{t("inventory.labels.purchaseOrder")}</span>
	                    <strong>{selectedReceive.id}</strong>
	                  </div>
	                  <div className="settings-item">
	                    <span className="settings-label">{t("inventory.labels.supplier")}</span>
	                    <strong>{selectedReceive.supplier_name}</strong>
	                  </div>
	                  <div className="settings-item">
	                    <span className="settings-label">{t("inventory.labels.targetWarehouse")}</span>
	                    <strong>{selectedReceiveWarehouse?.warehouse_name || "-"}</strong>
	                  </div>
	                  <div className="settings-item">
	                    <span className="settings-label">{t("inventory.labels.currency")}</span>
	                    <strong>{selectedReceive.currency}</strong>
	                  </div>
	                  <div className="settings-item">
	                    <span className="settings-label">{t("inventory.labels.receiveQty")}</span>
	                    <strong>{formatCount(receiveDraftTotals.qty)}</strong>
	                  </div>
	                  <div className="settings-item">
	                    <span className="settings-label">{t("inventory.labels.receiveAmount")}</span>
	                    <strong>{formatMoney(receiveDraftTotals.amount)}</strong>
	                  </div>
	                </div>

	                <SectionCard title={t("inventory.sections.receiveLines")}>
	                  <div className="table-wrap">
	                    <table className="data-table">
	                      <thead>
	                        <tr>
	                          <th>{t("inventory.table.code")}</th>
	                          <th>{t("inventory.table.brand")}</th>
	                          <th>{t("inventory.table.description")}</th>
	                          <th>{t("inventory.table.ordered")}</th>
	                          <th>{t("inventory.table.remaining")}</th>
	                          <th>{t("inventory.table.receiveNow")}</th>
	                          <th>{t("inventory.table.unitCost")}</th>
	                          <th>{t("inventory.table.lineTotal")}</th>
	                        </tr>
	                      </thead>
	                      <tbody>
	                        {receiveDraft.lines.map((line) => (
	                          <tr key={line.key}>
	                            <td>{line.product_code || line.old_code || "-"}</td>
	                            <td>{line.brand || "-"}</td>
	                            <td>{line.description || "-"}</td>
	                            <td>{formatCount(line.qty_ordered)}</td>
	                            <td>{formatCount(line.qty_remaining_before)}</td>
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

	                <SectionCard title={t("inventory.sections.receivePosting")}>
	                  <div className="customers-form-row customers-form-row--top">
	                    <div className="customers-form-row__label">{t("inventory.labels.notes")}</div>
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

	                <SectionCard title={t("inventory.sections.receiveHistory")}>
	                  <DataTable
	                    rows={selectedOrderReceives}
	                    columns={[
	                      { key: "id", header: t("inventory.table.receiveNo"), render: (row: PurchaseReceive) => row.id },
	                      { key: "date", header: t("inventory.table.date"), render: (row: PurchaseReceive) => formatDate(row.received_date) },
	                      { key: "warehouse", header: t("inventory.table.warehouse"), render: (row: PurchaseReceive) => row.warehouse_name || row.warehouse_code || "-" },
	                      { key: "qty", header: t("inventory.table.qty"), render: (row: PurchaseReceive) => formatCount(row.total_qty) },
	                      { key: "amount", header: t("inventory.table.amount"), render: (row: PurchaseReceive) => formatMoney(row.total_amount) },
	                      { key: "status", header: t("inventory.table.status"), render: (row: PurchaseReceive) => translateStatus(row.status) },
	                    ]}
	                    emptyText={t("inventory.empty.noPostedReceives")}
	                  />
	                </SectionCard>
	              </div>
	            ) : (
	              <SectionCard title={t("inventory.sections.purchaseReceives")}>
	                <div className="empty-state">{t("inventory.empty.noPurchaseOrderSelected")}</div>
	              </SectionCard>
	            )}
          </section>
        </div>
      ) : null}

      {activeTab === "Stock Movements" ? (
        <div className="page-stack">
	          <SectionCard title={t("inventory.sections.stockMovements")}>
	            <div className="toolbar toolbar--wrap">
	              <Select value={movementWarehouseId} options={warehouseFilterOptions} onChange={setMovementWarehouseId} />
	            </div>
	            <div className="meta-row">
	              <span>{t("inventory.status.movementRows", { count: formatCount(movementRows.length) })}</span>
	              <span>{loadingMovements ? t("inventory.status.refreshingMovementLedger") : t("inventory.status.liveStockLedger")}</span>
	            </div>
	            <DataTable rows={movementRows} columns={movementColumns} emptyText={t("inventory.empty.noStockMovementRows")} />
	          </SectionCard>
        </div>
      ) : null}

      {activeTab === "On Hand" ? (
        <div className="page-stack">
	          <SectionCard title={t("inventory.sections.onHand")}>
	            <div className="toolbar toolbar--wrap">
	              <Select value={onHandWarehouseId} options={warehouseFilterOptions} onChange={setOnHandWarehouseId} />
	            </div>
	            <div className="meta-row">
	              <span>{t("inventory.status.warehouseSnapshots", { count: formatCount(visibleOnHandRows.length) })}</span>
	              <span>{loadingOnHand ? t("inventory.status.rebuildingOnHandQuantities") : t("inventory.status.currentOnHandComputed")}</span>
	            </div>
	            <DataTable rows={visibleOnHandRows} columns={onHandColumns} emptyText={t("inventory.empty.noWarehouseInventorySnapshot")} />
	          </SectionCard>
	          <SectionCard title={t("inventory.sections.warehouseStockDetail")}>
	            <div className="toolbar toolbar--wrap">
	              <Input value={onHandStockSearch} onChange={setOnHandStockSearch} placeholder={t("inventory.placeholders.stockSearch")} />
	            </div>
	            <div className="meta-row">
	              <span>{t("inventory.status.stockRows", { count: formatCount(visibleOnHandStockRows.length) })}</span>
	              <span>
	                {loadingOnHandStock
	                  ? t("inventory.status.refreshingItemLevelStockDetail")
	                  : onHandWarehouseId
	                    ? t("inventory.status.itemLevelStockDetailForSelectedWarehouse")
	                    : t("inventory.status.selectWarehouseAboveToNarrowDetail")}
	              </span>
	            </div>
	            <DataTable rows={visibleOnHandStockRows} columns={onHandStockColumns} emptyText={t("inventory.empty.noItemLevelStockDetail")} />
	          </SectionCard>
        </div>
      ) : null}

      {activeTab === "Transfers" ? (
        <div className="page-stack">
	          <SectionCard title={t("inventory.sections.transfers")}>
	            <div className="page-stack">
	              <div className="settings-grid">
	                <Select label={t("inventory.labels.sourceWarehouse")} value={transferSourceId} options={stockedWarehouseOptions} onChange={setTransferSourceId} />
	                <Select label={t("inventory.labels.targetWarehouse")} value={transferTargetId} options={stockedWarehouseOptions} onChange={setTransferTargetId} />
	              </div>

	              <div className="toolbar toolbar--wrap">
	                <Input label={t("inventory.labels.searchSourceStock")} value={transferSearch} onChange={setTransferSearch} placeholder={t("inventory.placeholders.stockSearch")} />
	                <Button variant="secondary" onClick={handleClearTransferDraft}>
	                  {t("inventory.actions.clearDraft")}
	                </Button>
	                <Button onClick={() => void handlePostTransfer()} busy={postingTransfer} busyLabel={t("inventory.actions.posting")}>
	                  {t("inventory.actions.postTransfer")}
	                </Button>
	              </div>

	              <div className="settings-grid settings-stats-grid">
	                <div className="settings-item">
	                  <span className="settings-label">{t("inventory.labels.transferNo")}</span>
	                  <strong>{transferDraft?.transfer_no || "-"}</strong>
	                </div>
	                <div className="settings-item">
	                  <span className="settings-label">{t("inventory.labels.draftLines")}</span>
	                  <strong>{transferDraft ? formatCount(transferDraft.lines.length) : "0"}</strong>
	                </div>
	                <div className="settings-item">
	                  <span className="settings-label">{t("inventory.labels.transferQty")}</span>
	                  <strong>{formatCount(transferDraftTotals.qty)}</strong>
	                </div>
	                <div className="settings-item">
	                  <span className="settings-label">{t("inventory.labels.transferValue")}</span>
	                  <strong>{formatMoney(transferDraftTotals.amount)}</strong>
	                </div>
	              </div>

	              <SectionCard title={t("inventory.sections.sourceStock")}>
	                <div className="meta-row">
	                  <span>{t("inventory.status.sourceStockRows", { count: formatCount(filteredTransferStockRows.length) })}</span>
	                  <span>{loadingTransferStock ? t("inventory.status.refreshingSourceWarehouseStock") : t("inventory.status.selectSourceRowToAdd")}</span>
	                </div>
	                <DataTable
	                  rows={filteredTransferStockRows}
	                  columns={[
	                    { key: "brand", header: t("inventory.table.brand"), render: (row: WarehouseStockItem) => <BrandPill brand={row.brand} compact /> },
	                    { key: "code", header: t("inventory.table.code"), render: (row: WarehouseStockItem) => row.product_code || row.old_code || "-" },
	                    { key: "description", header: t("inventory.table.description"), render: (row: WarehouseStockItem) => row.description || "-" },
	                    { key: "origin", header: t("inventory.table.origin"), render: (row: WarehouseStockItem) => row.origin || "-" },
	                    { key: "qty", header: t("inventory.table.availableQty"), render: (row: WarehouseStockItem) => formatCount(row.available_qty) },
	                    { key: "cost", header: t("inventory.table.avgCost"), render: (row: WarehouseStockItem) => formatMoney(row.average_cost) },
	                    {
	                      key: "action",
	                      header: t("inventory.table.action"),
	                      render: (row: WarehouseStockItem) => (
	                        <Button className="button--compact" variant="secondary" onClick={() => handleAddTransferItem(row)}>
	                          {t("inventory.actions.add")}
	                        </Button>
	                      ),
	                    },
	                  ]}
	                  emptyText={t("inventory.empty.noAvailableStockInSourceWarehouse")}
	                />
	              </SectionCard>

	              <SectionCard title={t("inventory.sections.transferDraft")}>
	                {transferDraft?.lines.length ? (
	                  <div className="table-wrap">
	                    <table className="data-table">
	                      <thead>
	                        <tr>
	                          <th>{t("inventory.table.code")}</th>
	                          <th>{t("inventory.table.brand")}</th>
	                          <th>{t("inventory.table.description")}</th>
	                          <th>{t("inventory.table.available")}</th>
	                          <th>{t("inventory.table.transferQty")}</th>
	                          <th>{t("inventory.table.unitCost")}</th>
	                          <th>{t("inventory.table.lineTotal")}</th>
	                          <th>{t("inventory.table.action")}</th>
	                        </tr>
	                      </thead>
                      <tbody>
                        {transferDraft.lines.map((line) => (
                          <tr key={line.key}>
                            <td>{line.product_code || line.old_code || "-"}</td>
                            <td>{line.brand || "-"}</td>
                            <td>{line.description || "-"}</td>
	                            <td>{formatCount(line.available_qty)}</td>
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
	                                {t("inventory.actions.remove")}
	                              </Button>
	                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
	                  <div className="empty-state">{t("inventory.empty.noTransferLinesYet")}</div>
	                )}
	              </SectionCard>

	              <SectionCard title={t("inventory.sections.transferPosting")}>
	                <div className="customers-form-row">
	                  <div className="customers-form-row__label">{t("inventory.labels.transferDate")}</div>
                  <div className="customers-field-wrap customers-field-wrap--medium">
                    <Input
                      type="date"
                      value={transferDraft?.transfer_date || ""}
                      onChange={(value) => setTransferDraft((current) => (current ? { ...current, transfer_date: value } : current))}
                    />
                  </div>
	                </div>
	                <div className="customers-form-row customers-form-row--top">
	                  <div className="customers-form-row__label">{t("inventory.labels.notes")}</div>
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

	              <SectionCard title={t("inventory.sections.transferHistory")}>
	                <div className="meta-row">
	                  <span>{t("inventory.status.transferRecords", { count: formatCount(stockTransfers.length) })}</span>
	                  <span>{loadingTransfers ? t("inventory.status.refreshingTransferHistory") : t("inventory.status.postedTransfersCreateMovements")}</span>
	                </div>
	                <DataTable rows={stockTransfers} columns={transferHistoryColumns} emptyText={t("inventory.empty.noStockTransfersPosted")} />
	              </SectionCard>
            </div>
          </SectionCard>
        </div>
      ) : null}
    </div>
  );
}
