import { fetchWithTimeout } from "./fetchWithTimeout";
import { normalizeAppLanguage, type AppLanguage } from "../../shared/i18n";
import { sanitizeUserFacingMessage } from "../../shared/userMessage";

type AppLocaleResponse = {
  countryCode?: string;
  source?: string;
  suggestedLanguage?: string;
};

export type SuggestedAppLocale = {
  countryCode: string;
  source: "country" | "header" | "default";
  suggestedLanguage: AppLanguage;
};

export async function fetchSuggestedAppLocale(): Promise<SuggestedAppLocale> {
  const response = await fetchWithTimeout("/api/app-locale", { method: "GET", headers: { Accept: "application/json" } }, 4000, "Locale lookup");
  const payload = (await response.json().catch(() => ({}))) as AppLocaleResponse & { error?: string };

  if (!response.ok) {
    throw new Error(sanitizeUserFacingMessage(payload.error || `Locale lookup failed: ${response.status}`, "Language lookup failed right now."));
  }

  const source = payload.source === "country" || payload.source === "header" ? payload.source : "default";
  return {
    countryCode: String(payload.countryCode || "").trim().toUpperCase(),
    source,
    suggestedLanguage: normalizeAppLanguage(payload.suggestedLanguage),
  };
}
