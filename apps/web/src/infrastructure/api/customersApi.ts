import type { LocalCustomer } from "../../types/customers";
import { createEmptyCustomer } from "../../shared/localCustomers";
import { callAppAdminRecords } from "./appAdminRecordsApi";
import { getCurrentOrgId, isUuid } from "./organizationApi";

const CUSTOMER_COLUMNS = [
  "id",
  "customer_type",
  "salutation",
  "first_name",
  "last_name",
  "company_name",
  "display_name",
  "email",
  "customer_number",
  "work_phone",
  "mobile_phone",
  "language",
  "tax_rate",
  "company_id",
  "currency",
  "payment_terms",
  "contract_nr",
  "seller_company_profile_id",
  "price_list_type",
  "price_list_margin_percent",
  "billing_address",
  "shipping_address",
  "contact_persons",
  "custom_fields",
  "reporting_tags",
  "remarks",
  "created_at",
  "updated_at",
].join(",");

let customersCacheOrgId = "";
let customersCacheValue: LocalCustomer[] | null = null;
let customersCachePromise: Promise<LocalCustomer[]> | null = null;

function clearCustomersCache() {
  customersCacheValue = null;
  customersCachePromise = null;
}

function mapCustomerRow(row: Record<string, unknown>): LocalCustomer {
  return {
    id: String(row.id || ""),
    customer_type: String(row.customer_type || "Business") as LocalCustomer["customer_type"],
    salutation: String(row.salutation || ""),
    first_name: String(row.first_name || ""),
    last_name: String(row.last_name || ""),
    company_name: String(row.company_name || ""),
    display_name: String(row.display_name || ""),
    email: String(row.email || ""),
    customer_number: String(row.customer_number || ""),
    work_phone: String(row.work_phone || ""),
    mobile_phone: String(row.mobile_phone || ""),
    language: String(row.language || "English"),
    tax_rate: String(row.tax_rate || ""),
    company_id: String(row.company_id || ""),
    currency: String(row.currency || "EUR"),
    payment_terms: String(row.payment_terms || "Cash in Advance"),
    contract_nr: String(row.contract_nr || ""),
    seller_company_profile_id: String(row.seller_company_profile_id || ""),
    price_list_type: String(row.price_list_type || "A") as LocalCustomer["price_list_type"],
    price_list_margin_percent: row.price_list_margin_percent == null ? null : Number(row.price_list_margin_percent),
    billing_address: String(row.billing_address || ""),
    shipping_address: String(row.shipping_address || ""),
    contact_persons: String(row.contact_persons || ""),
    custom_fields: String(row.custom_fields || ""),
    reporting_tags: String(row.reporting_tags || ""),
    remarks: String(row.remarks || ""),
    created_at: String(row.created_at || ""),
    updated_at: String(row.updated_at || ""),
  };
}

function mapCustomerPayload(input: LocalCustomer, organizationId: string) {
  return {
    organization_id: organizationId,
    customer_type: input.customer_type,
    salutation: input.salutation,
    first_name: input.first_name,
    last_name: input.last_name,
    company_name: input.company_name,
    display_name: input.display_name.trim() || input.company_name.trim() || `${input.first_name} ${input.last_name}`.trim(),
    email: input.email,
    customer_number: input.customer_number,
    work_phone: input.work_phone,
    mobile_phone: input.mobile_phone,
    language: input.language,
    tax_rate: input.tax_rate,
    company_id: input.company_id,
    currency: input.currency,
    payment_terms: input.payment_terms,
    contract_nr: input.contract_nr,
    seller_company_profile_id: input.seller_company_profile_id || null,
    price_list_type: input.price_list_type,
    price_list_margin_percent: input.price_list_margin_percent,
    billing_address: input.billing_address,
    shipping_address: input.shipping_address,
    contact_persons: input.contact_persons,
    custom_fields: input.custom_fields,
    reporting_tags: input.reporting_tags,
    remarks: input.remarks,
    created_at: input.created_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

async function bootstrapCustomersFromLocalIfNeeded() {
  return;
}

export async function fetchCustomers(): Promise<LocalCustomer[]> {
  const organizationId = await getCurrentOrgId();
  if (customersCacheValue && customersCacheOrgId === organizationId) return customersCacheValue;
  if (customersCachePromise && customersCacheOrgId === organizationId) return customersCachePromise;

  customersCacheOrgId = organizationId;
  customersCachePromise = (async () => {
    await bootstrapCustomersFromLocalIfNeeded();
    const data = await callAppAdminRecords<Array<Record<string, unknown>>>({
      resource: "customers",
      action: "list",
    });
    const rows = data.map(mapCustomerRow);
    customersCacheValue = rows;
    customersCachePromise = null;
    return rows;
  })().catch((error) => {
    customersCachePromise = null;
    throw error;
  });

  return customersCachePromise;
}

export function createEmptyCloudCustomer(existingRows: LocalCustomer[] = []) {
  const nextNumber = `CUS-${String(existingRows.length + 1).padStart(5, "0")}`;
  return {
    ...createEmptyCustomer(),
    customer_number: nextNumber,
  };
}

export async function upsertCustomer(input: LocalCustomer): Promise<LocalCustomer> {
  const organizationId = await getCurrentOrgId();
  const payload = mapCustomerPayload(input, organizationId);

  const data = await callAppAdminRecords<Record<string, unknown>>({
    resource: "customers",
    action: "upsert",
    id: isUuid(input.id) ? input.id : "",
    payload,
  });
  clearCustomersCache();
  return mapCustomerRow(data);
}

export async function deleteCustomer(customerId: string) {
  const organizationId = await getCurrentOrgId();
  if (!isUuid(customerId)) return;

  await callAppAdminRecords({
    resource: "customers",
    action: "delete",
    id: customerId,
  });
  clearCustomersCache();
}

export function findCustomerByNameInList(customers: LocalCustomer[], name: string) {
  const key = name.trim().toLowerCase();
  return (
    customers.find((item) => item.display_name.trim().toLowerCase() === key || item.company_name.trim().toLowerCase() === key) || null
  );
}
