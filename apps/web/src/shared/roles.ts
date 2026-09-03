export type AppRole = "superadmin" | "admin" | "sales" | "warehouse" | "viewer" | "";
export type AppDepartment = "management" | "sales" | "purchasing" | "accounting" | "warehouse" | "viewer" | string;

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

export function canAccessCustomerOps(role: string | null | undefined, department?: AppDepartment | null) {
  return isCustomerStaffRole(role, department);
}

export function canAccessCatalogReviewModules(role: string | null | undefined, department?: AppDepartment | null) {
  return isAdminLikeRole(role, department);
}

export function canAccessSalesModules(role: string | null | undefined, department?: AppDepartment | null) {
  return isCustomerStaffRole(role, department);
}

export function canAccessOperationsModules(role: string | null | undefined, department?: AppDepartment | null) {
  return isAdminLikeRole(role, department) || ["purchasing", "accounting", "warehouse"].includes(String(department || "").toLowerCase());
}

export function canAccessPurchasingModules(role: string | null | undefined, department?: AppDepartment | null) {
  return canAccessOperationsModules(role, department);
}

export function canAccessInventoryModules(role: string | null | undefined, department?: AppDepartment | null) {
  return canAccessOperationsModules(role, department);
}

export function canAccessReportModules(role: string | null | undefined, department?: AppDepartment | null) {
  return canAccessOperationsModules(role, department);
}
