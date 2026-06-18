import type { CompanyProfile } from "../../types/company";

const LEGACY_STORAGE_KEY = "master-next-company-profile";
const DIRECTORY_KEY = "master-next-company-profiles";

function nextCompanyId() {
  return `company-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function normalizeProfile(input?: Partial<CompanyProfile>): CompanyProfile {
  return {
    id: String(input?.id || nextCompanyId()),
    companyName: String(input?.companyName || ""),
    email: String(input?.email || ""),
    phone: String(input?.phone || ""),
    website: String(input?.website || ""),
    address: String(input?.address || ""),
    bankDetails: String(input?.bankDetails || ""),
    taxOffice: String(input?.taxOffice || ""),
    taxNumber: String(input?.taxNumber || ""),
    footerNote: String(input?.footerNote || ""),
    logoDataUrl: String(input?.logoDataUrl || ""),
  };
}

export const emptyCompanyProfile: CompanyProfile = normalizeProfile({ id: "company-empty" });

function readLegacyProfile(): CompanyProfile | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(LEGACY_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CompanyProfile>;
    const normalized = normalizeProfile(parsed);
    const hasContent = Object.entries(normalized).some(([key, value]) => key !== "id" && String(value).trim());
    return hasContent ? normalized : null;
  } catch {
    return null;
  }
}

export function loadCompanyProfiles(): CompanyProfile[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(DIRECTORY_KEY);
    const parsed = raw ? (JSON.parse(raw) as Partial<CompanyProfile>[]) : [];
    const rows = parsed.map((item) => normalizeProfile(item)).filter((item) => item.companyName.trim());
    if (rows.length) return rows;
    const legacy = readLegacyProfile();
    return legacy ? [legacy] : [];
  } catch {
    const legacy = readLegacyProfile();
    return legacy ? [legacy] : [];
  }
}

export function saveCompanyProfiles(profiles: CompanyProfile[]) {
  if (typeof window === "undefined") return;
  const normalized = profiles.map((item) => normalizeProfile(item)).filter((item) => item.companyName.trim());
  window.localStorage.setItem(DIRECTORY_KEY, JSON.stringify(normalized));
  if (normalized[0]) {
    window.localStorage.setItem(LEGACY_STORAGE_KEY, JSON.stringify(normalized[0]));
  }
}

export function upsertCompanyProfile(profile: CompanyProfile) {
  const normalized = normalizeProfile(profile);
  const current = loadCompanyProfiles();
  const next = [normalized, ...current.filter((item) => item.id !== normalized.id)].sort((a, b) => a.companyName.localeCompare(b.companyName));
  saveCompanyProfiles(next);
  return normalized;
}

export function deleteCompanyProfile(profileId: string) {
  const current = loadCompanyProfiles();
  saveCompanyProfiles(current.filter((item) => item.id !== profileId));
}

export function loadCompanyProfile(companyName?: string): CompanyProfile {
  const rows = loadCompanyProfiles();
  if (!rows.length) return normalizeProfile(emptyCompanyProfile);
  if (companyName) {
    const match = rows.find((item) => item.companyName === companyName);
    if (match) return match;
  }
  return rows[0];
}

export function saveCompanyProfile(profile: CompanyProfile) {
  upsertCompanyProfile(profile);
}

export function safeText(value: unknown) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function nl2br(value: string) {
  return safeText(value).replaceAll("\n", "<br />");
}
