import { useEffect, useMemo, useState } from "react";
import { fetchCloudBrands } from "../../infrastructure/api/brandsApi";
import { fetchInventoryMovements, fetchPurchaseReceives, fetchWarehouseStockItems } from "../../infrastructure/api/inventoryApi";
import { fetchSalesOrders, fetchPurchaseOrders, fetchInvoices } from "../../infrastructure/api/ordersApi";
import { fetchWarehouses } from "../../infrastructure/api/warehousesApi";
import { buildEntityAlias } from "../../shared/entityAlias";
import { buildXlsxBlob, downloadBlob } from "../../shared/xlsx";
import { includesLooseText, normalizePartCode } from "../../domain/shared/normalize";
import type { InventoryMovement, PurchaseReceive, WarehouseStockItem } from "../../types/inventory";
import type { LocalInvoice, LocalPurchaseOrder, LocalSalesOrder } from "../../types/orders";
import type { Warehouse } from "../../types/warehouses";
import { useActionFeedback } from "../components/common/ActionFeedback";
import { Button } from "../components/common/Button";
import { DataTable } from "../components/common/DataTable";
import { Input } from "../components/common/Input";
import { SectionCard } from "../components/common/SectionCard";
import { Select } from "../components/common/Select";
import { BrandPill } from "../components/common/BrandPill";
import { useI18n } from "../../i18n/I18nProvider";

type AnalyticsTab = "Turnover" | "Aging" | "Forecast" | "Pending Procurement" | "Vendor Balance" | "Customer Balance";

type TurnoverRow = {
  brand: string;
  product_code: string;
  description: string;
  on_hand_qty: number;
  stock_value: number;
  sold_qty: number;
  sold_amount: number;
  turnover_ratio: number;
  days_cover: number | null;
};

type AgingRow = {
  warehouse_id: string;
  warehouse_name: string;
  brand: string;
  product_code: string;
  description: string;
  on_hand_qty: number;
  stock_value: number;
  last_moved_at: string;
  days_idle: number;
  age_bucket: string;
};

type ForecastRow = {
  brand: string;
  product_code: string;
  description: string;
  on_hand_qty: number;
  monthly_demand_qty: number;
  months_cover: number | null;
  recommended_qty: number;
  reorder_qty: number;
  status: "Reorder" | "Balanced" | "Overstock" | "No Demand";
};

type PendingProcurementRow = {
  sales_order_id: string;
  sales_order_no: string;
  customer_name: string;
  order_date: string;
  source_channel: string;
  brand: string;
  product_code: string;
  description: string;
  qty_ordered: number;
  qty_purchased: number;
  qty_pending: number;
  status: string;
};

type VendorBalanceRow = {
  purchase_order_id: string;
  purchase_order_no: string;
  supplier_name: string;
  sales_order_id: string;
  sales_order_no: string;
  customer_name: string;
  order_date: string;
  brand: string;
  product_code: string;
  description: string;
  qty_ordered: number;
  qty_received: number;
  qty_remaining: number;
  amount_remaining: number;
  status: string;
};

type CustomerBalanceRow = {
  sales_order_id: string;
  sales_order_no: string;
  customer_name: string;
  order_date: string;
  source_channel: string;
  brand: string;
  product_code: string;
  description: string;
  qty_ordered: number;
  qty_invoiced: number;
  qty_remaining: number;
  amount_remaining: number;
  status: string;
};

type AnalyticsFilters = {
  brand: string;
  warehouseId: string;
  codeSearch: string;
  dateFrom: string;
  dateTo: string;
  forecastMonths: string;
};

type InventoryAnalyticsPageProps = {
  onOpenSalesOrder?: (salesOrderId: string) => void;
  onOpenInventoryWarehouse?: (warehouseId: string) => void;
  onOpenInventoryItem?: (codeSearch: string, warehouseId?: string) => void;
};

function toNumber(value: unknown) {
  return Number(value ?? 0) || 0;
}

function round(value: number) {
  return Math.round(value * 100) / 100;
}

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

function normalizeKey(brand: string, code: string) {
  return `${brand.trim().toLowerCase()}::${normalizePartCode(code)}`;
}

function dayDiff(fromIso: string, toIso: string) {
  const from = new Date(fromIso);
  const to = new Date(toIso);
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / 86400000));
}

function bucketizeAging(daysIdle: number) {
  if (daysIdle <= 30) return "0-30";
  if (daysIdle <= 60) return "31-60";
  if (daysIdle <= 90) return "61-90";
  if (daysIdle <= 180) return "91-180";
  return "180+";
}

function invoiceDemandRows(invoices: LocalInvoice[]) {
  return invoices.flatMap((invoice) =>
    invoice.lines.map((line) => ({
      date: invoice.quote_date || invoice.updated_at.slice(0, 10),
      brand: line.brand || "",
      product_code: line.product_code || line.old_code || "",
      description: line.description || "",
      qty: toNumber(line.qty),
      amount: round(toNumber(line.sales_total)),
    })),
  );
}

function buildPurchaseCoverageMap(purchaseOrders: LocalPurchaseOrder[]) {
  const coverage = new Map<string, number>();
  purchaseOrders.forEach((purchaseOrder) => {
    purchaseOrder.lines.forEach((line) => {
      const key = `${purchaseOrder.sales_order_id}::${normalizeKey(line.brand || "", line.product_code || line.old_code || "")}`;
      coverage.set(key, round((coverage.get(key) || 0) + toNumber(line.qty)));
    });
  });
  return coverage;
}

function buildPurchaseReceiveCoverageMap(purchaseReceives: PurchaseReceive[]) {
  const coverage = new Map<string, number>();
  purchaseReceives
    .filter((receive) => receive.status === "posted")
    .forEach((receive) => {
      receive.lines.forEach((line) => {
        const key = `${receive.purchase_order_id}::${normalizeKey(line.brand || "", line.product_code || line.old_code || "")}`;
        coverage.set(key, round((coverage.get(key) || 0) + toNumber(line.qty_received)));
      });
    });
  return coverage;
}

function buildInvoiceCoverageMap(invoices: LocalInvoice[]) {
  const coverage = new Map<string, number>();
  invoices
    .filter((invoice) => ["confirmed", "open", "paid"].includes(String(invoice.status || "").toLowerCase()))
    .forEach((invoice) => {
      invoice.lines.forEach((line) => {
        const salesOrderId = line.sales_order_id || invoice.sales_order_id || invoice.sales_order_ids?.[0] || "";
        if (!salesOrderId) return;
        const key = `${salesOrderId}::${normalizeKey(line.brand || "", line.product_code || line.old_code || "")}`;
        coverage.set(key, round((coverage.get(key) || 0) + toNumber(line.qty)));
      });
    });
  return coverage;
}

export function InventoryAnalyticsPage({ onOpenSalesOrder, onOpenInventoryWarehouse, onOpenInventoryItem }: InventoryAnalyticsPageProps) {
  const { t } = useI18n();
  const r = (key: string, params?: Record<string, string | number>) => t(`reports.${key}`, params);
  const actionFeedback = useActionFeedback();
  const [activeTab, setActiveTab] = useState<AnalyticsTab>("Turnover");
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [brands, setBrands] = useState<Array<{ value: string; label: string }>>([]);
  const [warehouses, setWarehouses] = useState<Array<{ value: string; label: string }>>([]);
  const [filters, setFilters] = useState<AnalyticsFilters>({
    brand: "",
    warehouseId: "",
    codeSearch: "",
    dateFrom: "",
    dateTo: "",
    forecastMonths: "2",
  });
  const [stockItems, setStockItems] = useState<WarehouseStockItem[]>([]);
  const [movements, setMovements] = useState<InventoryMovement[]>([]);
  const [purchaseReceives, setPurchaseReceives] = useState<PurchaseReceive[]>([]);
  const [salesOrders, setSalesOrders] = useState<LocalSalesOrder[]>([]);
  const [purchaseOrders, setPurchaseOrders] = useState<LocalPurchaseOrder[]>([]);
  const [invoices, setInvoices] = useState<LocalInvoice[]>([]);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      try {
        const [brandRows, warehouseRows] = await Promise.all([fetchCloudBrands(), fetchWarehouses()]);
        if (cancelled) return;
        setBrands([{ value: "", label: r("filters.allBrands") }, ...brandRows.map((row) => ({ value: row.name, label: row.name }))]);
        setWarehouses([{ value: "", label: r("inventoryAnalytics.filters.allWarehouses") }, ...warehouseRows.map((row: Warehouse) => ({ value: row.id, label: `${row.warehouse_code} · ${row.warehouse_name}` }))]);
      } catch (caught) {
        if (!cancelled) actionFeedback.fail(caught instanceof Error ? caught.message : r("inventoryAnalytics.errors.filtersLoadFailed"));
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [actionFeedback, t]);

  async function handleLoad() {
    const canLoadWithoutScope = activeTab === "Vendor Balance" || activeTab === "Customer Balance" || activeTab === "Pending Procurement";
    if (!canLoadWithoutScope && !filters.brand && !filters.warehouseId && !filters.codeSearch.trim()) {
      actionFeedback.fail(r("inventoryAnalytics.errors.scopeRequired"));
      return;
    }

    try {
      setLoading(true);
      setLoaded(true);
      actionFeedback.begin(r("inventoryAnalytics.feedback.loading"));
      const [stockRows, movementRows, receiveRows, salesOrderRows, purchaseOrderRows, invoiceRows] = await Promise.all([
        fetchWarehouseStockItems(filters.warehouseId || undefined),
        fetchInventoryMovements(filters.warehouseId || undefined),
        fetchPurchaseReceives(),
        fetchSalesOrders(),
        fetchPurchaseOrders(),
        fetchInvoices(),
      ]);
      setStockItems(stockRows);
      setMovements(movementRows);
      setPurchaseReceives(receiveRows);
      setSalesOrders(salesOrderRows);
      setPurchaseOrders(purchaseOrderRows);
      setInvoices(invoiceRows);
      actionFeedback.succeed(r("inventoryAnalytics.feedback.loaded"));
    } catch (caught) {
      setStockItems([]);
      setMovements([]);
      setPurchaseReceives([]);
      setSalesOrders([]);
      setPurchaseOrders([]);
      setInvoices([]);
      actionFeedback.fail(caught instanceof Error ? caught.message : r("inventoryAnalytics.errors.loadFailed"));
    } finally {
      setLoading(false);
    }
  }

  const periodDays = useMemo(() => {
    if (filters.dateFrom && filters.dateTo) return Math.max(1, dayDiff(filters.dateFrom, filters.dateTo) + 1);
    return 90;
  }, [filters.dateFrom, filters.dateTo]);

  const filteredStockItems = useMemo(() => {
    const needle = filters.codeSearch.trim().toLowerCase();
    return stockItems.filter((row) => {
      if (filters.brand && row.brand.trim().toLowerCase() !== filters.brand.trim().toLowerCase()) return false;
      if (filters.warehouseId && row.warehouse_id !== filters.warehouseId) return false;
      if (needle) {
        if (!includesLooseText(`${row.product_code} ${row.old_code} ${row.description}`, needle)) return false;
      }
      return true;
    });
  }, [stockItems, filters.brand, filters.warehouseId, filters.codeSearch]);

  const filteredInvoiceDemand = useMemo(() => {
    const needle = filters.codeSearch.trim().toLowerCase();
    return invoiceDemandRows(invoices).filter((row) => {
      if (filters.brand && row.brand.trim().toLowerCase() !== filters.brand.trim().toLowerCase()) return false;
      if (filters.dateFrom && row.date && row.date < filters.dateFrom) return false;
      if (filters.dateTo && row.date && row.date > filters.dateTo) return false;
      if (needle) {
        if (!includesLooseText(`${row.product_code} ${row.description}`, needle)) return false;
      }
      return true;
    });
  }, [invoices, filters.brand, filters.dateFrom, filters.dateTo, filters.codeSearch]);

  const filteredMovementRows = useMemo(() => {
    const needle = filters.codeSearch.trim().toLowerCase();
    return movements.filter((row) => {
      if (filters.brand && row.brand.trim().toLowerCase() !== filters.brand.trim().toLowerCase()) return false;
      if (filters.warehouseId && row.warehouse_id !== filters.warehouseId) return false;
      if (filters.dateFrom && row.moved_at && row.moved_at.slice(0, 10) < filters.dateFrom) return false;
      if (filters.dateTo && row.moved_at && row.moved_at.slice(0, 10) > filters.dateTo) return false;
      if (needle) {
        if (!includesLooseText(`${row.product_code} ${row.old_code} ${row.description} ${row.document_no}`, needle)) return false;
      }
      return true;
    });
  }, [movements, filters.brand, filters.warehouseId, filters.dateFrom, filters.dateTo, filters.codeSearch]);

  const analyticsPulse = useMemo(() => {
    const receiveDocumentIds = new Set<string>();
    const transferDocumentIds = new Set<string>();
    let receiveValue = 0;
    let transferValue = 0;

    filteredMovementRows.forEach((row) => {
      if (row.movement_type === "purchase_receive") {
        if (row.document_id) receiveDocumentIds.add(row.document_id);
        receiveValue += toNumber(row.total_cost);
      }
      if (row.movement_type === "transfer_out") {
        if (row.document_id) transferDocumentIds.add(row.document_id);
        transferValue += toNumber(row.total_cost);
      }
    });

    return {
      receiveCount: receiveDocumentIds.size,
      receiveValue: round(receiveValue),
      transferCount: transferDocumentIds.size,
      transferValue: round(transferValue),
    };
  }, [filteredMovementRows]);

  const turnoverRows = useMemo<TurnoverRow[]>(() => {
    const stockMap = new Map<string, TurnoverRow>();
    filteredStockItems.forEach((item) => {
      const key = normalizeKey(item.brand, item.product_code || item.old_code);
      const current = stockMap.get(key) || {
        brand: item.brand,
        product_code: item.product_code || item.old_code,
        description: item.description,
        on_hand_qty: 0,
        stock_value: 0,
        sold_qty: 0,
        sold_amount: 0,
        turnover_ratio: 0,
        days_cover: null,
      };
      current.on_hand_qty += toNumber(item.on_hand_qty);
      current.stock_value += toNumber(item.stock_value);
      if (!current.description && item.description) current.description = item.description;
      stockMap.set(key, current);
    });

    filteredInvoiceDemand.forEach((row) => {
      const key = normalizeKey(row.brand, row.product_code);
      const current = stockMap.get(key) || {
        brand: row.brand,
        product_code: row.product_code,
        description: row.description,
        on_hand_qty: 0,
        stock_value: 0,
        sold_qty: 0,
        sold_amount: 0,
        turnover_ratio: 0,
        days_cover: null,
      };
      current.sold_qty += toNumber(row.qty);
      current.sold_amount += toNumber(row.amount);
      if (!current.description && row.description) current.description = row.description;
      stockMap.set(key, current);
    });

    return Array.from(stockMap.values())
      .map((row) => {
        const avgInventoryQty = row.on_hand_qty + row.sold_qty / 2;
        const dailyDemand = periodDays > 0 ? row.sold_qty / periodDays : 0;
        return {
          ...row,
          stock_value: round(row.stock_value),
          sold_amount: round(row.sold_amount),
          turnover_ratio: avgInventoryQty > 0 ? round(row.sold_qty / avgInventoryQty) : 0,
          days_cover: dailyDemand > 0 ? round(row.on_hand_qty / dailyDemand) : null,
        };
      })
      .sort((a, b) => b.sold_amount - a.sold_amount || a.brand.localeCompare(b.brand) || a.product_code.localeCompare(b.product_code));
  }, [filteredInvoiceDemand, filteredStockItems, periodDays]);

  const agingRows = useMemo<AgingRow[]>(() => {
    const todayIso = new Date().toISOString();
    return filteredStockItems
      .map((item) => {
        const daysIdle = item.last_moved_at ? dayDiff(item.last_moved_at, todayIso) : 9999;
        return {
          warehouse_id: item.warehouse_id,
          warehouse_name: item.warehouse_name || item.warehouse_code,
          brand: item.brand,
          product_code: item.product_code || item.old_code,
          description: item.description,
          on_hand_qty: round(toNumber(item.on_hand_qty)),
          stock_value: round(toNumber(item.stock_value)),
          last_moved_at: item.last_moved_at,
          days_idle: daysIdle,
          age_bucket: bucketizeAging(daysIdle),
        };
      })
      .sort((a, b) => b.days_idle - a.days_idle || b.stock_value - a.stock_value);
  }, [filteredStockItems]);

  const forecastRows = useMemo<ForecastRow[]>(() => {
    const targetMonths = Math.max(1, parseNumberInputSafe(filters.forecastMonths));
    const demandMap = new Map<string, { qty: number; description: string; brand: string; product_code: string }>();
    filteredInvoiceDemand.forEach((row) => {
      const key = normalizeKey(row.brand, row.product_code);
      const current = demandMap.get(key) || { qty: 0, description: row.description, brand: row.brand, product_code: row.product_code };
      current.qty += toNumber(row.qty);
      if (!current.description && row.description) current.description = row.description;
      demandMap.set(key, current);
    });

    const stockMap = new Map<string, { qty: number; description: string; brand: string; product_code: string }>();
    filteredStockItems.forEach((item) => {
      const key = normalizeKey(item.brand, item.product_code || item.old_code);
      const current = stockMap.get(key) || {
        qty: 0,
        description: item.description,
        brand: item.brand,
        product_code: item.product_code || item.old_code,
      };
      current.qty += toNumber(item.on_hand_qty);
      if (!current.description && item.description) current.description = item.description;
      stockMap.set(key, current);
    });

    const allKeys = new Set([...stockMap.keys(), ...demandMap.keys()]);
    return Array.from(allKeys)
      .map((key) => {
        const stock = stockMap.get(key);
        const demand = demandMap.get(key);
        const onHandQty = round(stock?.qty || 0);
        const soldQty = round(demand?.qty || 0);
        const monthlyDemandQty = round(periodDays > 0 ? (soldQty / periodDays) * 30 : 0);
        const monthsCover = monthlyDemandQty > 0 ? round(onHandQty / monthlyDemandQty) : null;
        const recommendedQty = round(monthlyDemandQty * targetMonths);
        const reorderQty = Math.max(0, round(recommendedQty - onHandQty));
        let status: ForecastRow["status"] = "Balanced";
        if (monthlyDemandQty <= 0) status = "No Demand";
        else if (reorderQty > 0) status = "Reorder";
        else if (monthsCover !== null && monthsCover > targetMonths * 1.75) status = "Overstock";
        return {
          brand: stock?.brand || demand?.brand || "",
          product_code: stock?.product_code || demand?.product_code || "",
          description: stock?.description || demand?.description || "",
          on_hand_qty: onHandQty,
          monthly_demand_qty: monthlyDemandQty,
          months_cover: monthsCover,
          recommended_qty: recommendedQty,
          reorder_qty: reorderQty,
          status,
        };
      })
      .filter((row) => row.product_code)
      .sort((a, b) => {
        const rank = { Reorder: 0, Overstock: 1, Balanced: 2, "No Demand": 3 } as const;
        return rank[a.status] - rank[b.status] || b.reorder_qty - a.reorder_qty || a.brand.localeCompare(b.brand) || a.product_code.localeCompare(b.product_code);
      });
  }, [filteredInvoiceDemand, filteredStockItems, filters.forecastMonths, periodDays]);

  const pendingProcurementRows = useMemo<PendingProcurementRow[]>(() => {
    const purchaseCoverage = buildPurchaseCoverageMap(purchaseOrders);
    const needle = filters.codeSearch.trim().toLowerCase();
    return salesOrders
      .filter((order) => order.status === "confirmed")
      .flatMap((order) =>
        order.lines.map((line) => {
          const code = line.resolvedCode || line.requestedCode || "";
          const key = `${order.id}::${normalizeKey(line.brand || "", code)}`;
          const purchasedQty = round(purchaseCoverage.get(key) || 0);
          const orderedQty = round(toNumber(line.qty));
          const pendingQty = Math.max(0, round(orderedQty - purchasedQty));
          return {
            sales_order_id: order.id,
            sales_order_no: order.sales_order_no,
            customer_name: order.customer_name,
            order_date: order.quote_date || order.updated_at.slice(0, 10),
            source_channel: order.source_channel || "internal",
            brand: line.brand || "",
            product_code: code,
            description: line.description || "",
            qty_ordered: orderedQty,
            qty_purchased: purchasedQty,
            qty_pending: pendingQty,
            status: order.status,
          };
        }),
      )
      .filter((row) => {
        if (row.qty_pending <= 0) return false;
        if (filters.brand && row.brand.trim().toLowerCase() !== filters.brand.trim().toLowerCase()) return false;
        if (filters.dateFrom && row.order_date && row.order_date < filters.dateFrom) return false;
        if (filters.dateTo && row.order_date && row.order_date > filters.dateTo) return false;
        if (needle) {
          if (!includesLooseText(`${row.sales_order_no} ${row.customer_name} ${row.product_code} ${row.description}`, needle)) return false;
        }
        return true;
      })
      .sort((a, b) => a.order_date.localeCompare(b.order_date) || a.sales_order_no.localeCompare(b.sales_order_no));
  }, [filters.brand, filters.codeSearch, filters.dateFrom, filters.dateTo, purchaseOrders, salesOrders]);

  const vendorBalanceRows = useMemo<VendorBalanceRow[]>(() => {
    const receiveCoverage = buildPurchaseReceiveCoverageMap(purchaseReceives);
    const needle = filters.codeSearch.trim().toLowerCase();
    return purchaseOrders
      .flatMap((purchaseOrder) =>
        purchaseOrder.lines.map((line) => {
          const productCode = line.product_code || line.old_code || "";
          const key = `${purchaseOrder.id}::${normalizeKey(line.brand || "", productCode)}`;
          const orderedQty = round(toNumber(line.qty));
          const receivedQty = round(receiveCoverage.get(key) || 0);
          const remainingQty = Math.max(0, round(orderedQty - receivedQty));
          return {
            purchase_order_id: purchaseOrder.id,
            purchase_order_no: purchaseOrder.id,
            supplier_name: purchaseOrder.supplier_name,
            sales_order_id: line.sales_order_id || purchaseOrder.sales_order_id,
            sales_order_no: line.sales_order_no || purchaseOrder.sales_order_no,
            customer_name: purchaseOrder.customer_name,
            order_date: String(purchaseOrder.created_at || "").slice(0, 10),
            brand: line.brand || "",
            product_code: productCode,
            description: line.description || "",
            qty_ordered: orderedQty,
            qty_received: receivedQty,
            qty_remaining: remainingQty,
            amount_remaining: round(remainingQty * toNumber(line.buy_price)),
            status: purchaseOrder.status,
          };
        }),
      )
      .filter((row) => {
        if (row.qty_remaining <= 0) return false;
        if (filters.brand && row.brand.trim().toLowerCase() !== filters.brand.trim().toLowerCase()) return false;
        if (filters.dateFrom && row.order_date && row.order_date < filters.dateFrom) return false;
        if (filters.dateTo && row.order_date && row.order_date > filters.dateTo) return false;
        if (needle) {
          if (!includesLooseText(`${row.purchase_order_no} ${row.supplier_name} ${row.sales_order_no} ${row.customer_name} ${row.product_code} ${row.description}`, needle)) return false;
        }
        return true;
      })
      .sort((a, b) => a.supplier_name.localeCompare(b.supplier_name) || a.sales_order_no.localeCompare(b.sales_order_no) || a.product_code.localeCompare(b.product_code));
  }, [filters.brand, filters.codeSearch, filters.dateFrom, filters.dateTo, purchaseOrders, purchaseReceives]);

  const customerBalanceRows = useMemo<CustomerBalanceRow[]>(() => {
    const invoiceCoverage = buildInvoiceCoverageMap(invoices);
    const needle = filters.codeSearch.trim().toLowerCase();
    return salesOrders
      .filter((order) => order.status === "confirmed")
      .flatMap((order) =>
        order.lines.map((line) => {
          const productCode = line.resolvedCode || line.requestedCode || "";
          const key = `${order.id}::${normalizeKey(line.brand || "", productCode)}`;
          const orderedQty = round(toNumber(line.qty));
          const invoicedQty = round(invoiceCoverage.get(key) || 0);
          const remainingQty = Math.max(0, round(orderedQty - invoicedQty));
          return {
            sales_order_id: order.id,
            sales_order_no: order.sales_order_no,
            customer_name: order.customer_name,
            order_date: order.quote_date || String(order.updated_at || "").slice(0, 10),
            source_channel: order.source_channel || "internal",
            brand: line.brand || "",
            product_code: productCode,
            description: line.description || "",
            qty_ordered: orderedQty,
            qty_invoiced: invoicedQty,
            qty_remaining: remainingQty,
            amount_remaining: round(remainingQty * toNumber(line.sell_price)),
            status: order.status,
          };
        }),
      )
      .filter((row) => {
        if (row.qty_remaining <= 0) return false;
        if (filters.brand && row.brand.trim().toLowerCase() !== filters.brand.trim().toLowerCase()) return false;
        if (filters.dateFrom && row.order_date && row.order_date < filters.dateFrom) return false;
        if (filters.dateTo && row.order_date && row.order_date > filters.dateTo) return false;
        if (needle) {
          if (!includesLooseText(`${row.sales_order_no} ${row.customer_name} ${row.product_code} ${row.description}`, needle)) return false;
        }
        return true;
      })
      .sort((a, b) => a.customer_name.localeCompare(b.customer_name) || a.sales_order_no.localeCompare(b.sales_order_no) || a.product_code.localeCompare(b.product_code));
  }, [filters.brand, filters.codeSearch, filters.dateFrom, filters.dateTo, invoices, salesOrders]);

  const defaultBrandOptions = useMemo(() => [{ value: "", label: r("filters.allBrands") }], [t]);
  const defaultWarehouseOptions = useMemo(() => [{ value: "", label: r("inventoryAnalytics.filters.allWarehouses") }], [t]);

  function analyticsTabLabel(tab: AnalyticsTab) {
    const key = tab.replace(/\s+/g, "").replace(/^./, (char) => char.toLowerCase());
    return r(`inventoryAnalytics.tabs.${key}`);
  }

  function forecastStatusLabel(status: ForecastRow["status"]) {
    const key = status.replace(/\s+/g, "").replace(/^./, (char) => char.toLowerCase());
    return r(`inventoryAnalytics.forecastStatus.${key}`);
  }

  const turnoverColumns = useMemo(
    () => [
      { key: "brand", header: r("columns.brand"), render: (row: TurnoverRow) => <BrandPill brand={row.brand} compact /> },
      { key: "code", header: r("columns.code"), render: (row: TurnoverRow) => row.product_code || "-" },
      { key: "description", header: r("columns.description"), render: (row: TurnoverRow) => row.description || "-" },
      { key: "stock", header: r("columns.onHand"), render: (row: TurnoverRow) => row.on_hand_qty.toLocaleString("en-US") },
      { key: "value", header: r("columns.stockValue"), render: (row: TurnoverRow) => formatMoney(row.stock_value) },
      { key: "soldqty", header: r("columns.soldQty"), render: (row: TurnoverRow) => row.sold_qty.toLocaleString("en-US") },
      { key: "soldamount", header: r("columns.soldAmount"), render: (row: TurnoverRow) => formatMoney(row.sold_amount) },
      { key: "turnover", header: r("columns.turnoverX"), render: (row: TurnoverRow) => row.turnover_ratio.toFixed(2) },
      { key: "cover", header: r("columns.daysCover"), render: (row: TurnoverRow) => (row.days_cover === null ? "-" : row.days_cover.toFixed(1)) },
      {
        key: "action",
        header: r("columns.action"),
        render: (row: TurnoverRow) => (
          <Button className="button--compact" variant="secondary" onClick={() => onOpenInventoryItem?.(row.product_code, filters.warehouseId || undefined)}>
            {r("actions.openStock")}
          </Button>
        ),
      },
    ],
    [filters.warehouseId, onOpenInventoryItem, t],
  );

  const agingColumns = useMemo(
    () => [
      { key: "warehouse", header: r("columns.warehouse"), render: (row: AgingRow) => row.warehouse_name || "-" },
      { key: "brand", header: r("columns.brand"), render: (row: AgingRow) => <BrandPill brand={row.brand} compact /> },
      { key: "code", header: r("columns.code"), render: (row: AgingRow) => row.product_code || "-" },
      { key: "description", header: r("columns.description"), render: (row: AgingRow) => row.description || "-" },
      { key: "stock", header: r("columns.onHand"), render: (row: AgingRow) => row.on_hand_qty.toLocaleString("en-US") },
      { key: "value", header: r("columns.stockValue"), render: (row: AgingRow) => formatMoney(row.stock_value) },
      { key: "days", header: r("columns.daysIdle"), render: (row: AgingRow) => row.days_idle.toLocaleString("en-US") },
      { key: "bucket", header: r("columns.bucket"), render: (row: AgingRow) => row.age_bucket },
      { key: "last", header: r("columns.lastMove"), render: (row: AgingRow) => formatDate(row.last_moved_at) },
      {
        key: "action",
        header: r("columns.action"),
        render: (row: AgingRow) => (
          <Button className="button--compact" variant="secondary" onClick={() => onOpenInventoryWarehouse?.(row.warehouse_id)}>
            {r("actions.openWarehouse")}
          </Button>
        ),
      },
    ],
    [onOpenInventoryWarehouse, t],
  );

  const forecastColumns = useMemo(
    () => [
      { key: "brand", header: r("columns.brand"), render: (row: ForecastRow) => <BrandPill brand={row.brand} compact /> },
      { key: "code", header: r("columns.code"), render: (row: ForecastRow) => row.product_code || "-" },
      { key: "description", header: r("columns.description"), render: (row: ForecastRow) => row.description || "-" },
      { key: "stock", header: r("columns.onHand"), render: (row: ForecastRow) => row.on_hand_qty.toLocaleString("en-US") },
      { key: "monthly", header: r("columns.monthlyDemand"), render: (row: ForecastRow) => row.monthly_demand_qty.toLocaleString("en-US") },
      { key: "cover", header: r("columns.monthsCover"), render: (row: ForecastRow) => (row.months_cover === null ? "-" : row.months_cover.toFixed(2)) },
      { key: "recommended", header: r("columns.recommended"), render: (row: ForecastRow) => row.recommended_qty.toLocaleString("en-US") },
      { key: "reorder", header: r("columns.reorderQty"), render: (row: ForecastRow) => row.reorder_qty.toLocaleString("en-US") },
      {
        key: "status",
        header: r("columns.status"),
        render: (row: ForecastRow) => (
          <span
            className={`mark-badge ${
              row.status === "Reorder"
                ? "mark-badge--accent"
                : row.status === "Overstock"
                  ? "mark-badge--info"
                  : row.status === "Balanced"
                    ? "mark-badge--success"
                    : ""
            }`}
          >
            {forecastStatusLabel(row.status)}
          </span>
        ),
      },
      {
        key: "action",
        header: r("columns.action"),
        render: (row: ForecastRow) => (
          <Button className="button--compact" variant="secondary" onClick={() => onOpenInventoryItem?.(row.product_code, filters.warehouseId || undefined)}>
            {r("actions.openStock")}
          </Button>
        ),
      },
    ],
    [filters.warehouseId, onOpenInventoryItem, t],
  );

  const pendingColumns = useMemo(
    () => [
      { key: "order", header: r("columns.salesOrder"), render: (row: PendingProcurementRow) => row.sales_order_no || "-" },
      {
        key: "customer",
        header: r("columns.customer"),
        render: (row: PendingProcurementRow) => <span title={row.customer_name || "-"}>{buildEntityAlias(row.customer_name)}</span>,
      },
      { key: "date", header: r("columns.date"), render: (row: PendingProcurementRow) => row.order_date || "-" },
      { key: "source", header: r("columns.source"), render: (row: PendingProcurementRow) => row.source_channel || "-" },
      { key: "brand", header: r("columns.brand"), render: (row: PendingProcurementRow) => <BrandPill brand={row.brand} compact /> },
      { key: "code", header: r("columns.code"), render: (row: PendingProcurementRow) => row.product_code || "-" },
      { key: "description", header: r("columns.description"), render: (row: PendingProcurementRow) => row.description || "-" },
      { key: "ordered", header: r("columns.ordered"), render: (row: PendingProcurementRow) => row.qty_ordered.toLocaleString("en-US") },
      { key: "purchased", header: r("columns.purchased"), render: (row: PendingProcurementRow) => row.qty_purchased.toLocaleString("en-US") },
      { key: "pending", header: r("columns.pending"), render: (row: PendingProcurementRow) => row.qty_pending.toLocaleString("en-US") },
      {
        key: "action",
        header: r("columns.action"),
        render: (row: PendingProcurementRow) => (
          <Button className="button--compact" variant="secondary" onClick={() => onOpenSalesOrder?.(row.sales_order_id)}>
            {r("actions.openSalesOrder")}
          </Button>
        ),
      },
    ],
    [onOpenSalesOrder, t],
  );

  const vendorBalanceColumns = useMemo(
    () => [
      {
        key: "supplier",
        header: r("columns.vendor"),
        render: (row: VendorBalanceRow) => <span title={row.supplier_name || "-"}>{buildEntityAlias(row.supplier_name)}</span>,
      },
      { key: "po", header: r("columns.purchaseOrder"), render: (row: VendorBalanceRow) => row.purchase_order_no || "-" },
      { key: "salesorder", header: r("columns.salesOrder"), render: (row: VendorBalanceRow) => row.sales_order_no || "-" },
      {
        key: "customer",
        header: r("columns.customer"),
        render: (row: VendorBalanceRow) => <span title={row.customer_name || "-"}>{buildEntityAlias(row.customer_name)}</span>,
      },
      { key: "date", header: r("columns.poDate"), render: (row: VendorBalanceRow) => row.order_date || "-" },
      { key: "brand", header: r("columns.brand"), render: (row: VendorBalanceRow) => <BrandPill brand={row.brand} compact /> },
      { key: "code", header: r("columns.code"), render: (row: VendorBalanceRow) => row.product_code || "-" },
      { key: "description", header: r("columns.description"), render: (row: VendorBalanceRow) => row.description || "-" },
      { key: "ordered", header: r("columns.ordered"), render: (row: VendorBalanceRow) => row.qty_ordered.toLocaleString("en-US") },
      { key: "received", header: r("columns.received"), render: (row: VendorBalanceRow) => row.qty_received.toLocaleString("en-US") },
      { key: "remaining", header: r("columns.vendorBalance"), render: (row: VendorBalanceRow) => row.qty_remaining.toLocaleString("en-US") },
      { key: "amount", header: r("columns.openCost"), render: (row: VendorBalanceRow) => formatMoney(row.amount_remaining) },
      {
        key: "action",
        header: r("columns.action"),
        render: (row: VendorBalanceRow) => (
          <Button className="button--compact" variant="secondary" onClick={() => onOpenSalesOrder?.(row.sales_order_id)}>
            {r("actions.openSalesOrder")}
          </Button>
        ),
      },
    ],
    [onOpenSalesOrder, t],
  );

  const customerBalanceColumns = useMemo(
    () => [
      { key: "order", header: r("columns.salesOrder"), render: (row: CustomerBalanceRow) => row.sales_order_no || "-" },
      {
        key: "customer",
        header: r("columns.customer"),
        render: (row: CustomerBalanceRow) => <span title={row.customer_name || "-"}>{buildEntityAlias(row.customer_name)}</span>,
      },
      { key: "date", header: r("columns.soDate"), render: (row: CustomerBalanceRow) => row.order_date || "-" },
      { key: "source", header: r("columns.source"), render: (row: CustomerBalanceRow) => row.source_channel || "-" },
      { key: "brand", header: r("columns.brand"), render: (row: CustomerBalanceRow) => <BrandPill brand={row.brand} compact /> },
      { key: "code", header: r("columns.code"), render: (row: CustomerBalanceRow) => row.product_code || "-" },
      { key: "description", header: r("columns.description"), render: (row: CustomerBalanceRow) => row.description || "-" },
      { key: "ordered", header: r("columns.ordered"), render: (row: CustomerBalanceRow) => row.qty_ordered.toLocaleString("en-US") },
      { key: "invoiced", header: r("columns.invoiced"), render: (row: CustomerBalanceRow) => row.qty_invoiced.toLocaleString("en-US") },
      { key: "remaining", header: r("columns.customerBalance"), render: (row: CustomerBalanceRow) => row.qty_remaining.toLocaleString("en-US") },
      { key: "amount", header: r("columns.openSales"), render: (row: CustomerBalanceRow) => formatMoney(row.amount_remaining) },
      {
        key: "action",
        header: r("columns.action"),
        render: (row: CustomerBalanceRow) => (
          <Button className="button--compact" variant="secondary" onClick={() => onOpenSalesOrder?.(row.sales_order_id)}>
            {r("actions.openSalesOrder")}
          </Button>
        ),
      },
    ],
    [onOpenSalesOrder, t],
  );

  const activeRows = useMemo(() => {
    if (activeTab === "Turnover") return turnoverRows;
    if (activeTab === "Aging") return agingRows;
    if (activeTab === "Forecast") return forecastRows;
    if (activeTab === "Pending Procurement") return pendingProcurementRows;
    if (activeTab === "Vendor Balance") return vendorBalanceRows;
    return customerBalanceRows;
  }, [activeTab, turnoverRows, agingRows, forecastRows, pendingProcurementRows, vendorBalanceRows, customerBalanceRows]);

  async function handleExport() {
    const stamp = new Date().toISOString().slice(0, 10).replaceAll("-", "");
    try {
      setExporting(true);
      actionFeedback.begin(r("inventoryAnalytics.feedback.preparingExport", { tab: analyticsTabLabel(activeTab) }));
      let rows: Array<Array<string | number>> = [];
      let numericColumns: number[] = [];

      if (activeTab === "Turnover") {
        rows = [
          ["Brand", "Code", "Description", "On_Hand_Qty", "Stock_Value_EUR", "Sold_Qty", "Sold_Amount_EUR", "Turnover_X", "Days_Cover"],
          ...turnoverRows.map((row) => [row.brand, row.product_code, row.description, row.on_hand_qty, row.stock_value, row.sold_qty, row.sold_amount, row.turnover_ratio, row.days_cover ?? ""]),
        ];
        numericColumns = [3, 4, 5, 6, 7, 8];
      } else if (activeTab === "Aging") {
        rows = [
          ["Warehouse", "Brand", "Code", "Description", "On_Hand_Qty", "Stock_Value_EUR", "Days_Idle", "Age_Bucket", "Last_Move"],
          ...agingRows.map((row) => [row.warehouse_name, row.brand, row.product_code, row.description, row.on_hand_qty, row.stock_value, row.days_idle, row.age_bucket, formatDate(row.last_moved_at)]),
        ];
        numericColumns = [4, 5, 6];
      } else if (activeTab === "Forecast") {
        rows = [
          ["Brand", "Code", "Description", "On_Hand_Qty", "Monthly_Demand_Qty", "Months_Cover", "Recommended_Qty", "Reorder_Qty", "Status"],
          ...forecastRows.map((row) => [row.brand, row.product_code, row.description, row.on_hand_qty, row.monthly_demand_qty, row.months_cover ?? "", row.recommended_qty, row.reorder_qty, row.status]),
        ];
        numericColumns = [3, 4, 5, 6, 7];
      } else if (activeTab === "Pending Procurement") {
        rows = [
          ["Sales_Order", "Customer", "Date", "Source", "Brand", "Code", "Description", "Qty_Ordered", "Qty_Purchased", "Qty_Pending"],
          ...pendingProcurementRows.map((row) => [row.sales_order_no, row.customer_name, row.order_date, row.source_channel, row.brand, row.product_code, row.description, row.qty_ordered, row.qty_purchased, row.qty_pending]),
        ];
        numericColumns = [7, 8, 9];
      } else if (activeTab === "Vendor Balance") {
        rows = [
          ["Vendor", "Purchase_Order", "Sales_Order", "Customer", "PO_Date", "Brand", "Code", "Description", "Qty_Ordered", "Qty_Received", "Vendor_Balance_Qty", "Open_Cost_EUR", "Status"],
          ...vendorBalanceRows.map((row) => [
            row.supplier_name,
            row.purchase_order_no,
            row.sales_order_no,
            row.customer_name,
            row.order_date,
            row.brand,
            row.product_code,
            row.description,
            row.qty_ordered,
            row.qty_received,
            row.qty_remaining,
            row.amount_remaining,
            row.status,
          ]),
        ];
        numericColumns = [8, 9, 10, 11];
      } else {
        rows = [
          ["Sales_Order", "Customer", "SO_Date", "Source", "Brand", "Code", "Description", "Qty_Ordered", "Qty_Invoiced", "Customer_Balance_Qty", "Open_Sales_EUR", "Status"],
          ...customerBalanceRows.map((row) => [
            row.sales_order_no,
            row.customer_name,
            row.order_date,
            row.source_channel,
            row.brand,
            row.product_code,
            row.description,
            row.qty_ordered,
            row.qty_invoiced,
            row.qty_remaining,
            row.amount_remaining,
            row.status,
          ]),
        ];
        numericColumns = [7, 8, 9, 10];
      }

      const blob = buildXlsxBlob(analyticsTabLabel(activeTab).slice(0, 31), rows, numericColumns);
      downloadBlob(`inventory-${activeTab.toLowerCase().replace(/\s+/g, "-")}-${stamp}.xlsx`, blob);
      actionFeedback.succeed(r("inventoryAnalytics.feedback.exported", { tab: analyticsTabLabel(activeTab) }));
    } catch (caught) {
      actionFeedback.fail(caught instanceof Error ? caught.message : r("inventoryAnalytics.errors.exportFailed", { tab: analyticsTabLabel(activeTab) }));
    } finally {
      setExporting(false);
    }
  }

  return (
    <SectionCard title={r("inventoryAnalytics.title")}>
      <div className="toolbar toolbar--wrap">
        <Select label={r("fields.brand")} value={filters.brand} options={brands.length ? brands : defaultBrandOptions} onChange={(value) => setFilters((current) => ({ ...current, brand: value }))} />
        <Select label={r("fields.warehouse")} value={filters.warehouseId} options={warehouses.length ? warehouses : defaultWarehouseOptions} onChange={(value) => setFilters((current) => ({ ...current, warehouseId: value }))} />
        <Input
          label={r("inventoryAnalytics.fields.codeDescription")}
          value={filters.codeSearch}
          onChange={(value) => setFilters((current) => ({ ...current, codeSearch: value }))}
          placeholder={r("inventoryAnalytics.placeholders.codeDescription")}
          onEnter={() => void handleLoad()}
        />
        <Input label={r("fields.dateFrom")} type="date" value={filters.dateFrom} onChange={(value) => setFilters((current) => ({ ...current, dateFrom: value }))} />
        <Input label={r("fields.dateTo")} type="date" value={filters.dateTo} onChange={(value) => setFilters((current) => ({ ...current, dateTo: value }))} />
        <Input label={r("inventoryAnalytics.fields.forecastMonths")} type="number" value={filters.forecastMonths} onChange={(value) => setFilters((current) => ({ ...current, forecastMonths: value }))} />
        <Button onClick={() => void handleLoad()} busy={loading} busyLabel={r("busy.loading")}>
          {r("actions.loadAnalytics")}
        </Button>
        <Button variant="secondary" onClick={() => void handleExport()} disabled={!loaded || !activeRows.length} busy={exporting} busyLabel={r("busy.exporting")}>
          {r("actions.exportExcel")}
        </Button>
      </div>

      <div className="meta-row">
        <span>{loaded ? r("inventoryAnalytics.meta.rowsReady", { count: activeRows.length.toLocaleString("en-US") }) : r("inventoryAnalytics.meta.selectFilter")}</span>
        <span>{loaded ? r("inventoryAnalytics.meta.periodBasis", { days: periodDays.toLocaleString("en-US") }) : r("inventoryAnalytics.meta.explicitLoadOnly")}</span>
      </div>

      {loaded ? (
        <div className="settings-grid settings-stats-grid">
          <div className="settings-item">
            <span className="settings-label">{r("inventoryAnalytics.pulse.postedReceives")}</span>
            <strong>{analyticsPulse.receiveCount.toLocaleString("en-US")}</strong>
          </div>
          <div className="settings-item">
            <span className="settings-label">{r("inventoryAnalytics.pulse.receiveValue")}</span>
            <strong>{formatMoney(analyticsPulse.receiveValue)}</strong>
          </div>
          <div className="settings-item">
            <span className="settings-label">{r("inventoryAnalytics.pulse.transfers")}</span>
            <strong>{analyticsPulse.transferCount.toLocaleString("en-US")}</strong>
          </div>
          <div className="settings-item">
            <span className="settings-label">{r("inventoryAnalytics.pulse.transferValue")}</span>
            <strong>{formatMoney(analyticsPulse.transferValue)}</strong>
          </div>
        </div>
      ) : null}

      <div className="module-tabs">
        {(["Turnover", "Aging", "Forecast", "Pending Procurement", "Vendor Balance", "Customer Balance"] as AnalyticsTab[]).map((tab) => (
          <button key={tab} className={`module-tab${activeTab === tab ? " active" : ""}`} onClick={() => setActiveTab(tab)}>
            {analyticsTabLabel(tab)}
          </button>
        ))}
      </div>

      {loaded ? (
        <>
          {activeTab === "Turnover" ? (
            <>
              <div className="settings-grid settings-stats-grid">
                <div className="settings-item">
                  <span className="settings-label">{r("inventoryAnalytics.metrics.trackedItems")}</span>
                  <strong>{turnoverRows.length.toLocaleString("en-US")}</strong>
                </div>
                <div className="settings-item">
                  <span className="settings-label">{r("inventoryAnalytics.metrics.stockValue")}</span>
                  <strong>{formatMoney(turnoverRows.reduce((sum, row) => sum + row.stock_value, 0))}</strong>
                </div>
                <div className="settings-item">
                  <span className="settings-label">{r("inventoryAnalytics.metrics.soldAmount")}</span>
                  <strong>{formatMoney(turnoverRows.reduce((sum, row) => sum + row.sold_amount, 0))}</strong>
                </div>
                <div className="settings-item">
                  <span className="settings-label">{r("inventoryAnalytics.metrics.soldQty")}</span>
                  <strong>{turnoverRows.reduce((sum, row) => sum + row.sold_qty, 0).toLocaleString("en-US")}</strong>
                </div>
              </div>
              <DataTable rows={turnoverRows} columns={turnoverColumns} emptyText={r("inventoryAnalytics.empty.noTurnoverRows")} />
            </>
          ) : null}

          {activeTab === "Aging" ? (
            <>
              <div className="settings-grid settings-stats-grid">
                <div className="settings-item">
                  <span className="settings-label">{r("inventoryAnalytics.metrics.agedSkus")}</span>
                  <strong>{agingRows.length.toLocaleString("en-US")}</strong>
                </div>
                <div className="settings-item">
                  <span className="settings-label">{r("inventoryAnalytics.metrics.days90Plus")}</span>
                  <strong>{agingRows.filter((row) => row.days_idle > 90).length.toLocaleString("en-US")}</strong>
                </div>
                <div className="settings-item">
                  <span className="settings-label">{r("inventoryAnalytics.metrics.agedValue")}</span>
                  <strong>{formatMoney(agingRows.filter((row) => row.days_idle > 90).reduce((sum, row) => sum + row.stock_value, 0))}</strong>
                </div>
                <div className="settings-item">
                  <span className="settings-label">{r("inventoryAnalytics.metrics.oldestIdle")}</span>
                  <strong>{r("inventoryAnalytics.values.days", { days: agingRows[0]?.days_idle?.toLocaleString("en-US") || "0" })}</strong>
                </div>
              </div>
              <DataTable rows={agingRows} columns={agingColumns} emptyText={r("inventoryAnalytics.empty.noAgingRows")} />
            </>
          ) : null}

          {activeTab === "Forecast" ? (
            <>
              <div className="settings-grid settings-stats-grid">
                <div className="settings-item">
                  <span className="settings-label">{r("inventoryAnalytics.metrics.reorderItems")}</span>
                  <strong>{forecastRows.filter((row) => row.status === "Reorder").length.toLocaleString("en-US")}</strong>
                </div>
                <div className="settings-item">
                  <span className="settings-label">{r("inventoryAnalytics.metrics.reorderQty")}</span>
                  <strong>{forecastRows.reduce((sum, row) => sum + row.reorder_qty, 0).toLocaleString("en-US")}</strong>
                </div>
                <div className="settings-item">
                  <span className="settings-label">{r("inventoryAnalytics.metrics.overstockItems")}</span>
                  <strong>{forecastRows.filter((row) => row.status === "Overstock").length.toLocaleString("en-US")}</strong>
                </div>
                <div className="settings-item">
                  <span className="settings-label">{r("inventoryAnalytics.metrics.noDemand")}</span>
                  <strong>{forecastRows.filter((row) => row.status === "No Demand").length.toLocaleString("en-US")}</strong>
                </div>
              </div>
              <DataTable rows={forecastRows} columns={forecastColumns} emptyText={r("inventoryAnalytics.empty.noForecastRows")} />
            </>
          ) : null}

          {activeTab === "Pending Procurement" ? (
            <>
              <div className="settings-grid settings-stats-grid">
                <div className="settings-item">
                  <span className="settings-label">{r("inventoryAnalytics.metrics.pendingLines")}</span>
                  <strong>{pendingProcurementRows.length.toLocaleString("en-US")}</strong>
                </div>
                <div className="settings-item">
                  <span className="settings-label">{r("inventoryAnalytics.metrics.pendingQty")}</span>
                  <strong>{pendingProcurementRows.reduce((sum, row) => sum + row.qty_pending, 0).toLocaleString("en-US")}</strong>
                </div>
                <div className="settings-item">
                  <span className="settings-label">{r("inventoryAnalytics.metrics.portalOrders")}</span>
                  <strong>{pendingProcurementRows.filter((row) => row.source_channel === "portal").length.toLocaleString("en-US")}</strong>
                </div>
                <div className="settings-item">
                  <span className="settings-label">{r("inventoryAnalytics.metrics.customersAffected")}</span>
                  <strong>{new Set(pendingProcurementRows.map((row) => row.customer_name)).size.toLocaleString("en-US")}</strong>
                </div>
              </div>
              <DataTable rows={pendingProcurementRows} columns={pendingColumns} emptyText={r("inventoryAnalytics.empty.noPendingProcurementRows")} />
            </>
          ) : null}

          {activeTab === "Vendor Balance" ? (
            <>
              <div className="settings-grid settings-stats-grid">
                <div className="settings-item">
                  <span className="settings-label">{r("inventoryAnalytics.metrics.openVendorLines")}</span>
                  <strong>{vendorBalanceRows.length.toLocaleString("en-US")}</strong>
                </div>
                <div className="settings-item">
                  <span className="settings-label">{r("inventoryAnalytics.metrics.vendorBalanceQty")}</span>
                  <strong>{vendorBalanceRows.reduce((sum, row) => sum + row.qty_remaining, 0).toLocaleString("en-US")}</strong>
                </div>
                <div className="settings-item">
                  <span className="settings-label">{r("inventoryAnalytics.metrics.openCost")}</span>
                  <strong>{formatMoney(vendorBalanceRows.reduce((sum, row) => sum + row.amount_remaining, 0))}</strong>
                </div>
                <div className="settings-item">
                  <span className="settings-label">{r("inventoryAnalytics.metrics.vendorsAffected")}</span>
                  <strong>{new Set(vendorBalanceRows.map((row) => row.supplier_name)).size.toLocaleString("en-US")}</strong>
                </div>
              </div>
              <DataTable rows={vendorBalanceRows} columns={vendorBalanceColumns} emptyText={r("inventoryAnalytics.empty.noVendorBalanceRows")} />
            </>
          ) : null}

          {activeTab === "Customer Balance" ? (
            <>
              <div className="settings-grid settings-stats-grid">
                <div className="settings-item">
                  <span className="settings-label">{r("inventoryAnalytics.metrics.openCustomerLines")}</span>
                  <strong>{customerBalanceRows.length.toLocaleString("en-US")}</strong>
                </div>
                <div className="settings-item">
                  <span className="settings-label">{r("inventoryAnalytics.metrics.customerBalanceQty")}</span>
                  <strong>{customerBalanceRows.reduce((sum, row) => sum + row.qty_remaining, 0).toLocaleString("en-US")}</strong>
                </div>
                <div className="settings-item">
                  <span className="settings-label">{r("inventoryAnalytics.metrics.openSales")}</span>
                  <strong>{formatMoney(customerBalanceRows.reduce((sum, row) => sum + row.amount_remaining, 0))}</strong>
                </div>
                <div className="settings-item">
                  <span className="settings-label">{r("inventoryAnalytics.metrics.customersAffected")}</span>
                  <strong>{new Set(customerBalanceRows.map((row) => row.customer_name)).size.toLocaleString("en-US")}</strong>
                </div>
              </div>
              <DataTable rows={customerBalanceRows} columns={customerBalanceColumns} emptyText={r("inventoryAnalytics.empty.noCustomerBalanceRows")} />
            </>
          ) : null}
        </>
      ) : (
        <div className="empty-state">{r("inventoryAnalytics.empty.loadPrompt")}</div>
      )}
    </SectionCard>
  );
}

function parseNumberInputSafe(value: string) {
  const normalized = value.replace(",", ".").trim();
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}
