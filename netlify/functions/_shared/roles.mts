export type AppRole = "superadmin" | "admin" | "sales" | "viewer" | "";

export function normalizeAppRole(role: string | null | undefined): AppRole {
  const value = String(role || "").trim().toLowerCase();
  if (value === "superadmin" || value === "admin" || value === "sales" || value === "viewer") {
    return value;
  }
  return "";
}

export function isSuperadminRole(role: string | null | undefined) {
  return normalizeAppRole(role) === "superadmin";
}

export function isAdminLikeRole(role: string | null | undefined, department?: string | null) {
  const normalized = normalizeAppRole(role);
  return normalized === "superadmin" || normalized === "admin" || String(department || "").toLowerCase() === "management";
}

export function isCustomerStaffRole(role: string | null | undefined, department?: string | null) {
  const normalized = normalizeAppRole(role);
  const normalizedDepartment = String(department || "").toLowerCase();
  return normalized === "superadmin" || normalized === "admin" || normalized === "sales" || normalizedDepartment === "sales" || normalizedDepartment === "accounting";
}

export function canAccessCustomerOps(role: string | null | undefined, department?: string | null) {
  return isCustomerStaffRole(role, department);
}

export function canAccessOperationsModules(role: string | null | undefined, department?: string | null) {
  const normalizedDepartment = String(department || "").toLowerCase();
  return isAdminLikeRole(role, department) || ["purchasing", "accounting", "warehouse"].includes(normalizedDepartment);
}
