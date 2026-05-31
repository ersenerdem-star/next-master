import type { PortalInvite } from "../../types/portal";
import { createEmptyPortalInvite } from "../../shared/localPortal";
import { callAppAdminRecords } from "./appAdminRecordsApi";
import { getCurrentOrgId, isUuid } from "./organizationApi";

function mapPortalInviteRow(row: Record<string, unknown>): PortalInvite {
  return {
    id: String(row.id || ""),
    party_type: String(row.party_type || "customer") as PortalInvite["party_type"],
    party_name: String(row.party_name || ""),
    customer_id: String(row.customer_id || ""),
    vendor_id: String(row.vendor_id || ""),
    email: String(row.email || ""),
    contact_name: String(row.contact_name || ""),
    status: String(row.status || "draft") as PortalInvite["status"],
    invite_token: "",
    last_sent_at: String(row.last_sent_at || ""),
    expires_at: String(row.expires_at || ""),
    created_at: String(row.created_at || ""),
    updated_at: String(row.updated_at || ""),
    has_password: Boolean(row.has_password ?? row.invite_token_hash),
    access: {
      can_view_account: Boolean(row.access_can_view_account),
      can_view_invoices: Boolean(row.access_can_view_invoices),
      can_view_payments: Boolean(row.access_can_view_payments),
      can_view_orders: Boolean(row.access_can_view_orders),
    },
  };
}

function mapPortalInvitePayload(input: PortalInvite, organizationId: string) {
  return {
    organization_id: organizationId,
    party_type: input.party_type,
    party_name: input.party_name.trim(),
    customer_id: input.party_type === "customer" && isUuid(input.customer_id) ? input.customer_id : null,
    vendor_id: input.party_type === "vendor" && isUuid(input.vendor_id) ? input.vendor_id : null,
    email: input.email.trim(),
    contact_name: input.contact_name.trim(),
    status: input.status,
    last_sent_at: input.last_sent_at || null,
    expires_at: input.expires_at || null,
    access_can_view_account: input.access.can_view_account,
    access_can_view_invoices: input.access.can_view_invoices,
    access_can_view_payments: input.access.can_view_payments,
    access_can_view_orders: input.access.can_view_orders,
    created_at: input.created_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

async function bootstrapPortalInvitesFromLocalIfNeeded() {
  return;
}

export async function fetchPortalInvites(): Promise<PortalInvite[]> {
  await bootstrapPortalInvitesFromLocalIfNeeded();
  const data = await callAppAdminRecords<Array<Record<string, unknown>>>({
    resource: "portalInvites",
    action: "list",
  });
  return data.map(mapPortalInviteRow);
}

export function createEmptyCloudPortalInvite() {
  return createEmptyPortalInvite();
}

export async function issuePortalInviteToken(portalInviteId: string): Promise<{ invite: PortalInvite; token: string }> {
  if (!isUuid(portalInviteId)) throw new Error("Portal invite id is invalid");
  const data = await callAppAdminRecords<{ invite: Record<string, unknown>; token: string }>({
    resource: "portalInvites",
    action: "issueToken",
    id: portalInviteId,
  });
  return {
    invite: mapPortalInviteRow((data?.invite || {}) as Record<string, unknown>),
    token: String(data?.token || ""),
  };
}

export async function upsertPortalInvite(input: PortalInvite): Promise<PortalInvite> {
  const organizationId = await getCurrentOrgId();
  const payload = mapPortalInvitePayload(input, organizationId);

  const data = await callAppAdminRecords<Record<string, unknown>>({
    resource: "portalInvites",
    action: "upsert",
    id: isUuid(input.id) ? input.id : "",
    payload,
  });
  return mapPortalInviteRow(data);
}

export async function markPortalInviteSent(portalInviteId: string): Promise<PortalInvite | null> {
  if (!isUuid(portalInviteId)) return null;
  const data = await callAppAdminRecords<Record<string, unknown> | null>({
    resource: "portalInvites",
    action: "markSent",
    id: portalInviteId,
  });
  return data ? mapPortalInviteRow(data) : null;
}

export async function setPortalInviteStatus(portalInviteId: string, status: PortalInvite["status"]): Promise<PortalInvite | null> {
  if (!isUuid(portalInviteId)) return null;
  const data = await callAppAdminRecords<Record<string, unknown> | null>({
    resource: "portalInvites",
    action: "setStatus",
    id: portalInviteId,
    status,
  });
  return data ? mapPortalInviteRow(data) : null;
}

export async function deletePortalInvite(portalInviteId: string) {
  if (!isUuid(portalInviteId)) return;
  await callAppAdminRecords({
    resource: "portalInvites",
    action: "delete",
    id: portalInviteId,
  });
}

export async function setPortalInvitePassword(portalInviteId: string, password: string): Promise<PortalInvite | null> {
  if (!isUuid(portalInviteId)) return null;
  const data = await callAppAdminRecords<Record<string, unknown> | null>({
    resource: "portalInvites",
    action: "setPassword",
    id: portalInviteId,
    payload: { password },
  });
  return data ? mapPortalInviteRow(data) : null;
}

export async function clearPortalInvitePassword(portalInviteId: string): Promise<PortalInvite | null> {
  if (!isUuid(portalInviteId)) return null;
  const data = await callAppAdminRecords<Record<string, unknown> | null>({
    resource: "portalInvites",
    action: "clearPassword",
    id: portalInviteId,
  });
  return data ? mapPortalInviteRow(data) : null;
}
