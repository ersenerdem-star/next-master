const ENTITY_ALIAS_OVERRIDES: Array<{ match: string; alias: string }> = [
  { match: "fuatti dis ticaret", alias: "Fuatti" },
  { match: "asad otomotiv", alias: "Asad" },
  { match: "farsak otomotiv", alias: "Farsak" },
  { match: "f a logistic", alias: "F.A." },
  { match: "llc yural", alias: "Yural" },
  { match: "fort co ltd", alias: "Fort" },
];

function normalizeEntityAliasKey(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function buildEntityAlias(value: string | null | undefined) {
  const source = String(value || "").trim();
  if (!source) return "-";

  const normalized = normalizeEntityAliasKey(source);
  const override = ENTITY_ALIAS_OVERRIDES.find((item) => normalized === item.match || normalized.startsWith(`${item.match} `));
  if (override) return override.alias;

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
