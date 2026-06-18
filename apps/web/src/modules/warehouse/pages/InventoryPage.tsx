import { useEffect, useMemo, useRef, useState } from "react";
import {
  INVENTORY_PACKING_SCHEMA_UNAVAILABLE_MESSAGE,
  buildPurchaseReceiveDraft,
  buildWarehouseLocationPath,
  fetchInventoryBarcodeAliases,
  createStockTransferDraft,
  fetchInventoryManualEntryAlerts,
  fetchInventoryMovements,
  fetchPurchaseReceives,
  fetchShipmentPackingSession,
  fetchStockTransfers,
  fetchWarehouseOnHand,
  fetchWarehouseLocations,
  fetchWarehouseOperationTasks,
  fetchWarehouseStockItems,
  findMatchingWarehouseStockItem,
  findWarehouseLocationByAddress,
  matchInventoryScanToLines,
  postPurchaseReceive,
  postStockAdjustment,
  postStockTransfer,
  resolveWarehouseLocationMatch,
  saveInventoryBarcodeAliasBinding,
  saveWarehouseLocation,
  saveWarehouseOperationTask,
  upsertShipmentPackingSession,
  type InventoryBarcodeBindableLine,
  type PurchaseReceiveDraft,
  type ShipmentPackingSessionInput,
  type StockAdjustmentInput,
  type StockTransferDraft,
} from "../../../infrastructure/api/inventoryApi";
import { fetchAppSession } from "../../../infrastructure/api/appSessionApi";
import { fetchCatalogRowsByCodes, fetchCloudCatalog } from "../../../infrastructure/api/catalogApi";
import { fetchInvoiceSummaries, fetchPurchaseOrders, fetchSalesOrders } from "../../../infrastructure/api/ordersApi";
import {
  createEmptyWarehouse,
  deleteWarehouseApiClient,
  fetchWarehouseApiClients,
  fetchWarehouses,
  rotateWarehouseApiClientToken,
  syncWarehouseExternalStock,
  upsertWarehouse,
  upsertWarehouseApiClient,
} from "../../../infrastructure/api/warehousesApi";
import { fetchOrgUsers, getPresenceStatus } from "../../../infrastructure/api/usersApi";
import type { CatalogRow } from "../../../types/catalog";
import type {
  InventoryBarcodeAlias,
  InventoryManualEntryAlert,
  InventoryMovement,
  PurchaseReceive,
  ShipmentPackingAssignment,
  ShipmentPackingPackage,
  ShipmentPackingSession,
  ShipmentPackingVehicle,
  StockTransfer,
  SaveWarehouseLocationInput,
  SaveWarehouseOperationTaskInput,
  WarehouseOnHandRow,
  WarehouseLocation,
  WarehouseLocationType,
  WarehouseOperationTask,
  WarehouseStockItem,
} from "../../../types/inventory";
import type { LocalInvoice, LocalPurchaseOrder, LocalSalesOrder } from "../../../types/orders";
import type { OrgUser } from "../../../types/users";
import type { Warehouse, WarehouseApiClient, WarehouseApiClientSecret } from "../../../types/warehouses";
import { useActionFeedback } from "../../../presentation/components/common/ActionFeedback";
import { Button } from "../../../presentation/components/common/Button";
import { DataTable } from "../../../presentation/components/common/DataTable";
import { Input } from "../../../presentation/components/common/Input";
import { SectionCard } from "../../../presentation/components/common/SectionCard";
import { Select } from "../../../presentation/components/common/Select";
import { BrandPill } from "../../../presentation/components/common/BrandPill";
import { StatCard } from "../../../presentation/components/common/StatCard";
import { WarehouseBarcodeBindingPanel } from "../../../presentation/components/common/WarehouseBarcodeBindingPanel";
import { WarehouseCodeScanner } from "../../../presentation/components/common/WarehouseCodeScanner";
import { includesLooseText, matchesOriginalNumberSearch, normalizeBrandKey, normalizePartCode, splitOriginalNumberCandidates } from "../../../domain/shared/normalize";
import { isUuid } from "../../../infrastructure/api/organizationApi";
import { openBusinessDocumentPreview } from "../../../shared/documentPrint";
import { downloadPdfFromHtml } from "../../../shared/pdfDownload";
import { getAppLanguageLocale, translateAppText, type AppLanguage } from "../../../shared/i18n";
import { isAdminLikeRole, isWarehouseRole } from "../../../shared/roles";
import {
  buildWarehousePackageLabelsHtml,
  buildWarehousePackingHtml,
  buildWarehousePackingWorkbook,
  type WarehouseLabelCodeMode,
  type WarehouseLabelLayout,
} from "../../../shared/warehousePackingPrint";
import { buildXlsxBlob, downloadBlob } from "../../../shared/xlsx";

type InventoryTab = "Scan Center" | "Warehouses" | "Purchase Receives" | "Stock Movements" | "On Hand" | "Transfers" | "Packing & Loading";
type InventoryFocusTarget = "manual-alerts" | "receive-alert" | "packing-alert";

const adminInventoryTabs: readonly InventoryTab[] = ["Warehouses", "Purchase Receives", "Stock Movements", "On Hand", "Transfers", "Packing & Loading"];
const warehouseInventoryTabs: readonly InventoryTab[] = ["Scan Center", "Purchase Receives", "Stock Movements", "On Hand", "Transfers", "Packing & Loading"];
const salesInventoryTabs: readonly InventoryTab[] = ["Packing & Loading"];
const INVENTORY_PHONE_BREAKPOINT_PX = 768;

function getAllowedInventoryTabs(role: string | null | undefined) {
  if (isAdminLikeRole(role)) return adminInventoryTabs;
  if (isWarehouseRole(role)) return warehouseInventoryTabs;
  return salesInventoryTabs;
}

function resolveInventoryTab(role: string | null | undefined, requestedTab?: InventoryTab | null) {
  const allowedTabs = getAllowedInventoryTabs(role);
  if (requestedTab && allowedTabs.includes(requestedTab)) {
    return requestedTab;
  }
  return allowedTabs[0] || "Packing & Loading";
}

type WarehouseLocationEditorState = {
  id: string;
  warehouse_id: string;
  warehouse_code: string;
  warehouse_name: string;
  location_code: string;
  location_barcode: string;
  zone_code: string;
  aisle_code: string;
  rack_code: string;
  level_code: string;
  bin_code: string;
  shelf_address: string;
  section_code: string;
  location_type: WarehouseLocationType;
  pick_sequence: string;
  capacity_volume_m3: string;
  capacity_weight_kg: string;
  is_active: boolean;
  is_default_pick_face: boolean;
  allow_mixed_sku: boolean;
  notes: string;
};

const WAREHOUSE_LOCATION_TYPE_OPTIONS: Array<{ value: WarehouseLocationType; label: string }> = [
  { value: "pick_face", label: "Pick Face" },
  { value: "reserve", label: "Reserve" },
  { value: "bulk", label: "Bulk" },
  { value: "staging", label: "Staging" },
  { value: "dock", label: "Dock" },
  { value: "quarantine", label: "Quarantine" },
  { value: "returns", label: "Returns" },
];

type InventoryPageProps = {
  initialTab?: InventoryTab;
  selectedWarehouseId?: string;
  stockSearch?: string;
  role?: string;
  language?: AppLanguage;
  onOpenPurchaseOrder?: (purchaseOrderId: string) => void;
  onOpenSalesOrder?: (salesOrderId: string) => void;
  focusTarget?: InventoryFocusTarget | "";
  focusDocumentId?: string;
  focusLineKey?: string;
  focusToken?: number;
};

function formatDate(value: string) {
  return value ? value.slice(0, 10) : "-";
}

function formatDateTime(value: string) {
  return value ? value.slice(0, 16).replace("T", " ") : "-";
}

function formatWarehouseLocation(value: { shelf_address?: string; section_code?: string } | null | undefined) {
  if (!value) return "-";
  const shelf = String(value.shelf_address || "").trim();
  const section = String(value.section_code || "").trim();
  if (shelf && section) return `${shelf} / ${section}`;
  return shelf || section || "-";
}

function formatElapsedMinutes(minutes: number) {
  if (!Number.isFinite(minutes) || minutes <= 0) return "<1m";
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const hours = Math.floor(minutes / 60);
  const remainder = Math.round(minutes % 60);
  if (!remainder) return `${hours}h`;
  return `${hours}h ${remainder}m`;
}

function deriveWarehouseTaskAlert(task: Pick<WarehouseOperationTask, "workflow_stage" | "status" | "updated_at" | "created_at">) {
  if (task.status === "completed" || task.status === "cancelled") {
    return {
      isOverdue: false,
      tone: "success" as const,
      labelKey: "inventory.task_alert_closed" as const,
      ageMinutes: 0,
      ageLabel: "-",
    };
  }

  const referenceTime = Date.parse(task.updated_at || task.created_at || "");
  const ageMinutes = Number.isFinite(referenceTime) ? Math.max(0, (Date.now() - referenceTime) / 60000) : 0;
  const watchThreshold = task.workflow_stage === "pick" ? 15 : task.workflow_stage === "putaway" ? 30 : 60;
  const criticalThreshold = watchThreshold * 4;
  const ageLabel = formatElapsedMinutes(ageMinutes);

  if (ageMinutes >= criticalThreshold) {
    return {
      isOverdue: true,
      tone: "danger" as const,
      labelKey: "inventory.task_alert_overdue" as const,
      ageMinutes,
      ageLabel,
    };
  }

  if (ageMinutes >= watchThreshold) {
    return {
      isOverdue: false,
      tone: "accent" as const,
      labelKey: "inventory.task_alert_watch" as const,
      ageMinutes,
      ageLabel,
    };
  }

  return {
    isOverdue: false,
    tone: "info" as const,
    labelKey: "inventory.task_alert_fresh" as const,
    ageMinutes,
    ageLabel,
  };
}

function warehouseTaskStatusTone(status: WarehouseOperationTask["status"]) {
  if (status === "completed") return "success";
  if (status === "in_progress") return "info";
  if (status === "cancelled") return "danger";
  return "accent";
}

function sanitizeDownloadName(value: string) {
  return value.replace(/[^a-z0-9_-]+/gi, "-").replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "") || "packing-loading-plan";
}

function createEmptyWarehouseLocationDraft(warehouse?: Warehouse | null): WarehouseLocationEditorState {
  return {
    id: "",
    warehouse_id: warehouse?.id || "",
    warehouse_code: warehouse?.warehouse_code || "",
    warehouse_name: warehouse?.warehouse_name || "",
    location_code: "",
    location_barcode: "",
    zone_code: "",
    aisle_code: "",
    rack_code: "",
    level_code: "",
    bin_code: "",
    shelf_address: "",
    section_code: "",
    location_type: "pick_face",
    pick_sequence: "",
    capacity_volume_m3: "",
    capacity_weight_kg: "",
    is_active: true,
    is_default_pick_face: false,
    allow_mixed_sku: false,
    notes: "",
  };
}

function mapWarehouseLocationToDraft(row: WarehouseLocation | null | undefined, warehouse?: Warehouse | null): WarehouseLocationEditorState {
  if (!row) return createEmptyWarehouseLocationDraft(warehouse);
  return {
    id: row.id,
    warehouse_id: row.warehouse_id || warehouse?.id || "",
    warehouse_code: row.warehouse_code || warehouse?.warehouse_code || "",
    warehouse_name: row.warehouse_name || warehouse?.warehouse_name || "",
    location_code: row.location_code || "",
    location_barcode: row.location_barcode || "",
    zone_code: row.zone_code || "",
    aisle_code: row.aisle_code || "",
    rack_code: row.rack_code || "",
    level_code: row.level_code || "",
    bin_code: row.bin_code || "",
    shelf_address: row.shelf_address || "",
    section_code: row.section_code || "",
    location_type: row.location_type || "pick_face",
    pick_sequence: String(row.pick_sequence || 0),
    capacity_volume_m3: String(row.capacity_volume_m3 || 0),
    capacity_weight_kg: String(row.capacity_weight_kg || 0),
    is_active: row.is_active,
    is_default_pick_face: row.is_default_pick_face,
    allow_mixed_sku: row.allow_mixed_sku,
    notes: row.notes || "",
  };
}

function draftWarehouseLocationPayload(draft: WarehouseLocationEditorState): SaveWarehouseLocationInput {
  return {
    id: draft.id || undefined,
    warehouse_id: draft.warehouse_id,
    warehouse_code: draft.warehouse_code,
    warehouse_name: draft.warehouse_name,
    location_code: draft.location_code,
    location_barcode: draft.location_barcode,
    zone_code: draft.zone_code,
    aisle_code: draft.aisle_code,
    rack_code: draft.rack_code,
    level_code: draft.level_code,
    bin_code: draft.bin_code,
    shelf_address: draft.shelf_address,
    section_code: draft.section_code,
    location_type: draft.location_type,
    pick_sequence: Number(draft.pick_sequence || 0),
    capacity_volume_m3: Number(draft.capacity_volume_m3 || 0),
    capacity_weight_kg: Number(draft.capacity_weight_kg || 0),
    is_active: draft.is_active,
    is_default_pick_face: draft.is_default_pick_face,
    allow_mixed_sku: draft.allow_mixed_sku,
    notes: draft.notes,
  };
}

function parseNumberInput(value: string) {
  const normalized = value.replace(",", ".").trim();
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function buildNextScanQty(pendingQty: string, confirmedQty: number, maxQty: number) {
  if (maxQty <= 0) return "0";
  if (maxQty < 1) return String(maxQty);
  const pendingValue = parseNumberInput(pendingQty);
  const baseQty = pendingValue > 0 ? pendingValue : Number(confirmedQty || 0);
  const nextQty = Math.max(1, Math.min(maxQty, Math.floor(baseQty) + 1));
  return String(nextQty);
}

function deriveWarehouseTaskStatus(completedQty: number, expectedQty: number): WarehouseOperationTask["status"] {
  if (completedQty <= 0) return "open";
  if (expectedQty > 0 && completedQty >= expectedQty) return "completed";
  return "in_progress";
}

function isPackingSchemaUnavailableError(message: unknown) {
  return String(message || "").trim() === INVENTORY_PACKING_SCHEMA_UNAVAILABLE_MESSAGE;
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

function scrollReceiveLineIntoView(lineKey: string) {
  if (!lineKey) return;
  window.setTimeout(() => {
    const element = document.querySelector<HTMLElement>(`[data-receive-line-key="${lineKey}"]`);
    element?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, 60);
}

function scrollShipmentLineIntoView(lineId: string) {
  if (!lineId) return;
  window.setTimeout(() => {
    const element = document.querySelector<HTMLElement>(`[data-shipment-line-id="${lineId}"]`);
    element?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, 60);
}

function scrollInventoryFocusTarget(target: InventoryFocusTarget) {
  window.setTimeout(() => {
    const element = document.querySelector<HTMLElement>(`[data-inventory-focus-target="${target}"]`);
    element?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, 80);
}

function isReceiveManualAlert(alert: InventoryManualEntryAlert) {
  return alert.workflow_stage === "receive";
}

function toReceiveBindableLine(line: PurchaseReceiveDraft["lines"][number]): InventoryBarcodeBindableLine {
  return {
    key: line.key,
    brand: line.brand,
    product_code: line.product_code,
    old_code: line.old_code,
    description: line.description,
    oem_no: line.oem_no,
  };
}

function toShipmentBindableLine(line: LocalSalesOrder["lines"][number]): InventoryBarcodeBindableLine {
  return {
    key: line.lineId,
    brand: line.brand,
    product_code: line.resolvedCode,
    old_code: line.requestedCode,
    description: line.description,
    oem_no: line.oem_no,
    supplier_name: line.supplier_name,
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

type StockAdjustmentFormState = {
  movedDate: string;
  brand: string;
  productCode: string;
  oldCode: string;
  description: string;
  qtyDelta: string;
  origin: string;
  relatedParty: string;
  notes: string;
};

type PackingPackageDraft = ShipmentPackingPackage;

type PackingLineAssignment = ShipmentPackingAssignment;

type PackingVehicleDraft = ShipmentPackingVehicle;

type LoadingVehiclePreset = {
  key: string;
  label: string;
  maxVolumeM3: number;
  maxGrossWeightKg: number;
};

type InventoryLocationPreview = {
  source: "onhand" | "transfer" | "shipment";
  warehouseCode: string;
  warehouseName: string;
  brand: string;
  productCode: string;
  oldCode: string;
  description: string;
  origin: string;
  shelfAddress: string;
  sectionCode: string;
  onHandQty?: number;
  availableQty?: number;
  reservedQty?: number;
  shipmentQty?: number;
  packedQty?: number;
  packageLabel?: string;
  lastMovedAt?: string;
};

function createEmptyStockAdjustmentForm(): StockAdjustmentFormState {
  return {
    movedDate: new Date().toISOString().slice(0, 10),
    brand: "",
    productCode: "",
    oldCode: "",
    description: "",
    qtyDelta: "",
    origin: "",
    relatedParty: "Opening Balance",
    notes: "",
  };
}

const loadingVehiclePresets: LoadingVehiclePreset[] = [
  { key: "container_20", label: "20ft Container", maxVolumeM3: 33.2, maxGrossWeightKg: 28200 },
  { key: "container_40", label: "40ft Container", maxVolumeM3: 67.7, maxGrossWeightKg: 28600 },
  { key: "container_40_hc", label: "40ft High Cube", maxVolumeM3: 76.3, maxGrossWeightKg: 28600 },
  { key: "tir_trailer", label: "TIR Trailer", maxVolumeM3: 82, maxGrossWeightKg: 24000 },
  { key: "box_truck", label: "Box Truck", maxVolumeM3: 45, maxGrossWeightKg: 12000 },
];

function createEmptyPackingPackage(index: number): PackingPackageDraft {
  const labelIndex = String(index).padStart(2, "0");
  return {
    id: `pkg-${Date.now()}-${labelIndex}`,
    label: `PKG-${labelIndex}`,
    packageType: "carton",
    lengthCm: "",
    widthCm: "",
    heightCm: "",
    grossWeightKg: "",
    orientation: "length-first",
    notes: "",
  };
}

function createEmptyPackingVehicleDraft(): PackingVehicleDraft {
  return {
    warehouse_id: "",
    warehouse_code: "",
    warehouse_name: "",
    mode: "container_40_hc",
    reference: "",
    notes: "",
  };
}

function getLoadingVehiclePreset(mode: string) {
  return loadingVehiclePresets.find((item) => item.key === mode) || loadingVehiclePresets[0];
}

function calculatePackageVolumeM3(pkg: Pick<PackingPackageDraft, "lengthCm" | "widthCm" | "heightCm">) {
  const length = parseNumberInput(pkg.lengthCm);
  const width = parseNumberInput(pkg.widthCm);
  const height = parseNumberInput(pkg.heightCm);
  if (length <= 0 || width <= 0 || height <= 0) return 0;
  return (length * width * height) / 1_000_000;
}

function buildPackingSessionSignature(input: {
  invoiceId: string;
  invoiceNo: string;
  warehouseId: string;
  warehouseCode: string;
  warehouseName: string;
  packages: PackingPackageDraft[];
  assignments: Record<string, PackingLineAssignment>;
  vehicle: PackingVehicleDraft;
  reservedLines: Array<{
    line_id: string;
    brand: string;
    product_code: string;
    old_code: string;
    description: string;
    origin: string;
    qty_reserved: number;
  }>;
}) {
  return JSON.stringify({
    invoiceId: input.invoiceId,
    invoiceNo: input.invoiceNo,
    warehouseId: input.warehouseId,
    warehouseCode: input.warehouseCode,
    warehouseName: input.warehouseName,
    packages: input.packages,
    assignments: input.assignments,
    vehicle: input.vehicle,
    reservedLines: input.reservedLines,
  });
}

function catalogScanScore(row: CatalogRow, token: string, preferredBrand?: string) {
  const rawToken = String(token || "").trim();
  const normalizedToken = normalizePartCode(rawToken);
  const preferredBrandKey = normalizeBrandKey(preferredBrand || "");
  const rowBrandKey = normalizeBrandKey(row.brand);
  const productCode = normalizePartCode(row.product_code);
  const ean = normalizePartCode(row.ean);
  const oemCandidates = splitOriginalNumberCandidates(row.oem_no).map((value) => normalizePartCode(value)).filter(Boolean);
  let score = 0;

  if (preferredBrandKey && preferredBrandKey === rowBrandKey) score += 25;
  if (normalizedToken && ean && ean === normalizedToken) score += 220;
  if (normalizedToken && productCode === normalizedToken) score += 120;
  if (normalizedToken && oemCandidates.includes(normalizedToken)) score += 100;
  if (matchesOriginalNumberSearch(row.oem_no, rawToken)) score += 80;
  if (normalizedToken && ean && ean.includes(normalizedToken)) score += 50;
  if (normalizedToken && productCode.includes(normalizedToken)) score += 40;
  if (includesLooseText(`${row.product_code} ${row.ean} ${row.oem_no}`, rawToken)) score += 18;
  if (includesLooseText(row.description, rawToken)) score += 6;
  return score;
}

function rankCatalogScanRows(rows: CatalogRow[], token: string, preferredBrand?: string) {
  return [...rows].sort((left, right) => {
    const scoreDelta = catalogScanScore(right, token, preferredBrand) - catalogScanScore(left, token, preferredBrand);
    if (scoreDelta !== 0) return scoreDelta;
    if (left.brand !== right.brand) return left.brand.localeCompare(right.brand);
    return left.product_code.localeCompare(right.product_code);
  });
}

export function InventoryPage({
  initialTab = "Warehouses",
  selectedWarehouseId: selectedWarehouseIdProp = "",
  stockSearch: stockSearchProp = "",
  role = "",
  language = "en",
  onOpenPurchaseOrder,
  onOpenSalesOrder,
  focusTarget = "",
  focusDocumentId = "",
  focusLineKey = "",
  focusToken = 0,
}: InventoryPageProps) {
  const actionFeedback = useActionFeedback();
  const appLocale = getAppLanguageLocale(language);
  const t = (key: Parameters<typeof translateAppText>[1], variables?: Record<string, string | number>) => translateAppText(language, key, variables);
  const formatLocalizedCount = (value: number) => value.toLocaleString(appLocale);
  const translatePresenceLabel = (tone?: string | null) => {
    if (tone === "online") return t("inventory.online_now");
    if (tone === "recent") return t("inventory.recently_active");
    return t("inventory.offline");
  };
  const translateWarehouseTaskWorkflow = (value: WarehouseOperationTask["workflow_stage"]) => {
    if (value === "pick") return t("inventory.workflow_pick");
    if (value === "putaway") return t("inventory.workflow_putaway");
    if (value === "transfer") return t("inventory.workflow_transfer");
    return value;
  };
  const translateWarehouseTaskStatus = (value: WarehouseOperationTask["status"]) => {
    if (value === "open") return t("inventory.status_open");
    if (value === "in_progress") return t("inventory.status_in_progress");
    if (value === "completed") return t("inventory.status_completed");
    if (value === "cancelled") return t("inventory.status_cancelled");
    return value;
  };
  const translateWarehouseLocationType = (value: WarehouseLocationType) => {
    if (value === "pick_face") return t("inventory.pick_face");
    if (value === "reserve") return t("inventory.reserve");
    if (value === "bulk") return t("inventory.bulk");
    if (value === "staging") return t("inventory.staging");
    if (value === "dock") return t("inventory.dock");
    if (value === "quarantine") return t("inventory.quarantine");
    if (value === "returns") return t("inventory.returns");
    return value;
  };
  const translateWarehouseKind = (value: Warehouse["warehouse_kind"]) =>
    value === "outsourced" ? t("inventory.outsourced") : t("inventory.internal");
  const translateFulfillmentModel = (value: Warehouse["fulfillment_model"]) =>
    value === "dropship" ? t("inventory.dropship") : t("inventory.stocked");
  const translateExternalAuthType = (value: Warehouse["external_auth_type"]) =>
    value === "bearer_env" ? t("inventory.bearer_token_env") : t("inventory.no_auth");
  const translateMovementType = (value: InventoryMovement["movement_type"]) => {
    if (value === "purchase_receive") return t("inventory.purchase_receives");
    if (value === "transfer_in") return `${t("inventory.transfers")} In`;
    if (value === "transfer_out") return `${t("inventory.transfers")} Out`;
    if (value === "adjustment") return t("inventory.manual_stock_adjustment");
    return value;
  };
  const translateManualAlertStage = (value: InventoryManualEntryAlert["workflow_stage"]) => {
    if (value === "receive") return t("inventory.purchase_receives");
    if (value === "packing" || value === "shipment") return t("inventory.packing_loading");
    return value;
  };
  const translateVehicleLabel = (value: string) => {
    if (value === "20ft Container") return "20ft Container";
    if (value === "40ft Container") return "40ft Container";
    if (value === "40ft High Cube") return "40ft High Cube";
    if (value === "TIR Trailer") return t("inventory.tir_trailer");
    if (value === "Box Truck") return t("inventory.box_truck");
    return value;
  };
  const translatePackageType = (value: string) => {
    if (value === "carton") return t("inventory.carton");
    if (value === "pallet") return t("inventory.pallet");
    if (value === "crate") return t("inventory.crate");
    if (value === "bundle") return t("inventory.bundle");
    return value;
  };
  const translateOrientation = (value: string) => {
    if (value === "length-first") return t("inventory.length_first");
    if (value === "width-first") return t("inventory.width_first");
    if (value === "upright") return t("inventory.upright");
    if (value === "stacked") return t("inventory.stacked");
    return value;
  };
  const [activeTab, setActiveTab] = useState<InventoryTab>(() => resolveInventoryTab(role, initialTab));
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [purchaseOrders, setPurchaseOrders] = useState<LocalPurchaseOrder[]>([]);
  const [purchaseReceives, setPurchaseReceives] = useState<PurchaseReceive[]>([]);
  const [movementRows, setMovementRows] = useState<InventoryMovement[]>([]);
  const [onHandRows, setOnHandRows] = useState<WarehouseOnHandRow[]>([]);
  const [onHandStockRows, setOnHandStockRows] = useState<WarehouseStockItem[]>([]);
  const [packingWarehouseStockRows, setPackingWarehouseStockRows] = useState<WarehouseStockItem[]>([]);
  const [locationPreview, setLocationPreview] = useState<InventoryLocationPreview | null>(null);
  const [locationPreviewCatalogRow, setLocationPreviewCatalogRow] = useState<CatalogRow | null>(null);
  const [loadingLocationPreviewCatalog, setLoadingLocationPreviewCatalog] = useState(false);
  const [onHandStockSearch, setOnHandStockSearch] = useState("");
  const [sourceStockRows, setSourceStockRows] = useState<WarehouseStockItem[]>([]);
  const [stockTransfers, setStockTransfers] = useState<StockTransfer[]>([]);
  const [shipmentOrders, setShipmentOrders] = useState<LocalSalesOrder[]>([]);
  const [shipmentInvoices, setShipmentInvoices] = useState<LocalInvoice[]>([]);
  const [selectedWarehouseId, setSelectedWarehouseId] = useState("");
  const [selectedReceiveId, setSelectedReceiveId] = useState("");
  const [selectedShipmentId, setSelectedShipmentId] = useState("");
  const [draft, setDraft] = useState<Warehouse | null>(null);
  const [saving, setSaving] = useState(false);
  const [receiveWarehouseId, setReceiveWarehouseId] = useState("");
  const [movementWarehouseId, setMovementWarehouseId] = useState("");
  const [adjustmentWarehouseId, setAdjustmentWarehouseId] = useState("");
  const [onHandWarehouseId, setOnHandWarehouseId] = useState("");
  const [transferSourceId, setTransferSourceId] = useState("");
  const [transferTargetId, setTransferTargetId] = useState("");
  const [transferSearch, setTransferSearch] = useState("");
  const [loadingOrders, setLoadingOrders] = useState(false);
  const [loadingReceives, setLoadingReceives] = useState(false);
  const [loadingMovements, setLoadingMovements] = useState(false);
  const [loadingAdjustmentStock, setLoadingAdjustmentStock] = useState(false);
  const [loadingOnHand, setLoadingOnHand] = useState(false);
  const [loadingOnHandStock, setLoadingOnHandStock] = useState(false);
  const [loadingPackingWarehouseStock, setLoadingPackingWarehouseStock] = useState(false);
  const [loadingTransferStock, setLoadingTransferStock] = useState(false);
  const [loadingTransfers, setLoadingTransfers] = useState(false);
  const [loadingShipments, setLoadingShipments] = useState(false);
  const [postingReceive, setPostingReceive] = useState(false);
  const [postingAdjustment, setPostingAdjustment] = useState(false);
  const [postingTransfer, setPostingTransfer] = useState(false);
  const [syncingWarehouse, setSyncingWarehouse] = useState(false);
  const [showWarehouseEditor, setShowWarehouseEditor] = useState(false);
  const [receiveDraft, setReceiveDraft] = useState<PurchaseReceiveDraft | null>(null);
  const [receiveScanInput, setReceiveScanInput] = useState("");
  const [receiveScanBusy, setReceiveScanBusy] = useState(false);
  const [receiveScanMessage, setReceiveScanMessage] = useState("");
  const [receiveScanMatchedKeys, setReceiveScanMatchedKeys] = useState<string[]>([]);
  const [receiveScanSelectedLineKey, setReceiveScanSelectedLineKey] = useState("");
  const [receiveScanPendingQty, setReceiveScanPendingQty] = useState("");
  const [receiveScanManualQtyMode, setReceiveScanManualQtyMode] = useState(false);
  const [manualReceiveBarcodeInput, setManualReceiveBarcodeInput] = useState("");
  const [manualReceiveLineKey, setManualReceiveLineKey] = useState("");
  const [manualReceiveNotes, setManualReceiveNotes] = useState("");
  const [savingManualReceiveBarcode, setSavingManualReceiveBarcode] = useState(false);
  const [manualEntryAlerts, setManualEntryAlerts] = useState<InventoryManualEntryAlert[]>([]);
  const [loadingManualEntryAlerts, setLoadingManualEntryAlerts] = useState(false);
  const [barcodeAliases, setBarcodeAliases] = useState<InventoryBarcodeAlias[]>([]);
  const [loadingBarcodeAliases, setLoadingBarcodeAliases] = useState(false);
  const [barcodeAliasSearch, setBarcodeAliasSearch] = useState("");
  const [selectedReceiveAliasId, setSelectedReceiveAliasId] = useState("");
  const [selectedPackingAliasId, setSelectedPackingAliasId] = useState("");
  const [orgUsers, setOrgUsers] = useState<OrgUser[]>([]);
  const [loadingOrgUsers, setLoadingOrgUsers] = useState(false);
  const [taskAssigneeFilter, setTaskAssigneeFilter] = useState("all");
  const [savingTaskAssignmentId, setSavingTaskAssignmentId] = useState("");
  const [warehouseTasks, setWarehouseTasks] = useState<WarehouseOperationTask[]>([]);
  const [loadingWarehouseTasks, setLoadingWarehouseTasks] = useState(false);
  const [warehouseLocations, setWarehouseLocations] = useState<WarehouseLocation[]>([]);
  const [loadingWarehouseLocations, setLoadingWarehouseLocations] = useState(false);
  const [warehouseLocationSearch, setWarehouseLocationSearch] = useState("");
  const [selectedWarehouseLocationId, setSelectedWarehouseLocationId] = useState("");
  const [warehouseLocationDraft, setWarehouseLocationDraft] = useState<WarehouseLocationEditorState>(() =>
    createEmptyWarehouseLocationDraft(),
  );
  const [savingWarehouseLocation, setSavingWarehouseLocation] = useState(false);
  const [receiveLocationScanInput, setReceiveLocationScanInput] = useState("");
  const [receiveLocationScanBusy, setReceiveLocationScanBusy] = useState(false);
  const [receiveLocationScanMessage, setReceiveLocationScanMessage] = useState("");
  const [receiveLocationResolvedId, setReceiveLocationResolvedId] = useState("");
  const [packingLocationScanInput, setPackingLocationScanInput] = useState("");
  const [packingLocationScanBusy, setPackingLocationScanBusy] = useState(false);
  const [packingLocationScanMessage, setPackingLocationScanMessage] = useState("");
  const [packingLocationResolvedId, setPackingLocationResolvedId] = useState("");
  const [receiveLineEanHints, setReceiveLineEanHints] = useState<Record<string, string>>({});
  const [shipmentLineEanHints, setShipmentLineEanHints] = useState<Record<string, string>>({});
  const [currentUserSession, setCurrentUserSession] = useState({ userId: "", email: "" });
  const [adjustmentDraft, setAdjustmentDraft] = useState<StockAdjustmentFormState>(createEmptyStockAdjustmentForm());
  const [adjustmentScanInput, setAdjustmentScanInput] = useState("");
  const [adjustmentLookupBusy, setAdjustmentLookupBusy] = useState(false);
  const [adjustmentLookupMessage, setAdjustmentLookupMessage] = useState("");
  const [adjustmentLookupResults, setAdjustmentLookupResults] = useState<CatalogRow[]>([]);
  const [adjustmentStockRows, setAdjustmentStockRows] = useState<WarehouseStockItem[]>([]);
  const [packingPackages, setPackingPackages] = useState<PackingPackageDraft[]>([]);
  const [packingPackageDraft, setPackingPackageDraft] = useState<PackingPackageDraft>(() => createEmptyPackingPackage(1));
  const [packingAssignments, setPackingAssignments] = useState<Record<string, PackingLineAssignment>>({});
  const [packingVehicleDraft, setPackingVehicleDraft] = useState<PackingVehicleDraft>(createEmptyPackingVehicleDraft());
  const [loadingPackingSession, setLoadingPackingSession] = useState(false);
  const [savingPackingSession, setSavingPackingSession] = useState(false);
  const [packingSessionMeta, setPackingSessionMeta] = useState<ShipmentPackingSession | null>(null);
  const [packingSessionReadyOrderId, setPackingSessionReadyOrderId] = useState("");
  const [packingSessionStorageReady, setPackingSessionStorageReady] = useState(true);
  const [packageLabelLayout, setPackageLabelLayout] = useState<WarehouseLabelLayout>("a4_single");
  const [packageLabelCodeMode, setPackageLabelCodeMode] = useState<WarehouseLabelCodeMode>("both");
  const [packingScanInput, setPackingScanInput] = useState("");
  const [packingScanBusy, setPackingScanBusy] = useState(false);
  const [packingScanMessage, setPackingScanMessage] = useState("");
  const [packingScanMatchedLineIds, setPackingScanMatchedLineIds] = useState<string[]>([]);
  const [packingScanSelectedLineId, setPackingScanSelectedLineId] = useState("");
  const [packingScanPendingQty, setPackingScanPendingQty] = useState("");
  const [packingScanManualQtyMode, setPackingScanManualQtyMode] = useState(false);
  const [manualPackingBarcodeInput, setManualPackingBarcodeInput] = useState("");
  const [manualPackingLineId, setManualPackingLineId] = useState("");
  const [manualPackingNotes, setManualPackingNotes] = useState("");
  const [savingManualPackingBarcode, setSavingManualPackingBarcode] = useState(false);
  const [previewingPackingPdf, setPreviewingPackingPdf] = useState(false);
  const [printingPackingPdf, setPrintingPackingPdf] = useState(false);
  const [downloadingPackingPdf, setDownloadingPackingPdf] = useState(false);
  const [downloadingPackingExcel, setDownloadingPackingExcel] = useState(false);
  const [previewingPackageLabelsPdf, setPreviewingPackageLabelsPdf] = useState(false);
  const [printingPackageLabelsPdf, setPrintingPackageLabelsPdf] = useState(false);
  const [downloadingPackageLabelsPdf, setDownloadingPackageLabelsPdf] = useState(false);
  const [transferDraft, setTransferDraft] = useState<StockTransferDraft | null>(null);
  const [warehouseApiClients, setWarehouseApiClients] = useState<WarehouseApiClient[]>([]);
  const [warehouseApiBaseUrl, setWarehouseApiBaseUrl] = useState("");
  const [warehouseApiHeaderName, setWarehouseApiHeaderName] = useState("x-api-key");
  const [warehouseApiDraft, setWarehouseApiDraft] = useState<WarehouseApiClient | null>(null);
  const [showWarehouseApiEditor, setShowWarehouseApiEditor] = useState(false);
  const [savingWarehouseApiClient, setSavingWarehouseApiClient] = useState(false);
  const [rotatingWarehouseApiClient, setRotatingWarehouseApiClient] = useState(false);
  const [latestWarehouseApiSecret, setLatestWarehouseApiSecret] = useState<WarehouseApiClientSecret | null>(null);
  const [isPhoneViewport, setIsPhoneViewport] = useState(false);
  const canSuperviseWarehouseTasks = isAdminLikeRole(role);
  const canWorkWarehouseTasks = isAdminLikeRole(role) || isWarehouseRole(role);
  const canManageManualBarcode = canWorkWarehouseTasks;
  const allowedInventoryTabs = useMemo(() => getAllowedInventoryTabs(role), [role]);
  const currentWarehouseTaskContextId =
    activeTab === "Purchase Receives" ? receiveWarehouseId : activeTab === "Packing & Loading" ? packingVehicleDraft.warehouse_id : "";
  const showManualEntryAlerts = isAdminLikeRole(role);
  const packingSessionSignatureRef = useRef("");

  useEffect(() => {
    if (typeof window === "undefined") return;
    const mediaQuery = window.matchMedia(`(max-width: ${INVENTORY_PHONE_BREAKPOINT_PX}px)`);
    const syncPhoneViewport = () => setIsPhoneViewport(mediaQuery.matches);
    syncPhoneViewport();
    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", syncPhoneViewport);
      return () => mediaQuery.removeEventListener("change", syncPhoneViewport);
    }
    mediaQuery.addListener(syncPhoneViewport);
    return () => mediaQuery.removeListener(syncPhoneViewport);
  }, []);

  async function reloadWarehouses() {
    const warehouseRows = await fetchWarehouses();
    setWarehouses(warehouseRows);
    return warehouseRows;
  }

  async function reloadWarehouseApiClients() {
    if (!canSuperviseWarehouseTasks) {
      setWarehouseApiClients([]);
      setWarehouseApiBaseUrl("");
      setWarehouseApiHeaderName("x-api-key");
      return [];
    }
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

  async function reloadManualEntryAlerts() {
    if (!showManualEntryAlerts) {
      setManualEntryAlerts([]);
      return [];
    }
    setLoadingManualEntryAlerts(true);
    try {
      const rows = await fetchInventoryManualEntryAlerts(12);
      setManualEntryAlerts(rows);
      return rows;
    } finally {
      setLoadingManualEntryAlerts(false);
    }
  }

  async function reloadBarcodeAliases() {
    if (!showManualEntryAlerts) {
      setBarcodeAliases([]);
      return [];
    }
    setLoadingBarcodeAliases(true);
    try {
      const rows = await fetchInventoryBarcodeAliases(40);
      setBarcodeAliases(rows);
      return rows;
    } finally {
      setLoadingBarcodeAliases(false);
    }
  }

  async function reloadOrgUsers() {
    if (!canWorkWarehouseTasks) {
      setOrgUsers([]);
      return [];
    }
    setLoadingOrgUsers(true);
    try {
      const rows = await fetchOrgUsers();
      setOrgUsers(rows);
      return rows;
    } finally {
      setLoadingOrgUsers(false);
    }
  }

  async function reloadWarehouseTasks(warehouseId?: string) {
    setLoadingWarehouseTasks(true);
    try {
      const rows = await fetchWarehouseOperationTasks(warehouseId, 60);
      setWarehouseTasks(rows);
      return rows;
    } finally {
      setLoadingWarehouseTasks(false);
    }
  }

  async function reloadWarehouseLocations(warehouseId?: string) {
    if (!warehouseId) {
      setWarehouseLocations([]);
      return [];
    }
    setLoadingWarehouseLocations(true);
    try {
      const rows = await fetchWarehouseLocations(warehouseId);
      setWarehouseLocations(rows);
      return rows;
    } finally {
      setLoadingWarehouseLocations(false);
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
          canSuperviseWarehouseTasks
            ? fetchWarehouseApiClients().catch(() => ({ clients: [], apiBaseUrl: "", headerName: "x-api-key" }))
            : Promise.resolve({ clients: [], apiBaseUrl: "", headerName: "x-api-key" }),
        ]);
        if (cancelled) return;
        setWarehouses(warehouseRows);
        setWarehouseApiClients(warehouseApiPayload.clients);
        setWarehouseApiBaseUrl(warehouseApiPayload.apiBaseUrl);
        setWarehouseApiHeaderName(warehouseApiPayload.headerName);

        const firstWarehouse = warehouseRows[0] || createEmptyWarehouse();
        const firstStockedWarehouse = warehouseRows.find((row) => row.fulfillment_model !== "dropship") || warehouseRows[0] || null;
        setSelectedWarehouseId(firstWarehouse.id);
        setDraft(firstWarehouse);
        setShowWarehouseEditor(false);
        setReceiveWarehouseId(firstStockedWarehouse?.id || "");
        setMovementWarehouseId(firstStockedWarehouse?.id || "");
        setAdjustmentWarehouseId(firstStockedWarehouse?.id || "");
        setOnHandWarehouseId("");
        setTransferSourceId(firstStockedWarehouse?.id || "");
        setTransferTargetId(
          warehouseRows.find((row) => row.id !== firstStockedWarehouse?.id && row.fulfillment_model !== "dropship")?.id || firstStockedWarehouse?.id || "",
        );

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
  }, [actionFeedback, canSuperviseWarehouseTasks]);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      const contextWarehouseId =
        activeTab === "Warehouses"
          ? selectedWarehouseId
          : activeTab === "Purchase Receives"
            ? receiveWarehouseId
            : activeTab === "Packing & Loading"
              ? packingVehicleDraft.warehouse_id
              : "";
      if (!contextWarehouseId || !["Warehouses", "Purchase Receives", "Packing & Loading"].includes(activeTab)) {
        setWarehouseLocations([]);
        setSelectedWarehouseLocationId("");
        return;
      }

      try {
        const rows = await reloadWarehouseLocations(contextWarehouseId);
        if (cancelled) return;
        if (activeTab === "Warehouses") {
          const warehouse = warehouses.find((row) => row.id === contextWarehouseId) || null;
          const nextSelected =
            rows.find((row) => row.id === selectedWarehouseLocationId) || rows.find((row) => row.is_default_pick_face) || rows[0] || null;
          setSelectedWarehouseLocationId(nextSelected?.id || "");
          setWarehouseLocationDraft(mapWarehouseLocationToDraft(nextSelected, warehouse));
        }
      } catch (caught) {
        if (!cancelled) {
          actionFeedback.fail(caught instanceof Error ? caught.message : "Warehouse location load failed");
        }
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [actionFeedback, activeTab, packingVehicleDraft.warehouse_id, receiveWarehouseId, selectedWarehouseId, warehouses]);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      if (!["Scan Center", "Purchase Receives", "Packing & Loading"].includes(activeTab)) return;
      const contextWarehouseId =
        activeTab === "Purchase Receives"
          ? receiveWarehouseId
          : activeTab === "Packing & Loading"
            ? packingVehicleDraft.warehouse_id
            : "";
      try {
        const rows = await reloadWarehouseTasks(contextWarehouseId || undefined);
        if (cancelled) return;
        setWarehouseTasks(rows);
      } catch (caught) {
        if (!cancelled) {
          actionFeedback.fail(caught instanceof Error ? caught.message : "Warehouse task load failed");
        }
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [actionFeedback, activeTab, currentWarehouseTaskContextId, packingVehicleDraft.warehouse_id, receiveWarehouseId]);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      if (!canSuperviseWarehouseTasks || !["Scan Center", "Purchase Receives", "Packing & Loading"].includes(activeTab)) return;
      try {
        const rows = await reloadOrgUsers();
        if (cancelled) return;
        setOrgUsers(rows);
      } catch (caught) {
        if (!cancelled) {
          actionFeedback.fail(caught instanceof Error ? caught.message : "Warehouse user load failed");
        }
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [actionFeedback, activeTab, canSuperviseWarehouseTasks]);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      try {
        const session = await fetchAppSession();
        if (!cancelled) {
          setCurrentUserSession({
            userId: session.userId || "",
            email: session.email || "",
          });
        }
      } catch {
        if (!cancelled) {
          setCurrentUserSession({ userId: "", email: "" });
        }
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setActiveTab(resolveInventoryTab(role, initialTab));
  }, [initialTab, role]);

  useEffect(() => {
    if (!allowedInventoryTabs.includes(activeTab)) {
      setActiveTab(resolveInventoryTab(role, activeTab));
    }
  }, [activeTab, allowedInventoryTabs, role]);

  useEffect(() => {
    if (!selectedWarehouseIdProp) return;
    setSelectedWarehouseId(selectedWarehouseIdProp);
    setOnHandWarehouseId(selectedWarehouseIdProp);
    setMovementWarehouseId(selectedWarehouseIdProp);
    setActiveTab(resolveInventoryTab(role, "On Hand"));
  }, [role, selectedWarehouseIdProp]);

  useEffect(() => {
    setOnHandStockSearch(stockSearchProp);
    if (stockSearchProp) setActiveTab(resolveInventoryTab(role, "On Hand"));
  }, [role, stockSearchProp]);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      if (activeTab !== "Purchase Receives") return;
      try {
        const [orders, receives] = await Promise.all([
          reloadPurchaseOrders(),
          reloadPurchaseReceives(),
          showManualEntryAlerts ? reloadManualEntryAlerts() : Promise.resolve([] as InventoryManualEntryAlert[]),
          showManualEntryAlerts ? reloadBarcodeAliases() : Promise.resolve([] as InventoryBarcodeAlias[]),
        ]);
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
  }, [actionFeedback, activeTab, showManualEntryAlerts]);

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
      if (activeTab !== "Stock Movements" || !adjustmentWarehouseId) {
        setAdjustmentStockRows([]);
        return;
      }
      try {
        setLoadingAdjustmentStock(true);
        const rows = await fetchWarehouseStockItems(adjustmentWarehouseId);
        if (!cancelled) setAdjustmentStockRows(rows);
      } catch (caught) {
        if (!cancelled) {
          actionFeedback.fail(caught instanceof Error ? caught.message : "Adjustment stock lookup failed");
        }
      } finally {
        if (!cancelled) setLoadingAdjustmentStock(false);
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [actionFeedback, activeTab, adjustmentWarehouseId]);

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

  useEffect(() => {
    let cancelled = false;

    async function run() {
      if (activeTab !== "Packing & Loading" || !packingVehicleDraft.warehouse_id) {
        setPackingWarehouseStockRows([]);
        return;
      }
      try {
        setLoadingPackingWarehouseStock(true);
        const rows = await fetchWarehouseStockItems(packingVehicleDraft.warehouse_id);
        if (!cancelled) setPackingWarehouseStockRows(rows);
      } catch (caught) {
        if (!cancelled) {
          actionFeedback.fail(caught instanceof Error ? caught.message : "Packing warehouse stock lookup failed");
        }
      } finally {
        if (!cancelled) setLoadingPackingWarehouseStock(false);
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [actionFeedback, activeTab, packingVehicleDraft.warehouse_id]);

  const warehouseColumns = useMemo(
    () => [
      { key: "code", header: t("inventory.code"), render: (row: Warehouse) => row.warehouse_code || "-" },
      { key: "name", header: t("inventory.warehouse_short"), render: (row: Warehouse) => row.warehouse_name || "-" },
      { key: "type", header: t("inventory.type_short"), render: (row: Warehouse) => translateWarehouseKind(row.warehouse_kind) },
      { key: "fulfillment", header: t("inventory.fulfillment_model"), render: (row: Warehouse) => translateFulfillmentModel(row.fulfillment_model) },
      { key: "region", header: t("inventory.region_short"), render: (row: Warehouse) => row.region || "-" },
      { key: "status", header: t("inventory.status_short"), render: (row: Warehouse) => (row.is_active ? t("inventory.active") : t("inventory.closed")) },
    ],
    [language],
  );

  const warehouseKindOptions = useMemo(
    () => [
      { value: "internal", label: `${t("inventory.internal")} ${t("inventory.warehouse_short")}` },
      { value: "outsourced", label: `${t("inventory.outsourced")} ${t("inventory.warehouse_short")}` },
    ],
    [language],
  );

  const externalAuthTypeOptions = useMemo(
    () => [
      { value: "none", label: t("inventory.no_auth") },
      { value: "bearer_env", label: t("inventory.bearer_token_env") },
    ],
    [language],
  );

  const fulfillmentModelOptions = useMemo(
    () => [
      { value: "stocked", label: `${t("inventory.stocked")} Fulfillment` },
      { value: "dropship", label: `${t("inventory.dropship")} Fulfillment` },
    ],
    [language],
  );

  const warehouseOptions = useMemo(
    () => [{ value: "", label: t("inventory.select_warehouse") }, ...warehouses.map((row) => ({ value: row.id, label: `${row.warehouse_code} · ${row.warehouse_name}` }))],
    [language, warehouses],
  );

  const stockedWarehouseOptions = useMemo(
    () => [{ value: "", label: t("inventory.select_warehouse") }, ...warehouses.filter((row) => row.fulfillment_model !== "dropship").map((row) => ({ value: row.id, label: `${row.warehouse_code} · ${row.warehouse_name}` }))],
    [language, warehouses],
  );

  const warehouseFilterOptions = useMemo(
    () => [{ value: "", label: t("inventory.all_warehouses") }, ...warehouses.map((row) => ({ value: row.id, label: `${row.warehouse_code} · ${row.warehouse_name}` }))],
    [language, warehouses],
  );

  const shareableWarehouses = useMemo(
    () => warehouses.filter((row) => row.is_active && row.fulfillment_model !== "dropship"),
    [warehouses],
  );

  const packingWarehouseOptions = useMemo(
    () => [{ value: "", label: t("inventory.select_warehouse") }, ...shareableWarehouses.map((row) => ({ value: row.id, label: `${row.warehouse_code} · ${row.warehouse_name}` }))],
    [language, shareableWarehouses],
  );

  const warehouseApiClientColumns = useMemo(
    () => [
      { key: "client", header: t("inventory.client_name"), render: (row: WarehouseApiClient) => row.client_name || "-" },
      { key: "partner", header: t("inventory.partner_name"), render: (row: WarehouseApiClient) => row.partner_name || "-" },
      { key: "warehouses", header: t("inventory.allowed_warehouses"), render: (row: WarehouseApiClient) => row.warehouse_labels.length || 0 },
      { key: "order", header: t("inventory.order_api"), render: (row: WarehouseApiClient) => (row.allow_order_submit ? t("inventory.status_open") : t("inventory.closed")) },
      { key: "status", header: t("inventory.status_short"), render: (row: WarehouseApiClient) => (row.status === "disabled" ? t("inventory.disabled") : t("inventory.active")) },
      { key: "key", header: t("inventory.key_prefix"), render: (row: WarehouseApiClient) => row.api_key_prefix || "-" },
      { key: "last", header: t("inventory.last_used"), render: (row: WarehouseApiClient) => formatDate(row.last_used_at) },
    ],
    [language],
  );

  const isWorkerRole = isWarehouseRole(role);

  const selectedReceiveWarehouse = useMemo(
    () => warehouses.find((row) => row.id === receiveWarehouseId) || null,
    [receiveWarehouseId, warehouses],
  );

  const selectedAdjustmentWarehouse = useMemo(
    () => warehouses.find((row) => row.id === adjustmentWarehouseId) || null,
    [adjustmentWarehouseId, warehouses],
  );

  const selectedTransferSourceWarehouse = useMemo(
    () => warehouses.find((row) => row.id === transferSourceId) || null,
    [transferSourceId, warehouses],
  );

  const selectedTransferTargetWarehouse = useMemo(
    () => warehouses.find((row) => row.id === transferTargetId) || null,
    [transferTargetId, warehouses],
  );

  const selectedPackingWarehouse = useMemo(
    () => shareableWarehouses.find((row) => row.id === packingVehicleDraft.warehouse_id) || null,
    [packingVehicleDraft.warehouse_id, shareableWarehouses],
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

  const receiveLineOptions = useMemo(
    () => [
      { value: "", label: t("inventory.select_receive_line") },
      ...(receiveDraft?.lines || []).map((line) => ({
        value: line.key,
        label: `${line.brand || "-"} · ${line.product_code || line.old_code || "-"} · ${t("inventory.qty_remaining", { count: formatLocalizedCount(line.qty_remaining_before) })}`,
      })),
    ],
    [language, receiveDraft],
  );

  const shipmentInvoiceBySalesOrderId = useMemo(() => {
    const next = new Map<string, LocalInvoice>();
    shipmentInvoices.forEach((invoice) => {
      [invoice.sales_order_id, ...(invoice.sales_order_ids || [])]
        .filter(Boolean)
        .forEach((salesOrderId) => {
          if (!next.has(salesOrderId)) next.set(salesOrderId, invoice);
        });
    });
    return next;
  }, [shipmentInvoices]);

  const readyShipmentOrders = useMemo(
    () =>
      shipmentOrders.filter((order) => order.status === "confirmed" && order.lines.some((line) => Number(line.qty || 0) > 0)),
    [shipmentOrders],
  );

  const selectedShipmentOrder = useMemo(
    () => readyShipmentOrders.find((order) => order.id === selectedShipmentId) || readyShipmentOrders[0] || null,
    [readyShipmentOrders, selectedShipmentId],
  );

  const selectedShipmentInvoice = useMemo(
    () => (selectedShipmentOrder ? shipmentInvoiceBySalesOrderId.get(selectedShipmentOrder.id) || null : null),
    [selectedShipmentOrder, shipmentInvoiceBySalesOrderId],
  );

  const selectedShipmentLines = selectedShipmentOrder?.lines || [];

  function handleReviewManualAlert(alert: InventoryManualEntryAlert) {
    if (isReceiveManualAlert(alert)) {
      setActiveTab("Purchase Receives");
      if (alert.document_id) setSelectedReceiveId(alert.document_id);
      if (alert.line_key) {
        setReceiveScanMatchedKeys([alert.line_key]);
        setReceiveScanSelectedLineKey(alert.line_key);
        setManualReceiveLineKey(alert.line_key);
      }
      return;
    }

    setActiveTab("Packing & Loading");
    if (alert.document_id) setSelectedShipmentId(alert.document_id);
    if (alert.line_key) {
      setPackingScanMatchedLineIds([alert.line_key]);
      setPackingScanSelectedLineId(alert.line_key);
      setManualPackingLineId(alert.line_key);
    }
  }

  useEffect(() => {
    if (!showManualEntryAlerts || !focusTarget || !focusToken) return;
    if (focusTarget === "manual-alerts" && activeTab === "Purchase Receives") {
      scrollInventoryFocusTarget(focusTarget);
    }
    if (focusTarget === "receive-alert" && activeTab === "Purchase Receives") {
      if (focusDocumentId && selectedReceiveId !== focusDocumentId) {
        setSelectedReceiveId(focusDocumentId);
        return;
      }
      if (focusLineKey && receiveDraft?.lines.some((line) => line.key === focusLineKey)) {
        setReceiveScanMatchedKeys([focusLineKey]);
        setReceiveScanSelectedLineKey(focusLineKey);
        setManualReceiveLineKey(focusLineKey);
        scrollReceiveLineIntoView(focusLineKey);
      }
    }
    if (focusTarget === "packing-alert" && activeTab === "Packing & Loading") {
      if (focusDocumentId && selectedShipmentId !== focusDocumentId) {
        setSelectedShipmentId(focusDocumentId);
        return;
      }
      if (focusLineKey && selectedShipmentLines.some((line) => line.lineId === focusLineKey)) {
        setPackingScanMatchedLineIds([focusLineKey]);
        setPackingScanSelectedLineId(focusLineKey);
        setManualPackingLineId(focusLineKey);
        scrollShipmentLineIntoView(focusLineKey);
      }
    }
  }, [
    activeTab,
    focusDocumentId,
    focusLineKey,
    focusTarget,
    focusToken,
    receiveDraft,
    selectedReceiveId,
    selectedShipmentId,
    selectedShipmentLines,
    showManualEntryAlerts,
  ]);

  useEffect(() => {
    if (activeTab !== "Purchase Receives" || !receiveScanSelectedLineKey) return;
    if (!receiveDraft?.lines.some((line) => line.key === receiveScanSelectedLineKey)) return;
    scrollReceiveLineIntoView(receiveScanSelectedLineKey);
  }, [activeTab, receiveDraft, receiveScanSelectedLineKey]);

  useEffect(() => {
    if (activeTab !== "Packing & Loading" || !packingScanSelectedLineId) return;
    if (!selectedShipmentLines.some((line) => line.lineId === packingScanSelectedLineId)) return;
    scrollShipmentLineIntoView(packingScanSelectedLineId);
  }, [activeTab, packingScanSelectedLineId, selectedShipmentLines]);

  const selectedReceiveBindingLine = useMemo(
    () => receiveDraft?.lines.find((line) => line.key === manualReceiveLineKey) || null,
    [manualReceiveLineKey, receiveDraft],
  );

  const selectedReceiveScanLine = useMemo(
    () => receiveDraft?.lines.find((line) => line.key === receiveScanSelectedLineKey) || null,
    [receiveDraft, receiveScanSelectedLineKey],
  );

  const selectedShipmentBindingLine = useMemo(
    () => selectedShipmentLines.find((line) => line.lineId === manualPackingLineId) || null,
    [manualPackingLineId, selectedShipmentLines],
  );

  const selectedPackingScanLine = useMemo(
    () => selectedShipmentLines.find((line) => line.lineId === packingScanSelectedLineId) || null,
    [packingScanSelectedLineId, selectedShipmentLines],
  );

  const selectedReceiveAlias = useMemo(
    () => barcodeAliases.find((alias) => alias.id === selectedReceiveAliasId) || null,
    [barcodeAliases, selectedReceiveAliasId],
  );

  const selectedPackingAlias = useMemo(
    () => barcodeAliases.find((alias) => alias.id === selectedPackingAliasId) || null,
    [barcodeAliases, selectedPackingAliasId],
  );

  const receiveBindableLines = useMemo(
    () =>
      receiveDraft?.lines.map((line) => ({
        ...toReceiveBindableLine(line),
        ean: receiveLineEanHints[line.key] || "",
      })) || [],
    [receiveDraft, receiveLineEanHints],
  );

  const shipmentBindableLines = useMemo(
    () =>
      selectedShipmentLines.map((line) => ({
        ...toShipmentBindableLine(line),
        ean: shipmentLineEanHints[line.lineId] || "",
      })),
    [selectedShipmentLines, shipmentLineEanHints],
  );

  const shipmentLineOptions = useMemo(
    () => [
      { value: "", label: t("inventory.select_shipment_item") },
      ...selectedShipmentLines.map((line) => ({
        value: line.lineId,
        label: `${line.brand || "-"} · ${line.resolvedCode || line.requestedCode || "-"} · ${t("inventory.qty_short", { count: formatLocalizedCount(Number(line.qty || 0)) })}`,
      })),
    ],
    [language, selectedShipmentLines],
  );

  const shipmentWarehouseLocationByLineId = useMemo(() => {
    const next = new Map<string, WarehouseStockItem | null>();
    selectedShipmentLines.forEach((line) => {
      next.set(
        line.lineId,
        findMatchingWarehouseStockItem(
          packingWarehouseStockRows,
          line.brand || "",
          line.resolvedCode || line.requestedCode || "",
          line.requestedCode || line.resolvedCode || "",
        ),
      );
    });
    return next;
  }, [packingWarehouseStockRows, selectedShipmentLines]);

  const receiveBindingCandidates = useMemo(() => {
    if (!receiveDraft) return [];
    const rankedKeys = Array.from(new Set([manualReceiveLineKey, ...receiveScanMatchedKeys].filter(Boolean)));
    return rankedKeys
      .map((key) => {
        const line = receiveDraft.lines.find((item) => item.key === key);
        if (!line) return null;
        return {
          id: line.key,
          title: `${line.brand || "-"} ${line.product_code || line.old_code || "-"}`.trim(),
          subtitle: line.description || t("inventory.no_description"),
          meta: `${t("inventory.qty_remaining", { count: formatLocalizedCount(line.qty_remaining_before) })}${line.oem_no ? ` · OEM ${line.oem_no}` : ""}`,
        };
      })
      .filter(Boolean) as Array<{ id: string; title: string; subtitle: string; meta: string }>;
  }, [formatLocalizedCount, language, manualReceiveLineKey, receiveDraft, receiveScanMatchedKeys]);

  const shipmentBindingCandidates = useMemo(() => {
    const rankedIds = Array.from(new Set([manualPackingLineId, ...packingScanMatchedLineIds].filter(Boolean)));
    return rankedIds
      .map((lineId) => {
        const line = selectedShipmentLines.find((item) => item.lineId === lineId);
        const stockLocation = shipmentWarehouseLocationByLineId.get(lineId) || null;
        if (!line) return null;
        return {
          id: line.lineId,
          title: `${line.brand || "-"} ${line.resolvedCode || line.requestedCode || "-"}`.trim(),
          subtitle: line.description || t("inventory.no_description"),
          meta: `${t("inventory.qty_short", { count: formatLocalizedCount(Number(line.qty || 0)) })}${line.origin ? ` · ${line.origin}` : ""}${line.hs_code ? ` · HS ${line.hs_code}` : ""}${stockLocation ? ` · ${formatWarehouseLocation(stockLocation)}` : ""}`,
        };
      })
      .filter(Boolean) as Array<{ id: string; title: string; subtitle: string; meta: string }>;
  }, [formatLocalizedCount, language, manualPackingLineId, packingScanMatchedLineIds, selectedShipmentLines, shipmentWarehouseLocationByLineId]);

  const receiveScanFocusKeys = useMemo(
    () => Array.from(new Set([receiveScanSelectedLineKey, manualReceiveLineKey, ...receiveScanMatchedKeys].filter(Boolean))),
    [manualReceiveLineKey, receiveScanMatchedKeys, receiveScanSelectedLineKey],
  );

  const packingScanFocusLineIds = useMemo(
    () => Array.from(new Set([packingScanSelectedLineId, manualPackingLineId, ...packingScanMatchedLineIds].filter(Boolean))),
    [manualPackingLineId, packingScanMatchedLineIds, packingScanSelectedLineId],
  );

  useEffect(() => {
    if (!receiveScanSelectedLineKey || selectedReceiveScanLine) return;
    setReceiveScanSelectedLineKey("");
    setReceiveScanPendingQty("");
    setReceiveScanManualQtyMode(false);
    setReceiveLocationResolvedId("");
    setReceiveLocationScanMessage("");
  }, [receiveScanSelectedLineKey, selectedReceiveScanLine]);

  useEffect(() => {
    if (!packingScanSelectedLineId || selectedPackingScanLine) return;
    setPackingScanSelectedLineId("");
    setPackingScanPendingQty("");
    setPackingScanManualQtyMode(false);
    setPackingLocationResolvedId("");
    setPackingLocationScanMessage("");
  }, [packingScanSelectedLineId, selectedPackingScanLine]);

  const visibleBarcodeAliases = useMemo(() => {
    const token = barcodeAliasSearch.trim().toLowerCase();
    if (!token) return barcodeAliases;
    return barcodeAliases.filter((alias) =>
      [alias.barcode, alias.brand, alias.product_code, alias.old_code, alias.description, alias.created_by_email]
        .join(" ")
        .toLowerCase()
        .includes(token),
    );
  }, [barcodeAliasSearch, barcodeAliases]);

  const packingPackageOptions = useMemo(
    () => [{ value: "", label: t("inventory.unassigned") }, ...packingPackages.map((pkg) => ({ value: pkg.id, label: pkg.label }))],
    [language, packingPackages],
  );

  const packedQtyTotal = useMemo(
    () =>
      selectedShipmentLines.reduce((sum, line) => {
        const assignment = packingAssignments[line.lineId];
        const packedQty = Math.max(0, Math.min(line.qty, parseNumberInput(assignment?.packedQty || "0")));
        return sum + packedQty;
      }, 0),
    [packingAssignments, selectedShipmentLines],
  );

  const selectedShipmentQtyTotal = useMemo(
    () => selectedShipmentLines.reduce((sum, line) => sum + Number(line.qty || 0), 0),
    [selectedShipmentLines],
  );

  const packingPackageSummaries = useMemo(
    () =>
      packingPackages.map((pkg) => {
        const assignedLines = selectedShipmentLines
          .map((line) => {
            const assignment = packingAssignments[line.lineId];
            if (assignment?.packageId !== pkg.id) return null;
            const packedQty = Math.max(0, Math.min(line.qty, parseNumberInput(assignment.packedQty || "0")));
            if (!packedQty) return null;
            return { line, packedQty };
          })
          .filter(Boolean) as Array<{ line: LocalSalesOrder["lines"][number]; packedQty: number }>;
        const netWeightKg = assignedLines.reduce((sum, item) => sum + (item.line.weight_kg || 0) * item.packedQty, 0);
        const manualGrossWeightKg = parseNumberInput(pkg.grossWeightKg);
        const grossWeightKg = manualGrossWeightKg > 0 ? manualGrossWeightKg : netWeightKg;
        const volumeM3 = calculatePackageVolumeM3(pkg);
        return {
          pkg,
          assignedLines,
          itemCount: assignedLines.reduce((sum, item) => sum + item.packedQty, 0),
          netWeightKg,
          grossWeightKg,
          volumeM3,
        };
      }),
    [packingAssignments, packingPackages, selectedShipmentLines],
  );

  const selectedLoadingVehicle = useMemo(
    () => getLoadingVehiclePreset(packingVehicleDraft.mode),
    [packingVehicleDraft.mode],
  );

  const selectedPackingScanLocation = useMemo(
    () => (selectedPackingScanLine ? shipmentWarehouseLocationByLineId.get(selectedPackingScanLine.lineId) || null : null),
    [selectedPackingScanLine, shipmentWarehouseLocationByLineId],
  );

  const selectedWarehouseLocation = useMemo(
    () => warehouseLocations.find((row) => row.id === selectedWarehouseLocationId) || null,
    [selectedWarehouseLocationId, warehouseLocations],
  );

  const visibleWarehouseLocations = useMemo(() => {
    const token = warehouseLocationSearch.trim().toLowerCase();
    if (!token) return warehouseLocations;
    return warehouseLocations.filter((row) =>
      [
        row.location_code,
        row.location_barcode,
        row.zone_code,
        row.aisle_code,
        row.rack_code,
        row.level_code,
        row.bin_code,
        row.shelf_address,
        row.section_code,
        row.location_type,
        row.notes,
      ]
        .join(" ")
        .toLowerCase()
        .includes(token),
    );
  }, [warehouseLocationSearch, warehouseLocations]);

  const selectedReceiveLocation = useMemo(
    () => findWarehouseLocationByAddress(warehouseLocations, selectedReceiveScanLine?.shelf_address || "", selectedReceiveScanLine?.section_code || ""),
    [selectedReceiveScanLine?.section_code, selectedReceiveScanLine?.shelf_address, warehouseLocations],
  );

  const selectedPackingExpectedLocation = useMemo(
    () =>
      selectedPackingScanLocation
        ? findWarehouseLocationByAddress(
            warehouseLocations,
            selectedPackingScanLocation.shelf_address || "",
            selectedPackingScanLocation.section_code || "",
          )
        : null,
    [selectedPackingScanLocation, warehouseLocations],
  );

  const warehouseAssignableUsers = useMemo(
    () =>
      orgUsers
        .filter((row) => row.is_active && (row.role === "warehouse" || row.role === "admin" || row.role === "superadmin"))
        .sort((left, right) => (left.full_name || left.email).localeCompare(right.full_name || right.email)),
    [orgUsers],
  );

  const warehouseTaskUserById = useMemo(() => new Map(orgUsers.map((row) => [row.user_id, row])), [orgUsers]);

  const warehouseTaskUserByEmail = useMemo(
    () =>
      new Map(
        orgUsers
          .map((row) => [String(row.email || "").trim().toLowerCase(), row] as const)
          .filter(([email]) => Boolean(email)),
      ),
    [orgUsers],
  );

  const warehouseTaskAssigneeOptions = useMemo(
    () => [
      { value: "", label: t("inventory.unassigned") },
      ...warehouseAssignableUsers.map((row) => ({
        value: row.user_id,
        label: `${row.full_name || row.email} · ${translatePresenceLabel(getPresenceStatus(row.last_seen_at).tone)}`,
      })),
    ],
    [language, warehouseAssignableUsers],
  );

  const onlineWarehouseWorkerCount = useMemo(
    () => warehouseAssignableUsers.filter((row) => getPresenceStatus(row.last_seen_at).tone === "online").length,
    [warehouseAssignableUsers],
  );

  const warehouseTaskFilterOptions = useMemo(
    () => [
      { value: "all", label: t("inventory.task_filter_all") },
      ...(currentUserSession.userId ? [{ value: "mine", label: t("inventory.task_filter_mine") }] : []),
      { value: "unassigned", label: t("inventory.unassigned") },
      ...warehouseAssignableUsers.map((row) => ({
        value: `user:${row.user_id}`,
        label: row.full_name || row.email,
      })),
    ],
    [currentUserSession.userId, language, warehouseAssignableUsers],
  );

  const filteredWarehouseTasks = useMemo(() => {
    const baseRows = warehouseTasks.filter((row) => {
      if (canSuperviseWarehouseTasks) return true;
      if (!currentUserSession.userId) return !row.assigned_user_id;
      return !row.assigned_user_id || row.assigned_user_id === currentUserSession.userId || row.completed_by_user_id === currentUserSession.userId;
    });

    if (taskAssigneeFilter === "all") return baseRows;
    if (taskAssigneeFilter === "mine") {
      return baseRows.filter((row) => row.assigned_user_id === currentUserSession.userId || row.completed_by_user_id === currentUserSession.userId);
    }
    if (taskAssigneeFilter === "unassigned") {
      return baseRows.filter((row) => !row.assigned_user_id && !row.assigned_user_email);
    }
    if (taskAssigneeFilter.startsWith("user:")) {
      const userId = taskAssigneeFilter.slice(5);
      return baseRows.filter((row) => row.assigned_user_id === userId);
    }
    return baseRows;
  }, [canSuperviseWarehouseTasks, currentUserSession.userId, taskAssigneeFilter, warehouseTasks]);

  const recentOpenWarehouseTasks = useMemo(
    () => warehouseTasks.filter((row) => row.status !== "completed" && row.status !== "cancelled"),
    [warehouseTasks],
  );

  const recentCompletedWarehouseTasks = useMemo(
    () => warehouseTasks.filter((row) => row.status === "completed").slice(0, 10),
    [warehouseTasks],
  );

  const overdueWarehouseTaskCount = useMemo(
    () => recentOpenWarehouseTasks.filter((row) => deriveWarehouseTaskAlert(row).isOverdue).length,
    [recentOpenWarehouseTasks],
  );

  const unassignedWarehouseTaskCount = useMemo(
    () => recentOpenWarehouseTasks.filter((row) => !row.assigned_user_id && !row.assigned_user_email).length,
    [recentOpenWarehouseTasks],
  );

  const visibleWarehouseTaskRows = useMemo(
    () =>
      filteredWarehouseTasks.slice(0, 16).map((task) => {
        const assignedUser =
          (task.assigned_user_id ? warehouseTaskUserById.get(task.assigned_user_id) : null) ||
          (task.assigned_user_email ? warehouseTaskUserByEmail.get(task.assigned_user_email.trim().toLowerCase()) : null) ||
          null;
        const presence = assignedUser ? getPresenceStatus(assignedUser.last_seen_at) : null;
        const alert = deriveWarehouseTaskAlert(task);
        return {
          task,
          assignedUser,
          presence,
          alert,
          locationPath:
            task.workflow_stage === "pick"
              ? formatWarehouseLocation({
                  shelf_address: task.from_shelf_address,
                  section_code: task.from_section_code,
                })
              : formatWarehouseLocation({
                  shelf_address: task.to_shelf_address,
                  section_code: task.to_section_code,
                }),
        };
      }),
    [filteredWarehouseTasks, warehouseTaskUserByEmail, warehouseTaskUserById],
  );

  const directedPutawayQueueRows = useMemo(() => {
    if (!receiveDraft) return [];
    return receiveDraft.lines
      .filter((line) => line.qty_received > 0 || line.key === receiveScanSelectedLineKey)
      .map((line) => {
        const savedTask =
          warehouseTasks.find(
            (row) => row.workflow_stage === "putaway" && row.source_document_id === selectedReceive?.id && row.source_line_key === line.key,
          ) || null;
        const completedQty = Math.max(0, line.key === receiveScanSelectedLineKey ? parseNumberInput(receiveScanPendingQty || "0") || line.qty_received : line.qty_received);
        const location = findWarehouseLocationByAddress(warehouseLocations, line.shelf_address, line.section_code);
        const assignee =
          (savedTask?.assigned_user_id ? warehouseTaskUserById.get(savedTask.assigned_user_id) : null) ||
          (savedTask?.assigned_user_email ? warehouseTaskUserByEmail.get(savedTask.assigned_user_email.trim().toLowerCase()) : null) ||
          null;
        return {
          key: line.key,
          brand: line.brand,
          code: line.product_code || line.old_code || "-",
          description: line.description || "-",
          expectedQty: line.qty_remaining_before,
          completedQty: savedTask?.completed_qty ?? completedQty,
          locationPath: location ? buildWarehouseLocationPath(location) : formatWarehouseLocation(line),
          status: savedTask?.status || deriveWarehouseTaskStatus(completedQty, line.qty_remaining_before),
          assigneeName: assignee?.full_name || assignee?.email || savedTask?.assigned_user_email || "",
        };
      });
  }, [
    receiveDraft,
    receiveScanPendingQty,
    receiveScanSelectedLineKey,
    selectedReceive?.id,
    warehouseLocations,
    warehouseTaskUserByEmail,
    warehouseTaskUserById,
    warehouseTasks,
  ]);

  const directedPickQueueRows = useMemo(
    () =>
      selectedShipmentLines.map((line) => {
        const savedTask =
          warehouseTasks.find(
            (row) => row.workflow_stage === "pick" && row.source_document_id === selectedShipmentOrder?.id && row.source_line_key === line.lineId,
          ) || null;
        const assignment = packingAssignments[line.lineId];
        const packedQty = Math.max(0, Math.min(Number(line.qty || 0), parseNumberInput(assignment?.packedQty || "0")));
        const location = shipmentWarehouseLocationByLineId.get(line.lineId) || null;
        const assignee =
          (savedTask?.assigned_user_id ? warehouseTaskUserById.get(savedTask.assigned_user_id) : null) ||
          (savedTask?.assigned_user_email ? warehouseTaskUserByEmail.get(savedTask.assigned_user_email.trim().toLowerCase()) : null) ||
          null;
        return {
          key: line.lineId,
          brand: line.brand || "",
          code: line.resolvedCode || line.requestedCode || "-",
          description: line.description || "-",
          expectedQty: Number(line.qty || 0),
          completedQty: savedTask?.completed_qty ?? packedQty,
          locationPath: location
            ? buildWarehouseLocationPath({
                warehouse_code: location.warehouse_code,
                location_code: "",
                zone_code: "",
                aisle_code: "",
                rack_code: "",
                level_code: "",
                bin_code: "",
                shelf_address: location.shelf_address,
                section_code: location.section_code,
              })
            : formatWarehouseLocation(location),
          status: savedTask?.status || deriveWarehouseTaskStatus(packedQty, Number(line.qty || 0)),
          assigneeName: assignee?.full_name || assignee?.email || savedTask?.assigned_user_email || "",
        };
      }),
    [
      packingAssignments,
      selectedShipmentLines,
      selectedShipmentOrder?.id,
      shipmentWarehouseLocationByLineId,
      warehouseTaskUserByEmail,
      warehouseTaskUserById,
      warehouseTasks,
    ],
  );

  const visibleReceiveLines = useMemo(() => {
    if (!receiveDraft) return [];
    if (!isPhoneViewport || !receiveScanFocusKeys.length) return receiveDraft.lines;
    const focusKeys = new Set(receiveScanFocusKeys);
    return receiveDraft.lines.filter((line) => focusKeys.has(line.key));
  }, [isPhoneViewport, receiveDraft, receiveScanFocusKeys]);

  const visibleDirectedPutawayQueueRows = useMemo(() => {
    if (!isPhoneViewport || !receiveScanFocusKeys.length) return directedPutawayQueueRows;
    const focusKeys = new Set(receiveScanFocusKeys);
    return directedPutawayQueueRows.filter((row) => focusKeys.has(row.key));
  }, [directedPutawayQueueRows, isPhoneViewport, receiveScanFocusKeys]);

  const visibleShipmentScanLines = useMemo(() => {
    if (!isPhoneViewport || !packingScanFocusLineIds.length) return selectedShipmentLines;
    const focusIds = new Set(packingScanFocusLineIds);
    return selectedShipmentLines.filter((line) => focusIds.has(line.lineId));
  }, [isPhoneViewport, packingScanFocusLineIds, selectedShipmentLines]);

  const visibleDirectedPickQueueRows = useMemo(() => {
    if (!isPhoneViewport || !packingScanFocusLineIds.length) return directedPickQueueRows;
    const focusIds = new Set(packingScanFocusLineIds);
    return directedPickQueueRows.filter((row) => focusIds.has(row.key));
  }, [directedPickQueueRows, isPhoneViewport, packingScanFocusLineIds]);

  function openLocationPreviewFromStockItem(item: WarehouseStockItem, source: "onhand" | "transfer") {
    setLocationPreview({
      source,
      warehouseCode: item.warehouse_code,
      warehouseName: item.warehouse_name,
      brand: item.brand,
      productCode: item.product_code,
      oldCode: item.old_code,
      description: item.description,
      origin: item.origin,
      shelfAddress: item.shelf_address,
      sectionCode: item.section_code,
      onHandQty: item.on_hand_qty,
      availableQty: item.available_qty,
      reservedQty: item.reserved_qty,
      lastMovedAt: item.last_moved_at,
    });
  }

  function openLocationPreviewFromShipmentLine(line: LocalSalesOrder["lines"][number]) {
    const stockLocation = shipmentWarehouseLocationByLineId.get(line.lineId) || null;
    const assignment = packingAssignments[line.lineId];
    const packedQty = Math.max(0, Math.min(Number(line.qty || 0), parseNumberInput(assignment?.packedQty || "0")));
    setLocationPreview({
      source: "shipment",
      warehouseCode: selectedPackingWarehouse?.warehouse_code || packingVehicleDraft.warehouse_code || "",
      warehouseName: selectedPackingWarehouse?.warehouse_name || packingVehicleDraft.warehouse_name || "",
      brand: line.brand || "",
      productCode: line.resolvedCode || line.requestedCode || "",
      oldCode: line.requestedCode || line.resolvedCode || "",
      description: line.description || "",
      origin: line.origin || "",
      shelfAddress: stockLocation?.shelf_address || "",
      sectionCode: stockLocation?.section_code || "",
      shipmentQty: Number(line.qty || 0),
      packedQty,
      packageLabel:
        packingPackages.find((pkg) => pkg.id === assignment?.packageId)?.label ||
        assignment?.packageId ||
        "",
      lastMovedAt: stockLocation?.last_moved_at || "",
      onHandQty: stockLocation?.on_hand_qty,
      availableQty: stockLocation?.available_qty,
      reservedQty: stockLocation?.reserved_qty,
    });
  }

  useEffect(() => {
    let cancelled = false;

    async function run() {
      if (!locationPreview?.brand || (!locationPreview.productCode && !locationPreview.oldCode)) {
        setLocationPreviewCatalogRow(null);
        return;
      }

      try {
        setLoadingLocationPreviewCatalog(true);
        const rows = await fetchCatalogRowsByCodes({
          brandName: locationPreview.brand,
          codes: [locationPreview.productCode, locationPreview.oldCode].filter(Boolean),
        });
        if (cancelled) return;
        const match =
          rows.find(
            (row) =>
              normalizePartCode(row.product_code) === normalizePartCode(locationPreview.productCode) ||
              normalizePartCode(row.product_code) === normalizePartCode(locationPreview.oldCode),
          ) ||
          rows[0] ||
          null;
        setLocationPreviewCatalogRow(match);
      } catch {
        if (!cancelled) setLocationPreviewCatalogRow(null);
      } finally {
        if (!cancelled) setLoadingLocationPreviewCatalog(false);
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [locationPreview?.brand, locationPreview?.oldCode, locationPreview?.productCode]);

  const locationPreviewSourceLabel = useMemo(() => {
    if (!locationPreview) return "";
    if (locationPreview.source === "shipment") return t("inventory.shipment_pick_source");
    if (locationPreview.source === "transfer") return t("inventory.transfer_source_location");
    return t("inventory.stock_location_source");
  }, [language, locationPreview]);

  useEffect(() => {
    if (activeTab !== "Packing & Loading" || !selectedPackingScanLine) return;
    openLocationPreviewFromShipmentLine(selectedPackingScanLine);
  }, [
    activeTab,
    packingAssignments,
    packingPackages,
    selectedPackingScanLine,
    selectedPackingWarehouse,
    shipmentWarehouseLocationByLineId,
  ]);

  const packedVolumeTotalM3 = useMemo(
    () => packingPackageSummaries.reduce((sum, pkg) => sum + pkg.volumeM3, 0),
    [packingPackageSummaries],
  );

  const packedGrossWeightTotalKg = useMemo(
    () => packingPackageSummaries.reduce((sum, pkg) => sum + pkg.grossWeightKg, 0),
    [packingPackageSummaries],
  );

  const sortedLoadingPackages = useMemo(
    () => [...packingPackageSummaries].sort((left, right) => right.volumeM3 - left.volumeM3 || right.grossWeightKg - left.grossWeightKg),
    [packingPackageSummaries],
  );

  const packingReservedLines = useMemo(
    () =>
      selectedShipmentLines
        .map((line) => {
          const assignment = packingAssignments[line.lineId];
          const packedQty = Math.max(0, Math.min(Number(line.qty || 0), parseNumberInput(assignment?.packedQty || "0")));
          const stockLocation = shipmentWarehouseLocationByLineId.get(line.lineId) || null;
          if (!packedQty) return null;
          return {
            line_id: line.lineId,
            brand: line.brand || "",
            product_code: line.resolvedCode || line.requestedCode || "",
            old_code: line.requestedCode || line.resolvedCode || "",
            description: line.description || "",
            origin: line.origin || "",
            shelf_address: stockLocation?.shelf_address || "",
            section_code: stockLocation?.section_code || "",
            qty_reserved: packedQty,
          };
        })
        .filter(Boolean) as ShipmentPackingSessionInput["reserved_lines"],
    [packingAssignments, selectedShipmentLines, shipmentWarehouseLocationByLineId],
  );

  const packingSessionPayload = useMemo<ShipmentPackingSessionInput | null>(() => {
    if (!selectedShipmentOrder) return null;
    const warehouse =
      selectedPackingWarehouse ||
      shareableWarehouses.find((row) => row.id === selectedShipmentInvoice?.warehouse_id) ||
      shareableWarehouses[0] ||
      null;
    return {
      sales_order_id: selectedShipmentOrder.id,
      sales_order_no: selectedShipmentOrder.sales_order_no || selectedShipmentOrder.id,
      invoice_id: selectedShipmentInvoice?.id || "",
      invoice_no: selectedShipmentInvoice?.id || "",
      warehouse_id: warehouse?.id || "",
      warehouse_code: warehouse?.warehouse_code || "",
      warehouse_name: warehouse?.warehouse_name || "",
      customer_name: selectedShipmentOrder.customer_name || "",
      seller_company: selectedShipmentOrder.seller_company || "",
      status: packingReservedLines.length ? "reserved" : "draft",
      package_count: packingPackageSummaries.length,
      packed_qty_total: packedQtyTotal,
      packages: packingPackages,
      assignments: packingAssignments,
      vehicle: {
        ...packingVehicleDraft,
        warehouse_id: warehouse?.id || "",
        warehouse_code: warehouse?.warehouse_code || "",
        warehouse_name: warehouse?.warehouse_name || "",
      },
      reserved_lines: packingReservedLines,
    };
  }, [
    packedQtyTotal,
    packingAssignments,
    packingPackageSummaries.length,
    packingPackages,
    packingReservedLines,
    packingVehicleDraft,
    selectedPackingWarehouse,
    selectedShipmentInvoice?.id,
    selectedShipmentInvoice?.warehouse_id,
    selectedShipmentOrder,
    shareableWarehouses,
  ]);

  useEffect(() => {
    if (activeTab !== "Packing & Loading" || loadingPackingSession || !packingSessionPayload) return;
    if (packingSessionReadyOrderId !== packingSessionPayload.sales_order_id) return;
    if (!packingSessionStorageReady) return;
    if (!packingSessionPayload.warehouse_id) return;
    const signature = buildPackingSessionSignature({
      invoiceId: packingSessionPayload.invoice_id,
      invoiceNo: packingSessionPayload.invoice_no,
      warehouseId: packingSessionPayload.warehouse_id,
      warehouseCode: packingSessionPayload.warehouse_code,
      warehouseName: packingSessionPayload.warehouse_name,
      packages: packingSessionPayload.packages,
      assignments: packingSessionPayload.assignments,
      vehicle: packingSessionPayload.vehicle,
      reservedLines: packingSessionPayload.reserved_lines,
    });
    if (signature === packingSessionSignatureRef.current) return;

    const timeoutId = window.setTimeout(() => {
      void (async () => {
        try {
          setSavingPackingSession(true);
          const saved = await upsertShipmentPackingSession(packingSessionPayload);
          packingSessionSignatureRef.current = signature;
          setPackingSessionMeta(saved);
        } catch (caught) {
          const message = caught instanceof Error ? caught.message : "Packing reservation save failed";
          if (isPackingSchemaUnavailableError(message)) {
            setPackingSessionStorageReady(false);
          } else {
            actionFeedback.fail(message);
          }
        } finally {
          setSavingPackingSession(false);
        }
      })();
    }, 500);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [actionFeedback, activeTab, loadingPackingSession, packingSessionPayload, packingSessionReadyOrderId, packingSessionStorageReady]);

  const shipmentReadyCount = readyShipmentOrders.length;

  function buildPackingDocumentInput() {
    if (!selectedShipmentOrder) return null;
    return {
      orderNo: selectedShipmentOrder.sales_order_no || selectedShipmentOrder.id,
      invoiceNo: selectedShipmentInvoice?.id || t("inventory.pending"),
      customerName: selectedShipmentOrder.customer_name || "-",
      sellerCompany: selectedShipmentOrder.seller_company || "Next Master",
      shipDate: formatDate(selectedShipmentOrder.quote_date || selectedShipmentInvoice?.quote_date || selectedShipmentOrder.created_at || ""),
      packingNotes: selectedShipmentOrder.packing_details || selectedShipmentInvoice?.packing_details || "",
      stockFlowNote: selectedPackingWarehouse
        ? t("inventory.reserved_stock_in_warehouse", { warehouse: selectedPackingWarehouse.warehouse_name })
        : t("inventory.packed_quantities_temp_depot"),
      vehicleLabel: translateVehicleLabel(selectedLoadingVehicle.label),
      vehicleReference: packingVehicleDraft.reference,
      vehicleNotes: packingVehicleDraft.notes,
      totalOrderQty: selectedShipmentQtyTotal,
      totalPackedQty: packedQtyTotal,
      packageCount: packingPackageSummaries.length,
      usedVolumeM3: packedVolumeTotalM3,
      remainingVolumeM3: selectedLoadingVehicle.maxVolumeM3 - packedVolumeTotalM3,
      loadedGrossWeightKg: packedGrossWeightTotalKg,
      remainingWeightKg: selectedLoadingVehicle.maxGrossWeightKg - packedGrossWeightTotalKg,
      maxVolumeM3: selectedLoadingVehicle.maxVolumeM3,
      maxGrossWeightKg: selectedLoadingVehicle.maxGrossWeightKg,
      packages: packingPackageSummaries.map((summary) => ({
        label: summary.pkg.label,
        packageType: summary.pkg.packageType,
        lengthCm: summary.pkg.lengthCm,
        widthCm: summary.pkg.widthCm,
        heightCm: summary.pkg.heightCm,
        orientation: summary.pkg.orientation,
        netWeightKg: summary.netWeightKg,
        grossWeightKg: summary.grossWeightKg,
        volumeM3: summary.volumeM3,
        itemCount: summary.itemCount,
        notes: summary.pkg.notes,
        assignedLines: summary.assignedLines.map((item) => ({
          code: item.line.resolvedCode || item.line.requestedCode || "-",
          packedQty: item.packedQty,
        })),
      })),
      shipmentLines: selectedShipmentLines.map((line) => {
        const assignment = packingAssignments[line.lineId];
        const packedQty = Math.max(0, Math.min(line.qty, parseNumberInput(assignment?.packedQty || "0")));
        const assignedPackage = packingPackages.find((pkg) => pkg.id === assignment?.packageId);
        const stockLocation = shipmentWarehouseLocationByLineId.get(line.lineId) || null;
        return {
          code: line.resolvedCode || line.requestedCode || "-",
          brand: line.brand || "",
          description: line.description || "",
          shelfAddress: stockLocation?.shelf_address || "",
          sectionCode: stockLocation?.section_code || "",
          origin: line.origin || "",
          hsCode: line.hs_code || "",
          netWeightKg: line.weight_kg,
          orderQty: Number(line.qty || 0),
          packedQty,
          packageLabel: assignedPackage?.label || t("inventory.unassigned"),
        };
      }),
      loadingRows: sortedLoadingPackages.map((summary, index) => ({
        sequence: index + 1,
        packageLabel: summary.pkg.label,
        packageType: summary.pkg.packageType,
        orientation: summary.pkg.orientation,
        volumeM3: summary.volumeM3,
        grossWeightKg: summary.grossWeightKg,
        itemQty: summary.itemCount,
      })),
    };
  }

  function buildPackingLoadingPdfHtml() {
    const input = buildPackingDocumentInput();
    if (!input) return null;
    return buildWarehousePackingHtml(input, language);
  }

  function buildPackingLoadingWorkbook() {
    const input = buildPackingDocumentInput();
    if (!input) return null;
    return buildWarehousePackingWorkbook(input, language);
  }

  function buildPackageLabelsHtml(packageLabels?: string[]) {
    const input = buildPackingDocumentInput();
    if (!input) return null;
    return buildWarehousePackageLabelsHtml(input, {
      packageLabels,
      layout: packageLabelLayout,
      codeMode: packageLabelCodeMode,
    }, language);
  }

  function handlePreviewPackingPdf() {
    const html = buildPackingLoadingPdfHtml();
    if (!html) return;
    setPreviewingPackingPdf(true);
    try {
      actionFeedback.begin(t("inventory.feedback_preparing_packing_pdf", { order: selectedShipmentOrder?.sales_order_no || "-" }));
      openBusinessDocumentPreview(html);
      actionFeedback.succeed(t("inventory.feedback_packing_pdf_preview_opened"));
    } catch (caught) {
      actionFeedback.fail(caught instanceof Error ? caught.message : t("inventory.error_packing_pdf_preview_failed"));
    } finally {
      setPreviewingPackingPdf(false);
    }
  }

  function handleDownloadPackingPdf() {
    const html = buildPackingLoadingPdfHtml();
    if (!html) return;
    setDownloadingPackingPdf(true);
    try {
      actionFeedback.begin(t("inventory.feedback_preparing_pdf_download", { order: selectedShipmentOrder?.sales_order_no || "-" }));
      const orderNo = String(selectedShipmentOrder?.sales_order_no || "packing-loading-plan").replace(/[^a-z0-9_-]+/gi, "-");
      void downloadPdfFromHtml({
        html,
        pagebreak: {
          mode: ["css", "legacy"],
          avoid: [".section", ".package-card", ".sticker-sheet", ".sticker", "tr"],
        },
        filename: `${orderNo}.pdf`,
      })
        .then(() => actionFeedback.succeed(t("inventory.feedback_packing_pdf_downloaded")))
        .catch((caught) => {
          actionFeedback.fail(caught instanceof Error ? caught.message : t("inventory.error_packing_pdf_download_failed"));
        })
        .finally(() => setDownloadingPackingPdf(false));
    } catch (caught) {
      actionFeedback.fail(caught instanceof Error ? caught.message : t("inventory.error_packing_pdf_download_failed"));
      setDownloadingPackingPdf(false);
    }
  }

  function handlePrintPackingPdf() {
    const html = buildPackingLoadingPdfHtml();
    if (!html) return;
    setPrintingPackingPdf(true);
    try {
      actionFeedback.begin(t("inventory.feedback_opening_print_dialog", { order: selectedShipmentOrder?.sales_order_no || "-" }));
      openBusinessDocumentPreview(html, { autoPrint: true });
      actionFeedback.succeed(t("inventory.feedback_packing_print_view_opened"));
    } catch (caught) {
      actionFeedback.fail(caught instanceof Error ? caught.message : t("inventory.error_packing_print_failed"));
    } finally {
      setPrintingPackingPdf(false);
    }
  }

  function handleDownloadPackingExcel() {
    const workbook = buildPackingLoadingWorkbook();
    if (!workbook || !selectedShipmentOrder) return;
    setDownloadingPackingExcel(true);
    try {
      actionFeedback.begin(t("inventory.feedback_preparing_excel_download", { order: selectedShipmentOrder.sales_order_no || "-" }));
      const orderNo = selectedShipmentOrder.sales_order_no || selectedShipmentOrder.id || "packing-loading-plan";
      const blob = buildXlsxBlob(t("subnav.packing_loading"), workbook.rows, workbook.numericColumns);
      downloadBlob(`${sanitizeDownloadName(orderNo)}.xlsx`, blob);
      actionFeedback.succeed(t("inventory.feedback_packing_excel_downloaded"));
    } catch (caught) {
      actionFeedback.fail(caught instanceof Error ? caught.message : t("inventory.error_packing_excel_download_failed"));
    } finally {
      setDownloadingPackingExcel(false);
    }
  }

  function handlePreviewPackageLabels(packageLabels?: string[]) {
    const html = buildPackageLabelsHtml(packageLabels);
    if (!html) return;
    setPreviewingPackageLabelsPdf(true);
    try {
      actionFeedback.begin(t("inventory.feedback_preparing_package_sticker_preview", { order: selectedShipmentOrder?.sales_order_no || "-" }));
      openBusinessDocumentPreview(html);
      actionFeedback.succeed(t("inventory.feedback_package_sticker_preview_opened"));
    } catch (caught) {
      actionFeedback.fail(caught instanceof Error ? caught.message : t("inventory.error_package_sticker_preview_failed"));
    } finally {
      setPreviewingPackageLabelsPdf(false);
    }
  }

  function handlePrintPackageLabels(packageLabels?: string[]) {
    const html = buildPackageLabelsHtml(packageLabels);
    if (!html) return;
    setPrintingPackageLabelsPdf(true);
    try {
      actionFeedback.begin(t("inventory.feedback_opening_package_sticker_print_dialog", { order: selectedShipmentOrder?.sales_order_no || "-" }));
      openBusinessDocumentPreview(html, { autoPrint: true });
      actionFeedback.succeed(t("inventory.feedback_package_sticker_print_view_opened"));
    } catch (caught) {
      actionFeedback.fail(caught instanceof Error ? caught.message : t("inventory.error_package_sticker_print_failed"));
    } finally {
      setPrintingPackageLabelsPdf(false);
    }
  }

  function handleDownloadPackageLabelsPdf(packageLabels?: string[]) {
    const html = buildPackageLabelsHtml(packageLabels);
    if (!html) return;
    setDownloadingPackageLabelsPdf(true);
    try {
      actionFeedback.begin(t("inventory.feedback_preparing_package_sticker_pdf", { order: selectedShipmentOrder?.sales_order_no || "-" }));
      const orderNo = sanitizeDownloadName(selectedShipmentOrder?.sales_order_no || "package-stickers");
      const suffix = packageLabels?.length === 1 ? `${sanitizeDownloadName(packageLabels[0])}-sticker` : "package-stickers";
      void downloadPdfFromHtml({
        html,
        format: packageLabelLayout === "a6" ? [105, 148] : "a4",
        pagebreak: {
          mode: ["css", "legacy"],
          avoid: [".sticker-sheet", ".sticker", ".sticker__section", ".sticker__footer"],
        },
        filename: `${orderNo}-${suffix}.pdf`,
      })
        .then(() => actionFeedback.succeed(t("inventory.feedback_package_sticker_pdf_downloaded")))
        .catch((caught) => {
          actionFeedback.fail(caught instanceof Error ? caught.message : t("inventory.error_package_sticker_pdf_download_failed"));
        })
        .finally(() => setDownloadingPackageLabelsPdf(false));
    } catch (caught) {
      actionFeedback.fail(caught instanceof Error ? caught.message : t("inventory.error_package_sticker_pdf_download_failed"));
      setDownloadingPackageLabelsPdf(false);
    }
  }

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
    if (!readyShipmentOrders.length) {
      setSelectedShipmentId("");
      return;
    }
    if (!selectedShipmentId || !readyShipmentOrders.some((order) => order.id === selectedShipmentId)) {
      setSelectedShipmentId(readyShipmentOrders[0].id);
    }
  }, [readyShipmentOrders, selectedShipmentId]);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      setPackingScanInput("");
      setPackingScanMatchedLineIds([]);
      setPackingScanMessage("");
      setManualPackingBarcodeInput("");
      setManualPackingLineId("");
      setManualPackingNotes("");
      setPackingPackageDraft(createEmptyPackingPackage(1));
      setPackingSessionMeta(null);
      setPackingSessionReadyOrderId("");
      setPackingSessionStorageReady(true);
      packingSessionSignatureRef.current = "";

      if (!selectedShipmentOrder) {
        setPackingPackages([]);
        setPackingAssignments({});
        setPackingVehicleDraft(createEmptyPackingVehicleDraft());
        return;
      }

      const defaultWarehouse =
        shareableWarehouses.find((row) => row.id === selectedShipmentInvoice?.warehouse_id) ||
        shareableWarehouses.find((row) => row.id === packingVehicleDraft.warehouse_id) ||
        shareableWarehouses[0] ||
        null;

      setLoadingPackingSession(true);
      try {
        const session = await fetchShipmentPackingSession(selectedShipmentOrder.id);
        if (cancelled) return;
        if (session) {
          const sessionWarehouse =
            shareableWarehouses.find((row) => row.id === session.warehouse_id) ||
            shareableWarehouses.find((row) => row.id === selectedShipmentInvoice?.warehouse_id) ||
            defaultWarehouse;
          const nextVehicle: PackingVehicleDraft = {
            ...createEmptyPackingVehicleDraft(),
            ...session.vehicle,
            warehouse_id: sessionWarehouse?.id || session.vehicle.warehouse_id || "",
            warehouse_code: sessionWarehouse?.warehouse_code || session.vehicle.warehouse_code || "",
            warehouse_name: sessionWarehouse?.warehouse_name || session.vehicle.warehouse_name || "",
          };
          setPackingPackages(session.packages);
          setPackingAssignments(session.assignments);
          setPackingVehicleDraft(nextVehicle);
          setPackingSessionMeta(session);
          packingSessionSignatureRef.current = buildPackingSessionSignature({
            invoiceId: selectedShipmentInvoice?.id || session.invoice_id,
            invoiceNo: selectedShipmentInvoice?.id || session.invoice_no,
            warehouseId: nextVehicle.warehouse_id,
            warehouseCode: nextVehicle.warehouse_code,
            warehouseName: nextVehicle.warehouse_name,
            packages: session.packages,
            assignments: session.assignments,
            vehicle: nextVehicle,
            reservedLines: session.reserved_lines,
          });
          setPackingSessionReadyOrderId(selectedShipmentOrder.id);
          return;
        }

        setPackingPackages([]);
        setPackingAssignments({});
        setPackingVehicleDraft({
          ...createEmptyPackingVehicleDraft(),
          warehouse_id: defaultWarehouse?.id || "",
          warehouse_code: defaultWarehouse?.warehouse_code || "",
          warehouse_name: defaultWarehouse?.warehouse_name || "",
        });
        setPackingSessionReadyOrderId(selectedShipmentOrder.id);
      } catch (caught) {
        if (!cancelled) {
          const message = caught instanceof Error ? caught.message : "Packing reservation load failed";
          if (isPackingSchemaUnavailableError(message)) {
            setPackingPackages([]);
            setPackingAssignments({});
            setPackingVehicleDraft({
              ...createEmptyPackingVehicleDraft(),
              warehouse_id: defaultWarehouse?.id || "",
              warehouse_code: defaultWarehouse?.warehouse_code || "",
              warehouse_name: defaultWarehouse?.warehouse_name || "",
            });
            setPackingSessionStorageReady(false);
            setPackingSessionReadyOrderId(selectedShipmentOrder.id);
          } else {
            actionFeedback.fail(message);
          }
        }
      } finally {
        if (!cancelled) setLoadingPackingSession(false);
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [actionFeedback, selectedShipmentOrder, selectedShipmentInvoice?.id, selectedShipmentInvoice?.warehouse_id, shareableWarehouses]);

  useEffect(() => {
    if (!selectedReceive) {
      setReceiveDraft(null);
      setReceiveScanMatchedKeys([]);
      setReceiveScanMessage("");
      setManualReceiveLineKey("");
      return;
    }
    setReceiveDraft(buildPurchaseReceiveDraft(selectedReceive, selectedReceiveWarehouse, purchaseReceives));
    setReceiveScanMatchedKeys([]);
    setReceiveScanMessage("");
    setManualReceiveLineKey("");
  }, [purchaseReceives, selectedReceive, selectedReceiveWarehouse]);

  useEffect(() => {
    if (!receiveDraft?.lines.length) {
      setManualReceiveLineKey("");
      return;
    }
    setManualReceiveLineKey((current) => {
      if (current && receiveDraft.lines.some((line) => line.key === current)) return current;
      return receiveDraft.lines[0]?.key || "";
    });
  }, [receiveDraft]);

  useEffect(() => {
    if (!selectedShipmentLines.length) {
      setManualPackingLineId("");
      return;
    }
    setManualPackingLineId((current) => {
      if (current && selectedShipmentLines.some((line) => line.lineId === current)) return current;
      return selectedShipmentLines[0]?.lineId || "";
    });
  }, [selectedShipmentLines]);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      if (activeTab !== "Purchase Receives" || !receiveDraft?.lines.length) {
        setReceiveLineEanHints({});
        return;
      }

      const brandCodes = new Map<string, Set<string>>();
      receiveDraft.lines.forEach((line) => {
        const brand = String(line.brand || "").trim();
        if (!brand) return;
        const codes = [line.product_code, line.old_code, line.oem_no].map((value) => String(value || "").trim()).filter(Boolean);
        if (!codes.length) return;
        const current = brandCodes.get(brand) || new Set<string>();
        codes.forEach((code) => current.add(code));
        brandCodes.set(brand, current);
      });

      if (!brandCodes.size) {
        setReceiveLineEanHints({});
        return;
      }

      const results = await Promise.all(
        [...brandCodes.entries()].map(async ([brand, codes]) => {
          try {
            return { brand, rows: await fetchCatalogRowsByCodes({ brandName: brand, codes: [...codes] }) };
          } catch {
            return { brand, rows: [] as CatalogRow[] };
          }
        }),
      );

      const nextHints: Record<string, string> = {};
      receiveDraft.lines.forEach((line) => {
        const brand = String(line.brand || "").trim();
        if (!brand) return;
        const brandResult = results.find((entry: { brand: string; rows: CatalogRow[] }) => normalizeBrandKey(entry.brand) === normalizeBrandKey(brand));
        if (!brandResult?.rows.length) return;
        const codes = [line.product_code, line.old_code, line.oem_no]
          .map((value) => String(value || "").trim())
          .filter(Boolean)
          .map((value) => normalizePartCode(value));
        const match = brandResult.rows.find((row) =>
          codes.some(
            (code) =>
              code === normalizePartCode(row.product_code) ||
              code === normalizePartCode(row.ean) ||
              code === normalizePartCode(row.oem_no),
          ),
        );
        if (match?.ean) {
          nextHints[line.key] = match.ean;
        }
      });

      if (!cancelled) {
        setReceiveLineEanHints(nextHints);
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [activeTab, receiveDraft]);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      if (activeTab !== "Packing & Loading" || !selectedShipmentLines.length) {
        setShipmentLineEanHints({});
        return;
      }

      const brandCodes = new Map<string, Set<string>>();
      selectedShipmentLines.forEach((line) => {
        const brand = String(line.brand || "").trim();
        if (!brand) return;
        const codes = [line.resolvedCode, line.requestedCode, line.oem_no]
          .map((value) => String(value || "").trim())
          .filter(Boolean);
        if (!codes.length) return;
        const current = brandCodes.get(brand) || new Set<string>();
        codes.forEach((code) => current.add(code));
        brandCodes.set(brand, current);
      });

      if (!brandCodes.size) {
        setShipmentLineEanHints({});
        return;
      }

      const results = await Promise.all(
        [...brandCodes.entries()].map(async ([brand, codes]) => {
          try {
            return { brand, rows: await fetchCatalogRowsByCodes({ brandName: brand, codes: [...codes] }) };
          } catch {
            return { brand, rows: [] as CatalogRow[] };
          }
        }),
      );

      const nextHints: Record<string, string> = {};
      selectedShipmentLines.forEach((line) => {
        const brand = String(line.brand || "").trim();
        if (!brand) return;
        const brandResult = results.find((entry: { brand: string; rows: CatalogRow[] }) => normalizeBrandKey(entry.brand) === normalizeBrandKey(brand));
        if (!brandResult?.rows.length) return;
        const codes = [line.resolvedCode, line.requestedCode, line.oem_no]
          .map((value) => String(value || "").trim())
          .filter(Boolean)
          .map((value) => normalizePartCode(value));
        const match = brandResult.rows.find((row) =>
          codes.some(
            (code) =>
              code === normalizePartCode(row.product_code) ||
              code === normalizePartCode(row.ean) ||
              code === normalizePartCode(row.oem_no),
          ),
        );
        if (match?.ean) {
          nextHints[line.lineId] = match.ean;
        }
      });

      if (!cancelled) {
        setShipmentLineEanHints(nextHints);
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [activeTab, selectedShipmentLines]);

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

  useEffect(() => {
    let cancelled = false;

    async function run() {
      if (activeTab !== "Packing & Loading") return;
      try {
        setLoadingShipments(true);
        const [salesOrders, invoices] = await Promise.all([
          fetchSalesOrders(),
          fetchInvoiceSummaries(),
          showManualEntryAlerts ? reloadBarcodeAliases() : Promise.resolve([] as InventoryBarcodeAlias[]),
        ]);
        if (cancelled) return;
        setShipmentOrders(salesOrders);
        setShipmentInvoices(invoices);
      } catch (caught) {
        if (!cancelled) {
          actionFeedback.fail(caught instanceof Error ? caught.message : "Packing queue load failed");
        }
      } finally {
        if (!cancelled) setLoadingShipments(false);
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [actionFeedback, activeTab, showManualEntryAlerts]);

  const movementColumns = useMemo(
    () => [
      { key: "date", header: t("inventory.date"), render: (row: InventoryMovement) => formatDate(row.moved_at) },
      { key: "warehouse", header: t("inventory.warehouse_short"), render: (row: InventoryMovement) => row.warehouse_name || row.warehouse_code || "-" },
      { key: "type", header: t("inventory.type_short"), render: (row: InventoryMovement) => translateMovementType(row.movement_type) },
      { key: "document", header: t("inventory.document"), render: (row: InventoryMovement) => row.document_no || row.document_type || "-" },
      { key: "party", header: t("inventory.related_party"), render: (row: InventoryMovement) => row.related_party || "-" },
      { key: "brand", header: t("inventory.brand"), render: (row: InventoryMovement) => <BrandPill brand={row.brand} compact /> },
      { key: "code", header: t("inventory.code"), render: (row: InventoryMovement) => row.product_code || row.old_code || "-" },
      { key: "description", header: t("inventory.description_short"), render: (row: InventoryMovement) => row.description || "-" },
      { key: "location", header: t("inventory.rack_section"), render: (row: InventoryMovement) => formatWarehouseLocation(row) },
      { key: "qtyin", header: t("inventory.qty_in"), render: (row: InventoryMovement) => row.qty_in.toLocaleString(appLocale) },
      { key: "qtyout", header: t("inventory.qty_out"), render: (row: InventoryMovement) => row.qty_out.toLocaleString(appLocale) },
    ],
    [appLocale, language],
  );

  const onHandColumns = useMemo(
    () => [
      { key: "code", header: t("inventory.code"), render: (row: WarehouseOnHandRow) => row.warehouse_code || "-" },
      { key: "name", header: t("inventory.warehouse_short"), render: (row: WarehouseOnHandRow) => row.warehouse_name || "-" },
      { key: "region", header: t("inventory.region_short"), render: (row: WarehouseOnHandRow) => row.region || "-" },
      { key: "sku", header: t("inventory.sku_count"), render: (row: WarehouseOnHandRow) => row.sku_count.toLocaleString(appLocale) },
      { key: "onhand", header: t("inventory.on_hand_label"), render: (row: WarehouseOnHandRow) => row.on_hand_qty.toLocaleString(appLocale) },
      { key: "reserved", header: t("inventory.reserved"), render: (row: WarehouseOnHandRow) => row.reserved_qty.toLocaleString(appLocale) },
      { key: "available", header: t("inventory.available"), render: (row: WarehouseOnHandRow) => row.available_qty.toLocaleString(appLocale) },
    ],
    [appLocale, language],
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
      return scopedRows.filter((row) =>
        includesLooseText(
          `${row.brand} ${row.product_code} ${row.old_code} ${row.description} ${row.origin} ${row.shelf_address} ${row.section_code}`,
          needle,
        ),
      );
    },
    [onHandStockRows, onHandWarehouseId, onHandStockSearch],
  );

  const filteredTransferStockRows = useMemo(() => {
    const normalized = transferSearch.trim().toLowerCase();
    const rows = transferSourceId ? sourceStockRows.filter((row) => row.warehouse_id === transferSourceId) : sourceStockRows;
    if (!normalized) return rows;
    return rows.filter((row) =>
      includesLooseText(
        [row.brand, row.product_code, row.old_code, row.description, row.origin, row.shelf_address, row.section_code].join(" "),
        normalized,
      ),
    );
  }, [sourceStockRows, transferSearch, transferSourceId]);

  const transferHistoryColumns = useMemo(
    () => [
      { key: "date", header: t("inventory.date"), render: (row: StockTransfer) => formatDate(row.transfer_date) },
      { key: "transfer", header: t("inventory.transfer_no"), render: (row: StockTransfer) => row.transfer_no || row.id },
      { key: "source", header: t("inventory.source_warehouse"), render: (row: StockTransfer) => row.source_warehouse_name || row.source_warehouse_code || "-" },
      { key: "target", header: t("inventory.target_warehouse_label"), render: (row: StockTransfer) => row.target_warehouse_name || row.target_warehouse_code || "-" },
      { key: "qty", header: t("inventory.qty_short_label"), render: (row: StockTransfer) => row.total_qty.toLocaleString(appLocale) },
      { key: "status", header: t("inventory.status_short"), render: (row: StockTransfer) => row.status.toUpperCase() },
    ],
    [appLocale, language],
  );

  const receiveDraftTotals = useMemo(() => {
    const lines = receiveDraft?.lines || [];
    return {
      qty: lines.reduce((sum, line) => sum + line.qty_received, 0),
    };
  }, [receiveDraft]);

  const transferDraftTotals = useMemo(() => {
    const lines = transferDraft?.lines || [];
    return {
      qty: lines.reduce((sum, line) => sum + line.qty_transferred, 0),
    };
  }, [transferDraft]);

  const activeWarehouseCount = useMemo(() => warehouses.filter((row) => row.is_active).length, [warehouses]);
  const outsourcedWarehouseCount = useMemo(() => warehouses.filter((row) => row.warehouse_kind === "outsourced").length, [warehouses]);
  const dropshipWarehouseCount = useMemo(() => warehouses.filter((row) => row.fulfillment_model === "dropship").length, [warehouses]);
  const liveStockWarehouseCount = useMemo(() => onHandRows.filter((row) => row.on_hand_qty > 0).length, [onHandRows]);
  const matchedAdjustmentItem = useMemo(
    () =>
      findMatchingWarehouseStockItem(
        adjustmentStockRows,
        adjustmentDraft.brand,
        adjustmentDraft.productCode,
        adjustmentDraft.oldCode,
      ),
    [adjustmentDraft.brand, adjustmentDraft.oldCode, adjustmentDraft.productCode, adjustmentStockRows],
  );
  const adjustmentQtyDelta = useMemo(() => parseNumberInput(adjustmentDraft.qtyDelta), [adjustmentDraft.qtyDelta]);
  const adjustmentCodeHint = useMemo(
    () =>
      [adjustmentDraft.productCode, adjustmentDraft.oldCode]
        .map((value) => normalizePartCode(value))
        .filter(Boolean)
        .join(" / "),
    [adjustmentDraft.oldCode, adjustmentDraft.productCode],
  );
  const adjustmentHasLookupInput = useMemo(
    () => Boolean(normalizeBrandKey(adjustmentDraft.brand) && adjustmentCodeHint),
    [adjustmentCodeHint, adjustmentDraft.brand],
  );

  const onHandStockColumns = useMemo(
    () => [
      { key: "brand", header: t("inventory.brand"), render: (row: WarehouseStockItem) => <BrandPill brand={row.brand} compact /> },
      { key: "code", header: t("inventory.code"), render: (row: WarehouseStockItem) => row.product_code || row.old_code || "-" },
      { key: "description", header: t("inventory.description_short"), render: (row: WarehouseStockItem) => row.description || "-" },
      { key: "location", header: t("inventory.rack_section"), render: (row: WarehouseStockItem) => formatWarehouseLocation(row) },
      { key: "origin", header: t("inventory.origin_short"), render: (row: WarehouseStockItem) => row.origin || "-" },
      { key: "onhand", header: t("inventory.on_hand_label"), render: (row: WarehouseStockItem) => row.on_hand_qty.toLocaleString(appLocale) },
      { key: "reserved", header: t("inventory.reserved"), render: (row: WarehouseStockItem) => row.reserved_qty.toLocaleString(appLocale) },
      { key: "available", header: t("inventory.available"), render: (row: WarehouseStockItem) => row.available_qty.toLocaleString(appLocale) },
      { key: "last", header: t("inventory.last_move"), render: (row: WarehouseStockItem) => formatDate(row.last_moved_at) },
    ],
    [appLocale, language],
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

  async function handleSyncWarehouse() {
    if (!draft || !isUuid(draft.id)) {
      actionFeedback.fail("Save the warehouse first before running API sync.");
      return;
    }
    try {
      setSyncingWarehouse(true);
      actionFeedback.begin(`Syncing outsourced warehouse ${draft.warehouse_name || draft.warehouse_code}...`);
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
        `Warehouse API sync complete. ${result.summary.adjustmentCount.toLocaleString("en-US")} adjustment movement(s) posted from ${result.summary.acceptedItemCount.toLocaleString("en-US")} accepted item(s).`,
      );
    } catch (caught) {
      actionFeedback.fail(caught instanceof Error ? caught.message : "Warehouse API sync failed");
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
      actionFeedback.fail("Client name and partner name are required.");
      return;
    }
    if (!warehouseApiDraft.warehouse_ids.length) {
      actionFeedback.fail("Select at least one stocked warehouse.");
      return;
    }
    try {
      setSavingWarehouseApiClient(true);
      actionFeedback.begin(`Saving API client ${warehouseApiDraft.client_name || warehouseApiDraft.partner_name}...`);
      const result = await upsertWarehouseApiClient({
        id: warehouseApiDraft.id || undefined,
        client_name: warehouseApiDraft.client_name,
        partner_name: warehouseApiDraft.partner_name,
        status: warehouseApiDraft.status,
        allowed_ip_list: warehouseApiDraft.allowed_ip_list,
        require_hmac: warehouseApiDraft.require_hmac,
        allow_order_submit: warehouseApiDraft.allow_order_submit,
        include_zero_stock: warehouseApiDraft.include_zero_stock,
        expose_unit_cost: false,
        notes: warehouseApiDraft.notes,
        expires_at: warehouseApiDraft.expires_at,
        warehouse_ids: warehouseApiDraft.warehouse_ids,
      });
      const clients = await reloadWarehouseApiClients();
      const saved = result.client || clients.find((row) => row.id === warehouseApiDraft.id) || null;
      if (saved) setWarehouseApiDraft(saved);
      setLatestWarehouseApiSecret(result.secret);
      actionFeedback.succeed(`Warehouse API client ${saved?.client_name || warehouseApiDraft.client_name} saved.`);
    } catch (caught) {
      actionFeedback.fail(caught instanceof Error ? caught.message : "Warehouse API client save failed");
    } finally {
      setSavingWarehouseApiClient(false);
    }
  }

  async function handleRotateWarehouseApiClient() {
    if (!warehouseApiDraft?.id || !isUuid(warehouseApiDraft.id)) {
      actionFeedback.fail("Save the API client first before rotating its key.");
      return;
    }
    try {
      setRotatingWarehouseApiClient(true);
      actionFeedback.begin(`Rotating API key for ${warehouseApiDraft.client_name || warehouseApiDraft.partner_name}...`);
      const result = await rotateWarehouseApiClientToken(warehouseApiDraft.id);
      const clients = await reloadWarehouseApiClients();
      const saved = result.client || clients.find((row) => row.id === warehouseApiDraft.id) || null;
      if (saved) setWarehouseApiDraft(saved);
      setLatestWarehouseApiSecret(result.secret);
      actionFeedback.succeed("Warehouse API key rotated.");
    } catch (caught) {
      actionFeedback.fail(caught instanceof Error ? caught.message : "Warehouse API key rotation failed");
    } finally {
      setRotatingWarehouseApiClient(false);
    }
  }

  async function handleDeleteWarehouseApiClient() {
    if (!warehouseApiDraft?.id || !isUuid(warehouseApiDraft.id)) {
      handleCloseWarehouseApiEditor();
      return;
    }
    if (!window.confirm(`Delete API client ${warehouseApiDraft.client_name || warehouseApiDraft.partner_name}?`)) return;
    try {
      setSavingWarehouseApiClient(true);
      actionFeedback.begin(`Deleting API client ${warehouseApiDraft.client_name || warehouseApiDraft.partner_name}...`);
      await deleteWarehouseApiClient(warehouseApiDraft.id);
      await reloadWarehouseApiClients();
      setWarehouseApiDraft(null);
      setLatestWarehouseApiSecret(null);
      setShowWarehouseApiEditor(false);
      actionFeedback.succeed("Warehouse API client deleted.");
    } catch (caught) {
      actionFeedback.fail(caught instanceof Error ? caught.message : "Warehouse API client delete failed");
    } finally {
      setSavingWarehouseApiClient(false);
    }
  }

  function handleReceiveDraftLineChange(
    lineKey: string,
    field: "qty_received" | "notes" | "shelf_address" | "section_code",
    value: string,
  ) {
    setReceiveDraft((current) => {
      if (!current) return current;
      const next = cloneDraft(current);
      next.lines = next.lines.map((line) => {
        if (line.key !== lineKey) return line;
        if (field === "notes") {
          return { ...line, notes: value };
        }
        if (field === "shelf_address" || field === "section_code") {
          return { ...line, [field]: value };
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

  function handleSelectWarehouseLocation(location: WarehouseLocation | null) {
    const warehouse = warehouses.find((row) => row.id === (location?.warehouse_id || selectedWarehouseId)) || null;
    setSelectedWarehouseLocationId(location?.id || "");
    setWarehouseLocationDraft(mapWarehouseLocationToDraft(location, warehouse));
  }

  async function handleScanWarehouseLocation(scanValue: string) {
    const token = String(scanValue || "").trim();
    if (!token || !selectedWarehouseId) {
      actionFeedback.fail("Select a warehouse first.");
      return;
    }
    try {
      const match = resolveWarehouseLocationMatch(warehouseLocations, token);
      if (!match) {
        actionFeedback.fail(`No warehouse location matched ${token}.`);
        return;
      }
      handleSelectWarehouseLocation(match);
      setWarehouseLocationSearch(match.location_code || token);
      actionFeedback.succeed(`Loaded location ${buildWarehouseLocationPath(match)}.`);
    } catch (caught) {
      actionFeedback.fail(caught instanceof Error ? caught.message : "Warehouse location scan failed");
    }
  }

  function handleNewWarehouseLocation() {
    const warehouse = warehouses.find((row) => row.id === (activeTab === "Warehouses" ? selectedWarehouseId : receiveWarehouseId)) || null;
    setSelectedWarehouseLocationId("");
    setWarehouseLocationDraft(createEmptyWarehouseLocationDraft(warehouse));
  }

  function handleWarehouseLocationFieldChange(field: keyof WarehouseLocationEditorState, value: string | boolean) {
    setWarehouseLocationDraft((current) => {
      const next = { ...current, [field]: value } as WarehouseLocationEditorState;
      if (field === "warehouse_id") {
        const warehouse = warehouses.find((row) => row.id === String(value || "")) || null;
        next.warehouse_code = warehouse?.warehouse_code || "";
        next.warehouse_name = warehouse?.warehouse_name || "";
      }
      return next;
    });
  }

  async function handleSaveWarehouseLocationDraft() {
    if (!warehouseLocationDraft.warehouse_id) {
      actionFeedback.fail("Select a warehouse first.");
      return;
    }
    if (!warehouseLocationDraft.location_code.trim()) {
      actionFeedback.fail("Location code is required.");
      return;
    }

    try {
      setSavingWarehouseLocation(true);
      actionFeedback.begin(`Saving warehouse location ${warehouseLocationDraft.location_code}...`);
      const saved = await saveWarehouseLocation(draftWarehouseLocationPayload(warehouseLocationDraft));
      const rows = await reloadWarehouseLocations(saved.warehouse_id);
      setSelectedWarehouseLocationId(saved.id);
      setWarehouseLocationDraft(mapWarehouseLocationToDraft(saved, warehouses.find((row) => row.id === saved.warehouse_id) || null));
      if (!rows.some((row) => row.id === saved.id)) {
        setWarehouseLocations([saved, ...rows]);
      }
      actionFeedback.succeed(`Warehouse location ${saved.location_code} saved.`);
    } catch (caught) {
      actionFeedback.fail(caught instanceof Error ? caught.message : "Warehouse location save failed");
    } finally {
      setSavingWarehouseLocation(false);
    }
  }

  async function handleScanReceiveLocation(scanValue: string) {
    const token = String(scanValue || receiveLocationScanInput || "").trim();
    if (!token || !selectedReceiveWarehouse || !receiveDraft || !selectedReceiveScanLine) {
      setReceiveLocationScanMessage("Select a purchase order, line, and warehouse first.");
      return;
    }

    try {
      setReceiveLocationScanBusy(true);
      const match = resolveWarehouseLocationMatch(warehouseLocations, token);
      if (!match) {
        setReceiveLocationResolvedId("");
        setReceiveLocationScanMessage(`No warehouse location matched ${token}.`);
        return;
      }
      handleReceiveDraftLineChange(selectedReceiveScanLine.key, "shelf_address", match.shelf_address || match.location_code);
      handleReceiveDraftLineChange(selectedReceiveScanLine.key, "section_code", match.section_code);
      setReceiveLocationResolvedId(match.id);
      setReceiveLocationScanMessage(`Receive line will use ${buildWarehouseLocationPath(match)}.`);
    } catch (caught) {
      setReceiveLocationResolvedId("");
      setReceiveLocationScanMessage(caught instanceof Error ? caught.message : "Location scan failed");
    } finally {
      setReceiveLocationScanBusy(false);
    }
  }

  async function handleScanPackingLocation(scanValue: string) {
    const token = String(scanValue || packingLocationScanInput || "").trim();
    if (!token || !selectedPackingWarehouse || !selectedPackingScanLine) {
      setPackingLocationScanMessage("Select a shipment line and packing warehouse first.");
      return;
    }

    try {
      setPackingLocationScanBusy(true);
      const match = resolveWarehouseLocationMatch(warehouseLocations, token);
      if (!match) {
        setPackingLocationResolvedId("");
        setPackingLocationScanMessage(`No warehouse location matched ${token}.`);
        return;
      }
      const expected = selectedPackingExpectedLocation;
      if (expected && expected.id !== match.id) {
        setPackingLocationResolvedId("");
        setPackingLocationScanMessage(`Scanned ${buildWarehouseLocationPath(match)} but this line is expected from ${buildWarehouseLocationPath(expected)}.`);
        return;
      }
      setPackingLocationResolvedId(match.id);
      setPackingLocationScanMessage(`Packing line is cleared from ${buildWarehouseLocationPath(match)}.`);
    } catch (caught) {
      setPackingLocationResolvedId("");
      setPackingLocationScanMessage(caught instanceof Error ? caught.message : "Location scan failed");
    } finally {
      setPackingLocationScanBusy(false);
    }
  }

  function mergeWarehouseTaskRow(task: WarehouseOperationTask) {
    setWarehouseTasks((current) => [task, ...current.filter((item) => item.id !== task.id)].slice(0, 60));
  }

  function buildWarehouseTaskSavePayload(
    task: WarehouseOperationTask,
    overrides: Partial<SaveWarehouseOperationTaskInput> = {},
  ): SaveWarehouseOperationTaskInput {
    return {
      warehouse_id: task.warehouse_id,
      warehouse_code: task.warehouse_code,
      warehouse_name: task.warehouse_name,
      workflow_stage: task.workflow_stage,
      status: task.status,
      priority: task.priority,
      source_document_type: task.source_document_type,
      source_document_id: task.source_document_id,
      source_document_no: task.source_document_no,
      source_line_key: task.source_line_key,
      brand: task.brand,
      product_code: task.product_code,
      old_code: task.old_code,
      description: task.description,
      origin: task.origin,
      expected_qty: task.expected_qty,
      completed_qty: task.completed_qty,
      from_location_code: task.from_location_code,
      from_shelf_address: task.from_shelf_address,
      from_section_code: task.from_section_code,
      to_location_code: task.to_location_code,
      to_shelf_address: task.to_shelf_address,
      to_section_code: task.to_section_code,
      task_notes: task.task_notes,
      completion_notes: task.completion_notes,
      assigned_user_id: task.assigned_user_id,
      assigned_user_email: task.assigned_user_email,
      completed_by_user_id: task.completed_by_user_id,
      completed_by_email: task.completed_by_email,
      completed_at: task.completed_at || undefined,
      ...overrides,
    };
  }

  async function handleAssignWarehouseTask(task: WarehouseOperationTask, nextUserId: string) {
    if (!canSuperviseWarehouseTasks) return;
    const assignee = warehouseAssignableUsers.find((row) => row.user_id === nextUserId) || null;
    try {
      setSavingTaskAssignmentId(task.id);
      const savedTask = await saveWarehouseOperationTask(
        buildWarehouseTaskSavePayload(task, {
          assigned_user_id: assignee?.user_id || "",
          assigned_user_email: assignee?.email || "",
        }),
      );
      mergeWarehouseTaskRow(savedTask);
      actionFeedback.succeed(
        assignee
          ? `Task assigned to ${assignee.full_name || assignee.email}.`
          : "Task is now unassigned and visible to warehouse queue.",
      );
    } catch (caught) {
      actionFeedback.fail(caught instanceof Error ? caught.message : "Task assignment save failed");
    } finally {
      setSavingTaskAssignmentId("");
    }
  }

  async function persistDirectedPutawayTask(line: PurchaseReceiveDraft["lines"][number], confirmedQty: number) {
    if (!selectedReceiveWarehouse || !selectedReceive) return;
    const session = currentUserSession.userId ? currentUserSession : await fetchAppSession();
    const existingTask =
      warehouseTasks.find(
        (row) => row.workflow_stage === "putaway" && row.source_document_id === selectedReceive.id && row.source_line_key === line.key,
      ) || null;
    const location =
      selectedReceiveLocation ||
      findWarehouseLocationByAddress(warehouseLocations, line.shelf_address, line.section_code);
    const task = await saveWarehouseOperationTask({
      warehouse_id: selectedReceiveWarehouse.id,
      warehouse_code: selectedReceiveWarehouse.warehouse_code,
      warehouse_name: selectedReceiveWarehouse.warehouse_name,
      workflow_stage: "putaway",
      status: deriveWarehouseTaskStatus(confirmedQty, line.qty_remaining_before),
      priority: confirmedQty >= line.qty_remaining_before ? "normal" : "high",
      source_document_type: "Purchase Receive",
      source_document_id: selectedReceive.id,
      source_document_no: receiveDraft?.purchase_order_no || selectedReceive.id,
      source_line_key: line.key,
      brand: line.brand,
      product_code: line.product_code,
      old_code: line.old_code,
      description: line.description,
      origin: line.origin,
      expected_qty: line.qty_remaining_before,
      completed_qty: confirmedQty,
      to_location_code: location?.location_code || "",
      to_shelf_address: line.shelf_address,
      to_section_code: line.section_code,
      task_notes: "Directed putaway from receive scan.",
      completion_notes: confirmedQty >= line.qty_remaining_before ? "Receive confirmed at target location." : "Partial receive confirmed at target location.",
      assigned_user_id: existingTask?.assigned_user_id || session.userId || "",
      assigned_user_email: existingTask?.assigned_user_email || session.email || "",
      completed_by_user_id: confirmedQty > 0 ? session.userId || existingTask?.completed_by_user_id || "" : existingTask?.completed_by_user_id || "",
      completed_by_email: confirmedQty > 0 ? session.email || existingTask?.completed_by_email || "" : existingTask?.completed_by_email || "",
    });
    setCurrentUserSession({ userId: session.userId || "", email: session.email || "" });
    mergeWarehouseTaskRow(task);
  }

  async function persistDirectedPickTask(line: LocalSalesOrder["lines"][number], confirmedQty: number) {
    if (!selectedPackingWarehouse || !selectedShipmentOrder) return;
    const session = currentUserSession.userId ? currentUserSession : await fetchAppSession();
    const existingTask =
      warehouseTasks.find(
        (row) => row.workflow_stage === "pick" && row.source_document_id === selectedShipmentOrder.id && row.source_line_key === line.lineId,
      ) || null;
    const location =
      selectedPackingExpectedLocation ||
      findWarehouseLocationByAddress(
        warehouseLocations,
        selectedPackingScanLocation?.shelf_address || "",
        selectedPackingScanLocation?.section_code || "",
      );
    const task = await saveWarehouseOperationTask({
      warehouse_id: selectedPackingWarehouse.id,
      warehouse_code: selectedPackingWarehouse.warehouse_code,
      warehouse_name: selectedPackingWarehouse.warehouse_name,
      workflow_stage: "pick",
      status: deriveWarehouseTaskStatus(confirmedQty, Number(line.qty || 0)),
      priority: confirmedQty >= Number(line.qty || 0) ? "normal" : "high",
      source_document_type: "Sales Order",
      source_document_id: selectedShipmentOrder.id,
      source_document_no: selectedShipmentOrder.sales_order_no || selectedShipmentOrder.id,
      source_line_key: line.lineId,
      brand: line.brand || "",
      product_code: line.resolvedCode || line.requestedCode || "",
      old_code: line.requestedCode || line.resolvedCode || "",
      description: line.description || "",
      origin: line.origin || "",
      expected_qty: Number(line.qty || 0),
      completed_qty: confirmedQty,
      from_location_code: location?.location_code || "",
      from_shelf_address: selectedPackingScanLocation?.shelf_address || "",
      from_section_code: selectedPackingScanLocation?.section_code || "",
      task_notes: "Directed pick from packing scan.",
      completion_notes: confirmedQty >= Number(line.qty || 0) ? "Shipment line fully picked." : "Shipment line partially picked.",
      assigned_user_id: existingTask?.assigned_user_id || session.userId || "",
      assigned_user_email: existingTask?.assigned_user_email || session.email || "",
      completed_by_user_id: confirmedQty > 0 ? session.userId || existingTask?.completed_by_user_id || "" : existingTask?.completed_by_user_id || "",
      completed_by_email: confirmedQty > 0 ? session.email || existingTask?.completed_by_email || "" : existingTask?.completed_by_email || "",
    });
    setCurrentUserSession({ userId: session.userId || "", email: session.email || "" });
    mergeWarehouseTaskRow(task);
  }

  async function handleSaveManualReceiveBarcode() {
    if (!canManageManualBarcode) {
      actionFeedback.fail(t("inventory.error_manual_barcode_binding_limited"));
      return;
    }
    if (!receiveDraft || !selectedReceive || !selectedReceiveWarehouse) {
      actionFeedback.fail(t("inventory.error_select_purchase_order_target_warehouse_first"));
      return;
    }
    const barcode = manualReceiveBarcodeInput.trim();
    const line = receiveDraft.lines.find((item) => item.key === manualReceiveLineKey) || null;
    const isAliasRemap = Boolean(
      selectedReceiveAlias && normalizePartCode(selectedReceiveAlias.barcode) === normalizePartCode(barcode),
    );
    if (!barcode) {
      actionFeedback.fail(t("inventory.error_enter_sticker_barcode_first"));
      return;
    }
    if (!line) {
      actionFeedback.fail(t("inventory.error_select_receive_line_for_sticker"));
      return;
    }

    try {
      setSavingManualReceiveBarcode(true);
      const session = currentUserSession.userId ? currentUserSession : await fetchAppSession();
      actionFeedback.begin(
        t("inventory.feedback_saving_manual_sticker_barcode", {
          item: `${line.brand} ${line.product_code || line.old_code || "-"}`.trim(),
        }),
      );
      const result = await saveInventoryBarcodeAliasBinding({
        barcode,
        warehouse_id: selectedReceiveWarehouse.id,
        warehouse_code: selectedReceiveWarehouse.warehouse_code,
        warehouse_name: selectedReceiveWarehouse.warehouse_name,
        workflow_stage: "receive",
        document_type: "Purchase Receive",
        document_id: selectedReceive.id,
        document_no: receiveDraft.purchase_order_no || selectedReceive.id,
        notes: manualReceiveNotes,
        line: toReceiveBindableLine(line),
        entered_by_user_id: session.userId || "",
        entered_by_email: session.email || "",
        allowRemap: isAliasRemap,
      });

      setCurrentUserSession({
        userId: session.userId || "",
        email: session.email || "",
      });
      if (showManualEntryAlerts) {
        await reloadBarcodeAliases();
      }
      setSelectedReceiveAliasId(result.alias.id);
      setReceiveScanMatchedKeys([line.key]);
      setReceiveScanMessage(
        isAliasRemap
          ? t("inventory.message_admin_remapped_receive_barcode", {
              barcode: result.alias.barcode,
              item: `${line.brand} ${line.product_code || line.old_code || "-"}`.trim(),
            })
          : t("inventory.message_saved_manual_sticker_barcode", {
              barcode: result.alias.barcode,
              item: `${line.brand} ${line.product_code || line.old_code || "-"}`.trim(),
            }),
      );
      setReceiveScanInput(result.alias.barcode);
      setManualReceiveBarcodeInput(result.alias.barcode);
      setManualReceiveNotes("");
      if (showManualEntryAlerts) {
        setManualEntryAlerts((current) => [result.alert, ...current.filter((item) => item.id !== result.alert.id)].slice(0, 12));
      }
      actionFeedback.succeed(t("inventory.feedback_manual_sticker_barcode_saved"));
    } catch (caught) {
      actionFeedback.fail(caught instanceof Error ? caught.message : t("inventory.error_manual_sticker_barcode_save_failed"));
    } finally {
      setSavingManualReceiveBarcode(false);
    }
  }

  function handleSelectManualReceiveLine(lineKey: string) {
    setManualReceiveLineKey(lineKey);
    setReceiveLocationResolvedId("");
    setReceiveLocationScanMessage("");
    if (!lineKey) return;
    setReceiveScanMatchedKeys((current) => (current.includes(lineKey) ? current : [lineKey, ...current]));
    scrollReceiveLineIntoView(lineKey);
  }

  function handleLoadReceiveAliasReview(alias: InventoryBarcodeAlias) {
    setSelectedReceiveAliasId(alias.id);
    setManualReceiveBarcodeInput(alias.barcode);
    const match =
      receiveDraft?.lines.find(
        (line) =>
          normalizeBrandKey(line.brand) === normalizeBrandKey(alias.brand) &&
          (
            normalizePartCode(line.product_code) === normalizePartCode(alias.product_code) ||
            normalizePartCode(line.old_code) === normalizePartCode(alias.old_code)
          ),
      ) || null;
    if (match) {
      handleSelectManualReceiveLine(match.key);
      setReceiveScanMessage(t("inventory.message_loaded_alias_review_receive", { barcode: alias.barcode }));
      return;
    }
    setManualReceiveLineKey("");
    setReceiveScanMatchedKeys([]);
    setReceiveScanMessage(t("inventory.message_loaded_alias_receive_not_in_po", { barcode: alias.barcode }));
  }

  function applyCatalogRowToAdjustment(row: CatalogRow) {
    setAdjustmentDraft((current) => ({
      ...current,
      brand: row.brand || current.brand,
      productCode: row.product_code || current.productCode,
      oldCode: current.oldCode,
      description: row.description || current.description,
      origin: row.origin || current.origin,
    }));
  }

  async function handleLookupAdjustmentScan(scanValue: string) {
    const token = String(scanValue || adjustmentScanInput || "").trim();
    if (!token) {
      setAdjustmentLookupMessage(t("inventory.error_enter_or_scan_code_first"));
      setAdjustmentLookupResults([]);
      return;
    }

    try {
      setAdjustmentLookupBusy(true);
      setAdjustmentLookupMessage("");
      const rows = rankCatalogScanRows(
        await fetchCloudCatalog({
          search: token,
          brandName: adjustmentDraft.brand.trim() || undefined,
          page: 1,
          pageSize: 8,
        }),
        token,
        adjustmentDraft.brand,
      );
      setAdjustmentLookupResults(rows);

      if (!rows.length) {
        setAdjustmentLookupMessage(t("inventory.message_no_catalog_item_matched", { code: token }));
        return;
      }

      const topRow = rows[0];
      const topScore = catalogScanScore(topRow, token, adjustmentDraft.brand);
      const nextScore = rows[1] ? catalogScanScore(rows[1], token, adjustmentDraft.brand) : -1;
      const canAutoApply =
        rows.length === 1 ||
        (topScore >= 180 && topScore > nextScore) ||
        (Boolean(normalizeBrandKey(adjustmentDraft.brand)) && topScore >= 100 && topScore > nextScore);
      if (canAutoApply) {
        applyCatalogRowToAdjustment(topRow);
        setAdjustmentLookupMessage(
          t("inventory.message_catalog_item_matched_review_post", {
            item: `${topRow.brand} ${topRow.product_code || "-"}`.trim(),
          }),
        );
        return;
      }

      setAdjustmentLookupMessage(t("inventory.message_catalog_matches_found", { count: rows.length }));
    } catch (caught) {
      setAdjustmentLookupMessage(caught instanceof Error ? caught.message : t("inventory.error_catalog_lookup_failed"));
      setAdjustmentLookupResults([]);
    } finally {
      setAdjustmentLookupBusy(false);
    }
  }

  async function handleScanReceiveLine(scanValue: string) {
    const token = String(scanValue || receiveScanInput || "").trim();
    if (!token || !receiveDraft) {
      setReceiveScanMessage(t("inventory.error_select_purchase_order_and_scan_code_first"));
      setReceiveScanMatchedKeys([]);
      setReceiveScanSelectedLineKey("");
      setReceiveScanPendingQty("");
      setReceiveScanManualQtyMode(false);
      setReceiveLocationResolvedId("");
      setReceiveLocationScanMessage("");
      return;
    }

    try {
      setReceiveScanBusy(true);
      const result = await matchInventoryScanToLines(token, receiveBindableLines);
      const matchedKeys = result.matchedLines.map((line) => line.key);
      const matchedLines = receiveDraft.lines.filter((line) => matchedKeys.includes(line.key));

      setReceiveScanMatchedKeys(matchedKeys);

      if (!matchedLines.length) {
        setManualReceiveBarcodeInput(token);
        setReceiveScanSelectedLineKey("");
        setReceiveScanPendingQty("");
        setReceiveScanManualQtyMode(false);
        setReceiveLocationResolvedId("");
        setReceiveLocationScanMessage("");
        if (result.alias) {
          setReceiveScanMessage(
            t("inventory.message_barcode_linked_not_in_po", {
              barcode: token,
              item: `${result.alias.brand} ${result.alias.product_code || result.alias.old_code || "-"}`.trim(),
            }),
          );
          return;
        }
        setReceiveScanMessage(t("inventory.message_no_receive_line_matched", { barcode: token }));
        return;
      }

      const firstKey = matchedKeys[0];
      scrollReceiveLineIntoView(firstKey);

      if (matchedLines.length === 1) {
        const match = matchedLines[0];
        handleSelectManualReceiveLine(match.key);
        setReceiveScanSelectedLineKey(match.key);
        setReceiveScanPendingQty(buildNextScanQty(receiveScanSelectedLineKey === match.key ? receiveScanPendingQty : "", match.qty_received, match.qty_remaining_before));
        setReceiveScanManualQtyMode(false);
        setReceiveLocationResolvedId("");
        setReceiveLocationScanMessage("");
        setManualReceiveBarcodeInput(token);
        setReceiveScanMessage(
          result.mode === "alias"
            ? t("inventory.message_matched_saved_sticker_barcode_qty_ready", {
                item: `${match.brand} ${match.product_code || match.old_code || "-"}`.trim(),
              })
            : t("inventory.message_matched_receive_line_qty_ready", {
                item: `${match.brand} ${match.product_code || match.old_code || "-"}`.trim(),
              }),
        );
        return;
      }

      setReceiveScanMessage(
        t("inventory.message_receive_lines_matched", {
          count: matchedLines.length,
          barcode: token,
        }),
      );
      setReceiveScanSelectedLineKey("");
      setReceiveScanPendingQty("");
      setReceiveScanManualQtyMode(false);
      setReceiveLocationResolvedId("");
      setReceiveLocationScanMessage("");
    } catch (caught) {
      setReceiveScanMatchedKeys([]);
      setReceiveScanSelectedLineKey("");
      setReceiveScanPendingQty("");
      setReceiveScanManualQtyMode(false);
      setReceiveLocationResolvedId("");
      setReceiveLocationScanMessage("");
      setReceiveScanMessage(caught instanceof Error ? caught.message : t("inventory.error_receive_scan_failed"));
    } finally {
      setReceiveScanBusy(false);
    }
  }

  async function handleConfirmReceiveScanQty() {
    if (!receiveDraft) {
      actionFeedback.fail(t("inventory.error_select_purchase_order_first"));
      return;
    }
    const line = receiveDraft.lines.find((item) => item.key === receiveScanSelectedLineKey) || null;
    if (!line) {
      actionFeedback.fail(t("inventory.error_scan_receive_line_first"));
      return;
    }
    const qty = Math.max(0, Math.min(line.qty_remaining_before, parseNumberInput(receiveScanPendingQty)));
    if (!qty) {
      actionFeedback.fail(t("inventory.error_enter_valid_quantity_first"));
      return;
    }
    if (warehouseLocations.length && !selectedReceiveLocation) {
      actionFeedback.fail(t("inventory.error_scan_assign_putaway_before_confirm"));
      return;
    }

    handleReceiveDraftLineChange(line.key, "qty_received", String(qty));
    try {
      await persistDirectedPutawayTask(line, qty);
    } catch (caught) {
      actionFeedback.fail(caught instanceof Error ? caught.message : t("inventory.error_directed_putaway_task_save_failed"));
      return;
    }
    setReceiveScanMessage(
      t("inventory.message_confirmed_receive_qty", {
        qty: qty.toLocaleString(appLocale),
        item: `${line.brand} ${line.product_code || line.old_code || "-"}`.trim(),
      }),
    );
    setReceiveScanPendingQty("");
    setReceiveScanManualQtyMode(false);
  }

  async function handlePostReceive() {
    if (!receiveDraft || !selectedReceive) return;
    try {
      setPostingReceive(true);
      actionFeedback.begin(t("inventory.feedback_posting_purchase_receive", { order: receiveDraft.purchase_order_no }));
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
      actionFeedback.succeed(t("inventory.feedback_purchase_receive_posted", { order: receiveDraft.purchase_order_no }));
    } catch (caught) {
      actionFeedback.fail(caught instanceof Error ? caught.message : t("inventory.error_purchase_receive_post_failed"));
    } finally {
      setPostingReceive(false);
    }
  }

  function handleAdjustmentFieldChange(field: keyof StockAdjustmentFormState, value: string) {
    setAdjustmentDraft((current) => ({
      ...current,
      [field]: value,
    }));
  }

  function handleResetAdjustmentForm() {
    setAdjustmentDraft(createEmptyStockAdjustmentForm());
    setAdjustmentScanInput("");
    setAdjustmentLookupResults([]);
    setAdjustmentLookupMessage("");
  }

  function handleApplyMatchedAdjustmentItem() {
    if (!matchedAdjustmentItem) return;
    setAdjustmentDraft((current) => ({
      ...current,
      brand: current.brand || matchedAdjustmentItem.brand,
      productCode: current.productCode || matchedAdjustmentItem.product_code,
      oldCode: current.oldCode || matchedAdjustmentItem.old_code,
      description: current.description || matchedAdjustmentItem.description,
      origin: current.origin || matchedAdjustmentItem.origin,
    }));
  }

  async function handlePostAdjustment() {
    if (!selectedAdjustmentWarehouse) {
      actionFeedback.fail(t("inventory.error_select_stocked_warehouse_first"));
      return;
    }

    const payload: StockAdjustmentInput = {
      warehouse_id: selectedAdjustmentWarehouse.id,
      warehouse_code: selectedAdjustmentWarehouse.warehouse_code,
      warehouse_name: selectedAdjustmentWarehouse.warehouse_name,
      moved_date: adjustmentDraft.movedDate,
      brand: adjustmentDraft.brand,
      product_code: adjustmentDraft.productCode,
      old_code: adjustmentDraft.oldCode,
      description: adjustmentDraft.description,
      qty_delta: adjustmentQtyDelta,
      unit_cost: 0,
      origin: adjustmentDraft.origin,
      related_party: adjustmentDraft.relatedParty,
      notes: adjustmentDraft.notes,
    };

    try {
      setPostingAdjustment(true);
      actionFeedback.begin(
        t("inventory.feedback_posting_stock_adjustment", {
          warehouse: selectedAdjustmentWarehouse.warehouse_name || selectedAdjustmentWarehouse.warehouse_code,
        }),
      );
      const movement = await postStockAdjustment(payload);
      const warehouseRows = warehouses.length ? warehouses : await reloadWarehouses();
      const [movementLedger, onHand, onHandStock, adjustmentStock] = await Promise.all([
        reloadMovements(movementWarehouseId || undefined),
        reloadOnHand(warehouseRows),
        reloadOnHandStock(onHandWarehouseId || undefined),
        fetchWarehouseStockItems(selectedAdjustmentWarehouse.id),
      ]);
      setMovementRows(movementLedger);
      setOnHandRows(onHand);
      setOnHandStockRows(onHandStock);
      setAdjustmentStockRows(adjustmentStock);
      if (transferSourceId === selectedAdjustmentWarehouse.id) {
        const stockRows = await reloadTransferStock(transferSourceId);
        setSourceStockRows(stockRows);
      }
      setAdjustmentDraft(createEmptyStockAdjustmentForm());
      setAdjustmentScanInput("");
      setAdjustmentLookupResults([]);
      setAdjustmentLookupMessage("");
      actionFeedback.succeed(t("inventory.feedback_manual_stock_adjustment_posted", { document: movement.document_no || movement.id }));
    } catch (caught) {
      actionFeedback.fail(caught instanceof Error ? caught.message : t("inventory.error_manual_stock_adjustment_failed"));
    } finally {
      setPostingAdjustment(false);
    }
  }

  function handlePackingPackageDraftChange(field: keyof PackingPackageDraft, value: string) {
    setPackingPackageDraft((current) => ({
      ...current,
      [field]: value,
    }));
  }

  function handleAddPackingPackage() {
    if (!packingPackageDraft.label.trim()) {
      actionFeedback.fail(t("inventory.error_package_label_required"));
      return;
    }
    const nextPackage = {
      ...packingPackageDraft,
      id: `pkg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      label: packingPackageDraft.label.trim(),
      packageType: packingPackageDraft.packageType || "carton",
      orientation: packingPackageDraft.orientation || "length-first",
    };
    setPackingPackages((current) => [...current, nextPackage]);
    setPackingPackageDraft(createEmptyPackingPackage(packingPackages.length + 2));
  }

  function handleRemovePackingPackage(packageId: string) {
    setPackingPackages((current) => current.filter((pkg) => pkg.id !== packageId));
    setPackingAssignments((current) => {
      const next = { ...current };
      Object.entries(next).forEach(([lineId, assignment]) => {
        if (assignment.packageId === packageId) {
          next[lineId] = { packageId: "", packedQty: "" };
        }
      });
      return next;
    });
  }

  function handlePackingAssignmentChange(lineId: string, field: keyof PackingLineAssignment, value: string) {
    setPackingAssignments((current) => ({
      ...current,
      [lineId]: {
        packageId: current[lineId]?.packageId || "",
        packedQty: current[lineId]?.packedQty || "",
        [field]: value,
      },
    }));
  }

  function handlePackingVehicleChange(field: keyof PackingVehicleDraft, value: string) {
    if (field === "warehouse_id") {
      const nextWarehouse = shareableWarehouses.find((row) => row.id === value) || null;
      setPackingVehicleDraft((current) => ({
        ...current,
        warehouse_id: nextWarehouse?.id || "",
        warehouse_code: nextWarehouse?.warehouse_code || "",
        warehouse_name: nextWarehouse?.warehouse_name || "",
      }));
      return;
    }
    setPackingVehicleDraft((current) => ({
      ...current,
      [field]: value,
    }));
  }

  async function handleSaveManualPackingBarcode() {
    if (!canManageManualBarcode) {
      actionFeedback.fail(t("inventory.error_manual_barcode_binding_limited"));
      return;
    }
    if (!selectedShipmentOrder) {
      actionFeedback.fail(t("inventory.error_select_shipment_first"));
      return;
    }

    const barcode = manualPackingBarcodeInput.trim();
    const line = selectedShipmentLines.find((item) => item.lineId === manualPackingLineId) || null;
    const isAliasRemap = Boolean(
      selectedPackingAlias && normalizePartCode(selectedPackingAlias.barcode) === normalizePartCode(barcode),
    );
    if (!barcode) {
      actionFeedback.fail(t("inventory.error_enter_shipment_barcode_first"));
      return;
    }
    if (!line) {
      actionFeedback.fail(t("inventory.error_select_shipment_item_for_barcode"));
      return;
    }

    try {
      setSavingManualPackingBarcode(true);
      const session = currentUserSession.userId ? currentUserSession : await fetchAppSession();
      actionFeedback.begin(
        t("inventory.feedback_saving_shipment_barcode", {
          item: `${line.brand} ${line.resolvedCode || line.requestedCode || "-"}`.trim(),
        }),
      );
      const result = await saveInventoryBarcodeAliasBinding({
        barcode,
        warehouse_id: selectedPackingWarehouse?.id || "",
        warehouse_code: selectedPackingWarehouse?.warehouse_code || "",
        warehouse_name: selectedPackingWarehouse?.warehouse_name || "",
        workflow_stage: "packing",
        document_type: "Sales Order",
        document_id: selectedShipmentOrder.id,
        document_no: selectedShipmentOrder.sales_order_no || selectedShipmentOrder.id,
        notes: manualPackingNotes,
        line: toShipmentBindableLine(line),
        entered_by_user_id: session.userId || "",
        entered_by_email: session.email || "",
        allowRemap: isAliasRemap,
      });

      setCurrentUserSession({
        userId: session.userId || "",
        email: session.email || "",
      });
      if (showManualEntryAlerts) {
        await reloadBarcodeAliases();
      }
      setSelectedPackingAliasId(result.alias.id);
      setPackingScanMatchedLineIds([line.lineId]);
      setPackingScanMessage(
        isAliasRemap
          ? t("inventory.message_admin_remapped_shipment_barcode", {
              barcode: result.alias.barcode,
              item: `${line.brand} ${line.resolvedCode || line.requestedCode || "-"}`.trim(),
            })
          : t("inventory.message_saved_shipment_barcode", {
              barcode: result.alias.barcode,
              item: `${line.brand} ${line.resolvedCode || line.requestedCode || "-"}`.trim(),
            }),
      );
      setPackingScanInput(result.alias.barcode);
      setManualPackingBarcodeInput(result.alias.barcode);
      setManualPackingNotes("");
      if (showManualEntryAlerts) {
        setManualEntryAlerts((current) => [result.alert, ...current.filter((item) => item.id !== result.alert.id)].slice(0, 12));
      }
      actionFeedback.succeed(t("inventory.feedback_shipment_barcode_saved_linked"));
    } catch (caught) {
      actionFeedback.fail(caught instanceof Error ? caught.message : t("inventory.error_shipment_barcode_save_failed"));
    } finally {
      setSavingManualPackingBarcode(false);
    }
  }

  function handleSelectManualPackingLine(lineId: string) {
    setManualPackingLineId(lineId);
    setPackingLocationResolvedId("");
    setPackingLocationScanMessage("");
    if (!lineId) return;
    setPackingScanMatchedLineIds((current) => (current.includes(lineId) ? current : [lineId, ...current]));
    scrollShipmentLineIntoView(lineId);
  }

  function handleLoadPackingAliasReview(alias: InventoryBarcodeAlias) {
    setSelectedPackingAliasId(alias.id);
    setManualPackingBarcodeInput(alias.barcode);
    const match =
      selectedShipmentLines.find(
        (line) =>
          normalizeBrandKey(line.brand) === normalizeBrandKey(alias.brand) &&
          (
            normalizePartCode(line.resolvedCode) === normalizePartCode(alias.product_code) ||
            normalizePartCode(line.requestedCode) === normalizePartCode(alias.old_code)
          ),
      ) || null;
    if (match) {
      handleSelectManualPackingLine(match.lineId);
      setPackingScanMessage(t("inventory.message_loaded_alias_review_shipment", { barcode: alias.barcode }));
      return;
    }
    setManualPackingLineId("");
    setPackingScanMatchedLineIds([]);
    setPackingScanMessage(t("inventory.message_loaded_alias_not_in_shipment", { barcode: alias.barcode }));
  }

  async function handleScanPackingLine(scanValue: string) {
    const token = String(scanValue || packingScanInput || "").trim();
    if (!token || !selectedShipmentLines.length) {
      setPackingScanMessage(t("inventory.error_select_shipment_and_scan_code_first"));
      setPackingScanMatchedLineIds([]);
      setPackingScanSelectedLineId("");
      setPackingScanPendingQty("");
      setPackingScanManualQtyMode(false);
      setPackingLocationResolvedId("");
      setPackingLocationScanMessage("");
      return;
    }

    try {
      setPackingScanBusy(true);
      const result = await matchInventoryScanToLines(token, shipmentBindableLines);
      const matchedIds = result.matchedLines.map((line) => line.key);
      const matches = selectedShipmentLines.filter((line) => matchedIds.includes(line.lineId));
      setPackingScanMatchedLineIds(matchedIds);

      if (!matches.length) {
        setManualPackingBarcodeInput(token);
        setPackingScanSelectedLineId("");
        setPackingScanPendingQty("");
        setPackingScanManualQtyMode(false);
        setPackingLocationResolvedId("");
        setPackingLocationScanMessage("");
        if (result.alias) {
          setPackingScanMessage(
            t("inventory.message_barcode_linked_not_in_shipment", {
              barcode: token,
              item: `${result.alias.brand} ${result.alias.product_code || result.alias.old_code || "-"}`.trim(),
            }),
          );
          return;
        }
        setPackingScanMessage(t("inventory.message_no_shipment_line_matched", { barcode: token }));
        return;
      }

      if (matches.length === 1) {
        const match = matches[0];
        handleSelectManualPackingLine(match.lineId);
        setPackingScanSelectedLineId(match.lineId);
        setPackingScanPendingQty(buildNextScanQty(packingScanSelectedLineId === match.lineId ? packingScanPendingQty : "", Number(match.qty || 0), Number(match.qty || 0)));
        setPackingScanManualQtyMode(false);
        setPackingLocationResolvedId("");
        setPackingLocationScanMessage("");
        setManualPackingBarcodeInput(token);
        setPackingScanMessage(
          result.mode === "alias"
            ? t("inventory.message_matched_saved_barcode_qty_ready", {
                item: `${match.brand} ${match.resolvedCode || match.requestedCode || "-"}`.trim(),
              })
            : t("inventory.message_matched_shipment_line_qty_ready", {
                item: `${match.brand} ${match.resolvedCode || match.requestedCode || "-"}`.trim(),
              }),
        );
        return;
      }

      if (matchedIds[0]) scrollShipmentLineIntoView(matchedIds[0]);
      setPackingScanMessage(
        t("inventory.message_shipment_lines_matched", {
          count: matches.length,
          barcode: token,
        }),
      );
      setPackingScanSelectedLineId("");
      setPackingScanPendingQty("");
      setPackingScanManualQtyMode(false);
      setPackingLocationResolvedId("");
      setPackingLocationScanMessage("");
    } catch (caught) {
      setPackingScanMatchedLineIds([]);
      setPackingScanSelectedLineId("");
      setPackingScanPendingQty("");
      setPackingScanManualQtyMode(false);
      setPackingLocationResolvedId("");
      setPackingLocationScanMessage("");
      setPackingScanMessage(caught instanceof Error ? caught.message : t("inventory.error_shipment_scan_failed"));
    } finally {
      setPackingScanBusy(false);
    }
  }

  async function handleConfirmPackingScanQty() {
    if (!selectedShipmentLines.length) {
      actionFeedback.fail(t("inventory.error_select_shipment_first"));
      return;
    }
    const line = selectedShipmentLines.find((item) => item.lineId === packingScanSelectedLineId) || null;
    if (!line) {
      actionFeedback.fail(t("inventory.error_scan_shipment_line_first"));
      return;
    }
    const qty = Math.max(0, Math.min(Number(line.qty || 0), parseNumberInput(packingScanPendingQty)));
    if (!qty) {
      actionFeedback.fail(t("inventory.error_enter_valid_quantity_first"));
      return;
    }
    if (warehouseLocations.length && !selectedPackingExpectedLocation) {
      actionFeedback.fail(t("inventory.error_no_saved_stock_location_for_shipment_line"));
      return;
    }
    if (warehouseLocations.length && !packingLocationResolvedId) {
      actionFeedback.fail(t("inventory.error_scan_stock_location_before_confirm"));
      return;
    }
    if (warehouseLocations.length && selectedPackingExpectedLocation && packingLocationResolvedId !== selectedPackingExpectedLocation.id) {
      actionFeedback.fail(t("inventory.error_scanned_stock_location_mismatch"));
      return;
    }

    handlePackingAssignmentChange(line.lineId, "packedQty", String(qty));
    try {
      await persistDirectedPickTask(line, qty);
    } catch (caught) {
      actionFeedback.fail(caught instanceof Error ? caught.message : t("inventory.error_directed_pick_task_save_failed"));
      return;
    }
    setPackingScanMessage(
      t("inventory.message_reserved_qty_temp_depot", {
        qty: qty.toLocaleString(appLocale),
        item: `${line.brand} ${line.resolvedCode || line.requestedCode || "-"}`.trim(),
      }),
    );
    setPackingScanPendingQty("");
    setPackingScanManualQtyMode(false);
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
        shelf_address: item.shelf_address,
        section_code: item.section_code,
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

  function renderLocationPreviewCard(allowedSources?: InventoryLocationPreview["source"][]) {
    if (!locationPreview) return null;
    if (allowedSources?.length && !allowedSources.includes(locationPreview.source)) return null;
    const imageUrl = locationPreviewCatalogRow?.image_url || "";
    const mainCode = locationPreview.productCode || locationPreview.oldCode || "-";
    const locationPath = [
      locationPreview.warehouseCode || locationPreview.warehouseName,
      locationPreview.shelfAddress,
      locationPreview.sectionCode,
    ]
      .map((value) => String(value || "").trim())
      .filter(Boolean)
      .join(" / ");

    return (
      <SectionCard
        title={t("inventory.location_card")}
        actions={
          <Button variant="secondary" className="button--compact" onClick={() => setLocationPreview(null)}>
            {t("inventory.close")}
          </Button>
        }
      >
        <div className="inventory-location-card">
          <div className="inventory-location-card__media">
            {imageUrl ? <img src={imageUrl} alt={`${locationPreview.brand} ${mainCode}`} /> : <span>{loadingLocationPreviewCatalog ? t("inventory.loading") : t("inventory.no_image")}</span>}
          </div>
          <div className="inventory-location-card__body">
            <div className="inventory-location-card__eyebrow">{locationPreviewSourceLabel}</div>
            <strong className="inventory-location-card__title">
              {locationPreview.brand || "-"} · {mainCode}
            </strong>
            <div className="inventory-location-card__description">{locationPreview.description || t("inventory.no_description")}</div>
            <div className="inventory-location-card__path">{locationPath || t("inventory.no_location_card_assignment")}</div>
            <div className="inventory-location-card__meta">
              <span>{t("inventory.depot_label")}: {locationPreview.warehouseName || locationPreview.warehouseCode || "-"}</span>
              <span>{t("inventory.rack")}: {locationPreview.shelfAddress || "-"}</span>
              <span>{t("inventory.section_label")}: {locationPreview.sectionCode || "-"}</span>
              <span>{t("inventory.origin_short")}: {locationPreview.origin || "-"}</span>
              <span>{t("inventory.last_move")}: {locationPreview.lastMovedAt ? formatDate(locationPreview.lastMovedAt) : "-"}</span>
            </div>
            <div className="inventory-location-card__stats">
              {locationPreview.onHandQty != null ? (
                <div>
                  <span>{t("inventory.on_hand_label")}</span>
                  <strong>{locationPreview.onHandQty.toLocaleString(appLocale)}</strong>
                </div>
              ) : null}
              {locationPreview.availableQty != null ? (
                <div>
                  <span>{t("inventory.available")}</span>
                  <strong>{locationPreview.availableQty.toLocaleString(appLocale)}</strong>
                </div>
              ) : null}
              {locationPreview.reservedQty != null ? (
                <div>
                  <span>{t("inventory.reserved")}</span>
                  <strong>{locationPreview.reservedQty.toLocaleString(appLocale)}</strong>
                </div>
              ) : null}
              {locationPreview.shipmentQty != null ? (
                <div>
                  <span>{t("inventory.shipment_qty")}</span>
                  <strong>{locationPreview.shipmentQty.toLocaleString(appLocale)}</strong>
                </div>
              ) : null}
              {locationPreview.packedQty != null ? (
                <div>
                  <span>{t("inventory.packed_qty")}</span>
                  <strong>{locationPreview.packedQty.toLocaleString(appLocale)}</strong>
                </div>
              ) : null}
              {locationPreview.packageLabel ? (
                <div>
                  <span>{t("inventory.package_short")}</span>
                  <strong>{locationPreview.packageLabel}</strong>
                </div>
              ) : null}
            </div>
            {!locationPreview.shelfAddress && !locationPreview.sectionCode ? (
              <div className="warning-text">{t("inventory.no_saved_stock_location")}</div>
            ) : (
              <div className="success-text">{t("inventory.worker_picks_from_location")}</div>
            )}
          </div>
        </div>
      </SectionCard>
    );
  }

  return (
    <div className="page-stack">
      {activeTab === "Scan Center" ? (
        <div className="page-stack warehouse-scan-center">
          <SectionCard title={isWorkerRole ? t("inventory.scan_center.section_title_worker") : t("inventory.scan_center.section_title_admin")}>
            <div className="warehouse-scan-center__hero">
              <div>
                <div className="warehouse-scan-center__eyebrow">{t("inventory.scan_center.eyebrow")}</div>
                <h3 className="warehouse-scan-center__title">{t("inventory.scan_center.title")}</h3>
                <p className="warehouse-scan-center__text">
                  {t("inventory.scan_center.text")}
                </p>
              </div>
              <div className="warehouse-scan-center__summary">
                <span>{t("inventory.scan_center.goods_ready", { count: formatLocalizedCount(receiveCandidates.length) })}</span>
                <span>{t("inventory.scan_center.shipments_ready", { count: formatLocalizedCount(readyShipmentOrders.length) })}</span>
                <span>{t("inventory.scan_center.active_warehouses", { count: formatLocalizedCount(activeWarehouseCount) })}</span>
              </div>
            </div>

            <div className="warehouse-scan-launch-grid">
              <button type="button" className="warehouse-scan-launch-card" onClick={() => setActiveTab("Purchase Receives")}>
                <span className="warehouse-scan-launch-card__step">01</span>
                <div className="warehouse-scan-launch-card__body">
                  <div className="warehouse-scan-launch-card__title-row">
                    <strong>{t("inventory.scan_center.goods_in_title")}</strong>
                    <span className="warehouse-scan-launch-card__meta">{formatLocalizedCount(receiveCandidates.length)} ready</span>
                  </div>
                  <p>{t("inventory.scan_center.goods_in_desc")}</p>
                  <div className="warehouse-scan-launch-card__hint">{t("inventory.scan_center.goods_in_hint")}</div>
                </div>
                <span className="warehouse-scan-launch-card__action">{t("inventory.scan_center.goods_in_action")}</span>
              </button>

              <button type="button" className="warehouse-scan-launch-card" onClick={() => setActiveTab("Packing & Loading")}>
                <span className="warehouse-scan-launch-card__step">02</span>
                <div className="warehouse-scan-launch-card__body">
                  <div className="warehouse-scan-launch-card__title-row">
                    <strong>{t("inventory.scan_center.packing_title")}</strong>
                    <span className="warehouse-scan-launch-card__meta">{formatLocalizedCount(readyShipmentOrders.length)} ready</span>
                  </div>
                  <p>{t("inventory.scan_center.packing_desc")}</p>
                  <div className="warehouse-scan-launch-card__hint">{t("inventory.scan_center.packing_hint")}</div>
                </div>
                <span className="warehouse-scan-launch-card__action">{t("inventory.scan_center.packing_action")}</span>
              </button>

              <button type="button" className="warehouse-scan-launch-card warehouse-scan-launch-card--secondary" onClick={() => setActiveTab("On Hand")}>
                <span className="warehouse-scan-launch-card__step">03</span>
                <div className="warehouse-scan-launch-card__body">
                  <div className="warehouse-scan-launch-card__title-row">
                    <strong>{t("inventory.scan_center.stock_title")}</strong>
                    <span className="warehouse-scan-launch-card__meta">{formatLocalizedCount(onHandRows.length)} site(s)</span>
                  </div>
                  <p>{t("inventory.scan_center.stock_desc")}</p>
                  <div className="warehouse-scan-launch-card__hint">{t("inventory.scan_center.stock_hint")}</div>
                </div>
                <span className="warehouse-scan-launch-card__action">{t("inventory.scan_center.stock_action")}</span>
              </button>

              <button type="button" className="warehouse-scan-launch-card warehouse-scan-launch-card--secondary" onClick={() => setActiveTab("Transfers")}>
                <span className="warehouse-scan-launch-card__step">04</span>
                <div className="warehouse-scan-launch-card__body">
                  <div className="warehouse-scan-launch-card__title-row">
                    <strong>{t("inventory.scan_center.transfer_title")}</strong>
                    <span className="warehouse-scan-launch-card__meta">{t("inventory.scan_center.internal_move")}</span>
                  </div>
                  <p>{t("inventory.scan_center.transfer_desc")}</p>
                  <div className="warehouse-scan-launch-card__hint">{t("inventory.scan_center.transfer_hint")}</div>
                </div>
                <span className="warehouse-scan-launch-card__action">{t("inventory.scan_center.transfer_action")}</span>
              </button>
            </div>

            <div className="warehouse-scan-center__footer">
              <div className="info-text">{t("inventory.scan_center.phone_camera_info")}</div>
              <div className="info-text">{t("inventory.scan_center.install_info")}</div>
              <div className="info-text">{t("inventory.scan_center.alias_info")}</div>
            </div>
          </SectionCard>

          <SectionCard title={t("inventory.directed_work_history")}>
            <div className="toolbar">
              {canSuperviseWarehouseTasks ? (
                <div style={{ minWidth: 220 }}>
                  <Select value={taskAssigneeFilter} options={warehouseTaskFilterOptions} onChange={setTaskAssigneeFilter} />
                </div>
              ) : null}
              <Button
                variant="secondary"
                className="button--compact"
                onClick={() => void reloadWarehouseTasks(currentWarehouseTaskContextId || undefined)}
                busy={loadingWarehouseTasks}
                busyLabel={t("inventory.refreshing")}
              >
                {t("inventory.refresh")}
              </Button>
            </div>
            <div className="settings-grid settings-stats-grid">
              <div className="settings-item">
                <span className="settings-label">{t("inventory.open_in_progress")}</span>
                <strong>{recentOpenWarehouseTasks.length.toLocaleString(appLocale)}</strong>
              </div>
              <div className="settings-item">
                <span className="settings-label">{t("inventory.overdue")}</span>
                <strong>{overdueWarehouseTaskCount.toLocaleString(appLocale)}</strong>
              </div>
              <div className="settings-item">
                <span className="settings-label">{t("inventory.unassigned")}</span>
                <strong>{unassignedWarehouseTaskCount.toLocaleString(appLocale)}</strong>
              </div>
              <div className="settings-item">
                <span className="settings-label">{t("inventory.completed")}</span>
                <strong>{recentCompletedWarehouseTasks.length.toLocaleString(appLocale)}</strong>
              </div>
              <div className="settings-item">
                <span className="settings-label">{t("inventory.workers_online")}</span>
                <strong>{loadingOrgUsers ? "..." : onlineWarehouseWorkerCount.toLocaleString(appLocale)}</strong>
              </div>
              <div className="settings-item">
                <span className="settings-label">{t("inventory.last_refresh")}</span>
                <strong>{loadingWarehouseTasks || loadingOrgUsers ? t("inventory.loading") : t("inventory.live")}</strong>
              </div>
            </div>
            <div className="info-text">
              {canSuperviseWarehouseTasks
                ? t("inventory.supervisor_queue_info")
                : t("inventory.worker_queue_info")}
            </div>
            {loadingWarehouseTasks ? (
              <div className="empty-state">{t("inventory.loading")}</div>
            ) : (
              <DataTable
                rows={visibleWarehouseTaskRows}
                columns={[
                  {
                    key: "updated",
                    header: t("inventory.updated"),
                    render: (row: { task: WarehouseOperationTask }) => formatDateTime(row.task.updated_at),
                    sortValue: (row: { task: WarehouseOperationTask }) => row.task.updated_at,
                  },
                  {
                    key: "workflow",
                    header: t("inventory.workflow"),
                    render: (row: { task: WarehouseOperationTask }) => (
                      <span className={`mark-badge mark-badge--${row.task.workflow_stage === "pick" ? "info" : row.task.workflow_stage === "putaway" ? "accent" : "danger"}`}>
                        {translateWarehouseTaskWorkflow(row.task.workflow_stage)}
                      </span>
                    ),
                  },
                  {
                    key: "alert",
                    header: t("inventory.alert"),
                    render: (row: { alert: ReturnType<typeof deriveWarehouseTaskAlert> }) => (
                      <span className={`mark-badge mark-badge--${row.alert.tone}`}>{t(row.alert.labelKey, { age: row.alert.ageLabel })}</span>
                    ),
                    sortValue: (row: { alert: ReturnType<typeof deriveWarehouseTaskAlert> }) => row.alert.ageMinutes,
                  },
                  {
                    key: "status",
                    header: t("inventory.status_short"),
                    render: (row: { task: WarehouseOperationTask }) => (
                      <span className={`mark-badge mark-badge--${warehouseTaskStatusTone(row.task.status)}`}>{translateWarehouseTaskStatus(row.task.status)}</span>
                    ),
                  },
                  {
                    key: "assignee",
                    header: t("inventory.assignee"),
                    render: (row: { task: WarehouseOperationTask; assignedUser: OrgUser | null; presence: ReturnType<typeof getPresenceStatus> | null }) =>
                      canSuperviseWarehouseTasks ? (
                        <div style={{ minWidth: 220 }}>
                          <label className="field">
                            <select
                              className="field__input"
                              value={row.task.assigned_user_id || ""}
                              disabled={savingTaskAssignmentId === row.task.id}
                              onChange={(event) => void handleAssignWarehouseTask(row.task, event.target.value)}
                            >
                              {warehouseTaskAssigneeOptions.map((option) => (
                                <option key={option.value} value={option.value}>
                                  {option.label}
                                </option>
                              ))}
                            </select>
                          </label>
                          {row.assignedUser ? (
                            <span className={`presence-badge presence-badge--${row.presence?.tone || "offline"}`}>
                              <span className="presence-dot" />
                              {translatePresenceLabel(row.presence?.tone)}
                            </span>
                          ) : (
                            <span className="warning-text">{t("inventory.waiting_worker_pickup")}</span>
                          )}
                        </div>
                      ) : row.assignedUser ? (
                        <div>
                          <strong>{row.assignedUser.full_name || row.assignedUser.email}</strong>
                          <div>
                            <span className={`presence-badge presence-badge--${row.presence?.tone || "offline"}`}>
                              <span className="presence-dot" />
                              {translatePresenceLabel(row.presence?.tone)}
                            </span>
                          </div>
                        </div>
                      ) : (
                        <span className="warning-text">{t("inventory.unassigned")}</span>
                      ),
                  },
                  {
                    key: "warehouse",
                    header: t("inventory.warehouse_short"),
                    render: (row: { task: WarehouseOperationTask }) => row.task.warehouse_code || row.task.warehouse_name || "-",
                  },
                  {
                    key: "item",
                    header: t("inventory.item"),
                    render: (row: { task: WarehouseOperationTask }) => `${row.task.brand || "-"} · ${row.task.product_code || row.task.old_code || "-"}`,
                  },
                  {
                    key: "qty",
                    header: t("inventory.qty_short_label"),
                    render: (row: { task: WarehouseOperationTask }) =>
                      `${row.task.completed_qty.toLocaleString(appLocale)} / ${row.task.expected_qty.toLocaleString(appLocale)}`,
                  },
                  {
                    key: "location",
                    header: t("inventory.location_short"),
                    render: (row: { locationPath: string }) => row.locationPath,
                  },
                ]}
                emptyText={t("inventory.no_directed_tasks")}
              />
            )}
          </SectionCard>
        </div>
      ) : null}

      {activeTab === "Warehouses" && canSuperviseWarehouseTasks ? (
        <div className="page-stack">
          <div className="stats-grid stats-grid--compact">
            <StatCard
              label={t("inventory.active_sites")}
              value={activeWarehouseCount.toLocaleString(appLocale)}
              subtext={t("inventory.active_sites_subtext")}
              tone="success"
            />
            <StatCard
              label={t("inventory.live_stock_sites")}
              value={liveStockWarehouseCount.toLocaleString(appLocale)}
              subtext={t("inventory.live_stock_sites_subtext")}
              tone={liveStockWarehouseCount ? "success" : "warning"}
            />
            <StatCard
              label={t("inventory.outsourced_nodes")}
              value={outsourcedWarehouseCount.toLocaleString(appLocale)}
              subtext={t("inventory.outsourced_nodes_subtext")}
              tone="neutral"
            />
            <StatCard
              label={t("inventory.api_clients")}
              value={warehouseApiClients.length.toLocaleString(appLocale)}
              subtext={t("inventory.api_clients_subtext", { count: formatLocalizedCount(dropshipWarehouseCount) })}
              tone="neutral"
            />
          </div>
          <SectionCard title={t("inventory.warehouses")}>
            <div className="toolbar">
              <Button className="button--compact" onClick={handleNewWarehouse}>
                {t("inventory.add_warehouse")}
              </Button>
            </div>
            <div className="meta-row">
              <span>{t("inventory.warehouse_count", { count: formatLocalizedCount(warehouses.length) })}</span>
              <span>{loadingOnHand ? t("inventory.loading_live_warehouse_counts") : t("inventory.open_warehouse_to_edit")}</span>
            </div>
            {warehouses.length && !liveStockWarehouseCount ? (
              <div className="warning-text">{t("inventory.warehouse_structure_no_stock")}</div>
            ) : null}
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
                        {warehouses.find((item) => item.id === warehouse.warehouse_id)?.is_active ? t("inventory.active") : t("inventory.closed")}
                      </span>
                    </div>
                    <div className="warehouse-card__meta">
                      <span>{warehouse.region || "-"}</span>
                      <span>{translateWarehouseKind(warehouses.find((item) => item.id === warehouse.warehouse_id)?.warehouse_kind || "internal")}</span>
                      <span>{translateFulfillmentModel(warehouses.find((item) => item.id === warehouse.warehouse_id)?.fulfillment_model || "stocked")}</span>
                    </div>
                    <div className="warehouse-card__stats">
                      <span>{t("inventory.items_count", { count: formatLocalizedCount(warehouse.sku_count) })}</span>
                      <span>{t("inventory.on_hand_count", { count: formatLocalizedCount(warehouse.on_hand_qty) })}</span>
                    </div>
                  </button>
                ))}
              </div>
            ) : (
              <div className="empty-state">{t("inventory.no_warehouses")}</div>
            )}
          </SectionCard>

          {showWarehouseEditor && draft ? (
            <SectionCard title={t("inventory.warehouse_setup")}>
              <div className="toolbar">
                <Button variant="secondary" onClick={handleCloseWarehouseEditor}>
                  {t("inventory.exit")}
                </Button>
                {draft.warehouse_kind === "outsourced" && draft.fulfillment_model !== "dropship" ? (
                  <Button variant="secondary" onClick={() => void handleSyncWarehouse()} busy={syncingWarehouse} busyLabel={t("inventory.syncing")}>
                    {t("inventory.sync_api_stock")}
                  </Button>
                ) : null}
                <Button onClick={() => void handleSave()} busy={saving} busyLabel={t("inventory.saving")}>
                  {t("inventory.save")}
                </Button>
              </div>
              <div className="customers-edit-card customers-edit-card--narrow">
                <div className="customers-form-row">
                  <div className="customers-form-row__label">{t("inventory.warehouse_code")}</div>
                  <div className="customers-field-wrap customers-field-wrap--medium">
                    <Input value={draft.warehouse_code} onChange={(value) => setDraft((current) => (current ? { ...current, warehouse_code: value } : current))} />
                  </div>
                </div>
                <div className="customers-form-row">
                  <div className="customers-form-row__label">{t("inventory.warehouse_name")}</div>
                  <div className="customers-field-wrap customers-field-wrap--wide">
                    <Input value={draft.warehouse_name} onChange={(value) => setDraft((current) => (current ? { ...current, warehouse_name: value } : current))} />
                  </div>
                </div>
                <div className="customers-form-row">
                  <div className="customers-form-row__label">{t("inventory.region_short")}</div>
                  <div className="customers-field-wrap customers-field-wrap--wide">
                    <Input value={draft.region} onChange={(value) => setDraft((current) => (current ? { ...current, region: value } : current))} />
                  </div>
                </div>
                <div className="customers-form-row">
                  <div className="customers-form-row__label">{t("inventory.warehouse_type")}</div>
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
                  <div className="customers-form-row__label">{t("inventory.fulfillment_model")}</div>
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
                  <div className="customers-form-row__label">{t("inventory.address_short")}</div>
                  <div className="customers-field-wrap customers-field-wrap--full">
                    <label className="field customer-field">
                      <textarea className="field__input field__input--textarea" value={draft.address} onChange={(event) => setDraft((current) => (current ? { ...current, address: event.target.value } : current))} />
                    </label>
                  </div>
                </div>
                <div className="customers-form-row">
                  <div className="customers-form-row__label">{t("inventory.status_short")}</div>
                  <div className="customers-field-wrap customers-field-wrap--medium">
                    <label className="field customer-field">
                      <select className="field__input" value={draft.is_active ? "active" : "closed"} onChange={(event) => setDraft((current) => (current ? { ...current, is_active: event.target.value === "active" } : current))}>
                        <option value="active">{t("inventory.active")}</option>
                        <option value="closed">{t("inventory.closed")}</option>
                      </select>
                    </label>
                  </div>
                </div>
                {draft.fulfillment_model === "dropship" ? (
                  <div className="warning-text">
                    {t("inventory.dropship_warehouse_info")}
                  </div>
                ) : null}
                {draft.warehouse_kind === "outsourced" ? (
                  <>
                    <div className="customers-form-row">
                      <div className="customers-form-row__label">{t("inventory.outsource_partner")}</div>
                      <div className="customers-field-wrap customers-field-wrap--wide">
                        <Input value={draft.outsource_partner_name} onChange={(value) => setDraft((current) => (current ? { ...current, outsource_partner_name: value } : current))} />
                      </div>
                    </div>
                    <div className="customers-form-row">
                      <div className="customers-form-row__label">{t("inventory.api_provider")}</div>
                      <div className="customers-field-wrap customers-field-wrap--wide">
                        <Input value={draft.external_api_provider} placeholder={t("inventory.vendor_name_or_api_label")} onChange={(value) => setDraft((current) => (current ? { ...current, external_api_provider: value } : current))} />
                      </div>
                    </div>
                    <div className="customers-form-row">
                      <div className="customers-form-row__label">{t("inventory.api_url")}</div>
                      <div className="customers-field-wrap customers-field-wrap--full">
                        <Input
                          value={draft.external_api_url}
                          placeholder="https://partner.example/api/stock?location={{location_code}}"
                          onChange={(value) => setDraft((current) => (current ? { ...current, external_api_url: value } : current))}
                        />
                      </div>
                    </div>
                    <div className="customers-form-row">
                      <div className="customers-form-row__label">{t("inventory.location_code")}</div>
                      <div className="customers-field-wrap customers-field-wrap--medium">
                        <Input value={draft.external_location_code} onChange={(value) => setDraft((current) => (current ? { ...current, external_location_code: value } : current))} />
                      </div>
                    </div>
                    <div className="customers-form-row">
                      <div className="customers-form-row__label">{t("inventory.auth_type")}</div>
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
                        <div className="customers-form-row__label">{t("inventory.token_env_name")}</div>
                        <div className="customers-field-wrap customers-field-wrap--medium">
                          <Input value={draft.external_api_token_env} placeholder="OUTSOURCE_WAREHOUSE_API_TOKEN" onChange={(value) => setDraft((current) => (current ? { ...current, external_api_token_env: value } : current))} />
                        </div>
                      </div>
                    ) : null}
                    {draft.fulfillment_model !== "dropship" ? (
                      <div className="customers-form-row">
                        <div className="customers-form-row__label">{t("inventory.sync_mode")}</div>
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
                              <option value="enabled">{t("inventory.manual_api_sync_enabled")}</option>
                              <option value="disabled">{t("inventory.disabled")}</option>
                            </select>
                          </label>
                        </div>
                      </div>
                    ) : null}
                    <div className="settings-grid settings-stats-grid">
                      <div className="settings-item">
                        <span className="settings-label">{t("inventory.last_sync")}</span>
                        <strong>{draft.external_last_sync_at ? formatDate(draft.external_last_sync_at) : "-"}</strong>
                      </div>
                      <div className="settings-item">
                        <span className="settings-label">{t("inventory.sync_status")}</span>
                        <strong>{draft.external_last_sync_status || t("inventory.not_synced")}</strong>
                      </div>
                      <div className="settings-item">
                        <span className="settings-label">{t("inventory.sync_message")}</span>
                        <strong>{draft.external_last_sync_message || t("inventory.waiting_first_sync")}</strong>
                      </div>
                    </div>
                    <div className="meta-row">
                      <span>{t("inventory.expected_api_payload")}</span>
                      <span>{t("inventory.supported_api_fields")}</span>
                    </div>
                  </>
                ) : null}
              </div>
            </SectionCard>
          ) : null}

          <SectionCard title={t("inventory.warehouse_locations")}>
            <div className="toolbar toolbar--wrap">
              <Button className="button--compact" onClick={handleNewWarehouseLocation}>
                {t("inventory.add_location")}
              </Button>
              <Button variant="secondary" className="button--compact" onClick={() => void handleSaveWarehouseLocationDraft()} busy={savingWarehouseLocation} busyLabel={t("inventory.saving")}>
                {t("inventory.save_location")}
              </Button>
            </div>
            <div className="meta-row">
              <span>{t("inventory.location_count", { count: formatLocalizedCount(warehouseLocations.length) })}</span>
              <span>{loadingWarehouseLocations ? t("inventory.loading_location_master") : t("inventory.scan_location_to_open")}</span>
            </div>
            <WarehouseCodeScanner
              language={language}
              label={t("inventory.scan_location")}
              value={warehouseLocationSearch}
              onChange={setWarehouseLocationSearch}
              onSubmit={(value) => void handleScanWarehouseLocation(value)}
              submitLabel={t("inventory.find_location")}
              busy={loadingWarehouseLocations}
              busyLabel={t("inventory.loading")}
              helperText={t("inventory.scan_location_helper")}
            />
            <div className="settings-grid settings-stats-grid" style={{ marginTop: 16 }}>
              <div className="settings-item">
                <span className="settings-label">{t("inventory.selected_location")}</span>
                <strong>{selectedWarehouseLocation?.location_code || warehouseLocationDraft.location_code || "-"}</strong>
              </div>
              <div className="settings-item">
                <span className="settings-label">{t("inventory.path")}</span>
                <strong>{selectedWarehouseLocation ? buildWarehouseLocationPath(selectedWarehouseLocation) : "-"}</strong>
              </div>
              <div className="settings-item">
                <span className="settings-label">{t("inventory.type_short")}</span>
                <strong>{translateWarehouseLocationType(selectedWarehouseLocation?.location_type || warehouseLocationDraft.location_type)}</strong>
              </div>
              <div className="settings-item">
                <span className="settings-label">{t("inventory.status_short")}</span>
                <strong>{(selectedWarehouseLocation?.is_active ?? warehouseLocationDraft.is_active) ? t("inventory.active") : t("inventory.inactive")}</strong>
              </div>
            </div>
            <DataTable
              rows={visibleWarehouseLocations}
              onRowClick={(row: WarehouseLocation) => handleSelectWarehouseLocation(row)}
              rowClassName={(row: WarehouseLocation) => (row.id === selectedWarehouseLocationId ? "inventory-scan-match" : "")}
              columns={[
                { key: "updated", header: t("inventory.updated"), render: (row: WarehouseLocation) => formatDate(row.updated_at) },
                { key: "code", header: t("inventory.location_short"), render: (row: WarehouseLocation) => row.location_code || "-" },
                { key: "barcode", header: t("inventory.barcode"), render: (row: WarehouseLocation) => row.location_barcode || "-" },
                { key: "path", header: t("inventory.path"), render: (row: WarehouseLocation) => buildWarehouseLocationPath(row) || "-" },
                { key: "type", header: t("inventory.type_short"), render: (row: WarehouseLocation) => translateWarehouseLocationType(row.location_type) },
                {
                  key: "flags",
                  header: t("inventory.flags"),
                  render: (row: WarehouseLocation) =>
                    `${row.is_default_pick_face ? t("inventory.default_pick_face") : ""}${row.is_default_pick_face && row.allow_mixed_sku ? " · " : ""}${row.allow_mixed_sku ? t("inventory.allow_mixed_sku") : ""}` || "-",
                },
                {
                  key: "action",
                  header: t("inventory.action"),
                  render: (row: WarehouseLocation) => (
                    <Button variant="secondary" onClick={() => handleSelectWarehouseLocation(row)}>
                      {t("inventory.edit")}
                    </Button>
                  ),
                },
              ]}
              emptyText={t("inventory.no_warehouse_locations")}
            />

            <div className="customers-edit-card customers-edit-card--narrow warehouse-location-editor" style={{ marginTop: 16 }}>
              <div className="customers-form-row">
                <div className="customers-form-row__label">{t("inventory.warehouse_short")}</div>
                <div className="customers-field-wrap customers-field-wrap--wide">
                  <Select
                    value={warehouseLocationDraft.warehouse_id}
                    options={[{ value: "", label: t("inventory.select_warehouse") }, ...warehouses.map((row) => ({ value: row.id, label: `${row.warehouse_code} · ${row.warehouse_name}` }))]}
                    onChange={(value) => handleWarehouseLocationFieldChange("warehouse_id", value)}
                  />
                </div>
              </div>
              <div className="customers-form-row">
                <div className="customers-form-row__label">{t("inventory.location_code")}</div>
                <div className="customers-field-wrap customers-field-wrap--medium">
                  <Input value={warehouseLocationDraft.location_code} onChange={(value) => handleWarehouseLocationFieldChange("location_code", value)} placeholder="A-01-01" />
                </div>
              </div>
              <div className="customers-form-row">
                <div className="customers-form-row__label">Barcode</div>
                <div className="customers-field-wrap customers-field-wrap--medium">
                  <Input value={warehouseLocationDraft.location_barcode} onChange={(value) => handleWarehouseLocationFieldChange("location_barcode", value)} placeholder="LOC-A0101" />
                </div>
              </div>
              <div className="customers-form-row">
                <div className="customers-form-row__label">{t("inventory.type_short")}</div>
                <div className="customers-field-wrap customers-field-wrap--medium">
                  <Select
                    value={warehouseLocationDraft.location_type}
                    options={WAREHOUSE_LOCATION_TYPE_OPTIONS.map((option) => ({ ...option, label: translateWarehouseLocationType(option.value) }))}
                    onChange={(value) => handleWarehouseLocationFieldChange("location_type", value as WarehouseLocationType)}
                  />
                </div>
              </div>
              <div className="settings-grid settings-stats-grid">
                <Input label={t("inventory.zone")} value={warehouseLocationDraft.zone_code} onChange={(value) => handleWarehouseLocationFieldChange("zone_code", value)} placeholder="Z1" />
                <Input label={t("inventory.aisle")} value={warehouseLocationDraft.aisle_code} onChange={(value) => handleWarehouseLocationFieldChange("aisle_code", value)} placeholder="A12" />
                <Input label={t("inventory.rack")} value={warehouseLocationDraft.rack_code} onChange={(value) => handleWarehouseLocationFieldChange("rack_code", value)} placeholder="R04" />
                <Input label={t("inventory.level")} value={warehouseLocationDraft.level_code} onChange={(value) => handleWarehouseLocationFieldChange("level_code", value)} placeholder="L02" />
                <Input label={t("inventory.bin")} value={warehouseLocationDraft.bin_code} onChange={(value) => handleWarehouseLocationFieldChange("bin_code", value)} placeholder="B07" />
                <Input label={t("inventory.shelf_address")} value={warehouseLocationDraft.shelf_address} onChange={(value) => handleWarehouseLocationFieldChange("shelf_address", value)} placeholder="R04-L02-B07" />
                <Input label={t("inventory.section_code")} value={warehouseLocationDraft.section_code} onChange={(value) => handleWarehouseLocationFieldChange("section_code", value)} placeholder="PICK-01" />
                <Input label={t("inventory.pick_sequence")} type="number" value={warehouseLocationDraft.pick_sequence} onChange={(value) => handleWarehouseLocationFieldChange("pick_sequence", value)} placeholder="10" />
                <Input label={t("inventory.volume_m3")} type="number" value={warehouseLocationDraft.capacity_volume_m3} onChange={(value) => handleWarehouseLocationFieldChange("capacity_volume_m3", value)} placeholder="1.2000" />
                <Input label={t("inventory.weight_kg")} type="number" value={warehouseLocationDraft.capacity_weight_kg} onChange={(value) => handleWarehouseLocationFieldChange("capacity_weight_kg", value)} placeholder="500.0000" />
              </div>
              <div className="warehouse-api-checkboxes">
                <label className="checkbox-field warehouse-api-checkbox">
                  <input type="checkbox" checked={warehouseLocationDraft.is_active} onChange={(event) => handleWarehouseLocationFieldChange("is_active", event.target.checked)} />
                  <span>{t("inventory.active")}</span>
                </label>
                <label className="checkbox-field warehouse-api-checkbox">
                  <input type="checkbox" checked={warehouseLocationDraft.is_default_pick_face} onChange={(event) => handleWarehouseLocationFieldChange("is_default_pick_face", event.target.checked)} />
                  <span>{t("inventory.default_pick_face")}</span>
                </label>
                <label className="checkbox-field warehouse-api-checkbox">
                  <input type="checkbox" checked={warehouseLocationDraft.allow_mixed_sku} onChange={(event) => handleWarehouseLocationFieldChange("allow_mixed_sku", event.target.checked)} />
                  <span>{t("inventory.allow_mixed_sku")}</span>
                </label>
              </div>
              <div className="customers-form-row customers-form-row--top">
                <div className="customers-form-row__label">{t("inventory.notes")}</div>
                <div className="customers-field-wrap customers-field-wrap--full">
                  <label className="field customer-field">
                    <textarea className="field__input field__input--textarea" value={warehouseLocationDraft.notes} onChange={(event) => handleWarehouseLocationFieldChange("notes", event.target.value)} />
                  </label>
                </div>
              </div>
            </div>
          </SectionCard>

          <SectionCard title={t("inventory.partner_api_clients")}>
            <div className="toolbar">
              <Button className="button--compact" onClick={handleNewWarehouseApiClient}>
                {t("inventory.add_api_client")}
              </Button>
            </div>
            <div className="meta-row">
              <span>{t("inventory.api_client_count", { count: formatLocalizedCount(warehouseApiClients.length) })}</span>
              <span>{warehouseApiBaseUrl || t("inventory.save_client_to_generate_credentials")}</span>
            </div>
            <DataTable rows={warehouseApiClients} columns={warehouseApiClientColumns} emptyText={t("inventory.no_partner_api_clients")} onRowClick={handleSelectWarehouseApiClient} />

            {showWarehouseApiEditor && warehouseApiDraft ? (
              <div className="customers-edit-card customers-edit-card--narrow warehouse-api-editor">
                <div className="toolbar">
                  <Button variant="secondary" onClick={handleCloseWarehouseApiEditor}>
                    {t("inventory.exit")}
                  </Button>
                  {warehouseApiDraft.id ? (
                    <Button variant="secondary" onClick={() => void handleRotateWarehouseApiClient()} busy={rotatingWarehouseApiClient} busyLabel={t("inventory.refreshing")}>
                      {t("inventory.rotate_api_key")}
                    </Button>
                  ) : null}
                  {warehouseApiDraft.id ? (
                    <Button variant="secondary" onClick={() => void handleDeleteWarehouseApiClient()} busy={savingWarehouseApiClient} busyLabel={t("inventory.deleting")}>
                      {t("inventory.delete")}
                    </Button>
                  ) : null}
                  <Button onClick={() => void handleSaveWarehouseApiClient()} busy={savingWarehouseApiClient} busyLabel={t("inventory.saving")}>
                    {t("inventory.save")}
                  </Button>
                </div>

                <div className="customers-form-row">
                  <div className="customers-form-row__label">{t("inventory.client_name")}</div>
                  <div className="customers-field-wrap customers-field-wrap--wide">
                    <Input value={warehouseApiDraft.client_name} onChange={(value) => setWarehouseApiDraft((current) => (current ? { ...current, client_name: value } : current))} />
                  </div>
                </div>
                <div className="customers-form-row">
                  <div className="customers-form-row__label">{t("inventory.partner_name")}</div>
                  <div className="customers-field-wrap customers-field-wrap--wide">
                    <Input value={warehouseApiDraft.partner_name} onChange={(value) => setWarehouseApiDraft((current) => (current ? { ...current, partner_name: value } : current))} />
                  </div>
                </div>
                <div className="customers-form-row">
                  <div className="customers-form-row__label">{t("inventory.status_short")}</div>
                  <div className="customers-field-wrap customers-field-wrap--medium">
                    <Select
                      value={warehouseApiDraft.status}
                      options={[
                        { value: "active", label: t("inventory.active") },
                        { value: "disabled", label: t("inventory.disabled") },
                      ]}
                      onChange={(value) => setWarehouseApiDraft((current) => (current ? { ...current, status: value === "disabled" ? "disabled" : "active" } : current))}
                    />
                  </div>
                </div>
                <div className="customers-form-row">
                  <div className="customers-form-row__label">{t("inventory.expires_at")}</div>
                  <div className="customers-field-wrap customers-field-wrap--medium">
                    <Input type="date" value={warehouseApiDraft.expires_at ? warehouseApiDraft.expires_at.slice(0, 10) : ""} onChange={(value) => setWarehouseApiDraft((current) => (current ? { ...current, expires_at: value ? `${value}T23:59:59.000Z` : "" } : current))} />
                  </div>
                </div>

                <div className="customers-form-row customers-form-row--top">
                  <div className="customers-form-row__label">{t("inventory.allowlisted_ips")}</div>
                  <div className="customers-field-wrap customers-field-wrap--full">
                    <label className="field customer-field">
                      <textarea
                        className="field__input field__input--textarea"
                        value={warehouseApiDraft.allowed_ip_list}
                        onChange={(event) => setWarehouseApiDraft((current) => (current ? { ...current, allowed_ip_list: event.target.value } : current))}
                        placeholder={"203.0.113.10\n203.0.113.0/24"}
                      />
                    </label>
                  </div>
                </div>

                <div className="customers-form-row customers-form-row--top">
                  <div className="customers-form-row__label">{t("inventory.allowed_warehouses")}</div>
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
                    <span>{t("inventory.require_hmac_signed")}</span>
                  </label>
                  <label className="checkbox-field warehouse-api-checkbox">
                    <input
                      type="checkbox"
                      checked={warehouseApiDraft.allow_order_submit}
                      onChange={(event) => setWarehouseApiDraft((current) => (current ? { ...current, allow_order_submit: event.target.checked } : current))}
                    />
                    <span>{t("inventory.open_order_submit_endpoint")}</span>
                  </label>
                  <label className="checkbox-field warehouse-api-checkbox">
                    <input
                      type="checkbox"
                      checked={warehouseApiDraft.include_zero_stock}
                      onChange={(event) => setWarehouseApiDraft((current) => (current ? { ...current, include_zero_stock: event.target.checked } : current))}
                    />
                    <span>{t("inventory.include_zero_stock")}</span>
                  </label>
                </div>

                <div className="customers-form-row customers-form-row--top">
                  <div className="customers-form-row__label">{t("inventory.notes")}</div>
                  <div className="customers-field-wrap customers-field-wrap--full">
                    <label className="field customer-field">
                      <textarea className="field__input field__input--textarea" value={warehouseApiDraft.notes} onChange={(event) => setWarehouseApiDraft((current) => (current ? { ...current, notes: event.target.value } : current))} />
                    </label>
                  </div>
                </div>

                <div className="settings-grid settings-stats-grid">
                  <div className="settings-item">
                    <span className="settings-label">{t("inventory.feed_url")}</span>
                    <strong>{warehouseApiBaseUrl || "-"}</strong>
                  </div>
                  <div className="settings-item">
                    <span className="settings-label">{t("inventory.order_url")}</span>
                    <strong>{warehouseApiBaseUrl ? warehouseApiBaseUrl.replace("/warehouse-stock-feed", "/warehouse-order-submit") : "-"}</strong>
                  </div>
                  <div className="settings-item">
                    <span className="settings-label">{t("inventory.auth_header")}</span>
                    <strong>{warehouseApiHeaderName}</strong>
                  </div>
                  <div className="settings-item">
                    <span className="settings-label">{t("inventory.key_prefix")}</span>
                    <strong>{warehouseApiDraft.api_key_prefix || t("inventory.generated_on_first_save")}</strong>
                  </div>
                  <div className="settings-item">
                    <span className="settings-label">{t("inventory.last_used")}</span>
                    <strong>{warehouseApiDraft.last_used_at ? formatDate(warehouseApiDraft.last_used_at) : "-"}</strong>
                  </div>
                </div>

                {latestWarehouseApiSecret ? (
                  <div className="warehouse-api-token">
                    <strong>{t("inventory.copy_api_key_now")}</strong>
                    <div className="warehouse-api-token__value">{latestWarehouseApiSecret.api_key}</div>
                    <div className="meta-row">
                      <span>{t("inventory.header")}: {latestWarehouseApiSecret.header_name}</span>
                      <span>{t("inventory.example")}: {latestWarehouseApiSecret.sample_url}</span>
                    </div>
                    <div className="meta-row">
                      <span>{t("inventory.use_same_api_key_as_hmac")}</span>
                      <span>{t("inventory.send_timestamp_signature_headers")}</span>
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
              <h3>{t("inventory.purchase_receives")}</h3>
            </div>
            <div className="customers-list">
              {loadingOrders || loadingReceives ? <div className="empty-state">{t("inventory.loading_purchase_receives")}</div> : null}
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
                      <span>{t("inventory.qty_remaining", { count: formatLocalizedCount(remainingQty) })}</span>
                    </button>
                  );
                })
              ) : null}
              {!loadingOrders && !loadingReceives && !receiveCandidates.length ? <div className="empty-state">{t("inventory.no_purchase_orders_ready")}</div> : null}
            </div>
          </aside>

          <section className="customers-editor">
            <div className="customers-editor__header">
              <h2>{t("inventory.receive_into_warehouse")}</h2>
              <div className="toolbar">
                <Select value={receiveWarehouseId} options={stockedWarehouseOptions} onChange={setReceiveWarehouseId} />
                <Button onClick={() => void handlePostReceive()} busy={postingReceive} busyLabel={t("inventory.posting")}>
                  {t("inventory.put_to_stock")}
                </Button>
              </div>
            </div>
            {selectedReceive && receiveDraft ? (
              <div className="page-stack">
                <div className="settings-grid settings-stats-grid">
                  <div className="settings-item">
                    <span className="settings-label">{t("inventory.purchase_order")}</span>
                    <strong>{selectedReceive.id}</strong>
                  </div>
                  <div className="settings-item">
                    <span className="settings-label">{t("inventory.supplier")}</span>
                    <strong>{selectedReceive.supplier_name}</strong>
                  </div>
                  <div className="settings-item">
                    <span className="settings-label">{t("inventory.target_warehouse")}</span>
                    <strong>{selectedReceiveWarehouse?.warehouse_name || "-"}</strong>
                  </div>
                  <div className="settings-item">
                    <span className="settings-label">{t("inventory.receive_qty")}</span>
                    <strong>{formatLocalizedCount(receiveDraftTotals.qty)}</strong>
                  </div>
                </div>

                <SectionCard title={t("inventory.scan_receive_line")}>
                  <WarehouseCodeScanner
                    language={language}
                    label={t("inventory.scan_product_oem")}
                    value={receiveScanInput}
                    onChange={setReceiveScanInput}
                    onSubmit={handleScanReceiveLine}
                    submitLabel={t("inventory.find_line")}
                    busy={receiveScanBusy}
                    busyLabel={t("inventory.matching")}
                    helperText={t("inventory.scan_receive_helper")}
                  />
                  {receiveScanMessage ? <div className="info-text">{receiveScanMessage}</div> : null}
                  {selectedReceiveScanLine ? (
                    <div className="settings-grid settings-stats-grid" style={{ marginTop: 16 }}>
                      <div className="settings-item">
                        <span className="settings-label">{t("inventory.matched_line")}</span>
                        <strong>{selectedReceiveScanLine.brand || "-"} · {selectedReceiveScanLine.product_code || selectedReceiveScanLine.old_code || "-"}</strong>
                        <span className="info-text">{receiveScanManualQtyMode ? t("inventory.manual_qty_mode_on") : t("inventory.approve_receive_qty")}</span>
                      </div>
                      <div className="settings-item">
                        <span className="settings-label">{t("inventory.putaway_location")}</span>
                        <strong>{selectedReceiveLocation ? buildWarehouseLocationPath(selectedReceiveLocation) : t("inventory.no_location_assigned")}</strong>
                        <span className="info-text">
                          {warehouseLocations.length
                            ? t("inventory.scan_rack_before_confirm")
                            : t("inventory.location_master_empty")}
                        </span>
                      </div>
                      <WarehouseCodeScanner
                        language={language}
                        label={t("inventory.scan_shelf_location")}
                        value={receiveLocationScanInput}
                        onChange={setReceiveLocationScanInput}
                        onSubmit={handleScanReceiveLocation}
                        submitLabel={t("inventory.load_location")}
                        busy={receiveLocationScanBusy}
                        busyLabel={t("inventory.matching")}
                        helperText={t("inventory.scan_location_helper")}
                      />
                      {receiveLocationScanMessage ? <div className="info-text">{receiveLocationScanMessage}</div> : null}
                      <Input
                        label={receiveScanManualQtyMode ? t("inventory.manual_qty") : t("inventory.suggested_qty")}
                        type="number"
                        value={receiveScanPendingQty}
                        onChange={setReceiveScanPendingQty}
                        placeholder={receiveScanManualQtyMode ? t("inventory.type_qty") : "1"}
                      />
                      <div className="inline-actions" style={{ alignSelf: "end" }}>
                        <Button onClick={() => void handleConfirmReceiveScanQty()} disabled={parseNumberInput(receiveScanPendingQty) <= 0}>
                          {t("inventory.confirm")}
                        </Button>
                        <Button
                          variant="secondary"
                          onClick={() => {
                            setReceiveScanManualQtyMode(true);
                            setReceiveScanPendingQty("");
                          }}
                        >
                          {t("inventory.other_manual")}
                        </Button>
                        <Button
                          variant="secondary"
                          onClick={() => {
                            setReceiveScanSelectedLineKey("");
                            setReceiveScanPendingQty("");
                            setReceiveScanManualQtyMode(false);
                          }}
                        >
                          {t("inventory.clear")}
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </SectionCard>

                <SectionCard title={t("inventory.directed_putaway_queue")}>
                  <div className="info-text">
                    {t("inventory.directed_putaway_info")}
                  </div>
                  {isPhoneViewport ? (
                    visibleDirectedPutawayQueueRows.length ? (
                      <div className="inventory-scan-mobile-list">
                        {visibleDirectedPutawayQueueRows.map((row) => (
                          <article
                            key={row.key}
                            data-receive-line-key={row.key}
                            className={`inventory-scan-mobile-card${receiveScanMatchedKeys.includes(row.key) ? " inventory-scan-mobile-card--matched" : ""}`}
                          >
                            <div className="inventory-scan-mobile-card__header">
                              <strong className="inventory-scan-mobile-card__title">{`${row.brand || "-"} · ${row.code}`}</strong>
                              <span>{row.description || "-"}</span>
                            </div>
                            <div className="inventory-scan-mobile-card__meta">
                              <div className="settings-item">
                                <span className="settings-label">{t("inventory.qty_short_label")}</span>
                                <strong>{`${row.completedQty.toLocaleString(appLocale)} / ${row.expectedQty.toLocaleString(appLocale)}`}</strong>
                              </div>
                              <div className="settings-item">
                                <span className="settings-label">{t("inventory.putaway_short")}</span>
                                <strong>{row.locationPath || "-"}</strong>
                              </div>
                              <div className="settings-item">
                                <span className="settings-label">{t("inventory.assignee")}</span>
                                <strong>{row.assigneeName || t("inventory.unassigned")}</strong>
                              </div>
                              <div className="settings-item">
                                <span className="settings-label">{t("inventory.status_short")}</span>
                                <strong>{row.status}</strong>
                              </div>
                            </div>
                          </article>
                        ))}
                      </div>
                    ) : (
                      <div className="empty-state">{t("inventory.no_directed_putaway")}</div>
                    )
                  ) : (
                    <DataTable
                      rows={visibleDirectedPutawayQueueRows}
                      wrapClassName={isPhoneViewport ? "table-wrap--scan-mobile" : ""}
                      columns={[
                        { key: "item", header: t("inventory.item"), render: (row: { brand: string; code: string }) => `${row.brand || "-"} · ${row.code}` },
                        { key: "description", header: t("inventory.description_short"), render: (row: { description: string }) => row.description || "-" },
                        { key: "qty", header: t("inventory.qty_short_label"), render: (row: { completedQty: number; expectedQty: number }) => `${row.completedQty.toLocaleString(appLocale)} / ${row.expectedQty.toLocaleString(appLocale)}` },
                        { key: "location", header: t("inventory.putaway_short"), render: (row: { locationPath: string }) => row.locationPath || "-" },
                        { key: "assignee", header: t("inventory.assignee"), render: (row: { assigneeName: string }) => row.assigneeName || t("inventory.unassigned") },
                        { key: "status", header: t("inventory.status_short"), render: (row: { status: string }) => row.status },
                      ]}
                      emptyText={t("inventory.no_directed_putaway")}
                    />
                  )}
                </SectionCard>

                {canManageManualBarcode ? (
                  <SectionCard title={t("inventory.first_scan_barcode_binding")}>
                    <WarehouseBarcodeBindingPanel
                      language={language}
                      intro={t("inventory.first_scan_receive_intro")}
                      barcodeLabel={t("inventory.sticker_barcode")}
                      barcodeValue={manualReceiveBarcodeInput}
                      onBarcodeChange={setManualReceiveBarcodeInput}
                      barcodePlaceholder={t("inventory.sticker_barcode_placeholder")}
                      selectedItemLabel={
                        selectedReceiveBindingLine
                          ? `${selectedReceiveBindingLine.brand || "-"} · ${selectedReceiveBindingLine.product_code || selectedReceiveBindingLine.old_code || "-"}`
                          : ""
                      }
                      selectedItemId={manualReceiveLineKey}
                      itemLabel={t("inventory.receive_line")}
                      itemOptions={receiveLineOptions}
                      onSelectItem={handleSelectManualReceiveLine}
                      suggestedItems={receiveBindingCandidates}
                      emptySuggestionText={t("inventory.no_receive_suggestion")}
                      noteLabel={t("inventory.why_manual")}
                      noteValue={manualReceiveNotes}
                      onNoteChange={setManualReceiveNotes}
                      notePlaceholder={t("inventory.manual_note_placeholder")}
                      lastScanValue={receiveScanInput}
                      onUseLastScan={() => setManualReceiveBarcodeInput(receiveScanInput)}
                      onSave={() => void handleSaveManualReceiveBarcode()}
                      saveLabel={
                        selectedReceiveAlias && normalizePartCode(selectedReceiveAlias.barcode) === normalizePartCode(manualReceiveBarcodeInput)
                          ? t("inventory.admin_remap_barcode")
                          : t("inventory.save_manual_barcode")
                      }
                      saveBusy={savingManualReceiveBarcode}
                      saveBusyLabel={t("inventory.saving")}
                    />
                  </SectionCard>
                ) : null}

                {showManualEntryAlerts ? (
                  <SectionCard title={t("inventory.barcode_alias_review")}>
                    <div className="page-stack">
                      <div className="info-text">{t("inventory.barcode_alias_review_info_receive")}</div>
                      <div className="toolbar toolbar--wrap">
                        <Input label={t("inventory.search_alias")} value={barcodeAliasSearch} onChange={setBarcodeAliasSearch} placeholder={t("inventory.barcode_search_placeholder")} />
                        <Button variant="secondary" onClick={() => void reloadBarcodeAliases()} busy={loadingBarcodeAliases} busyLabel={t("inventory.refreshing")}>
                          {t("inventory.refresh_alias_list")}
                        </Button>
                      </div>
                      {loadingBarcodeAliases ? (
                        <div className="empty-state">{t("inventory.loading_barcode_aliases")}</div>
                      ) : (
                        <DataTable
                          rows={visibleBarcodeAliases}
                          onRowClick={handleLoadReceiveAliasReview}
                          rowClassName={(row: InventoryBarcodeAlias) => (row.id === selectedReceiveAliasId ? "inventory-scan-match" : "")}
                          columns={[
                            { key: "updated", header: t("inventory.updated"), render: (row: InventoryBarcodeAlias) => formatDate(row.updated_at) },
                            { key: "barcode", header: t("inventory.barcode"), render: (row: InventoryBarcodeAlias) => row.barcode || "-" },
                            {
                              key: "item",
                              header: t("inventory.current_item"),
                              render: (row: InventoryBarcodeAlias) => `${row.brand || "-"} · ${row.product_code || row.old_code || "-"}`,
                            },
                            { key: "description", header: t("inventory.description_short"), render: (row: InventoryBarcodeAlias) => row.description || "-" },
                            { key: "user", header: t("inventory.last_by"), render: (row: InventoryBarcodeAlias) => row.created_by_email || "-" },
                            {
                              key: "action",
                              header: t("inventory.action"),
                              render: (row: InventoryBarcodeAlias) => (
                                <Button variant="secondary" onClick={() => handleLoadReceiveAliasReview(row)}>
                                  {t("inventory.load")}
                                </Button>
                              ),
                            },
                          ]}
                          emptyText={t("inventory.no_barcode_aliases")}
                        />
                      )}
                    </div>
                  </SectionCard>
                ) : null}

                {showManualEntryAlerts ? (
                  <div data-inventory-focus-target="manual-alerts">
                  <SectionCard title={t("inventory.recent_manual_barcode_alerts")}>
                    <div className="page-stack">
                      <div className="info-text">{t("inventory.manual_barcode_alerts_info")}</div>
                      {loadingManualEntryAlerts ? (
                        <div className="empty-state">{t("inventory.loading_manual_barcode_alerts")}</div>
                      ) : manualEntryAlerts.length ? (
                        <DataTable
                          rows={manualEntryAlerts}
                          columns={[
                            { key: "date", header: t("inventory.date"), render: (row: InventoryManualEntryAlert) => formatDate(row.created_at) },
                            { key: "stage", header: t("inventory.stage"), render: (row: InventoryManualEntryAlert) => translateManualAlertStage(row.workflow_stage) },
                            { key: "barcode", header: t("inventory.barcode"), render: (row: InventoryManualEntryAlert) => row.barcode },
                            {
                              key: "item",
                              header: t("inventory.matched_line"),
                              render: (row: InventoryManualEntryAlert) => `${row.brand || "-"} · ${row.product_code || row.old_code || "-"}`,
                            },
                            { key: "document", header: t("inventory.document"), render: (row: InventoryManualEntryAlert) => row.document_no || row.document_id || "-" },
                            { key: "warehouse", header: t("inventory.warehouse_short"), render: (row: InventoryManualEntryAlert) => row.warehouse_name || row.warehouse_code || "-" },
                            { key: "user", header: t("inventory.entered_by"), render: (row: InventoryManualEntryAlert) => row.entered_by_email || "-" },
                            {
                              key: "action",
                              header: t("inventory.action"),
                              render: (row: InventoryManualEntryAlert) => (
                                <div className="toolbar">
                                  <Button
                                    variant="secondary"
                                    className="button--compact"
                                    onClick={() => {
                                      if (!row.document_id) return;
                                      if (isReceiveManualAlert(row)) {
                                        onOpenPurchaseOrder?.(row.document_id);
                                        return;
                                      }
                                      onOpenSalesOrder?.(row.document_id);
                                    }}
                                  >
                                    {isReceiveManualAlert(row) ? t("inventory.open_po") : t("inventory.open_so")}
                                  </Button>
                                  <Button
                                    variant="secondary"
                                    className="button--compact"
                                    onClick={() => handleReviewManualAlert(row)}
                                  >
                                    {t("inventory.review")}
                                  </Button>
                                </div>
                              ),
                            },
                          ]}
                          emptyText={t("inventory.no_manual_barcode_entries")}
                        />
                      ) : (
                        <div className="empty-state">{t("inventory.no_manual_barcode_entries")}</div>
                      )}
                    </div>
                  </SectionCard>
                  </div>
                ) : null}

                <SectionCard title={t("inventory.receive_lines")}>
                  {isPhoneViewport ? (
                    visibleReceiveLines.length ? (
                      <div className="inventory-scan-mobile-list">
                        {visibleReceiveLines.map((line) => (
                          <article
                            key={line.key}
                            data-receive-line-key={line.key}
                            className={`inventory-scan-mobile-card${receiveScanMatchedKeys.includes(line.key) ? " inventory-scan-mobile-card--matched" : ""}`}
                          >
                            <div className="inventory-scan-mobile-card__header">
                              <strong className="inventory-scan-mobile-card__title">{`${line.brand || "-"} · ${line.product_code || line.old_code || "-"}`}</strong>
                              <span>{line.description || "-"}</span>
                            </div>
                            <div className="inventory-scan-mobile-card__meta">
                              <div className="settings-item">
                                <span className="settings-label">{t("inventory.oem")}</span>
                                <strong>{line.oem_no || "-"}</strong>
                              </div>
                              <div className="settings-item">
                                <span className="settings-label">{t("inventory.ordered")}</span>
                                <strong>{line.qty_ordered.toLocaleString(appLocale)}</strong>
                              </div>
                              <div className="settings-item">
                                <span className="settings-label">{t("inventory.remaining")}</span>
                                <strong>{line.qty_remaining_before.toLocaleString(appLocale)}</strong>
                              </div>
                              <div className="settings-item">
                                <span className="settings-label">{t("inventory.receive_now")}</span>
                                <strong>{String(line.qty_received || 0)}</strong>
                              </div>
                            </div>
                            <div className="inventory-scan-mobile-card__field-grid">
                              <label className="field">
                                <span className="field__label">{t("inventory.rack")}</span>
                                <input
                                  className="field__input"
                                  type="text"
                                  value={line.shelf_address}
                                  placeholder="A-01-03"
                                  onChange={(event) => handleReceiveDraftLineChange(line.key, "shelf_address", event.target.value)}
                                />
                              </label>
                              <label className="field">
                                <span className="field__label">{t("inventory.section_label")}</span>
                                <input
                                  className="field__input"
                                  type="text"
                                  value={line.section_code}
                                  placeholder="B1"
                                  onChange={(event) => handleReceiveDraftLineChange(line.key, "section_code", event.target.value)}
                                />
                              </label>
                              <label className="field">
                                <span className="field__label">{t("inventory.receive_now")}</span>
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
                            </div>
                          </article>
                        ))}
                      </div>
                    ) : (
                      <div className="empty-state">{t("inventory.no_purchase_order_selected")}</div>
                    )
                  ) : (
                    <div className="table-wrap">
                      <table className="data-table">
                        <thead>
                          <tr>
                            <th>{t("inventory.code")}</th>
                            <th>{t("inventory.oem")}</th>
                            <th>{t("inventory.brand")}</th>
                            <th>{t("inventory.description_short")}</th>
                            <th>{t("inventory.rack")}</th>
                            <th>{t("inventory.section_label")}</th>
                            <th>{t("inventory.ordered")}</th>
                            <th>{t("inventory.remaining")}</th>
                            <th>{t("inventory.receive_now")}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {visibleReceiveLines.map((line) => (
                            <tr
                              key={line.key}
                              data-receive-line-key={line.key}
                              className={receiveScanMatchedKeys.includes(line.key) ? "inventory-scan-match" : ""}
                            >
                              <td>{line.product_code || line.old_code || "-"}</td>
                              <td>{line.oem_no || "-"}</td>
                              <td>{line.brand || "-"}</td>
                              <td>{line.description || "-"}</td>
                              <td>
                                <label className="field">
                                  <input
                                    className="field__input"
                                    type="text"
                                    value={line.shelf_address}
                                    placeholder="A-01-03"
                                    onChange={(event) => handleReceiveDraftLineChange(line.key, "shelf_address", event.target.value)}
                                  />
                                </label>
                              </td>
                              <td>
                                <label className="field">
                                  <input
                                    className="field__input"
                                    type="text"
                                    value={line.section_code}
                                    placeholder="B1"
                                    onChange={(event) => handleReceiveDraftLineChange(line.key, "section_code", event.target.value)}
                                  />
                                </label>
                              </td>
                              <td>{line.qty_ordered.toLocaleString(appLocale)}</td>
                              <td>{line.qty_remaining_before.toLocaleString(appLocale)}</td>
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
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </SectionCard>

                <SectionCard title={t("inventory.receive_posting")}>
                  <div className="customers-form-row customers-form-row--top">
                    <div className="customers-form-row__label">{t("inventory.notes")}</div>
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

                <SectionCard title={t("inventory.receive_history")}>
                  <DataTable
                    rows={selectedOrderReceives}
                    columns={[
                      { key: "id", header: t("inventory.receive_no"), render: (row: PurchaseReceive) => row.id },
                      { key: "date", header: t("inventory.date"), render: (row: PurchaseReceive) => formatDate(row.received_date) },
                      { key: "warehouse", header: t("inventory.warehouse_short"), render: (row: PurchaseReceive) => row.warehouse_name || row.warehouse_code || "-" },
                      { key: "qty", header: t("inventory.qty_short_label"), render: (row: PurchaseReceive) => row.total_qty.toLocaleString(appLocale) },
                      { key: "status", header: t("inventory.status_short"), render: (row: PurchaseReceive) => row.status.toUpperCase() },
                    ]}
                    emptyText={t("inventory.no_posted_receives")}
                  />
                </SectionCard>
              </div>
            ) : (
              <SectionCard title={t("inventory.purchase_receives")}>
                <div className="empty-state">{t("inventory.no_purchase_order_selected")}</div>
              </SectionCard>
            )}
          </section>
        </div>
      ) : null}

      {activeTab === "Stock Movements" ? (
        <div className="page-stack">
          <SectionCard title={t("inventory.manual_stock_adjustment")}>
            <div className="page-stack">
              <WarehouseCodeScanner
                language={language}
                label={t("inventory.scan_product_oem")}
                value={adjustmentScanInput}
                onChange={setAdjustmentScanInput}
                onSubmit={(value) => void handleLookupAdjustmentScan(value)}
                submitLabel={t("inventory.lookup_item")}
                busy={adjustmentLookupBusy}
                busyLabel={t("inventory.looking_up")}
                helperText={t("inventory.scan_adjustment_helper")}
              />
              {adjustmentLookupMessage ? <div className="info-text">{adjustmentLookupMessage}</div> : null}
              {adjustmentLookupResults.length ? (
                <div className="inventory-lookup-results">
                  {adjustmentLookupResults.map((row) => (
                    <button
                      key={`${row.product_id || row.product_code}::${row.brand}`}
                      className="inventory-lookup-card"
                      onClick={() => applyCatalogRowToAdjustment(row)}
                    >
                      <div className="inventory-lookup-card__media">
                        {row.image_url ? <img src={row.image_url} alt={`${row.brand} ${row.product_code}`} /> : <span>{t("inventory.no_image")}</span>}
                      </div>
                      <div className="inventory-lookup-card__body">
                        <strong>{row.brand} · {row.product_code}</strong>
                        <span>{row.description || t("inventory.no_description")}</span>
                        <div className="inventory-lookup-card__meta">
                          <span>EAN: {row.ean || "-"}</span>
                          <span>OEM: {row.oem_no || "-"}</span>
                          <span>{t("inventory.origin_short")}: {row.origin || "-"}</span>
                          <span>{t("inventory.weight")}: {row.weight_kg == null ? "-" : `${row.weight_kg} kg`}</span>
                        </div>
                      </div>
                      <div className="inventory-lookup-card__action">{t("inventory.use_item")}</div>
                    </button>
                  ))}
                </div>
              ) : null}

              <div className="settings-grid">
                <Select label={t("inventory.warehouse_short")} value={adjustmentWarehouseId} options={stockedWarehouseOptions} onChange={setAdjustmentWarehouseId} />
                <Input label={t("inventory.move_date")} type="date" value={adjustmentDraft.movedDate} onChange={(value) => handleAdjustmentFieldChange("movedDate", value)} />
                <Input label={t("inventory.brand")} value={adjustmentDraft.brand} onChange={(value) => handleAdjustmentFieldChange("brand", value)} placeholder="MANN, BOSCH, FEBI" />
                <Input label={t("inventory.product_code")} value={adjustmentDraft.productCode} onChange={(value) => handleAdjustmentFieldChange("productCode", value)} placeholder={t("inventory.main_part_code_placeholder")} />
                <Input label={t("inventory.old_code")} value={adjustmentDraft.oldCode} onChange={(value) => handleAdjustmentFieldChange("oldCode", value)} placeholder={t("inventory.optional_legacy_code_placeholder")} />
                <Input label={t("inventory.qty_delta")} value={adjustmentDraft.qtyDelta} onChange={(value) => handleAdjustmentFieldChange("qtyDelta", value)} placeholder="+100 or -2" />
                <Input label={t("inventory.origin_short")} value={adjustmentDraft.origin} onChange={(value) => handleAdjustmentFieldChange("origin", value)} placeholder={t("inventory.country_of_origin_placeholder")} />
              </div>
              <div className="settings-grid">
                <Input label={t("inventory.description_short")} value={adjustmentDraft.description} onChange={(value) => handleAdjustmentFieldChange("description", value)} placeholder={t("inventory.product_description_placeholder")} />
                <Input label={t("inventory.reason_reference")} value={adjustmentDraft.relatedParty} onChange={(value) => handleAdjustmentFieldChange("relatedParty", value)} placeholder={t("inventory.reason_reference_placeholder")} />
              </div>
              <div className="customers-form-row customers-form-row--top">
                <div className="customers-form-row__label">{t("inventory.notes")}</div>
                <div className="customers-field-wrap customers-field-wrap--full">
                  <label className="field customer-field">
                    <textarea
                      className="field__input field__input--textarea"
                      value={adjustmentDraft.notes}
                      onChange={(event) => handleAdjustmentFieldChange("notes", event.target.value)}
                      placeholder={t("inventory.adjustment_notes_placeholder")}
                    />
                  </label>
                </div>
              </div>

              <div className="toolbar toolbar--wrap">
                <Button variant="secondary" onClick={handleResetAdjustmentForm}>
                  {t("inventory.clear")}
                </Button>
                {matchedAdjustmentItem ? (
                  <Button variant="secondary" onClick={handleApplyMatchedAdjustmentItem}>
                    {t("inventory.use_existing_item_data")}
                  </Button>
                ) : null}
                <Button onClick={() => void handlePostAdjustment()} busy={postingAdjustment} busyLabel={t("inventory.posting")}>
                  {t("inventory.post_adjustment")}
                </Button>
              </div>

              <div className="meta-row">
                <span>
                  {adjustmentQtyDelta > 0
                    ? t("inventory.positive_qty_creates_stock")
                    : adjustmentQtyDelta < 0
                      ? t("inventory.negative_qty_removes_stock")
                      : t("inventory.enter_positive_negative_qty")}
                </span>
                <span>{t("inventory.reuse_matching_stock_row")}</span>
              </div>

              {matchedAdjustmentItem ? (
                <div className="success-text">
                  {t("inventory.matched_current_stock", {
                    item: `${matchedAdjustmentItem.brand} ${matchedAdjustmentItem.product_code || matchedAdjustmentItem.old_code}`,
                    qty: formatLocalizedCount(matchedAdjustmentItem.on_hand_qty),
                  })}
                </div>
              ) : null}
              {!matchedAdjustmentItem && adjustmentHasLookupInput ? (
                <div className="warning-text">
                  {t("inventory.no_current_stock_row", {
                    brand: adjustmentDraft.brand || t("inventory.brand").toLowerCase(),
                    code: adjustmentCodeHint,
                  })}
                </div>
              ) : null}
              <div className="meta-row">
                <span>
                  {loadingAdjustmentStock
                    ? t("inventory.checking_current_stock")
                    : t("inventory.stock_rows_available_selected", { count: formatLocalizedCount(adjustmentStockRows.length) })}
                </span>
                <span>{selectedAdjustmentWarehouse ? `${selectedAdjustmentWarehouse.warehouse_code} · ${selectedAdjustmentWarehouse.warehouse_name}` : t("inventory.select_stocked_warehouse_to_post")}</span>
              </div>
            </div>
          </SectionCard>

          <SectionCard title={t("subnav.stock_movements")}>
            <div className="toolbar toolbar--wrap">
              <Select value={movementWarehouseId} options={warehouseFilterOptions} onChange={setMovementWarehouseId} />
            </div>
            <div className="meta-row">
              <span>{formatLocalizedCount(movementRows.length)} movement rows</span>
              <span>{loadingMovements ? t("inventory.refreshing_movement_ledger") : t("inventory.movement_ledger_info")}</span>
            </div>
            <DataTable rows={movementRows} columns={movementColumns} emptyText={t("inventory.no_stock_movement_rows")} />
          </SectionCard>
        </div>
      ) : null}

      {activeTab === "On Hand" ? (
        <div className="page-stack">
          <SectionCard title={t("subnav.on_hand")}>
            <div className="toolbar toolbar--wrap">
              <Select value={onHandWarehouseId} options={warehouseFilterOptions} onChange={setOnHandWarehouseId} />
            </div>
            <div className="meta-row">
              <span>{t("inventory.warehouse_snapshots", { count: formatLocalizedCount(visibleOnHandRows.length) })}</span>
              <span>{loadingOnHand ? t("inventory.rebuilding_on_hand") : t("inventory.current_on_hand_info")}</span>
            </div>
            <DataTable rows={visibleOnHandRows} columns={onHandColumns} emptyText={t("inventory.no_inventory_snapshot")} />
          </SectionCard>
          <SectionCard title={t("inventory.warehouse_stock_detail")}>
            <div className="toolbar toolbar--wrap">
              <Input value={onHandStockSearch} onChange={setOnHandStockSearch} placeholder={t("inventory.search_code_desc_brand")} />
            </div>
            <div className="meta-row">
              <span>{t("inventory.stock_rows_count", { count: formatLocalizedCount(visibleOnHandStockRows.length) })}</span>
              <span>
                {loadingOnHandStock
                  ? t("inventory.refreshing_item_detail")
                  : onHandWarehouseId
                    ? t("inventory.item_level_detail_selected")
                    : t("inventory.select_warehouse_above")}
              </span>
            </div>
            <DataTable
              rows={visibleOnHandStockRows}
              columns={onHandStockColumns}
              emptyText={t("inventory.no_item_level_detail")}
              onRowClick={(row: WarehouseStockItem) => openLocationPreviewFromStockItem(row, "onhand")}
            />
          </SectionCard>
          {renderLocationPreviewCard(["onhand"])}
        </div>
      ) : null}

      {activeTab === "Packing & Loading" ? (
        <div className="customers-shell">
          <aside className="customers-sidebar">
            <div className="customers-sidebar__header">
              <h3>{t("inventory.packing_loading")}</h3>
              <span>{formatLocalizedCount(shipmentReadyCount)}</span>
            </div>
            <div className="customers-list">
              {loadingShipments ? <div className="empty-state">{t("inventory.loading_confirmed_shipment_queue")}</div> : null}
              {!loadingShipments && readyShipmentOrders.length
                ? readyShipmentOrders.map((order) => {
                    const invoice = shipmentInvoiceBySalesOrderId.get(order.id);
                    const orderQty = order.lines.reduce((sum, line) => sum + Number(line.qty || 0), 0);
                    return (
                      <button
                        key={order.id}
                        className={`customers-list__item${selectedShipmentOrder?.id === order.id ? " active" : ""}`}
                        onClick={() => setSelectedShipmentId(order.id)}
                      >
                        <strong>{order.sales_order_no}</strong>
                        <span>{order.customer_name || t("inventory.no_customer")} · {invoice ? `Invoice ${invoice.id}` : t("inventory.invoice_pending")}</span>
                        <span>{formatLocalizedCount(orderQty)} qty · {formatLocalizedCount(order.lines.length)} lines</span>
                      </button>
                    );
                  })
                : null}
              {!loadingShipments && !readyShipmentOrders.length ? <div className="empty-state">{t("inventory.no_confirmed_sales_order_ready")}</div> : null}
            </div>
          </aside>

          <section className="customers-editor">
            <div className="customers-editor__header">
              <h2>{t("inventory.packing_loading")}</h2>
              <div className="toolbar">
                <Select
                  value={packingVehicleDraft.mode}
                  options={loadingVehiclePresets.map((item) => ({ value: item.key, label: translateVehicleLabel(item.label) }))}
                  onChange={(value) => handlePackingVehicleChange("mode", value)}
                />
              </div>
            </div>

            {selectedShipmentOrder ? (
              <div className="page-stack">
                <div className="settings-grid settings-stats-grid">
                  <div className="settings-item">
                    <span className="settings-label">{translateAppText(language, "subnav.sales_orders")}</span>
                    <strong>{selectedShipmentOrder.sales_order_no}</strong>
                  </div>
                  <div className="settings-item">
                    <span className="settings-label">{translateAppText(language, "subnav.customers")}</span>
                    <strong>{selectedShipmentOrder.customer_name || "-"}</strong>
                  </div>
                  <div className="settings-item">
                    <span className="settings-label">{t("inventory.linked_invoice")}</span>
                    <strong>{selectedShipmentInvoice?.id || t("inventory.pending")}</strong>
                    <span className="info-text">{t("inventory.packed_quantities_temp_depot")}</span>
                  </div>
                  <div className="settings-item">
                    <span className="settings-label">{t("inventory.shipment_lines")}</span>
                    <strong>{formatLocalizedCount(selectedShipmentLines.length)}</strong>
                  </div>
                  <div className="settings-item">
                    <span className="settings-label">{t("inventory.order_qty")}</span>
                    <strong>{formatLocalizedCount(selectedShipmentQtyTotal)}</strong>
                  </div>
                  <div className="settings-item">
                    <span className="settings-label">{t("inventory.packed_qty")}</span>
                    <strong>{formatLocalizedCount(packedQtyTotal)}</strong>
                  </div>
                </div>

                  {selectedShipmentOrder.packing_details || selectedShipmentInvoice?.packing_details ? (
                  <div className="warning-text">
                    {t("inventory.packing_notes_prefix")} {selectedShipmentOrder.packing_details || selectedShipmentInvoice?.packing_details}
                  </div>
                ) : null}
                <div className="info-text" style={{ marginBottom: 12 }}>{t("inventory.reserved_first_info")}</div>
                <div className="settings-grid settings-stats-grid" style={{ marginBottom: 16 }}>
                  <Select
                    label={t("inventory.packing_warehouse")}
                    value={packingVehicleDraft.warehouse_id}
                    options={packingWarehouseOptions}
                    onChange={(value) => handlePackingVehicleChange("warehouse_id", value)}
                  />
                  <div className="settings-item">
                    <span className="settings-label">{t("inventory.reservation_save")}</span>
                    <strong>
                      {loadingPackingSession
                        ? t("inventory.loading")
                        : !packingSessionStorageReady
                          ? t("inventory.schema_update_pending")
                        : savingPackingSession
                          ? t("inventory.saving")
                          : packingSessionMeta?.updated_at
                            ? t("inventory.saved_at", { date: packingSessionMeta.updated_at.slice(0, 16).replace("T", " ") })
                            : t("inventory.not_saved_yet")}
                    </strong>
                    <span className="info-text">
                      {!packingSessionStorageReady
                        ? t("inventory.packing_schema_live")
                        : selectedPackingWarehouse
                        ? t("inventory.reserved_stock_in_warehouse", { warehouse: selectedPackingWarehouse.warehouse_name })
                        : t("inventory.choose_warehouse_before_reserve")}
                    </span>
                  </div>
                  <div className="settings-item">
                    <span className="settings-label">{t("inventory.location_source")}</span>
                    <strong>
                      {loadingPackingWarehouseStock
                        ? t("inventory.loading")
                        : selectedPackingWarehouse
                          ? t("inventory.stock_rows", { count: formatLocalizedCount(packingWarehouseStockRows.length) })
                          : t("inventory.select_warehouse")}
                    </strong>
                    <span className="info-text">{t("inventory.location_source_help")}</span>
                  </div>
                </div>

                <SectionCard title={t("inventory.scan_shipment_line")}>
                  <WarehouseCodeScanner
                    language={language}
                    label={t("inventory.scan_shipment_item")}
                    value={packingScanInput}
                    onChange={setPackingScanInput}
                    onSubmit={handleScanPackingLine}
                    submitLabel={t("inventory.find_line")}
                    busy={packingScanBusy}
                    busyLabel={t("inventory.matching")}
                    helperText={t("inventory.scan_shipment_helper")}
                  />
                  {packingScanMessage ? <div className="info-text">{packingScanMessage}</div> : null}
                  {selectedPackingScanLine ? (
                    <div className="settings-grid settings-stats-grid" style={{ marginTop: 16 }}>
                      <div className="settings-item">
                        <span className="settings-label">{t("inventory.matched_line")}</span>
                        <strong>{selectedPackingScanLine.brand || "-"} · {selectedPackingScanLine.resolvedCode || selectedPackingScanLine.requestedCode || "-"}</strong>
                        <span className="info-text">{packingScanManualQtyMode ? t("inventory.manual_qty_mode_on") : t("inventory.approve_packed_qty")}</span>
                      </div>
                      <div className="settings-item">
                        <span className="settings-label">{t("inventory.rack_section")}</span>
                        <strong>{formatWarehouseLocation(selectedPackingScanLocation)}</strong>
                        <span className="info-text">
                          {selectedPackingScanLocation ? t("inventory.pick_from_this_location") : t("inventory.no_saved_stock_location")}
                        </span>
                      </div>
                      <WarehouseCodeScanner
                        language={language}
                        label={t("inventory.scan_stock_location")}
                        value={packingLocationScanInput}
                        onChange={setPackingLocationScanInput}
                        onSubmit={handleScanPackingLocation}
                        submitLabel={t("inventory.verify_location")}
                        busy={packingLocationScanBusy}
                        busyLabel={t("inventory.matching")}
                        helperText={t("inventory.scan_stock_location_helper")}
                      />
                      {packingLocationScanMessage ? <div className="info-text">{packingLocationScanMessage}</div> : null}
                      <Input
                        label={packingScanManualQtyMode ? t("inventory.manual_qty") : t("inventory.suggested_qty")}
                        type="number"
                        value={packingScanPendingQty}
                        onChange={setPackingScanPendingQty}
                        placeholder={packingScanManualQtyMode ? t("inventory.type_qty") : "1"}
                      />
                      <div className="inline-actions" style={{ alignSelf: "end" }}>
                        <Button onClick={() => void handleConfirmPackingScanQty()} disabled={parseNumberInput(packingScanPendingQty) <= 0}>
                          {t("inventory.confirm")}
                        </Button>
                        <Button
                          variant="secondary"
                          onClick={() => {
                            setPackingScanManualQtyMode(true);
                            setPackingScanPendingQty("");
                          }}
                        >
                          {t("inventory.other_manual")}
                        </Button>
                        <Button
                          variant="secondary"
                          onClick={() => {
                            setPackingScanSelectedLineId("");
                            setPackingScanPendingQty("");
                            setPackingScanManualQtyMode(false);
                          }}
                        >
                          {t("inventory.clear")}
                        </Button>
                      </div>
                    </div>
                  ) : null}
                </SectionCard>

                <SectionCard title={t("inventory.directed_pick_queue")}>
                  <div className="info-text">{t("inventory.directed_pick_info")}</div>
                  {isPhoneViewport ? (
                    visibleDirectedPickQueueRows.length ? (
                      <div className="inventory-scan-mobile-list">
                        {visibleDirectedPickQueueRows.map((row) => (
                          <article
                            key={row.key}
                            data-shipment-line-id={row.key}
                            className={`inventory-scan-mobile-card${packingScanMatchedLineIds.includes(row.key) ? " inventory-scan-mobile-card--matched" : ""}`}
                          >
                            <div className="inventory-scan-mobile-card__header">
                              <strong className="inventory-scan-mobile-card__title">{`${row.brand || "-"} · ${row.code}`}</strong>
                              <span>{row.description || "-"}</span>
                            </div>
                            <div className="inventory-scan-mobile-card__meta">
                              <div className="settings-item">
                                <span className="settings-label">{t("inventory.qty_short_label")}</span>
                                <strong>{`${row.completedQty.toLocaleString(appLocale)} / ${row.expectedQty.toLocaleString(appLocale)}`}</strong>
                              </div>
                              <div className="settings-item">
                                <span className="settings-label">{t("inventory.pick_from")}</span>
                                <strong>{row.locationPath || "-"}</strong>
                              </div>
                              <div className="settings-item">
                                <span className="settings-label">{t("inventory.assignee")}</span>
                                <strong>{row.assigneeName || t("inventory.unassigned")}</strong>
                              </div>
                              <div className="settings-item">
                                <span className="settings-label">{t("inventory.status_short")}</span>
                                <strong>{row.status}</strong>
                              </div>
                            </div>
                          </article>
                        ))}
                      </div>
                    ) : (
                      <div className="empty-state">{t("inventory.no_directed_pick")}</div>
                    )
                  ) : (
                    <DataTable
                      rows={visibleDirectedPickQueueRows}
                      wrapClassName={isPhoneViewport ? "table-wrap--scan-mobile" : ""}
                      columns={[
                        { key: "item", header: t("inventory.item"), render: (row: { brand: string; code: string }) => `${row.brand || "-"} · ${row.code}` },
                        { key: "description", header: t("inventory.description_short"), render: (row: { description: string }) => row.description || "-" },
                        { key: "qty", header: t("inventory.qty_short_label"), render: (row: { completedQty: number; expectedQty: number }) => `${row.completedQty.toLocaleString(appLocale)} / ${row.expectedQty.toLocaleString(appLocale)}` },
                        { key: "location", header: t("inventory.pick_from"), render: (row: { locationPath: string }) => row.locationPath || "-" },
                        { key: "assignee", header: t("inventory.assignee"), render: (row: { assigneeName: string }) => row.assigneeName || t("inventory.unassigned") },
                        { key: "status", header: t("inventory.status_short"), render: (row: { status: string }) => row.status },
                      ]}
                      emptyText={t("inventory.no_directed_pick")}
                    />
                  )}
                </SectionCard>

                {canManageManualBarcode ? (
                  <SectionCard title={t("inventory.first_scan_barcode_binding")}>
                    <WarehouseBarcodeBindingPanel
                      language={language}
                      intro={t("inventory.first_scan_shipment_intro")}
                      barcodeLabel={t("inventory.shipment_barcode")}
                      barcodeValue={manualPackingBarcodeInput}
                      onBarcodeChange={setManualPackingBarcodeInput}
                      barcodePlaceholder={t("inventory.shipment_barcode_placeholder")}
                      selectedItemLabel={
                        selectedShipmentBindingLine
                          ? `${selectedShipmentBindingLine.brand || "-"} · ${selectedShipmentBindingLine.resolvedCode || selectedShipmentBindingLine.requestedCode || "-"}`
                          : ""
                      }
                      selectedItemId={manualPackingLineId}
                      itemLabel={t("inventory.shipment_item")}
                      itemOptions={shipmentLineOptions}
                      onSelectItem={handleSelectManualPackingLine}
                      suggestedItems={shipmentBindingCandidates}
                      emptySuggestionText={t("inventory.no_shipment_suggestion")}
                      noteLabel={t("inventory.binding_note")}
                      noteValue={manualPackingNotes}
                      onNoteChange={setManualPackingNotes}
                      notePlaceholder={t("inventory.note_placeholder_admin_review")}
                      lastScanValue={packingScanInput}
                      onUseLastScan={() => setManualPackingBarcodeInput(packingScanInput)}
                      onSave={() => void handleSaveManualPackingBarcode()}
                      saveLabel={
                        selectedPackingAlias && normalizePartCode(selectedPackingAlias.barcode) === normalizePartCode(manualPackingBarcodeInput)
                          ? t("inventory.admin_remap_barcode")
                          : t("inventory.save_barcode_alias")
                      }
                      saveBusy={savingManualPackingBarcode}
                      saveBusyLabel={t("inventory.saving")}
                    />
                  </SectionCard>
                ) : null}

                {showManualEntryAlerts ? (
                  <SectionCard title={t("inventory.barcode_alias_review")}>
                    <div className="page-stack">
                      <div className="info-text">{t("inventory.barcode_alias_review_info_packing")}</div>
                      <div className="toolbar toolbar--wrap">
                        <Input label={t("inventory.search_alias")} value={barcodeAliasSearch} onChange={setBarcodeAliasSearch} placeholder={t("inventory.barcode_search_placeholder")} />
                        <Button variant="secondary" onClick={() => void reloadBarcodeAliases()} busy={loadingBarcodeAliases} busyLabel={t("inventory.refreshing")}>
                          {t("inventory.refresh_alias_list")}
                        </Button>
                      </div>
                      {loadingBarcodeAliases ? (
                        <div className="empty-state">{t("inventory.loading_barcode_aliases")}</div>
                      ) : (
                        <DataTable
                          rows={visibleBarcodeAliases}
                          onRowClick={handleLoadPackingAliasReview}
                          rowClassName={(row: InventoryBarcodeAlias) => (row.id === selectedPackingAliasId ? "inventory-scan-match" : "")}
                          columns={[
                            { key: "updated", header: t("inventory.updated"), render: (row: InventoryBarcodeAlias) => formatDate(row.updated_at) },
                            { key: "barcode", header: t("inventory.barcode"), render: (row: InventoryBarcodeAlias) => row.barcode || "-" },
                            {
                              key: "item",
                              header: t("inventory.current_item"),
                              render: (row: InventoryBarcodeAlias) => `${row.brand || "-"} · ${row.product_code || row.old_code || "-"}`,
                            },
                            { key: "description", header: t("inventory.description_short"), render: (row: InventoryBarcodeAlias) => row.description || "-" },
                            { key: "user", header: t("inventory.last_by"), render: (row: InventoryBarcodeAlias) => row.created_by_email || "-" },
                            {
                              key: "action",
                              header: t("inventory.action"),
                              render: (row: InventoryBarcodeAlias) => (
                                <Button variant="secondary" onClick={() => handleLoadPackingAliasReview(row)}>
                                  {t("inventory.load")}
                                </Button>
                              ),
                            },
                          ]}
                          emptyText={t("inventory.no_barcode_aliases")}
                        />
                      )}
                    </div>
                  </SectionCard>
                ) : null}

                <SectionCard title={t("inventory.package_builder")}>
                  <div className="settings-grid">
                    <Input label={t("inventory.package_label")} value={packingPackageDraft.label} onChange={(value) => handlePackingPackageDraftChange("label", value)} placeholder="PKG-01 / PALLET-01" />
                    <Select
                      label={t("inventory.package_type")}
                      value={packingPackageDraft.packageType}
                      options={[
                        { value: "carton", label: t("inventory.carton") },
                        { value: "pallet", label: t("inventory.pallet") },
                        { value: "crate", label: t("inventory.crate") },
                        { value: "bundle", label: t("inventory.bundle") },
                      ]}
                      onChange={(value) => handlePackingPackageDraftChange("packageType", value)}
                    />
                    <Input label={t("inventory.length_cm")} value={packingPackageDraft.lengthCm} onChange={(value) => handlePackingPackageDraftChange("lengthCm", value)} placeholder="120" />
                    <Input label={t("inventory.width_cm")} value={packingPackageDraft.widthCm} onChange={(value) => handlePackingPackageDraftChange("widthCm", value)} placeholder="80" />
                    <Input label={t("inventory.height_cm")} value={packingPackageDraft.heightCm} onChange={(value) => handlePackingPackageDraftChange("heightCm", value)} placeholder="140" />
                    <Input label={t("inventory.gross_weight_kg")} value={packingPackageDraft.grossWeightKg} onChange={(value) => handlePackingPackageDraftChange("grossWeightKg", value)} placeholder={t("inventory.manual_gross_weight_placeholder")} />
                    <Select
                      label={t("inventory.load_orientation")}
                      value={packingPackageDraft.orientation}
                      options={[
                        { value: "length-first", label: t("inventory.length_first") },
                        { value: "width-first", label: t("inventory.width_first") },
                        { value: "upright", label: t("inventory.upright") },
                        { value: "stacked", label: t("inventory.stacked") },
                      ]}
                      onChange={(value) => handlePackingPackageDraftChange("orientation", value)}
                    />
                  </div>
                  <div className="customers-form-row customers-form-row--top">
                    <div className="customers-form-row__label">{t("inventory.package_notes")}</div>
                    <div className="customers-field-wrap customers-field-wrap--full">
                      <label className="field customer-field">
                        <textarea
                          className="field__input field__input--textarea"
                          value={packingPackageDraft.notes}
                          onChange={(event) => handlePackingPackageDraftChange("notes", event.target.value)}
                          placeholder={t("inventory.package_notes_placeholder")}
                        />
                      </label>
                    </div>
                  </div>
                  <div className="toolbar toolbar--wrap">
                    <Button variant="secondary" onClick={() => setPackingPackageDraft(createEmptyPackingPackage(packingPackages.length + 1))}>
                      {t("inventory.reset_package")}
                    </Button>
                    <Button onClick={handleAddPackingPackage}>
                      {t("inventory.add_package")}
                    </Button>
                  </div>
                  <div className="meta-row">
                    <span>{t("inventory.package_shells_created", { count: formatLocalizedCount(packingPackages.length) })}</span>
                    <span>{t("inventory.enter_dimensions_first")}</span>
                  </div>
                </SectionCard>

                <SectionCard title={t("inventory.shipment_lines")}>
                  {isPhoneViewport ? (
                    visibleShipmentScanLines.length ? (
                      <div className="inventory-scan-mobile-list">
                        {visibleShipmentScanLines.map((line) => (
                          <article
                            key={line.lineId}
                            data-shipment-line-id={line.lineId}
                            className={`inventory-scan-mobile-card${packingScanMatchedLineIds.includes(line.lineId) ? " inventory-scan-mobile-card--matched" : ""}`}
                          >
                            <div className="inventory-scan-mobile-card__header">
                              <strong className="inventory-scan-mobile-card__title">{`${line.brand || "-"} · ${line.resolvedCode || line.requestedCode || "-"}`}</strong>
                              <span>{line.description || "-"}</span>
                            </div>
                            <div className="inventory-scan-mobile-card__meta">
                              <div className="settings-item">
                                <span className="settings-label">{t("inventory.rack_section")}</span>
                                <strong>{formatWarehouseLocation(shipmentWarehouseLocationByLineId.get(line.lineId) || null)}</strong>
                              </div>
                              <div className="settings-item">
                                <span className="settings-label">{t("inventory.qty_short_label")}</span>
                                <strong>{Number(line.qty || 0).toLocaleString(appLocale)}</strong>
                              </div>
                              <div className="settings-item">
                                <span className="settings-label">{t("inventory.origin_short")}</span>
                                <strong>{line.origin || "-"}</strong>
                              </div>
                              <div className="settings-item">
                                <span className="settings-label">HS Code</span>
                                <strong>{line.hs_code || "-"}</strong>
                              </div>
                              <div className="settings-item">
                                <span className="settings-label">{t("inventory.net_weight_short")}</span>
                                <strong>{line.weight_kg == null ? "-" : `${line.weight_kg} kg`}</strong>
                              </div>
                            </div>
                            <div className="inventory-scan-mobile-card__field-grid">
                              <label className="field">
                                <span className="field__label">{t("inventory.pack_to")}</span>
                                <select
                                  className="field__input"
                                  value={packingAssignments[line.lineId]?.packageId || ""}
                                  onChange={(event) => handlePackingAssignmentChange(line.lineId, "packageId", event.target.value)}
                                >
                                  {packingPackageOptions.map((option) => (
                                    <option key={option.value || "unassigned"} value={option.value}>
                                      {option.label}
                                    </option>
                                  ))}
                                </select>
                              </label>
                              <label className="field">
                                <span className="field__label">{t("inventory.packed_qty")}</span>
                                <input
                                  className="field__input inventory-number-input"
                                  type="number"
                                  min="0"
                                  step="0.01"
                                  max={line.qty}
                                  value={packingAssignments[line.lineId]?.packedQty || ""}
                                  onChange={(event) => handlePackingAssignmentChange(line.lineId, "packedQty", event.target.value)}
                                />
                              </label>
                            </div>
                            <div className="inventory-scan-mobile-card__actions">
                              <Button className="button--compact" variant="secondary" onClick={() => openLocationPreviewFromShipmentLine(line)}>
                                {t("inventory.location_short")}
                              </Button>
                            </div>
                          </article>
                        ))}
                      </div>
                    ) : (
                      <div className="empty-state">
                        {packingScanInput
                          ? t("inventory.message_no_shipment_line_matched", { barcode: packingScanInput })
                          : t("inventory.no_shipment_line_assigned")}
                      </div>
                    )
                  ) : (
                    <div className="table-wrap">
                      <table className="data-table">
                        <thead>
                          <tr>
                            <th>{t("inventory.code")}</th>
                            <th>{t("inventory.brand")}</th>
                            <th>{t("inventory.description_short")}</th>
                            <th>{t("inventory.rack_section")}</th>
                            <th>{t("inventory.qty_short_label")}</th>
                            <th>{t("inventory.origin_short")}</th>
                            <th>HS Code</th>
                            <th>{t("inventory.net_weight_short")}</th>
                            <th>{t("inventory.pack_to")}</th>
                            <th>{t("inventory.packed_qty")}</th>
                            <th>{t("inventory.detail")}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {visibleShipmentScanLines.map((line) => (
                            <tr
                              key={line.lineId}
                              data-shipment-line-id={line.lineId}
                              className={packingScanMatchedLineIds.includes(line.lineId) ? "inventory-scan-match" : ""}
                            >
                              <td>{line.resolvedCode || line.requestedCode || "-"}</td>
                              <td>{line.brand || "-"}</td>
                              <td>{line.description || "-"}</td>
                              <td>{formatWarehouseLocation(shipmentWarehouseLocationByLineId.get(line.lineId) || null)}</td>
                              <td>{Number(line.qty || 0).toLocaleString(appLocale)}</td>
                              <td>{line.origin || "-"}</td>
                              <td>{line.hs_code || "-"}</td>
                              <td>{line.weight_kg == null ? "-" : `${line.weight_kg} kg`}</td>
                              <td>
                                <label className="field">
                                  <select
                                    className="field__input"
                                    value={packingAssignments[line.lineId]?.packageId || ""}
                                    onChange={(event) => handlePackingAssignmentChange(line.lineId, "packageId", event.target.value)}
                                  >
                                    {packingPackageOptions.map((option) => (
                                      <option key={option.value || "unassigned"} value={option.value}>
                                        {option.label}
                                      </option>
                                    ))}
                                  </select>
                                </label>
                              </td>
                              <td>
                                <label className="field">
                                  <input
                                    className="field__input inventory-number-input"
                                    type="number"
                                    min="0"
                                    step="0.01"
                                    max={line.qty}
                                    value={packingAssignments[line.lineId]?.packedQty || ""}
                                    onChange={(event) => handlePackingAssignmentChange(line.lineId, "packedQty", event.target.value)}
                                  />
                                </label>
                              </td>
                              <td>
                                <Button className="button--compact" variant="secondary" onClick={() => openLocationPreviewFromShipmentLine(line)}>
                                  {t("inventory.location_short")}
                                </Button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </SectionCard>
                {renderLocationPreviewCard(["shipment"])}

                <SectionCard
                  title={t("inventory.package_summary")}
                  actions={
                    <div className="inline-actions">
                      <Button variant="secondary" onClick={() => handlePreviewPackageLabels()} busy={previewingPackageLabelsPdf} busyLabel={t("inventory.opening")}>
                        {t("inventory.preview_stickers")}
                      </Button>
                      <Button variant="secondary" onClick={() => handlePrintPackageLabels()} busy={printingPackageLabelsPdf} busyLabel={t("inventory.opening")}>
                        {t("inventory.print_stickers")}
                      </Button>
                      <Button variant="secondary" onClick={() => handleDownloadPackageLabelsPdf()} busy={downloadingPackageLabelsPdf} busyLabel={t("inventory.preparing")}>
                        {t("inventory.download_sticker_pdf")}
                      </Button>
                    </div>
                  }
                >
                  <div className="settings-grid" style={{ marginBottom: 16 }}>
                    <Select
                      label={t("inventory.sticker_layout")}
                      value={packageLabelLayout}
                      options={[
                        { value: "a4_single", label: t("inventory.a4_full_sheet_direct_stick") },
                        { value: "a6", label: t("inventory.a6_single_label") },
                      ]}
                      onChange={(value) => {
                        if (value === "a4_single" || value === "a6") setPackageLabelLayout(value);
                      }}
                    />
                    <Select
                      label={t("inventory.code_type")}
                      value={packageLabelCodeMode}
                      options={[
                        { value: "both", label: t("inventory.qr_plus_barcode") },
                        { value: "qr", label: t("inventory.qr_only") },
                        { value: "barcode", label: t("inventory.barcode_only") },
                      ]}
                      onChange={(value) => {
                        if (value === "both" || value === "qr" || value === "barcode") setPackageLabelCodeMode(value);
                      }}
                    />
                  </div>
                  <div className="warning-text" style={{ marginBottom: 16 }}>
                    {t("inventory.one_package_per_sheet")}
                  </div>
                  {packingPackageSummaries.length ? (
                    <div className="packing-package-grid">
                      {packingPackageSummaries.map((summary) => (
                        <div key={summary.pkg.id} className="packing-package-card">
                          <div className="packing-package-card__top">
                            <div>
                              <strong>{summary.pkg.label}</strong>
                              <div className="packing-package-card__meta">
                                {translatePackageType(summary.pkg.packageType)} · {summary.pkg.lengthCm || "-"} x {summary.pkg.widthCm || "-"} x {summary.pkg.heightCm || "-"} cm
                              </div>
                            </div>
                            <div className="inline-actions">
                              <Button className="button--compact" variant="secondary" onClick={() => handlePreviewPackageLabels([summary.pkg.label])}>
                                {t("inventory.preview")}
                              </Button>
                              <Button className="button--compact" variant="secondary" onClick={() => handlePrintPackageLabels([summary.pkg.label])}>
                                {t("inventory.print")}
                              </Button>
                              <Button className="button--compact" variant="secondary" onClick={() => handleRemovePackingPackage(summary.pkg.id)}>
                                {t("inventory.remove")}
                              </Button>
                            </div>
                          </div>
                          <div className="packing-package-card__stats">
                            <span>{t("inventory.qty_short", { count: formatLocalizedCount(summary.itemCount) })}</span>
                            <span>{t("inventory.gross_weight_short", { count: summary.grossWeightKg.toLocaleString(appLocale, { maximumFractionDigits: 2 }) })}</span>
                            <span>{summary.volumeM3.toLocaleString(appLocale, { maximumFractionDigits: 2 })} m3</span>
                          </div>
                          <div className="packing-package-card__meta">
                            {t("inventory.orientation_prefix", { orientation: translateOrientation(summary.pkg.orientation) })} {summary.pkg.notes ? `· ${summary.pkg.notes}` : ""}
                          </div>
                          {summary.assignedLines.length ? (
                            <div className="packing-package-lines">
                              {summary.assignedLines.map((item) => (
                                <span key={`${summary.pkg.id}-${item.line.lineId}`} className="packing-package-lines__item">
                                  {item.line.resolvedCode || item.line.requestedCode} x {item.packedQty}
                                </span>
                              ))}
                            </div>
                          ) : (
                            <div className="empty-state">{t("inventory.no_shipment_line_assigned")}</div>
                          )}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="empty-state">{t("inventory.create_packages_first")}</div>
                  )}
                </SectionCard>

                <SectionCard
                  title={t("inventory.loading_plan")}
                  actions={
                    <div className="inline-actions">
                      <Button variant="secondary" onClick={handlePreviewPackingPdf} busy={previewingPackingPdf} busyLabel={t("inventory.opening_pdf")}>
                        {t("inventory.preview_pdf")}
                      </Button>
                      <Button variant="secondary" onClick={handlePrintPackingPdf} busy={printingPackingPdf} busyLabel={t("inventory.opening")}>
                        {t("inventory.print")}
                      </Button>
                      <Button variant="secondary" onClick={handleDownloadPackingPdf} busy={downloadingPackingPdf} busyLabel={t("inventory.preparing")}>
                        {t("inventory.download_pdf")}
                      </Button>
                      <Button variant="secondary" onClick={handleDownloadPackingExcel} busy={downloadingPackingExcel} busyLabel={t("inventory.preparing")}>
                        {t("inventory.download_excel")}
                      </Button>
                    </div>
                  }
                >
                  <div className="settings-grid">
                    <Select
                      label={t("inventory.vehicle_container")}
                      value={packingVehicleDraft.mode}
                      options={loadingVehiclePresets.map((item) => ({ value: item.key, label: translateVehicleLabel(item.label) }))}
                      onChange={(value) => handlePackingVehicleChange("mode", value)}
                    />
                    <Input label={t("inventory.reference")} value={packingVehicleDraft.reference} onChange={(value) => handlePackingVehicleChange("reference", value)} placeholder={t("inventory.reference_placeholder")} />
                  </div>
                  <div className="customers-form-row customers-form-row--top">
                    <div className="customers-form-row__label">{t("inventory.load_notes")}</div>
                    <div className="customers-field-wrap customers-field-wrap--full">
                      <label className="field customer-field">
                        <textarea
                          className="field__input field__input--textarea"
                          value={packingVehicleDraft.notes}
                          onChange={(event) => handlePackingVehicleChange("notes", event.target.value)}
                          placeholder={t("inventory.load_notes_placeholder")}
                        />
                      </label>
                    </div>
                  </div>
                  <div className="settings-grid settings-stats-grid">
                    <div className="settings-item">
                      <span className="settings-label">{t("inventory.vehicle")}</span>
                      <strong>{translateVehicleLabel(selectedLoadingVehicle.label)}</strong>
                    </div>
                    <div className="settings-item">
                      <span className="settings-label">{t("inventory.used_volume")}</span>
                      <strong>{packedVolumeTotalM3.toLocaleString(appLocale, { maximumFractionDigits: 2 })} m3</strong>
                    </div>
                    <div className="settings-item">
                      <span className="settings-label">{t("inventory.remaining_volume")}</span>
                      <strong>{(selectedLoadingVehicle.maxVolumeM3 - packedVolumeTotalM3).toLocaleString(appLocale, { maximumFractionDigits: 2 })} m3</strong>
                    </div>
                    <div className="settings-item">
                      <span className="settings-label">{t("inventory.loaded_gross")}</span>
                      <strong>{packedGrossWeightTotalKg.toLocaleString(appLocale, { maximumFractionDigits: 2 })} kg</strong>
                    </div>
                    <div className="settings-item">
                      <span className="settings-label">{t("inventory.remaining_weight")}</span>
                      <strong>{(selectedLoadingVehicle.maxGrossWeightKg - packedGrossWeightTotalKg).toLocaleString(appLocale, { maximumFractionDigits: 2 })} kg</strong>
                    </div>
                    <div className="settings-item">
                      <span className="settings-label">{t("inventory.packages")}</span>
                      <strong>{packingPackageSummaries.length.toLocaleString(appLocale)}</strong>
                    </div>
                  </div>
                  {packedVolumeTotalM3 > selectedLoadingVehicle.maxVolumeM3 || packedGrossWeightTotalKg > selectedLoadingVehicle.maxGrossWeightKg ? (
                    <div className="warning-text">
                      {t("inventory.package_plan_exceeds")}
                    </div>
                  ) : (
                    <div className="success-text">
                      {t("inventory.package_plan_fits")}
                    </div>
                  )}
                  <div className="table-wrap">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>{t("inventory.load_seq")}</th>
                          <th>{t("inventory.package_short")}</th>
                          <th>{t("inventory.type_short")}</th>
                          <th>{t("inventory.load_orientation")}</th>
                          <th>{t("inventory.volume")}</th>
                          <th>{t("inventory.gross")}</th>
                          <th>{t("inventory.item_qty")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {sortedLoadingPackages.map((summary, index) => (
                            <tr key={`load-${summary.pkg.id}`}>
                              <td>{index + 1}</td>
                              <td>{summary.pkg.label}</td>
                              <td>{translatePackageType(summary.pkg.packageType)}</td>
                              <td>{translateOrientation(summary.pkg.orientation)}</td>
                              <td>{summary.volumeM3.toLocaleString(appLocale, { maximumFractionDigits: 2 })} m3</td>
                              <td>{summary.grossWeightKg.toLocaleString(appLocale, { maximumFractionDigits: 2 })} kg</td>
                              <td>{summary.itemCount.toLocaleString(appLocale)}</td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                </SectionCard>
              </div>
            ) : (
              <SectionCard title={t("inventory.packing_loading")}>
                <div className="empty-state">{loadingShipments ? t("inventory.loading_confirmed_shipment_queue") : t("inventory.no_confirmed_sales_order_ready")}</div>
              </SectionCard>
            )}
          </section>
        </div>
      ) : null}

      {activeTab === "Transfers" ? (
        <div className="page-stack">
          <SectionCard title={t("inventory.transfers")}>
            <div className="page-stack">
              <div className="settings-grid">
                <Select label={t("inventory.source_warehouse")} value={transferSourceId} options={stockedWarehouseOptions} onChange={setTransferSourceId} />
                <Select label={t("inventory.target_warehouse_label")} value={transferTargetId} options={stockedWarehouseOptions} onChange={setTransferTargetId} />
              </div>

              <div className="toolbar toolbar--wrap">
                <Input label={t("inventory.search_source_stock")} value={transferSearch} onChange={setTransferSearch} placeholder={t("inventory.search_source_stock_placeholder")} />
                <Button variant="secondary" onClick={handleClearTransferDraft}>
                  {t("inventory.clear_draft")}
                </Button>
                <Button onClick={() => void handlePostTransfer()} busy={postingTransfer} busyLabel={t("inventory.posting")}>
                  {t("inventory.post_transfer")}
                </Button>
              </div>

              <div className="settings-grid settings-stats-grid">
                <div className="settings-item">
                  <span className="settings-label">{t("inventory.transfer_no")}</span>
                  <strong>{transferDraft?.transfer_no || "-"}</strong>
                </div>
                <div className="settings-item">
                  <span className="settings-label">{t("inventory.draft_lines")}</span>
                  <strong>{transferDraft?.lines.length.toLocaleString(appLocale) || "0"}</strong>
                </div>
                <div className="settings-item">
                  <span className="settings-label">{t("inventory.transfer_qty")}</span>
                  <strong>{transferDraftTotals.qty.toLocaleString(appLocale)}</strong>
                </div>
              </div>

              <SectionCard title={t("inventory.source_stock")}>
                <div className="meta-row">
                  <span>{t("inventory.source_stock_rows", { count: formatLocalizedCount(filteredTransferStockRows.length) })}</span>
                  <span>{loadingTransferStock ? t("inventory.refreshing_source_stock") : t("inventory.select_source_row_to_add")}</span>
                </div>
                <DataTable
                  rows={filteredTransferStockRows}
                  columns={[
                    { key: "brand", header: t("inventory.brand"), render: (row: WarehouseStockItem) => <BrandPill brand={row.brand} compact /> },
                    { key: "code", header: t("inventory.code"), render: (row: WarehouseStockItem) => row.product_code || row.old_code || "-" },
                    { key: "description", header: t("inventory.description_short"), render: (row: WarehouseStockItem) => row.description || "-" },
                    { key: "location", header: t("inventory.rack_section"), render: (row: WarehouseStockItem) => formatWarehouseLocation(row) },
                    { key: "origin", header: t("inventory.origin_short"), render: (row: WarehouseStockItem) => row.origin || "-" },
                    { key: "qty", header: t("inventory.available_qty"), render: (row: WarehouseStockItem) => row.available_qty.toLocaleString(appLocale) },
                    {
                      key: "action",
                      header: t("inventory.action"),
                      render: (row: WarehouseStockItem) => (
                        <div className="inline-actions">
                          <Button className="button--compact" variant="secondary" onClick={() => openLocationPreviewFromStockItem(row, "transfer")}>
                            {t("inventory.location_short")}
                          </Button>
                          <Button className="button--compact" variant="secondary" onClick={() => handleAddTransferItem(row)}>
                            {t("inventory.add")}
                          </Button>
                        </div>
                      ),
                    },
                  ]}
                  emptyText={t("inventory.no_available_source_stock")}
                  onRowClick={(row: WarehouseStockItem) => openLocationPreviewFromStockItem(row, "transfer")}
                />
              </SectionCard>
              {renderLocationPreviewCard(["transfer"])}

              <SectionCard title={t("inventory.transfer_draft")}>
                {transferDraft?.lines.length ? (
                  <div className="table-wrap">
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>{t("inventory.code")}</th>
                          <th>{t("inventory.brand")}</th>
                          <th>{t("inventory.description_short")}</th>
                          <th>{t("inventory.rack_section")}</th>
                          <th>{t("inventory.available")}</th>
                          <th>{t("inventory.transfer_qty")}</th>
                          <th>{t("inventory.action")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {transferDraft.lines.map((line) => (
                          <tr key={line.key}>
                            <td>{line.product_code || line.old_code || "-"}</td>
                            <td>{line.brand || "-"}</td>
                            <td>{line.description || "-"}</td>
                            <td>{formatWarehouseLocation(line)}</td>
                            <td>{line.available_qty.toLocaleString(appLocale)}</td>
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
                            <td>
                              <Button className="button--compact" variant="secondary" onClick={() => handleRemoveTransferLine(line.key)}>
                                {t("inventory.remove")}
                              </Button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="empty-state">{t("inventory.no_transfer_lines")}</div>
                )}
              </SectionCard>

              <SectionCard title={t("inventory.transfer_posting")}>
                <div className="customers-form-row">
                  <div className="customers-form-row__label">{t("inventory.transfer_date")}</div>
                  <div className="customers-field-wrap customers-field-wrap--medium">
                    <Input
                      type="date"
                      value={transferDraft?.transfer_date || ""}
                      onChange={(value) => setTransferDraft((current) => (current ? { ...current, transfer_date: value } : current))}
                    />
                  </div>
                </div>
                <div className="customers-form-row customers-form-row--top">
                  <div className="customers-form-row__label">{t("inventory.notes")}</div>
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

              <SectionCard title={t("inventory.transfer_history")}>
                <div className="meta-row">
                  <span>{t("inventory.transfer_records", { count: formatLocalizedCount(stockTransfers.length) })}</span>
                  <span>{loadingTransfers ? t("inventory.refreshing_transfer_history") : t("inventory.posted_transfers_info")}</span>
                </div>
                <DataTable rows={stockTransfers} columns={transferHistoryColumns} emptyText={t("inventory.no_stock_transfers")} />
              </SectionCard>
            </div>
          </SectionCard>
        </div>
      ) : null}
    </div>
  );
}
