import { CoreReportsPage } from "./CoreReportsPage";
import { InventoryAnalyticsPage } from "./InventoryAnalyticsPage";
import { ItemTransactionsPage } from "./ItemTransactionsPage";
import { MasterPage } from "./MasterPage";
import { ProcurementDashboardPage } from "./ProcurementDashboardPage";

type ReportsPageProps = {
  activeTab?: "Procurement Dashboard" | "Master" | "Core Reports" | "Item Transactions" | "Inventory Analytics";
  onOpenSalesOrder?: (salesOrderId: string) => void;
  onOpenPurchaseOrder?: (purchaseOrderId: string) => void;
  onOpenInvoice?: (invoiceId: string) => void;
  onOpenBill?: (billId: string) => void;
  onOpenInventoryWarehouse?: (warehouseId: string) => void;
  onOpenInventoryItem?: (codeSearch: string, warehouseId?: string) => void;
  onOpenSupplierComparison?: () => void;
};

export function ReportsPage({
  activeTab = "Procurement Dashboard",
  onOpenSalesOrder,
  onOpenPurchaseOrder,
  onOpenInvoice,
  onOpenBill,
  onOpenInventoryWarehouse,
  onOpenInventoryItem,
  onOpenSupplierComparison,
}: ReportsPageProps) {
  return (
    <div className="page-stack">
      {activeTab === "Procurement Dashboard" ? <ProcurementDashboardPage onOpenSupplierComparison={onOpenSupplierComparison} /> : null}
      {activeTab === "Master" ? <MasterPage /> : null}
      {activeTab === "Core Reports" ? <CoreReportsPage /> : null}
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
    </div>
  );
}
