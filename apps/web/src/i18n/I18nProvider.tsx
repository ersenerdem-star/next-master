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

type I18nContextValue = {
  locale: LocaleCode;
  localeOptions: Array<{ value: LocaleCode; label: string }>;
  setLocale: (nextLocale: LocaleCode) => void;
  t: (path: string) => string;
};

const I18nContext = createContext<I18nContextValue | null>(null);

const messagesByLocale: Record<LocaleCode, MessageTree> = {
  en: enMessages,
  tr: trMessages,
};

function isLocaleCode(value: string | null | undefined): value is LocaleCode {
  return value === "en" || value === "tr";
}

function readStoredLocale(): LocaleCode {
  if (typeof window === "undefined") return "en";
  try {
    const stored = window.localStorage.getItem(localeStorageKey);
    return isLocaleCode(stored) ? stored : "en";
  } catch {
    return "en";
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

function resolveMessage(tree: MessageTree, path: string) {
  const [namespace, ...rest] = path.split(".");
  if (!namespace || !rest.length) return undefined;
  const group = tree[namespace];
  if (!group) return undefined;
  return group[rest.join(".")];
}

function createTranslator(locale: LocaleCode) {
  const currentMessages = messagesByLocale[locale];
  const fallbackMessages = messagesByLocale.en;
  return (path: string) => {
    const current = resolveMessage(currentMessages, path);
    if (typeof current === "string") return current;
    const fallback = resolveMessage(fallbackMessages, path);
    if (typeof fallback === "string") return fallback;
    return path;
  };
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<LocaleCode>(() => readStoredLocale());

  const t = useMemo(() => createTranslator(locale), [locale]);

  const setLocale = useCallback((nextLocale: LocaleCode) => {
    setLocaleState(nextLocale);
  }, []);

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
