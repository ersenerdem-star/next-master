import type { Config, Context } from "@netlify/functions";
import { requireCallerProfile } from "./_shared/auth.mts";
import { buildRestUrl, getJson, json, sendJson, serviceRoleHeaders } from "./_shared/http.mts";
import { sanitizeUserFacingError } from "./_shared/user-message.mts";

const permissionKeys = [
  "customers.view", "customers.manage", "catalog.view", "catalog.manage",
  "sales.orders", "sales.invoices", "purchasing.orders", "purchasing.receive",
  "supplier_prices.view", "supplier_prices.manage", "inventory.view",
  "finance.view", "finance.manage", "reports.view",
] as const;
type PermissionKey = (typeof permissionKeys)[number];

function isUuid(value: unknown) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || "").trim());
}

function normalizePermissions(value: unknown) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return Object.fromEntries(permissionKeys.map((key) => [key, source[key] === true])) as Record<PermissionKey, boolean>;
}

async function deleteRows(url: string, headers: Record<string, string>) {
  const response = await fetch(url, { method: "DELETE", headers });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(body || `Request failed: ${response.status}`);
  }
}

export default async (req: Request, _context: Context) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  try {
    const caller = await requireCallerProfile(req, ["superadmin"]);
    if ("error" in caller) return json({ error: caller.error }, caller.status);
    const payload = await req.json().catch(() => ({}));
    const userId = String(payload?.userId || "").trim();
    if (!isUuid(userId)) return json({ error: "A valid user id is required" }, 400);

    const target = await getJson<Array<{ id: string; organization_id: string; customer_scope_mode?: string | null; permissions?: Record<string, boolean> | null }>>(
      buildRestUrl(caller.supabaseUrl, "profiles", {
        select: "id,organization_id,customer_scope_mode,permissions",
        id: `eq.${userId}`,
        organization_id: `eq.${caller.profile.organization_id}`,
        limit: "1",
      }), { headers: serviceRoleHeaders(caller.serviceRoleKey) },
    );
    if (!target[0]) return json({ error: "Target user was not found in this organization" }, 404);

    const existingPermissions = await getJson<Array<{ permission_key: string; allowed: boolean }>>(
      buildRestUrl(caller.supabaseUrl, "profile_permissions", {
        select: "permission_key,allowed",
        organization_id: `eq.${caller.profile.organization_id}`,
        profile_id: `eq.${userId}`,
        limit: "100",
      }), { headers: serviceRoleHeaders(caller.serviceRoleKey) },
    ).catch(() => []);
    const existingAccess = await getJson<Array<{ customer_id: string }>>(
      buildRestUrl(caller.supabaseUrl, "profile_customer_access", {
        select: "customer_id",
        organization_id: `eq.${caller.profile.organization_id}`,
        profile_id: `eq.${userId}`,
        limit: "5000",
      }), { headers: serviceRoleHeaders(caller.serviceRoleKey) },
    ).catch(() => []);

    if (String(payload?.action || "get").toLowerCase() === "get") {
      const permissions = { ...normalizePermissions(target[0].permissions), ...Object.fromEntries(existingPermissions.map((row) => [row.permission_key, Boolean(row.allowed)])) };
      return json({ ok: true, userId, scopeMode: target[0].customer_scope_mode === "assigned" ? "assigned" : "all", permissions, customerIds: existingAccess.map((row) => row.customer_id).filter(isUuid) });
    }
    if (String(payload?.action || "").toLowerCase() !== "save") return json({ error: "Unsupported action" }, 400);

    const scopeMode = payload?.scopeMode === "assigned" ? "assigned" : "all";
    const permissions = normalizePermissions(payload?.permissionStates || payload?.permissions || payload?.allowedPermissionKeys && Object.fromEntries((payload.allowedPermissionKeys as unknown[]).map((key) => [String(key), true])));
    const requestedCustomerIds = Array.isArray(payload?.customerIds) ? [...new Set(payload.customerIds.map((value: unknown) => String(value || "").trim()).filter(isUuid))] : [];
    let customerIds: string[] = [];
    if (requestedCustomerIds.length) {
      const rows = await getJson<Array<{ id: string }>>(
        buildRestUrl(caller.supabaseUrl, "customers", {
          select: "id", organization_id: `eq.${caller.profile.organization_id}`, id: `in.(${requestedCustomerIds.join(",")})`, limit: "5000",
        }), { headers: serviceRoleHeaders(caller.serviceRoleKey) },
      );
      const valid = new Set(rows.map((row) => row.id));
      customerIds = requestedCustomerIds.filter((id) => valid.has(id));
      if (customerIds.length !== requestedCustomerIds.length) return json({ error: "One or more selected customers are outside this organization" }, 400);
    }
    const headers = { ...serviceRoleHeaders(caller.serviceRoleKey), Prefer: "return=minimal" };
    await sendJson<unknown>(buildRestUrl(caller.supabaseUrl, "profiles", { id: `eq.${userId}`, organization_id: `eq.${caller.profile.organization_id}` }), {
      method: "PATCH", headers, body: JSON.stringify({ customer_scope_mode: scopeMode, permissions }),
    });
    await deleteRows(buildRestUrl(caller.supabaseUrl, "profile_permissions", { profile_id: `eq.${userId}`, organization_id: `eq.${caller.profile.organization_id}` }), headers);
    await deleteRows(buildRestUrl(caller.supabaseUrl, "profile_customer_access", { profile_id: `eq.${userId}`, organization_id: `eq.${caller.profile.organization_id}` }), headers);
    await sendJson<unknown>(caller.supabaseUrl + "/rest/v1/profile_permissions", {
      method: "POST", headers, body: JSON.stringify(permissionKeys.map((permission_key) => ({ organization_id: caller.profile.organization_id, profile_id: userId, permission_key, allowed: permissions[permission_key] }))),
    });
    if (customerIds.length) {
      await sendJson<unknown>(caller.supabaseUrl + "/rest/v1/profile_customer_access", {
        method: "POST", headers, body: JSON.stringify(customerIds.map((customer_id) => ({ organization_id: caller.profile.organization_id, profile_id: userId, customer_id, access_level: "order" }))),
      });
    }
    return json({ ok: true, userId, scopeMode, permissions, customerIds });
  } catch (error) {
    return json({ error: sanitizeUserFacingError(error, "User access settings could not be saved") }, 500);
  }
};

export const config: Config = { path: "/api/admin-user-access", method: "POST" };
