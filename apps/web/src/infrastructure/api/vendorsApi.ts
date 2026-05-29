import { fetchCloudSuppliers } from "./suppliersApi";
import { createEmptyVendor } from "../../shared/localVendors";
import type { LocalVendor } from "../../types/vendors";
import { callAppAdminRecords } from "./appAdminRecordsApi";
import { getCurrentOrgId, isUuid } from "./organizationApi";

const VENDOR_COLUMNS = [
  "id",
  "vendor_type",
  "salutation",
  "first_name",
  "last_name",
  "company_name",
  "display_name",
  "email",
  "vendor_number",
  "work_phone",
  "mobile_phone",
  "language",
  "tax_rate",
  "company_id",
  "currency",
  "payment_terms",
  "billing_address",
  "shipping_address",
  "contact_persons",
  "custom_fields",
  "reporting_tags",
  "remarks",
  "created_at",
  "updated_at",
].join(",");

let vendorsCacheOrgId = "";
let vendorsCacheValue: LocalVendor[] | null = null;
let vendorsCachePromise: Promise<LocalVendor[]> | null = null;

function clearVendorsCache() {
  vendorsCacheValue = null;
  vendorsCachePromise = null;
}

function mapVendorRow(row: Record<string, unknown>): LocalVendor {
  return {
    id: String(row.id || ""),
    vendor_type: String(row.vendor_type || "Business") as LocalVendor["vendor_type"],
    salutation: String(row.salutation || ""),
    first_name: String(row.first_name || ""),
    last_name: String(row.last_name || ""),
    company_name: String(row.company_name || ""),
    display_name: String(row.display_name || ""),
    email: String(row.email || ""),
    vendor_number: String(row.vendor_number || ""),
    work_phone: String(row.work_phone || ""),
    mobile_phone: String(row.mobile_phone || ""),
    language: String(row.language || "English"),
    tax_rate: String(row.tax_rate || ""),
    company_id: String(row.company_id || ""),
    currency: String(row.currency || "EUR"),
    payment_terms: String(row.payment_terms || "Cash in Advance"),
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

function mapVendorPayload(input: LocalVendor, organizationId: string) {
  return {
    organization_id: organizationId,
    vendor_type: input.vendor_type,
    salutation: input.salutation,
    first_name: input.first_name,
    last_name: input.last_name,
    company_name: input.company_name,
    display_name: input.display_name.trim() || input.company_name.trim() || `${input.first_name} ${input.last_name}`.trim(),
    email: input.email,
    vendor_number: input.vendor_number,
    work_phone: input.work_phone,
    mobile_phone: input.mobile_phone,
    language: input.language,
    tax_rate: input.tax_rate,
    company_id: input.company_id,
    currency: input.currency,
    payment_terms: input.payment_terms,
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

async function bootstrapVendorsIfNeeded() {
  return;
}

export async function fetchVendors(): Promise<LocalVendor[]> {
  const organizationId = await getCurrentOrgId();
  if (vendorsCacheValue && vendorsCacheOrgId === organizationId) return vendorsCacheValue;
  if (vendorsCachePromise && vendorsCacheOrgId === organizationId) return vendorsCachePromise;

  vendorsCacheOrgId = organizationId;
  vendorsCachePromise = (async () => {
    await bootstrapVendorsIfNeeded();
    const data = await callAppAdminRecords<Array<Record<string, unknown>>>({
      resource: "vendors",
      action: "list",
    });
    const rows = data.map(mapVendorRow);
    vendorsCacheValue = rows;
    vendorsCachePromise = null;
    return rows;
  })().catch((error) => {
    vendorsCachePromise = null;
    throw error;
  });

  return vendorsCachePromise;
}

export function createEmptyCloudVendor(existingRows: LocalVendor[] = []) {
  return {
    ...createEmptyVendor(existingRows),
  };
}

export async function upsertVendor(input: LocalVendor): Promise<LocalVendor> {
  const organizationId = await getCurrentOrgId();
  const payload = mapVendorPayload(input, organizationId);

  const data = await callAppAdminRecords<Record<string, unknown>>({
    resource: "vendors",
    action: "upsert",
    id: isUuid(input.id) ? input.id : "",
    payload,
  });
  clearVendorsCache();
  return mapVendorRow(data);
}

export async function deleteVendor(vendorId: string) {
  const organizationId = await getCurrentOrgId();
  if (!isUuid(vendorId)) return;
  await callAppAdminRecords({
    resource: "vendors",
    action: "delete",
    id: vendorId,
  });
  clearVendorsCache();
}
