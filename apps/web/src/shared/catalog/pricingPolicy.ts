export type CustomerPricingType = "A" | "B" | "C" | "Other";
export type CustomerPricingMode = "standard" | "prefer_c_when_available";

export function shouldUseCPriceForCustomer(
  customerType: CustomerPricingType,
  pricingMode: CustomerPricingMode,
) {
  return customerType === "C" || pricingMode === "prefer_c_when_available";
}

export function normalizeQuoteCustomerTypeForRpc(customerType: CustomerPricingType) {
  return customerType === "Other" ? "A" : customerType;
}

export function normalizeSupplierQuoteCustomerType(customerType: CustomerPricingType) {
  return customerType === "B" ? "B" : "A";
}

