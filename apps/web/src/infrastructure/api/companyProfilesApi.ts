import type { CompanyProfile } from "../../types/company";
import { emptyCompanyProfile } from "../../shared/companyProfile";
import { callAppAdminRecords } from "./appAdminRecordsApi";
import { getCurrentOrgId, isUuid } from "./organizationApi";

const COMPANY_PROFILE_COLUMNS = [
  "id",
  "company_name",
  "email",
  "phone",
  "website",
  "address",
  "bank_details",
  "tax_office",
  "tax_number",
  "footer_note",
  "logo_data_url",
].join(",");

let companyProfilesCacheOrgId = "";
let companyProfilesCacheValue: CompanyProfile[] | null = null;
let companyProfilesCachePromise: Promise<CompanyProfile[]> | null = null;

function clearCompanyProfilesCache() {
  companyProfilesCacheValue = null;
  companyProfilesCachePromise = null;
}

function mapCompanyProfileRow(row: Record<string, unknown>): CompanyProfile {
  return {
    id: String(row.id || ""),
    companyName: String(row.company_name || ""),
    email: String(row.email || ""),
    phone: String(row.phone || ""),
    website: String(row.website || ""),
    address: String(row.address || ""),
    bankDetails: String(row.bank_details || ""),
    taxOffice: String(row.tax_office || ""),
    taxNumber: String(row.tax_number || ""),
    footerNote: String(row.footer_note || ""),
    logoDataUrl: String(row.logo_data_url || ""),
  };
}

function mapCompanyProfilePayload(input: CompanyProfile, organizationId: string) {
  return {
    organization_id: organizationId,
    company_name: input.companyName.trim(),
    email: input.email,
    phone: input.phone,
    website: input.website,
    address: input.address,
    bank_details: input.bankDetails,
    tax_office: input.taxOffice,
    tax_number: input.taxNumber,
    footer_note: input.footerNote,
    logo_data_url: input.logoDataUrl,
    updated_at: new Date().toISOString(),
  };
}

async function bootstrapCompanyProfilesFromLocalIfNeeded() {
  return;
}

export async function fetchCompanyProfiles(): Promise<CompanyProfile[]> {
  const organizationId = await getCurrentOrgId();
  if (companyProfilesCacheValue && companyProfilesCacheOrgId === organizationId) return companyProfilesCacheValue;
  if (companyProfilesCachePromise && companyProfilesCacheOrgId === organizationId) return companyProfilesCachePromise;

  companyProfilesCacheOrgId = organizationId;
  companyProfilesCachePromise = (async () => {
    await bootstrapCompanyProfilesFromLocalIfNeeded();
    const data = await callAppAdminRecords<Array<Record<string, unknown>>>({
      resource: "companyProfiles",
      action: "list",
    });
    const rows = data.map(mapCompanyProfileRow);
    companyProfilesCacheValue = rows;
    companyProfilesCachePromise = null;
    return rows;
  })().catch((error) => {
    companyProfilesCachePromise = null;
    throw error;
  });

  return companyProfilesCachePromise;
}

export function createEmptyCloudCompanyProfile() {
  return {
    ...emptyCompanyProfile,
    id: `company-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  };
}

export async function upsertCompanyProfile(input: CompanyProfile): Promise<CompanyProfile> {
  const organizationId = await getCurrentOrgId();
  const payload = mapCompanyProfilePayload(input, organizationId);

  const data = await callAppAdminRecords<Record<string, unknown>>({
    resource: "companyProfiles",
    action: "upsert",
    id: isUuid(input.id) ? input.id : "",
    payload: isUuid(input.id)
      ? payload
      : {
          ...payload,
          created_at: new Date().toISOString(),
        },
  });
  clearCompanyProfilesCache();
  return mapCompanyProfileRow(data);
}

export async function deleteCompanyProfileById(profileId: string) {
  const organizationId = await getCurrentOrgId();
  if (!isUuid(profileId)) return;

  await callAppAdminRecords({
    resource: "companyProfiles",
    action: "delete",
    id: profileId,
  });
  clearCompanyProfilesCache();
}

export function findCompanyProfileByName(profiles: CompanyProfile[], companyName: string) {
  const key = companyName.trim();
  if (!key) return profiles[0] || null;
  return profiles.find((item) => item.companyName === key) || profiles[0] || null;
}
