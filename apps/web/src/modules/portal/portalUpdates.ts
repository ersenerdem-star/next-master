export function portalUpdateText(title: string, detail: string, preferDetail: boolean) {
  const primary = (preferDetail ? detail : title).trim();
  return primary || (preferDetail ? title : detail).trim();
}

export function portalUpdateDate(value: string | undefined, locale: string) {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat(locale === "tr" ? "tr-TR" : "en-GB", {
    dateStyle: "medium", timeStyle: "short",
  }).format(date);
}
