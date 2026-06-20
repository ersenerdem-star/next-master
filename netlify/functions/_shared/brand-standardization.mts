export function canonicalizeInternalBrandName(input: string) {
  const value = String(input || "").trim();
  if (!value) return "";
  const lower = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
  if (lower === "lemforder") return "Lemforder";
  if (lower === "wabco") return "Wabco";
  if (lower === "trw") return "TRW";
  if (lower === "bosch") return "Bosch";
  if (lower === "mann" || lower === "mannfilter") return "Mann";
  if (lower === "sachs") return "Sachs";
  if (lower === "nrf") return "NRF";
  if (lower === "skf") return "SKF";
  if (lower === "knorrbremse") return "Knorr-Bremse";
  if (lower === "behr") return "Behr";
  if (lower === "fag") return "FAG";
  if (lower === "nissens") return "Nissens";
  if (lower === "ina") return "INA";
  if (lower === "donaldson") return "Donaldson";
  if (lower === "valeo") return "Valeo";
  if (lower === "fte") return "FTE";
  if (lower === "swf") return "SWF";
  if (lower === "brembo") return "Brembo";
  if (lower === "hengst") return "Hengst";
  if (lower === "meyle") return "Meyle";
  if (lower === "mahle") return "Mahle";
  if (lower === "dayco") return "Dayco";
  if (lower === "vitesco") return "Vitesco";
  if (lower === "payen") return "Payen";
  if (lower === "jurid" || lower === "juridparts") return "Jurid";
  if (lower === "goetze") return "Goetze";
  if (lower === "glyco") return "Glyco";
  if (lower === "nural" || lower === "nuralparts") return "Nural";
  if (lower === "ferodo") return "Ferodo";
  if (lower === "champion") return "Champion";
  if (lower === "beru") return "Beru";
  if (lower === "beral") return "Beral";
  if (lower === "monroe") return "Monroe";
  if (lower === "moog") return "Moog";
  if (lower === "walker") return "Walker";
  if (lower === "ae" || lower === "aeparts") return "AE";
  if (lower === "fpdiesel" || lower === "fp-diesel") return "FP Diesel";
  if (lower === "hepu") return "HEPU";
  if (lower === "holset") return "Holset";
  if (lower === "borgwarner" || lower === "borgwagner") return "BorgWarner";
  if (lower === "garrett") return "Garrett";
  if (lower === "kkk") return "KKK";
  if (lower === "schwitzer") return "Schwitzer";
  if (lower === "ihi") return "IHI";
  if (lower === "mitsubishiturbochargers") return "Mitsubishi Turbochargers";
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
