const ENTITY_ALIAS_OVERRIDES: Record<string, string> = {
  "fuatti dis ticaret ltd. sti.": "Fuatti",
  "fuatti dış ticaret ltd. şti.": "Fuatti",
  "asad otomotiv sanayi ve ticaret ltd.": "Asad",
  "farsak otomotiv": "Farsak",
  "f.a. logistic ltd.": "F.A.",
  "llc yural": "Yural",
  "fort co.ltd": "Fort",
  "fort co. ltd": "Fort",
};

export function buildEntityAlias(value: string | null | undefined) {
  const source = String(value || "").trim();
  if (!source) return "-";

  const normalized = source.toLowerCase();
  const directOverride = ENTITY_ALIAS_OVERRIDES[normalized];
  if (directOverride) return directOverride;

  const rawTokens = source.split(/\s+/).filter(Boolean);
  const stopWords = new Set([
    "sanayi",
    "ticaret",
    "limited",
    "ltd",
    "ltd.",
    "sti",
    "şti",
    "sti.",
    "şti.",
    "sirketi",
    "şirketi",
    "otomotiv",
    "dis",
    "dış",
    "ve",
    "co",
    "co.",
    "company",
    "gmbh",
    "sro",
    "s.r.o.",
    "llc",
    "inc",
    "corp",
    "bv",
    "ag",
  ]);

  const significantTokens = rawTokens.filter((token) => !stopWords.has(token.toLowerCase()));
  const aliasTokens = (significantTokens.length >= 2 ? significantTokens : rawTokens).slice(0, 2);
  return aliasTokens.join(" ");
}
