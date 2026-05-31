import type { PortalInvite } from "../types/portal";

const PORTAL_INVITES_KEY = "master-next-portal-invites";

function readJson<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown) {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(key, JSON.stringify(value));
}

function makeId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function nowIso() {
  return new Date().toISOString();
}

export function loadPortalInvites() {
  return readJson<PortalInvite[]>(PORTAL_INVITES_KEY, []);
}

export function savePortalInvites(rows: PortalInvite[]) {
  writeJson(PORTAL_INVITES_KEY, rows);
}

export function createEmptyPortalInvite(): PortalInvite {
  return {
    id: makeId("portal"),
    party_type: "customer",
    party_name: "",
    customer_id: "",
    vendor_id: "",
    email: "",
    contact_name: "",
    status: "draft",
    invite_token: "",
    last_sent_at: "",
    expires_at: "",
    created_at: nowIso(),
    updated_at: nowIso(),
    has_password: false,
    allowed_brand_ids: [],
    access: {
      can_view_account: true,
      can_view_invoices: true,
      can_view_payments: true,
      can_view_orders: true,
    },
  };
}

export function upsertPortalInvite(input: PortalInvite) {
  const current = loadPortalInvites();
  const previous = current.find((item) => item.id === input.id);
  const nextInvite: PortalInvite = {
    ...input,
    invite_token: input.invite_token || previous?.invite_token || "",
    created_at: previous?.created_at || input.created_at || nowIso(),
    updated_at: nowIso(),
    has_password: input.has_password ?? previous?.has_password ?? false,
  };
  const next = [nextInvite, ...current.filter((item) => item.id !== input.id)].sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  savePortalInvites(next);
  return nextInvite;
}

export function markPortalInviteSent(id: string) {
  const current = loadPortalInvites();
  const next = current.map((item) =>
    item.id === id
      ? {
          ...item,
          status: (item.status === "active" ? "active" : "invited") as PortalInvite["status"],
          last_sent_at: nowIso(),
          updated_at: nowIso(),
        }
      : item,
  );
  savePortalInvites(next);
  return next.find((item) => item.id === id) || null;
}

export function deletePortalInvite(id: string) {
  savePortalInvites(loadPortalInvites().filter((item) => item.id !== id));
}
