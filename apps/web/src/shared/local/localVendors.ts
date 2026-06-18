import type { LocalVendor } from "../../types/vendors";

const VENDORS_KEY = "master-next-vendors";

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

function nowIso() {
  return new Date().toISOString();
}

function makeId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function makeVendorNumber(index: number) {
  return `VEN-${String(index).padStart(5, "0")}`;
}

export function loadLocalVendors() {
  return readJson<LocalVendor[]>(VENDORS_KEY, []);
}

export function createEmptyVendor(existingRows: LocalVendor[] = []): LocalVendor {
  return {
    id: makeId("vend"),
    vendor_type: "Business",
    salutation: "",
    first_name: "",
    last_name: "",
    company_name: "",
    display_name: "",
    email: "",
    vendor_number: makeVendorNumber(existingRows.length + 1),
    work_phone: "",
    mobile_phone: "",
    language: "English",
    tax_rate: "",
    company_id: "",
    currency: "EUR",
    payment_terms: "Cash in Advance",
    billing_address: "",
    shipping_address: "",
    contact_persons: "",
    custom_fields: "",
    reporting_tags: "",
    remarks: "",
    created_at: nowIso(),
    updated_at: nowIso(),
  };
}

export function saveLocalVendors(rows: LocalVendor[]) {
  writeJson(VENDORS_KEY, rows);
}
