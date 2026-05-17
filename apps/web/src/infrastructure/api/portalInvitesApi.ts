import type { PortalInvite } from "../../types/portal";
import { createEmptyPortalInvite, loadPortalInvites } from "../../shared/localPortal";
import { supabaseClient } from "./supabaseClient";
import { getCurrentOrgId, isUuid } from "./organizationApi";

const PORTAL_INVITE_COLUMNS = [
  "id",
  "party_type",
  "party_name",
  "customer_id",
  "vendor_id",
  "email",
  "contact_name",
  "status",
  "last_sent_at",
  "expires_at",
  "access_can_view_account",
  "access_can_view_invoices",
  "access_can_view_payments",
  "access_can_view_orders",
  "created_at",
  "updated_at",
].join(",");

const LEGACY_PORTAL_INVITE_COLUMNS = [
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

const PORTAL_TOKEN_TTL_DAYS = 14;

function buildExpiryIso() {
  const value = new Date();
  value.setDate(value.getDate() + PORTAL_TOKEN_TTL_DAYS);
  return value.toISOString();
}

function encodeHex(input: ArrayBuffer) {
  return Array.from(new Uint8Array(input))
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

async function hashPortalToken(token: string) {
  const digest = await window.crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return encodeHex(digest);
}

function generatePortalToken() {
  const bytes = new Uint8Array(24);
  window.crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

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
  const primary = await supabaseClient
    .from("portal_invites")
    .select(PORTAL_INVITE_COLUMNS)
    .eq("organization_id", organizationId)
    .order("updated_at", { ascending: false });

  if (!primary.error) {
    return ((primary.data || []) as unknown as Record<string, unknown>[]).map(mapPortalInviteRow);
  }

  const legacy = await supabaseClient
    .from("portal_invites")
    .select(LEGACY_PORTAL_INVITE_COLUMNS)
    .eq("organization_id", organizationId)
    .order("updated_at", { ascending: false });

  if (legacy.error) throw new Error(legacy.error.message || primary.error.message || "Portal invites load failed");
  return ((legacy.data || []) as unknown as Record<string, unknown>[]).map(mapPortalInviteRow);
}

export function createEmptyCloudPortalInvite() {
  return createEmptyPortalInvite();
}

export async function issuePortalInviteToken(portalInviteId: string): Promise<{ invite: PortalInvite; token: string }> {
  const organizationId = await getCurrentOrgId();
  if (!isUuid(portalInviteId)) throw new Error("Portal invite id is invalid");

  const token = generatePortalToken();
  const tokenHash = await hashPortalToken(token);
  const expiresAt = buildExpiryIso();
  const { data, error } = await supabaseClient
    .from("portal_invites")
    .update({
      invite_token: null,
      invite_token_hash: tokenHash,
      expires_at: expiresAt,
      updated_at: new Date().toISOString(),
    })
    .eq("id", portalInviteId)
    .eq("organization_id", organizationId)
    .select(PORTAL_INVITE_COLUMNS)
    .single();

  if (error) throw new Error(error.message || "Portal invite token issue failed");
  return {
    invite: mapPortalInviteRow(data as unknown as Record<string, unknown>),
    token,
  };
}

export async function upsertPortalInvite(input: PortalInvite): Promise<PortalInvite> {
  const organizationId = await getCurrentOrgId();
  const payload = mapPortalInvitePayload(input, organizationId);

  if (isUuid(input.id)) {
    const primary = await supabaseClient
      .from("portal_invites")
      .update(payload)
      .eq("id", input.id)
      .eq("organization_id", organizationId)
      .select(PORTAL_INVITE_COLUMNS)
      .single();

    if (!primary.error) return mapPortalInviteRow(primary.data as unknown as Record<string, unknown>);

    const legacyPayload = {
      organization_id: organizationId,
      party_type: input.party_type,
      party_name: input.party_name.trim(),
      email: input.email.trim(),
      contact_name: input.contact_name.trim(),
      status: input.status,
      last_sent_at: input.last_sent_at || null,
      access_can_view_account: input.access.can_view_account,
      access_can_view_invoices: input.access.can_view_invoices,
      access_can_view_payments: input.access.can_view_payments,
      access_can_view_orders: input.access.can_view_orders,
      created_at: input.created_at || new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    const legacy = await supabaseClient
      .from("portal_invites")
      .update(legacyPayload)
      .eq("id", input.id)
      .eq("organization_id", organizationId)
      .select(LEGACY_PORTAL_INVITE_COLUMNS)
      .single();

    if (legacy.error) throw new Error(legacy.error.message || primary.error.message || "Portal access save failed");
    return mapPortalInviteRow(legacy.data as unknown as Record<string, unknown>);
  }

  const primary = await supabaseClient
    .from("portal_invites")
    .insert(payload)
    .select(PORTAL_INVITE_COLUMNS)
    .single();

  if (!primary.error) return mapPortalInviteRow(primary.data as unknown as Record<string, unknown>);

  const legacyPayload = {
    organization_id: organizationId,
    party_type: input.party_type,
    party_name: input.party_name.trim(),
    email: input.email.trim(),
    contact_name: input.contact_name.trim(),
    status: input.status,
    invite_token: input.invite_token || null,
    last_sent_at: input.last_sent_at || null,
    access_can_view_account: input.access.can_view_account,
    access_can_view_invoices: input.access.can_view_invoices,
    access_can_view_payments: input.access.can_view_payments,
    access_can_view_orders: input.access.can_view_orders,
    created_at: input.created_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  const legacy = await supabaseClient
    .from("portal_invites")
    .insert(legacyPayload)
    .select(LEGACY_PORTAL_INVITE_COLUMNS)
    .single();

  if (legacy.error) throw new Error(legacy.error.message || primary.error.message || "Portal access create failed");
  return mapPortalInviteRow(legacy.data as unknown as Record<string, unknown>);
}

export async function markPortalInviteSent(portalInviteId: string): Promise<PortalInvite | null> {
  const organizationId = await getCurrentOrgId();
  if (!isUuid(portalInviteId)) return null;

  const primary = await supabaseClient
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

  if (!primary.error) return primary.data ? mapPortalInviteRow(primary.data as unknown as Record<string, unknown>) : null;

  const legacy = await supabaseClient
    .from("portal_invites")
    .update({
      status: "invited",
      last_sent_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", portalInviteId)
    .eq("organization_id", organizationId)
    .select(LEGACY_PORTAL_INVITE_COLUMNS)
    .single();

  if (legacy.error) throw new Error(legacy.error.message || primary.error.message || "Portal invite send failed");
  return legacy.data ? mapPortalInviteRow(legacy.data as unknown as Record<string, unknown>) : null;
}

export async function setPortalInviteStatus(portalInviteId: string, status: PortalInvite["status"]): Promise<PortalInvite | null> {
  const organizationId = await getCurrentOrgId();
  if (!isUuid(portalInviteId)) return null;

  const primary = await supabaseClient
    .from("portal_invites")
    .update({
      status,
      updated_at: new Date().toISOString(),
    })
    .eq("id", portalInviteId)
    .eq("organization_id", organizationId)
    .select(PORTAL_INVITE_COLUMNS)
      .single();

  if (!primary.error) return primary.data ? mapPortalInviteRow(primary.data as unknown as Record<string, unknown>) : null;

  const legacy = await supabaseClient
    .from("portal_invites")
    .update({
      status,
      updated_at: new Date().toISOString(),
    })
    .eq("id", portalInviteId)
    .eq("organization_id", organizationId)
    .select(LEGACY_PORTAL_INVITE_COLUMNS)
    .single();

  if (legacy.error) throw new Error(legacy.error.message || primary.error.message || "Portal invite status update failed");
  return legacy.data ? mapPortalInviteRow(legacy.data as unknown as Record<string, unknown>) : null;
}

export async function deletePortalInvite(portalInviteId: string) {
  const organizationId = await getCurrentOrgId();
  if (!isUuid(portalInviteId)) return;

  const { error } = await supabaseClient.from("portal_invites").delete().eq("id", portalInviteId).eq("organization_id", organizationId);
  if (error) throw new Error(error.message || "Portal invite delete failed");
}
