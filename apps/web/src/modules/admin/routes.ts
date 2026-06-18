import { lazy } from "react";

export const AdminDashboardPage = lazy(() =>
  import("./pages/DashboardPage").then((module) => ({ default: module.DashboardPage })),
);
export const AdminItemsPage = lazy(() =>
  import("./pages/ItemsPage").then((module) => ({ default: module.ItemsPage })),
);
export const AdminLoginPage = lazy(() =>
  import("./pages/LoginPage").then((module) => ({ default: module.LoginPage })),
);
export const AdminPurchasesPage = lazy(() =>
  import("./pages/PurchasesPage").then((module) => ({ default: module.PurchasesPage })),
);
export const AdminReportsPage = lazy(() =>
  import("./pages/ReportsPage").then((module) => ({ default: module.ReportsPage })),
);
export const AdminSalesPage = lazy(() =>
  import("./pages/SalesPage").then((module) => ({ default: module.SalesPage })),
);
export const AdminSettingsPage = lazy(() =>
  import("./pages/SettingsPage").then((module) => ({ default: module.SettingsPage })),
);
