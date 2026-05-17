import type { PortalInvite } from "../../types/portal";
import { createEmptyPortalInvite, loadPortalInvites } from "../../shared/localPortal";
import { supabaseClient } from "./supabaseClient";
import { getCurrentOrgId, isUuid } from "./organizationApi";

const PORTAL_INVITE_COLUMNS = [
  "id",
  "party_type",
  "party_name",
  "email",
  "contact_name",
  "status",
  "invite_token",
  "last_sent_at",
  "access_can_view_account",
  "access_can_view_invoices",
  "access_can_view_payments",
  "access_can_view_orders",
  "created_at",
  "updated_at",
].join(",");

function mapPortalInviteRow(row: Record<string, unknown>): PortalInvite {
  return {
    id: String(row.id || ""),
    party_type: String(row.party_type || "customer") as PortalInvite["party_type"],
    party_name: String(row.party_name || ""),
    email: String(row.email || ""),
    contact_name: String(row.contact_name || ""),
    status: String(row.status || "draft") as PortalInvite["status"],
    invite_token: String(row.invite_token || ""),
    last_sent_at: String(row.last_sent_at || ""),
    created_at: String(row.created_at || ""),
    updated_at: String(row.updated_at || ""),
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
    email: input.email.trim(),
    contact_name: input.contact_name.trim(),
    status: input.status,
    invite_token: input.invite_token,
    last_sent_at: input.last_sent_at || null,
    access_can_view_account: input.access.can_view_account,
    access_can_view_invoices: input.access.can_view_invoices,
    access_can_view_payments: input.access.can_view_payments,
    access_can_view_orders: input.access.can_view_orders,
    created_at: input.created_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

async function bootstrapPortalInvitesFromLocalIfNeeded() {
  const organizationId = await getCurrentOrgId();
  const localRows = loadPortalInvites();
  if (!localRows.length) return;

  const { count, error: countError } = await supabaseClient
    .from("portal_invites")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId);

  if (countError) throw new Error(countError.message || "Portal invite bootstrap check failed");
  if ((count || 0) > 0) return;

  const payload = localRows.map((row) => mapPortalInvitePayload(row, organizationId));
  const { error } = await supabaseClient.from("portal_invites").insert(payload);
  if (error) throw new Error(error.message || "Portal invite bootstrap failed");
}

export async function fetchPortalInvites(): Promise<PortalInvite[]> {
  await bootstrapPortalInvitesFromLocalIfNeeded();
  const organizationId = await getCurrentOrgId();
  const { data, error } = await supabaseClient
    .from("portal_invites")
    .select(PORTAL_INVITE_COLUMNS)
    .eq("organization_id", organizationId)
    .order("updated_at", { ascending: false });

  if (error) throw new Error(error.message || "Portal invites load failed");
  return ((data || []) as unknown as Record<string, unknown>[]).map(mapPortalInviteRow);
}

export function createEmptyCloudPortalInvite() {
  return createEmptyPortalInvite();
}

export async function upsertPortalInvite(input: PortalInvite): Promise<PortalInvite> {
  const organizationId = await getCurrentOrgId();
  const payload = mapPortalInvitePayload(input, organizationId);

  if (isUuid(input.id)) {
    const { data, error } = await supabaseClient
      .from("portal_invites")
      .update(payload)
      .eq("id", input.id)
      .eq("organization_id", organizationId)
      .select(PORTAL_INVITE_COLUMNS)
      .single();

    if (error) throw new Error(error.message || "Portal access save failed");
    return mapPortalInviteRow(data as unknown as Record<string, unknown>);
  }

  const { data, error } = await supabaseClient
    .from("portal_invites")
    .insert(payload)
    .select(PORTAL_INVITE_COLUMNS)
    .single();

  if (error) throw new Error(error.message || "Portal access create failed");
  return mapPortalInviteRow(data as unknown as Record<string, unknown>);
}

export async function markPortalInviteSent(portalInviteId: string): Promise<PortalInvite | null> {
  const organizationId = await getCurrentOrgId();
  if (!isUuid(portalInviteId)) return null;

  const { data, error } = await supabaseClient
    .from("portal_invites")
    .update({
      status: "invited",
      last_sent_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", portalInviteId)
    .eq("organization_id", organizationId)
    .select(PORTAL_INVITE_COLUMNS)
    .single();

  if (error) throw new Error(error.message || "Portal invite send failed");
  return data ? mapPortalInviteRow(data as unknown as Record<string, unknown>) : null;
}

export async function setPortalInviteStatus(portalInviteId: string, status: PortalInvite["status"]): Promise<PortalInvite | null> {
  const organizationId = await getCurrentOrgId();
  if (!isUuid(portalInviteId)) return null;

  const { data, error } = await supabaseClient
    .from("portal_invites")
    .update({
      status,
      updated_at: new Date().toISOString(),
    })
    .eq("id", portalInviteId)
    .eq("organization_id", organizationId)
    .select(PORTAL_INVITE_COLUMNS)
    .single();

  if (error) throw new Error(error.message || "Portal invite status update failed");
  return data ? mapPortalInviteRow(data as unknown as Record<string, unknown>) : null;
}

export async function deletePortalInvite(portalInviteId: string) {
  const organizationId = await getCurrentOrgId();
  if (!isUuid(portalInviteId)) return;

  const { error } = await supabaseClient.from("portal_invites").delete().eq("id", portalInviteId).eq("organization_id", organizationId);
  if (error) throw new Error(error.message || "Portal invite delete failed");
}
