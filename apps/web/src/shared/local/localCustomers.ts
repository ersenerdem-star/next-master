import type { LocalCustomer } from "../../types/customers";

const CUSTOMERS_KEY = "master-next-customers";

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

function makeCustomerNumber(index: number) {
  return `CUS-${String(index).padStart(5, "0")}`;
}

export function loadLocalCustomers() {
  return readJson<LocalCustomer[]>(CUSTOMERS_KEY, []);
}

export function saveLocalCustomers(rows: LocalCustomer[]) {
  writeJson(CUSTOMERS_KEY, rows);
}

export function createEmptyCustomer(): LocalCustomer {
  const existing = loadLocalCustomers();
  const nextNumber = makeCustomerNumber(existing.length + 1);
  return {
    id: makeId("cust"),
    customer_type: "Business",
    salutation: "",
    first_name: "",
    last_name: "",
    company_name: "",
    display_name: "",
    email: "",
    customer_number: nextNumber,
    work_phone: "",
    mobile_phone: "",
    language: "English",
    tax_rate: "",
    company_id: "",
    currency: "EUR",
    payment_terms: "Cash in Advance",
    contract_nr: "",
    seller_company_profile_id: "",
    price_list_type: "",
    portal_c_price_mode: "standard",
    price_list_margin_percent: null,
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

export function upsertLocalCustomer(input: LocalCustomer) {
  const current = loadLocalCustomers();
  const previous = current.find((item) => item.id === input.id);
  const nextCustomer: LocalCustomer = {
    ...input,
    display_name: input.display_name.trim() || input.company_name.trim() || `${input.first_name} ${input.last_name}`.trim(),
    created_at: previous?.created_at || input.created_at || nowIso(),
    updated_at: nowIso(),
  };
  const next = [nextCustomer, ...current.filter((item) => item.id !== input.id)].sort((a, b) => String(a.display_name || a.company_name).localeCompare(String(b.display_name || b.company_name)));
  saveLocalCustomers(next);
  return nextCustomer;
}

export function deleteLocalCustomer(id: string) {
  const next = loadLocalCustomers().filter((item) => item.id !== id);
  saveLocalCustomers(next);
}

export function findCustomerByName(name: string) {
  const key = name.trim().toLowerCase();
  return loadLocalCustomers().find((item) => {
    return (
      item.display_name.trim().toLowerCase() === key ||
      item.company_name.trim().toLowerCase() === key
    );
  }) || null;
}
