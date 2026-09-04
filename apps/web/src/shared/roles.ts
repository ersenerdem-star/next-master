export type AppRole = "superadmin" | "admin" | "sales" | "warehouse" | "viewer" | "";
export type AppDepartment = "management" | "sales" | "purchasing" | "accounting" | "warehouse" | "viewer" | string;
export type AppPermissionMap = Record<string, boolean>;

function permissionAllows(permissions: AppPermissionMap | undefined, key: string) {
  return permissions && Object.prototype.hasOwnProperty.call(permissions, key) ? permissions[key] === true : undefined;
}

function hasPermissionOverride(permissions: AppPermissionMap | undefined, keys: string[]) {
  return Boolean(permissions && keys.some((key) => Object.prototype.hasOwnProperty.call(permissions, key)));
}

export function normalizeAppRole(role: string | null | undefined): AppRole {
  const value = String(role || "").trim().toLowerCase();
  if (value === "superadmin" || value === "admin" || value === "sales" || value === "warehouse" || value === "viewer") {
    return value;
  }
  return "";
}

export function isSuperadminRole(role: string | null | undefined) {
  return normalizeAppRole(role) === "superadmin";
}

export function isAdminLikeRole(role: string | null | undefined, department?: AppDepartment | null) {
  const normalized = normalizeAppRole(role);
  return normalized === "superadmin" || normalized === "admin" || String(department || "").toLowerCase() === "management";
}

export function isCustomerStaffRole(role: string | null | undefined, department?: AppDepartment | null) {
  const normalized = normalizeAppRole(role);
  return normalized === "superadmin" || normalized === "admin" || normalized === "sales" || ["sales", "accounting"].includes(String(department || "").toLowerCase());
}

export function canAccessSystemModules(role: string | null | undefined) {
  return isSuperadminRole(role);
}

export function canAccessCustomerOps(role: string | null | undefined, department?: AppDepartment | null, permissions?: AppPermissionMap) {
  return permissionAllows(permissions, "customers.view") ?? isCustomerStaffRole(role, department);
}

export function canAccessCatalogReviewModules(role: string | null | undefined, department?: AppDepartment | null, permissions?: AppPermissionMap) {
  return permissionAllows(permissions, "catalog.manage") ?? isAdminLikeRole(role, department);
}

export function canAccessSalesModules(role: string | null | undefined, department?: AppDepartment | null, permissions?: AppPermissionMap) {
  if (isAdminLikeRole(role, department)) return true;
  return (permissionAllows(permissions, "sales.orders") ?? false) || (permissionAllows(permissions, "sales.invoices") ?? false) || (permissionAllows(permissions, "customers.view") ?? isCustomerStaffRole(role, department));
}

export function canAccessOperationsModules(role: string | null | undefined, department?: AppDepartment | null, permissions?: AppPermissionMap) {
  const normalizedDepartment = String(department || "").toLowerCase();
  const keys = ["purchasing.orders", "purchasing.receive", "inventory.view", "finance.view", "reports.view"];
  if (hasPermissionOverride(permissions, keys)) return keys.some((key) => permissionAllows(permissions, key) === true);
  return isAdminLikeRole(role, department) || ["purchasing", "accounting", "warehouse"].includes(normalizedDepartment);
}

export function canAccessPurchasingModules(role: string | null | undefined, department?: AppDepartment | null, permissions?: AppPermissionMap) {
  const keys = ["purchasing.orders", "purchasing.receive", "supplier_prices.view"];
  if (hasPermissionOverride(permissions, keys)) return keys.some((key) => permissionAllows(permissions, key) === true);
  return isAdminLikeRole(role, department) || ["purchasing", "accounting"].includes(String(department || "").toLowerCase());
}

export function canAccessInventoryModules(role: string | null | undefined, department?: AppDepartment | null, permissions?: AppPermissionMap) {
  if (hasPermissionOverride(permissions, ["inventory.view"])) return permissionAllows(permissions, "inventory.view") === true;
  return isAdminLikeRole(role, department) || String(department || "").toLowerCase() === "warehouse";
}

export function canAccessReportModules(role: string | null | undefined, department?: AppDepartment | null, permissions?: AppPermissionMap) {
  if (hasPermissionOverride(permissions, ["reports.view"])) return permissionAllows(permissions, "reports.view") === true;
  return isAdminLikeRole(role, department) || ["purchasing", "accounting", "warehouse"].includes(String(department || "").toLowerCase());
}
