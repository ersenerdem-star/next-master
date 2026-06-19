export { DashboardPage } from "../../presentation/pages/DashboardPage";
export { ItemsPage } from "../../presentation/pages/ItemsPage";
export { InventoryPage } from "../../presentation/pages/InventoryPage";
export { SalesPage } from "../../presentation/pages/SalesPage";
export { PurchasesPage } from "../../presentation/pages/PurchasesPage";
export { ReportsPage } from "../../presentation/pages/ReportsPage";
export { SettingsPage } from "../../presentation/pages/SettingsPage";

export const adminModuleRoutes = {
  Home: "DashboardPage",
  Items: "ItemsPage",
  Inventory: "InventoryPage",
  Sales: "SalesPage",
  Purchases: "PurchasesPage",
  Reports: "ReportsPage",
  Settings: "SettingsPage",
} as const;
