export function canonicalizeInternalBrandName(input: string) {
  const value = String(input || "").trim();
  if (!value) return "";
  const lower = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
  if (lower === "lemforder") return "Lemforder";
  if (lower === "wabco") return "WABCO";
  if (lower === "trw") return "TRW";
  if (lower === "bosch") return "Bosch";
  if (lower === "mann" || lower === "mannfilter") return "Mann";
  if (lower === "sachs") return "Sachs";
  if (lower === "nrf") return "NRF";
  if (lower === "skf") return "SKF";
  if (lower === "knorrbremse") return "Knorr-Bremse";
  if (lower === "fag") return "FAG";
  if (lower === "nissens") return "Nissens";
  if (lower === "ina") return "INA";
  if (lower === "donaldson") return "Donaldson";
  if (lower === "valeo") return "Valeo";
  if (lower === "fte") return "FTE";
  if (lower === "swf") return "SWF";
  if (lower === "hepu") return "HEPU";
  if (lower === "zf") return "ZF";
  if (lower === "boge") return "Boge";
  return value;
}

export function normalizeBrandKey(value: string) {
  return String(value || "")
    .trim()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}
