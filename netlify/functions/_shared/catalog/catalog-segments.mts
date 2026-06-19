export type CatalogMarketSegment =
  | "pc"
  | "cv"
  | "lcv"
  | "motorcycle"
  | "engines"
  | "universal"
  | "marine"
  | "industrial"
  | "agriculture";

const SEGMENT_OPTIONS: Array<{ value: CatalogMarketSegment; label: string }> = [
  { value: "pc", label: "PC" },
  { value: "cv", label: "CV" },
  { value: "lcv", label: "LCV" },
  { value: "motorcycle", label: "Motorcycle" },
  { value: "engines", label: "Engines" },
  { value: "universal", label: "Universal" },
  { value: "marine", label: "Marine" },
  { value: "industrial", label: "Industrial" },
  { value: "agriculture", label: "Agriculture" },
];

const SEGMENT_LABELS = new Map(SEGMENT_OPTIONS.map((option) => [option.value, option.label]));

const SEGMENT_ALIASES: Record<string, CatalogMarketSegment> = {
  pc: "pc",
  pkw: "pc",
  passengercar: "pc",
  passenger_car: "pc",
  passenger_cars: "pc",
  passenger_vehicle: "pc",
  passengervehicle: "pc",
  passenger_vehicles: "pc",
  car: "pc",
  cv: "cv",
  truck: "cv",
  truckbus: "cv",
  truck_bus: "cv",
  truck_bus_commercial: "cv",
  truck_bus_light_commercial: "cv",
  commercial: "cv",
  commercial_vehicle: "cv",
  commercialvehicle: "cv",
  commercial_vehicles: "cv",
  lkw: "cv",
  lcv: "lcv",
  light_commercial: "lcv",
  lightcommercial: "lcv",
  light_commercial_vehicle: "lcv",
  lightcommercialvehicle: "lcv",
  light_commercial_vehicles: "lcv",
  van: "lcv",
  motorcycle: "motorcycle",
  motorbike: "motorcycle",
  motorcycles: "motorcycle",
  motorbikes: "motorcycle",
  bike: "motorcycle",
  engine: "engines",
  engines: "engines",
  powertrain: "engines",
  universal: "universal",
  marine: "marine",
  industrial: "industrial",
  agriculture: "agriculture",
  agricultural: "agriculture",
  agri: "agriculture",
};

export const CATALOG_MARKET_SEGMENT_OPTIONS = SEGMENT_OPTIONS;

export function normalizeCatalogMarketSegment(value: string | null | undefined): CatalogMarketSegment | null {
  const text = String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[\s-]+/g, "_")
    .replace(/[^a-z_]/g, "")
    .trim();

  if (!text) return null;
  if (SEGMENT_ALIASES[text]) return SEGMENT_ALIASES[text];

  switch (text) {
    case "pc":
    case "cv":
    case "lcv":
    case "motorcycle":
    case "engines":
    case "universal":
    case "marine":
    case "industrial":
    case "agriculture":
      return text;
    default:
      return null;
  }
}

export function formatCatalogMarketSegmentLabel(value: string | null | undefined) {
  const normalized = normalizeCatalogMarketSegment(value);
  if (!normalized) return "Unassigned";
  return SEGMENT_LABELS.get(normalized) || normalized;
}
