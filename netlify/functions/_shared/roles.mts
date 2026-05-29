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

export function isAdminLikeRole(role: string | null | undefined) {
  const normalized = normalizeAppRole(role);
  return normalized === "superadmin" || normalized === "admin";
}

export function isCustomerStaffRole(role: string | null | undefined) {
  const normalized = normalizeAppRole(role);
  return normalized === "superadmin" || normalized === "admin" || normalized === "sales";
}

export function canAccessCustomerOps(role: string | null | undefined) {
  return isCustomerStaffRole(role);
}

export function canAccessOperationsModules(role: string | null | undefined) {
  return isAdminLikeRole(role);
}
