import { fetchCloudSuppliers } from "./suppliersApi";
import { loadLocalVendors, createEmptyVendor } from "../../shared/localVendors";
import type { LocalVendor } from "../../types/vendors";
import { supabaseClient } from "./supabaseClient";
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
  const organizationId = await getCurrentOrgId();
  const { count, error: countError } = await supabaseClient
    .from("vendors")
    .select("id", { count: "planned", head: true })
    .eq("organization_id", organizationId);

  if (countError) throw new Error(countError.message || "Vendor bootstrap check failed");
  if ((count || 0) > 0) return;

  const localRows = loadLocalVendors();
  const seedRows = localRows.length
    ? localRows
    : (await fetchCloudSuppliers()).map((supplier, index) => ({
        ...createEmptyVendor([]),
        company_name: supplier.name,
        display_name: supplier.name,
        vendor_number: `VEN-${String(index + 1).padStart(5, "0")}`,
      }));

  if (!seedRows.length) return;

  const payload = seedRows.map((row) => mapVendorPayload(row, organizationId));
  const { error } = await supabaseClient.from("vendors").insert(payload);
  if (error) throw new Error(error.message || "Vendor bootstrap failed");
}

export async function fetchVendors(): Promise<LocalVendor[]> {
  const organizationId = await getCurrentOrgId();
  if (vendorsCacheValue && vendorsCacheOrgId === organizationId) return vendorsCacheValue;
  if (vendorsCachePromise && vendorsCacheOrgId === organizationId) return vendorsCachePromise;

  vendorsCacheOrgId = organizationId;
  vendorsCachePromise = (async () => {
    await bootstrapVendorsIfNeeded();
    const { data, error } = await supabaseClient
      .from("vendors")
      .select(VENDOR_COLUMNS)
      .eq("organization_id", organizationId)
      .order("display_name", { ascending: true });

    if (error) throw new Error(error.message || "Vendors load failed");
    const rows = ((data || []) as unknown as Record<string, unknown>[]).map(mapVendorRow);
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

  if (isUuid(input.id)) {
    const { data, error } = await supabaseClient
      .from("vendors")
      .update(payload)
      .eq("id", input.id)
      .eq("organization_id", organizationId)
      .select(VENDOR_COLUMNS)
      .single();

    if (error) throw new Error(error.message || "Vendor save failed");
    clearVendorsCache();
    return mapVendorRow(data as unknown as Record<string, unknown>);
  }

  const { data, error } = await supabaseClient.from("vendors").insert(payload).select(VENDOR_COLUMNS).single();
  if (error) throw new Error(error.message || "Vendor create failed");
  clearVendorsCache();
  return mapVendorRow(data as unknown as Record<string, unknown>);
}

export async function deleteVendor(vendorId: string) {
  const organizationId = await getCurrentOrgId();
  if (!isUuid(vendorId)) return;
  const { error } = await supabaseClient.from("vendors").delete().eq("id", vendorId).eq("organization_id", organizationId);
  if (error) throw new Error(error.message || "Vendor delete failed");
  clearVendorsCache();
}
