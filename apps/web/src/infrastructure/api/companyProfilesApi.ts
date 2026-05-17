import type { CompanyProfile } from "../../types/company";
import { emptyCompanyProfile, loadCompanyProfiles } from "../../shared/companyProfile";
import { supabaseClient } from "./supabaseClient";
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
  const organizationId = await getCurrentOrgId();
  const localRows = loadCompanyProfiles();
  if (!localRows.length) return;

  const { count, error: countError } = await supabaseClient
    .from("company_profiles")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", organizationId);

  if (countError) throw new Error(countError.message || "Company profile bootstrap check failed");
  if ((count || 0) > 0) return;

  const payload = localRows
    .filter((row) => row.companyName.trim())
    .map((row) => ({
      ...mapCompanyProfilePayload(row, organizationId),
      created_at: new Date().toISOString(),
    }));

  if (!payload.length) return;
  const { error } = await supabaseClient.from("company_profiles").insert(payload);
  if (error) throw new Error(error.message || "Company profile bootstrap failed");
}

export async function fetchCompanyProfiles(): Promise<CompanyProfile[]> {
  const organizationId = await getCurrentOrgId();
  if (companyProfilesCacheValue && companyProfilesCacheOrgId === organizationId) return companyProfilesCacheValue;
  if (companyProfilesCachePromise && companyProfilesCacheOrgId === organizationId) return companyProfilesCachePromise;

  companyProfilesCacheOrgId = organizationId;
  companyProfilesCachePromise = (async () => {
    await bootstrapCompanyProfilesFromLocalIfNeeded();
    const { data, error } = await supabaseClient
      .from("company_profiles")
      .select(COMPANY_PROFILE_COLUMNS)
      .eq("organization_id", organizationId)
      .order("company_name", { ascending: true });

    if (error) throw new Error(error.message || "Company profiles load failed");
    const rows = ((data || []) as unknown as Record<string, unknown>[]).map(mapCompanyProfileRow);
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

  if (isUuid(input.id)) {
    const { data, error } = await supabaseClient
      .from("company_profiles")
      .update(payload)
      .eq("id", input.id)
      .eq("organization_id", organizationId)
      .select(COMPANY_PROFILE_COLUMNS)
      .single();

    if (error) throw new Error(error.message || "Company profile save failed");
    clearCompanyProfilesCache();
    return mapCompanyProfileRow(data as unknown as Record<string, unknown>);
  }

  const { data, error } = await supabaseClient
    .from("company_profiles")
    .insert({
      ...payload,
      created_at: new Date().toISOString(),
    })
    .select(COMPANY_PROFILE_COLUMNS)
    .single();

  if (error) throw new Error(error.message || "Company profile create failed");
  clearCompanyProfilesCache();
  return mapCompanyProfileRow(data as unknown as Record<string, unknown>);
}

export async function deleteCompanyProfileById(profileId: string) {
  const organizationId = await getCurrentOrgId();
  if (!isUuid(profileId)) return;

  const { error } = await supabaseClient.from("company_profiles").delete().eq("id", profileId).eq("organization_id", organizationId);
  if (error) throw new Error(error.message || "Company profile delete failed");
  clearCompanyProfilesCache();
}

export function findCompanyProfileByName(profiles: CompanyProfile[], companyName: string) {
  const key = companyName.trim();
  if (!key) return profiles[0] || null;
  return profiles.find((item) => item.companyName === key) || profiles[0] || null;
}
