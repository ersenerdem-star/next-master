export { InventoryPage } from "../../presentation/pages/InventoryPage";
export { ItemTransactionsPage } from "../../presentation/pages/ItemTransactionsPage";
export { InventoryAnalyticsPage } from "../../presentation/pages/InventoryAnalyticsPage";

export const warehouseModuleRoutes = {
  Inventory: "InventoryPage",
  ItemTransactions: "ItemTransactionsPage",
  InventoryAnalytics: "InventoryAnalyticsPage",
} as const;
