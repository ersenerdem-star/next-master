export type CustomerPricingType = "A" | "B" | "C" | "Other";

export function normalizeCustomerPricingType(value: string): CustomerPricingType {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "a" || normalized === "a price list") return "A";
  if (normalized === "b" || normalized === "b price list") return "B";
  if (normalized === "c" || normalized === "c price list") return "C";
  if (normalized === "other" || normalized === "other margin") return "Other";
  throw new Error("Customer price profile is invalid. Select A, B, or Other on the customer account.");
}

export function requireActiveCustomerPricing(customerType: CustomerPricingType, marginOverride: number | null) {
  if (customerType === "C") {
    throw new Error("The retired C price list cannot be used. Select A, B, or Other on the customer account.");
  }
  if (marginOverride != null && !Number.isFinite(marginOverride)) {
    throw new Error("Customer account margin must be a valid number.");
  }
  if (customerType === "Other" && marginOverride == null) {
    throw new Error("Enter a custom margin on the customer account before using Other pricing.");
  }
}

export function shouldUseCPriceForCustomer(customerType: CustomerPricingType) {
  return customerType === "C";
}

export function getSupplierFallbackCustomerType(customerType: CustomerPricingType) {
  return customerType === "B" ? "B" : "A";
}

export function getDisplayPriceListType(customerType: CustomerPricingType) {
  return customerType === "C" ? "C" : customerType;
}
