import { useState } from "react";
import { InventoryAnalyticsPage } from "./InventoryAnalyticsPage";
import { ItemTransactionsPage } from "./ItemTransactionsPage";
import { MasterPage } from "./MasterPage";

type ReportsPageProps = {
  onOpenSalesOrder?: (salesOrderId: string) => void;
  onOpenPurchaseOrder?: (purchaseOrderId: string) => void;
  onOpenInvoice?: (invoiceId: string) => void;
  onOpenBill?: (billId: string) => void;
  onOpenInventoryWarehouse?: (warehouseId: string) => void;
  onOpenInventoryItem?: (codeSearch: string, warehouseId?: string) => void;
};

export function ReportsPage({
  onOpenSalesOrder,
  onOpenPurchaseOrder,
  onOpenInvoice,
  onOpenBill,
  onOpenInventoryWarehouse,
  onOpenInventoryItem,
}: ReportsPageProps) {
  const [activeTab, setActiveTab] = useState("Master");

  return (
    <div className="page-stack">
      <div className="module-tabs">
        <button className={`module-tab${activeTab === "Master" ? " active" : ""}`} onClick={() => setActiveTab("Master")}>
          Master
        </button>
        <button className={`module-tab${activeTab === "Item Transactions" ? " active" : ""}`} onClick={() => setActiveTab("Item Transactions")}>
          Item Transactions
        </button>
        <button className={`module-tab${activeTab === "Inventory Analytics" ? " active" : ""}`} onClick={() => setActiveTab("Inventory Analytics")}>
          Inventory Analytics
        </button>
      </div>
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
