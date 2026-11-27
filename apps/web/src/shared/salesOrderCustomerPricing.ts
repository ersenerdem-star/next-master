import { markupMoney } from "../../../../shared/order-money.mjs";
import type { QuoteBuilderLine } from "../types/quoteBuilder";

export type SalesOrderPricingContext = {
  workbenchMode: "new" | "existing";
  hasCustomerProfile: boolean;
  customerType: "A" | "B" | "C" | "Other";
  marginA: number;
  marginB: number;
  customerId?: string | null;
  pricingBlocked?: boolean;
};

// Customer changes intentionally do not change this token. Opening, replacing,
// clearing or leaving an editor does; late responses must not cross editors.
export function isSalesOrderWorkCurrent(startedGeneration: number, currentGeneration: number) {
  return startedGeneration === currentGeneration;
}

// Only a new line or an explicitly marked pending line may be repriced.
// Existing historical lines never acquire the marker simply by being opened.
export function applySalesOrderCustomerPricing(lines: QuoteBuilderLine[], context: SalesOrderPricingContext): QuoteBuilderLine[] {
  let changed = false;
  const result = lines.map((line) => {
    const isNew = context.workbenchMode === "new";
    const pending = line.customer_pricing_pending === true;
    if (!isNew && !pending) return line;
    if (!isNew && line.sell_price != null) return line;
    if (!context.hasCustomerProfile || context.pricingBlocked) {
      if (!isNew) return line;
      const optionChanged = line.supplierOptions.some((option) => option.sell_price != null);
      const nextSell = line.manual_sell_price ? line.sell_price : null;
      const nextPending = !line.manual_sell_price;
      if (line.sell_price === nextSell && Boolean(line.customer_pricing_pending) === nextPending && !optionChanged && line.c_sell_price == null) return line;
      changed = true;
      return { ...line, sell_price: nextSell, c_sell_price: null, customer_pricing_pending: nextPending,
        supplierOptions: line.supplierOptions.map((option) => option.sell_price == null ? option : { ...option, sell_price: null }) };
    }
    // The retired C list does not have a safe automatic price. Its caller
    // surfaces the existing account configuration error instead.
    if (context.customerType === "C") return line;
    const margin = context.customerType === "B" ? context.marginB : context.marginA;
    const selected = line.supplierOptions.find((option, index) => `${option.supplier_name}-${index}` === line.selectedSupplierKey)
      || line.supplierOptions[0] || null;
    const preserveSupplierChoice = line.supplier_override_keep_sell_price === true;
    // An explicitly chosen supplier is a procurement decision. Customer
    // pricing uses the original price basis, including an unknown/null basis.
    const buyPrice = preserveSupplierChoice
      ? line.customer_price_basis_buy_price ?? null
      : selected?.buy_price ?? line.buy_price;
    const pricingKey = JSON.stringify([context.customerId ?? "", context.customerType, margin]);
    // Do not replace an existing agreed sale price merely because the
    // supplier changed. An explicit customer/profile change may reprice a
    // new or pending line using its original basis, never the new supplier.
    const preserveSale = preserveSupplierChoice && line.sell_price != null && !pending
      && (!line.customer_price_basis_context_key || line.customer_price_basis_context_key === pricingKey);
    const nextSell = line.manual_sell_price || preserveSale ? line.sell_price : buyPrice == null ? null : markupMoney(buyPrice, margin);
    // Once a customer was selected this is no longer waiting for customer
    // selection, even when the supplier has no available purchase price.
    const nextPending = false;
    const optionChanged = line.supplierOptions.some((option) => option.sell_price !== (option.buy_price == null ? null : markupMoney(option.buy_price, margin)));
    if (line.sell_price === nextSell && Boolean(line.customer_pricing_pending) === nextPending && !optionChanged
      && (!preserveSupplierChoice || line.customer_price_basis_context_key === pricingKey)) return line;
    changed = true;
    return { ...line, sell_price: nextSell, customer_pricing_pending: nextPending,
      ...(preserveSupplierChoice ? { customer_price_basis_context_key: pricingKey } : {}),
      supplierOptions: line.supplierOptions.map((option) => ({ ...option, sell_price: option.buy_price == null ? null : markupMoney(option.buy_price, margin) })) };
  });
  return changed ? result : lines;
}
