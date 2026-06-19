export type CustomerPricingType = "A" | "B" | "C" | "Other";
export type CustomerPricingMode = "standard" | "prefer_c_when_available";

export function normalizeCustomerPricingType(value: string): CustomerPricingType {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "a" || normalized === "a price list") return "A";
  if (normalized === "b" || normalized === "b price list") return "B";
  if (normalized === "c" || normalized === "c price list") return "C";
  if (normalized === "other" || normalized === "other margin") return "Other";
  return "A";
}

export function shouldUseCPriceForCustomer(customerType: CustomerPricingType, pricingMode: CustomerPricingMode) {
  return customerType === "C" || pricingMode === "prefer_c_when_available";
}

export function getSupplierFallbackCustomerType(customerType: CustomerPricingType) {
  return customerType === "B" ? "B" : "A";
}

export function getDisplayPriceListType(customerType: CustomerPricingType) {
  return customerType === "C" ? "C" : customerType;
}
