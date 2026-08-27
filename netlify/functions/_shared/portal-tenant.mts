import { buildRestUrl, getJson, serviceRoleHeaders } from "./http.mts";

export type PortalSellerTenant = {
  id: string;
  organization_id: string;
  seller_company_profile_id: string | null;
  hostname: string;
  portal_label: string;
};

function normalizeHostname(value: string) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .split(",")[0]
    .split(":")[0]
    .replace(/^https?:\/\//, "")
    .replace(/\.$/, "");
}

export function getPortalRequestHostname(req: Request) {
  // Prefer the direct host header. `x-forwarded-host` is only a fallback for
  // trusted platform forwarding and is easier for arbitrary callers to spoof.
  const host = req.headers.get("host") || req.headers.get("x-forwarded-host") || "";
  return normalizeHostname(host);
}

export function isLocalPortalHostname(hostname: string) {
  const value = normalizeHostname(hostname);
  return value === "localhost" || value === "127.0.0.1" || value === "0.0.0.0" || value === "[::1]";
}

export async function resolvePortalSellerTenant(
  supabaseUrl: string,
  serviceRoleKey: string,
  hostname: string,
) {
  const normalizedHostname = normalizeHostname(hostname);
  if (!normalizedHostname || isLocalPortalHostname(normalizedHostname)) return null;

  const rows = await getJson<PortalSellerTenant[]>(
    buildRestUrl(supabaseUrl, "portal_seller_domains", {
      select: "id,organization_id,seller_company_profile_id,hostname,portal_label",
      hostname: `ilike.${normalizedHostname}`,
      is_active: "eq.true",
      limit: "1",
    }),
    { headers: serviceRoleHeaders(serviceRoleKey) },
  );

  return rows[0] || null;
}

export async function resolvePortalSellerDomainForSeller(
  supabaseUrl: string,
  serviceRoleKey: string,
  organizationId: string,
  sellerCompanyProfileId: string,
) {
  const rows = await getJson<PortalSellerTenant[]>(
    buildRestUrl(supabaseUrl, "portal_seller_domains", {
      select: "id,organization_id,seller_company_profile_id,hostname,portal_label",
      organization_id: `eq.${String(organizationId || "").trim()}`,
      seller_company_profile_id: `eq.${String(sellerCompanyProfileId || "").trim()}`,
      is_active: "eq.true",
      order: "hostname.asc",
      limit: "1",
    }),
    { headers: serviceRoleHeaders(serviceRoleKey) },
  );
  return rows[0] || null;
}

export function assertPortalTenantInvite(
  inviteOrganizationId: string,
  inviteSellerCompanyProfileId: string | null | undefined,
  tenant: PortalSellerTenant | null,
) {
  if (tenant && String(inviteOrganizationId) !== String(tenant.organization_id)) {
    throw new Error("Portal account is not available for this seller domain.");
  }
  if (
    tenant?.seller_company_profile_id &&
    String(inviteSellerCompanyProfileId || "") !== String(tenant.seller_company_profile_id)
  ) {
    throw new Error("Portal account is not available for this seller domain.");
  }
}
