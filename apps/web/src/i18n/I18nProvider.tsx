import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { enMessages } from "./locales/en";
import { trMessages } from "./locales/tr";

export const supportedLocales = ["en", "tr"] as const;
export type LocaleCode = (typeof supportedLocales)[number];

const localeLabels: Record<LocaleCode, string> = {
  en: "English",
  tr: "Türkçe",
};

const localeStorageKey = "next-master-locale";

type MessageTree = Record<string, Record<string, string>>;

type LocalePreferenceInput = {
  preferredLocale?: string | null;
  storedLocale?: string | null;
  browserLocale?: string | null;
};

type I18nContextValue = {
  locale: LocaleCode;
  localeOptions: Array<{ value: LocaleCode; label: string }>;
  setLocale: (nextLocale: LocaleCode) => void;
  t: (path: string, params?: Record<string, string | number>) => string;
};

const I18nContext = createContext<I18nContextValue | null>(null);

const messagesByLocale: Record<LocaleCode, MessageTree> = {
  en: enMessages,
  tr: trMessages,
};

function normalizeLocaleCandidate(value: string | null | undefined): LocaleCode | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized.startsWith("tr")) return "tr";
  if (normalized.startsWith("en")) return "en";
  return null;
}

function readStoredLocale(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const stored = window.localStorage.getItem(localeStorageKey);
    return stored;
  } catch {
    return null;
  }
}

function writeStoredLocale(locale: LocaleCode) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(localeStorageKey, locale);
  } catch {
    // Best effort only.
  }
}

function readBrowserLocale(): string | null {
  if (typeof navigator === "undefined") return null;
  const candidates = [...(navigator.languages || []), navigator.language];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const normalized = candidate.trim();
    if (normalized) return normalized;
  }
  return null;
}

function resolveMessage(tree: MessageTree, path: string) {
  const [namespace, ...rest] = path.split(".");
  if (!namespace || !rest.length) return undefined;
  const group = tree[namespace];
  if (!group) return undefined;
  return group[rest.join(".")];
}

function interpolate(template: string, params: Record<string, string | number>) {
  return Object.entries(params).reduce((result, [key, value]) => result.replaceAll(`{${key}}`, String(value)), template);
}

function humanizeMissingPath(path: string) {
  const acronyms: Record<string, string> = {
    csv: "CSV",
    id: "ID",
    pdf: "PDF",
    po: "PO",
    sku: "SKU",
    tsv: "TSV",
  };

  const readable = path
    .split(".")
    .slice(1)
    .join(" ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!readable) return path;

  return readable
    .split(" ")
    .map((token, index) => {
      const lower = token.toLowerCase();
      if (acronyms[lower]) return acronyms[lower];
      if (index === 0) return token.charAt(0).toUpperCase() + token.slice(1);
      return token;
    })
    .join(" ");
}

export function resolveLocalePreference({
  preferredLocale,
  storedLocale,
  browserLocale,
}: LocalePreferenceInput): LocaleCode {
  return (
    normalizeLocaleCandidate(preferredLocale) ??
    normalizeLocaleCandidate(storedLocale) ??
    normalizeLocaleCandidate(browserLocale) ??
    "en"
  );
}

function createTranslator(locale: LocaleCode) {
  const currentMessages = messagesByLocale[locale];
  const fallbackMessages = messagesByLocale.en;
  return (path: string, params?: Record<string, string | number>) => {
    const current = resolveMessage(currentMessages, path);
    if (typeof current === "string") return params ? interpolate(current, params) : current;
    const fallback = resolveMessage(fallbackMessages, path);
    if (typeof fallback === "string") return params ? interpolate(fallback, params) : fallback;
    return humanizeMissingPath(path);
  };
}

export function I18nProvider({
  children,
  preferredLocale,
}: {
  children: ReactNode;
  preferredLocale?: string | null;
}) {
  const [locale, setLocaleState] = useState<LocaleCode>(() =>
    resolveLocalePreference({
      preferredLocale,
      storedLocale: readStoredLocale(),
      browserLocale: readBrowserLocale(),
    }),
  );

  const t = useMemo(() => createTranslator(locale), [locale]);

  const setLocale = useCallback((nextLocale: LocaleCode) => {
    setLocaleState(nextLocale);
  }, []);

  useEffect(() => {
    const nextLocale = normalizeLocaleCandidate(preferredLocale);
    if (!nextLocale) return;
    setLocaleState((current) => (current === nextLocale ? current : nextLocale));
  }, [preferredLocale]);

  useEffect(() => {
    writeStoredLocale(locale);
    if (typeof document !== "undefined") {
      document.documentElement.lang = locale;
      document.documentElement.dir = "ltr";
    }
  }, [locale]);

  const value = useMemo<I18nContextValue>(
    () => ({
      locale,
      localeOptions: supportedLocales.map((value) => ({ value, label: localeLabels[value] })),
      setLocale,
      t,
    }),
    [locale, setLocale, t],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const context = useContext(I18nContext);
  if (!context) {
    throw new Error("useI18n must be used within I18nProvider");
  }
  return context;
}
