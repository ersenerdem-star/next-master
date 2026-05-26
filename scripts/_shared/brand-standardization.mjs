function normalizeBrandKey(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

const BRAND_STANDARDS = [
  {
    keys: ["LEMFORDER", "LEMFÖRDER"],
    canonical: "Lemforder",
    sparetoQuery: "LEMFÖRDER",
    sparetoSlug: "lemforder",
  },
  {
    keys: ["BOSCH"],
    canonical: "Bosch",
    sparetoQuery: "BOSCH",
    sparetoSlug: "bosch",
  },
  {
    keys: ["WABCO"],
    canonical: "WABCO",
    sparetoQuery: "WABCO",
    sparetoSlug: "wabco",
  },
  {
    keys: ["TRW"],
    canonical: "TRW",
    sparetoQuery: "TRW",
    sparetoSlug: "trw",
  },
  {
    keys: ["MANN", "MANNFILTER", "MANN-FILTER"],
    canonical: "Mann",
    sparetoQuery: "MANN-FILTER",
    sparetoSlug: "mann-filter",
  },
  {
    keys: ["SACHS"],
    canonical: "Sachs",
    sparetoQuery: "SACHS",
    sparetoSlug: "sachs",
  },
  {
    keys: ["NRF"],
    canonical: "NRF",
    sparetoQuery: "NRF",
    sparetoSlug: "nrf",
  },
  {
    keys: ["SKF"],
    canonical: "SKF",
    sparetoQuery: "SKF",
    sparetoSlug: "skf",
  },
  {
    keys: ["KNORRBREMSE", "KNORR-BREMSE"],
    canonical: "Knorr-Bremse",
    sparetoQuery: "Knorr-Bremse",
    sparetoSlug: "knorr-bremse",
  },
  {
    keys: ["FAG"],
    canonical: "FAG",
    sparetoQuery: "FAG",
    sparetoSlug: "fag",
  },
  {
    keys: ["NISSENS"],
    canonical: "Nissens",
    sparetoQuery: "NISSENS",
    sparetoSlug: "nissens",
  },
  {
    keys: ["INA"],
    canonical: "INA",
    sparetoQuery: "INA",
    sparetoSlug: "ina",
  },
  {
    keys: ["DONALDSON"],
    canonical: "Donaldson",
    sparetoQuery: "DONALDSON",
    sparetoSlug: "donaldson",
  },
  {
    keys: ["VALEO"],
    canonical: "Valeo",
    sparetoQuery: "VALEO",
    sparetoSlug: "valeo",
  },
  {
    keys: ["HEPU"],
    canonical: "HEPU",
    sparetoQuery: "HEPU",
    sparetoSlug: "hepu",
  },
];

function buildFallbackSlug(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function resolveBrandStandard(value) {
  const raw = String(value || "").trim();
  const key = normalizeBrandKey(raw);
  const match = BRAND_STANDARDS.find((item) => item.keys.some((entry) => normalizeBrandKey(entry) === key));
  if (match) return match;
  return {
    keys: [raw],
    canonical: raw,
    sparetoQuery: raw,
    sparetoSlug: buildFallbackSlug(raw),
  };
}

export function canonicalizeBrandName(value) {
  return resolveBrandStandard(value).canonical;
}

export function resolveSparetoBrandQuery(value) {
  return resolveBrandStandard(value).sparetoQuery;
}

export function resolveSparetoBrandSlug(value) {
  return resolveBrandStandard(value).sparetoSlug;
}
