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
  if (lower === "hella") return "Hella";
  if (lower === "knecht") return "Knecht";
  if (lower === "clevite") return "Clevite";
  if (lower === "purolatorindia") return "Purolator India";
  if (lower === "metalleve") return "Metal Leve";
  if (lower === "izumi") return "Izumi";
  if (lower === "barum") return "Barum Tires";
  if (lower === "barumtires") return "Barum Tires";
  if (lower === "continental") return "Continental";
  if (lower === "continentalctam") return "Continental CTAM";
  if (lower === "continentaltires") return "Continental Tires";
  if (lower === "contitech") return "ContiTech Air Spring";
  if (lower === "contitechairspring") return "ContiTech Air Spring";
  if (lower === "galfer") return "Galfer";
  if (lower === "generaltire") return "General Tire";
  if (lower === "matador") return "Matador";
  if (lower === "phoenix") return "Phoenix";
  if (lower === "primeride") return "Prime-Ride";
  if (lower === "uniroyal") return "Uniroyal";
  if (lower === "vdo") return "VDO/Continental";
  if (lower === "vdocontinental") return "VDO/Continental";
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
