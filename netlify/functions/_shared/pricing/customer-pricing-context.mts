import { normalizeCustomerPricingType, requireActiveCustomerPricing } from "./pricing-policy.mts";

const CUSTOMER_META_PREFIX = "[[NEXT_MASTER_META]]";

type CustomerPriceFields = {
  custom_fields?: unknown;
  price_list_type?: string | null;
  price_list_margin_percent?: number | string | null;
  currency?: string | null;
};

type PriceListFields = {
  list_type?: unknown;
  margin_percent?: unknown;
};

export function parseEmbeddedCustomerMeta(raw: unknown): Record<string, unknown> {
  const text = String(raw || "");
  const markerIndex = text.lastIndexOf(CUSTOMER_META_PREFIX);
  if (markerIndex < 0) return {};
  const jsonText = text.slice(markerIndex + CUSTOMER_META_PREFIX.length).trim();
  try {
    return (JSON.parse(jsonText) as Record<string, unknown>) || {};
  } catch {
    return {};
  }
}

function getEmbeddedCustomerPriceListType(meta: Record<string, unknown>) {
  const value = String(meta.price_list_type || "").trim();
  if (value === "A" || value === "B" || value === "C" || value === "Other") return value;
  return "";
}

/** Shared portal/worker pricing rules. Callers supply active lists in newest-first order. */
export function deriveCustomerPriceListSettings(customer: CustomerPriceFields, priceLists: PriceListFields[]) {
  const meta = parseEmbeddedCustomerMeta(customer.custom_fields);
  const byType = new Map<string, PriceListFields>();
  for (const row of priceLists) {
    const type = String(row.list_type || "");
    if (type && !byType.has(type)) byType.set(type, row);
  }
  const defaultMarginA = byType.get("A")?.margin_percent == null ? 10 : Number(byType.get("A")?.margin_percent);
  const defaultMarginB = byType.get("B")?.margin_percent == null ? 15 : Number(byType.get("B")?.margin_percent);
  const customerType = normalizeCustomerPricingType(String(customer.price_list_type || getEmbeddedCustomerPriceListType(meta) || "A"));
  const marginOverrideRaw = customer.price_list_margin_percent == null
    ? meta.price_list_margin_percent : customer.price_list_margin_percent;
  const marginOverride = marginOverrideRaw == null || String(marginOverrideRaw).trim() === ""
    ? null : Number(marginOverrideRaw);
  requireActiveCustomerPricing(customerType, marginOverride);
  const currency = String(customer.currency || "EUR").trim().toUpperCase();
  if (currency !== "EUR") {
    throw new Error("Live supplier prices are in EUR. Customer currency conversion is required before pricing this account.");
  }
  return {
    customerType,
    currency,
    effectiveMarginA: (customerType === "A" || customerType === "Other") && marginOverride != null
      ? marginOverride : defaultMarginA,
    effectiveMarginB: customerType === "B" && marginOverride != null
      ? marginOverride : defaultMarginB,
    cPriceListIds: [] as string[],
  };
}
