import { useState } from "react";
import { InventoryAnalyticsPage } from "./InventoryAnalyticsPage";
import { ItemTransactionsPage } from "./ItemTransactionsPage";
import { MasterPage } from "./MasterPage";

type ReportsPageProps = {
  onOpenSalesOrder?: (salesOrderId: string) => void;
  onOpenInventoryWarehouse?: (warehouseId: string) => void;
};

export function ReportsPage({ onOpenSalesOrder, onOpenInventoryWarehouse }: ReportsPageProps) {
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
      {activeTab === "Item Transactions" ? <ItemTransactionsPage /> : null}
      {activeTab === "Inventory Analytics" ? (
        <InventoryAnalyticsPage onOpenSalesOrder={onOpenSalesOrder} onOpenInventoryWarehouse={onOpenInventoryWarehouse} />
      ) : null}
    </div>
  );
}
