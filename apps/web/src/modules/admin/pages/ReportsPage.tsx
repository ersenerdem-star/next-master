import { InventoryAnalyticsPage } from "./InventoryAnalyticsPage";
import { ItemTransactionsPage } from "./ItemTransactionsPage";
import { MasterPage } from "./MasterPage";

type ReportsPageProps = {
  activeTab?: "Master" | "Item Transactions" | "Inventory Analytics";
  onOpenSalesOrder?: (salesOrderId: string) => void;
  onOpenPurchaseOrder?: (purchaseOrderId: string) => void;
  onOpenInvoice?: (invoiceId: string) => void;
  onOpenBill?: (billId: string) => void;
  onOpenInventoryWarehouse?: (warehouseId: string) => void;
  onOpenInventoryItem?: (codeSearch: string, warehouseId?: string) => void;
};

export function ReportsPage({
  activeTab = "Master",
  onOpenSalesOrder,
  onOpenPurchaseOrder,
  onOpenInvoice,
  onOpenBill,
  onOpenInventoryWarehouse,
  onOpenInventoryItem,
}: ReportsPageProps) {
  return (
    <div className="page-stack">
      {activeTab === "Master" ? <MasterPage /> : null}
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
