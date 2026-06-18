export type CatalogMarketSegment =
  | "truck"
  | "bus"
  | "agriculture"
  | "marine"
  | "passenger_car"
  | "industrial";

const SEGMENT_OPTIONS: Array<{ value: CatalogMarketSegment; label: string }> = [
  { value: "truck", label: "Truck" },
  { value: "bus", label: "Bus" },
  { value: "agriculture", label: "Agriculture" },
  { value: "marine", label: "Marine" },
  { value: "passenger_car", label: "Passenger Car" },
  { value: "industrial", label: "Industrial" },
];

const SEGMENT_LABELS = new Map<string, string>(SEGMENT_OPTIONS.map((option) => [option.value, option.label]));
const SEGMENT_ALIASES: Record<string, CatalogMarketSegment> = {
  pkw: "passenger_car",
  passengercar: "passenger_car",
  passenger_vehicle: "passenger_car",
  passengervehicle: "passenger_car",
  lkw: "truck",
  commercial: "truck",
  commercial_vehicle: "truck",
  commercialvehicle: "truck",
  light_commercial: "truck",
  lightcommercial: "truck",
  light_commercial_vehicle: "truck",
  lightcommercialvehicle: "truck",
  truck_bus_commercial: "truck",
  truck_bus_light_commercial: "truck",
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
    case "truck":
    case "bus":
    case "agriculture":
    case "marine":
    case "passenger_car":
    case "industrial":
      return text;
    default:
      return null;
  }
}

export function formatCatalogMarketSegmentLabel(value: string | null | undefined) {
  const normalized = normalizeCatalogMarketSegment(value);
  if (!normalized) return "-";
  return SEGMENT_LABELS.get(normalized) || normalized;
}
