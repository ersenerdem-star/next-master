import type { Config, Context } from "@netlify/functions";
import { json } from "./_shared/core/http.mts";

type AppLanguage = "en" | "tr" | "ru" | "ar" | "fa" | "de";

const countryLanguageMap: Partial<Record<string, AppLanguage>> = {
  AE: "ar",
  AF: "fa",
  AT: "de",
  AZ: "ru",
  BH: "ar",
  BY: "ru",
  CH: "de",
  CY: "ar",
  DE: "de",
  DZ: "ar",
  EG: "ar",
  IQ: "ar",
  IR: "fa",
  JO: "ar",
  KG: "ru",
  KW: "ar",
  KZ: "ru",
  LB: "ar",
  LI: "de",
  LU: "de",
  LY: "ar",
  MA: "ar",
  OM: "ar",
  QA: "ar",
  RU: "ru",
  SA: "ar",
  SD: "ar",
  SY: "ar",
  TJ: "ru",
  TN: "ar",
  TR: "tr",
  UA: "ru",
  UZ: "ru",
  YE: "ar",
};

function normalizeLanguage(value: string | null | undefined): AppLanguage {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "tr" || normalized.startsWith("tr-")) return "tr";
  if (normalized === "ru" || normalized.startsWith("ru-")) return "ru";
  if (normalized === "ar" || normalized.startsWith("ar-")) return "ar";
  if (normalized === "fa" || normalized.startsWith("fa-")) return "fa";
  if (normalized === "de" || normalized.startsWith("de-")) return "de";
  return "en";
}

function parseAcceptLanguage(header: string | null) {
  if (!header) return "en" as AppLanguage;
  const first = header
    .split(",")
    .map((part) => part.split(";")[0]?.trim())
    .find(Boolean);
  return normalizeLanguage(first);
}

export default async (req: Request, context: Context) => {
  if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);

  const countryCode = String(context.geo?.country?.code || "").trim().toUpperCase();
  const countryLanguage = countryLanguageMap[countryCode];
  const headerLanguage = parseAcceptLanguage(req.headers.get("accept-language"));

  return json(
    {
      countryCode,
      source: countryLanguage ? "country" : "header",
      suggestedLanguage: countryLanguage || headerLanguage,
    },
    200,
    { "Cache-Control": "no-store" },
  );
};

export const config: Config = {
  method: "GET",
};
