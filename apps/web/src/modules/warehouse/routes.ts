import { lazy } from "react";

export const WarehouseInventoryPage = lazy(() =>
  import("./pages/InventoryPage").then((module) => ({ default: module.InventoryPage })),
);
