import { CoreReportsPage } from "./CoreReportsPage";
import { InventoryAnalyticsPage } from "./InventoryAnalyticsPage";
import { ItemTransactionsPage } from "./ItemTransactionsPage";
import { MasterPage } from "./MasterPage";
import { ProcurementDashboardPage } from "./ProcurementDashboardPage";
import { OperationsStatusPage } from "./OperationsStatusPage";
import { useI18n } from "../../i18n/I18nProvider";
import { PortalAccessReportPage } from "./PortalAccessReportPage";

type ReportsPageProps = {
  portalAccessAllowed?: boolean;
  onOpenSupplierPrices?: () => void;
  activeTab?: "Procurement Dashboard" | "Master" | "Core Reports" | "Item Transactions" | "Inventory Analytics" | "Status Center" | "Portal Access";
  onOpenSalesOrder?: (salesOrderId: string) => void;
  onOpenPurchaseOrder?: (purchaseOrderId: string) => void;
  onOpenInvoice?: (invoiceId: string) => void;
  onOpenBill?: (billId: string) => void;
  onOpenInventoryWarehouse?: (warehouseId: string) => void;
  onOpenInventoryItem?: (codeSearch: string, warehouseId?: string) => void;
  onOpenSupplierComparison?: () => void;
};

export function ReportsPage({
  portalAccessAllowed = false,
  activeTab = "Procurement Dashboard",
  onOpenSupplierPrices,
  onOpenSalesOrder,
  onOpenPurchaseOrder,
  onOpenInvoice,
  onOpenBill,
  onOpenInventoryWarehouse,
  onOpenInventoryItem,
  onOpenSupplierComparison,
}: ReportsPageProps) {
  const { locale, t } = useI18n();
  const activeLabel = { "Procurement Dashboard": "nav.procurementDashboard", Master: "nav.supplierComparison", "Core Reports": "nav.coreReports", "Item Transactions": "nav.itemTransactions", "Inventory Analytics": "nav.inventoryAnalytics", "Status Center": "nav.statusCenter", "Portal Access": "nav.portalAccess" }[activeTab];
  return (
    <div className="page-stack reports-workspace">
      <section className="reports-command-banner">
        <div>
          <span className="reports-command-banner__eyebrow">{locale === "tr" ? "İçgörü merkezi" : "Insight workspace"}</span>
          <h2>{locale === "tr" ? "Karar vermek için tek rapor görünümü" : "One reporting view for faster decisions"}</h2>
          <p>{locale === "tr" ? "Tedarik, satış, stok ve durum sinyallerini aynı çalışma yüzeyinde karşılaştırın." : "Compare procurement, sales, inventory and operational signals in one focused workspace."}</p>
        </div>
        <div className="reports-command-banner__active">
          <span>{locale === "tr" ? "Açık görünüm" : "Active view"}</span>
          <strong>{t(activeLabel)}</strong>
        </div>
      </section>
      {activeTab === "Procurement Dashboard" ? <ProcurementDashboardPage onOpenSupplierComparison={onOpenSupplierComparison} /> : null}
      {activeTab === "Master" ? <MasterPage /> : null}
      {activeTab === "Core Reports" ? <CoreReportsPage /> : null}
      {activeTab === "Portal Access" && portalAccessAllowed ? <PortalAccessReportPage /> : null}
      {activeTab === "Item Transactions" ? (
        <ItemTransactionsPage
          onOpenSalesOrder={onOpenSalesOrder}
          onOpenPurchaseOrder={onOpenPurchaseOrder}
          onOpenInvoice={onOpenInvoice}
          onOpenBill={onOpenBill}
        />
      ) : null}
      {activeTab === "Inventory Analytics" ? (
        <InventoryAnalyticsPage onOpenSalesOrder={onOpenSalesOrder} onOpenInventoryWarehouse={onOpenInventoryWarehouse} onOpenInventoryItem={onOpenInventoryItem} />
      ) : null}
      {activeTab === "Status Center" ? <OperationsStatusPage onOpenSupplierPrices={onOpenSupplierPrices} /> : null}
    </div>
  );
}
