import { orderConcurrencyError } from "./orderConcurrencyError";

/** Turn server-side document errors into actionable feedback. */
export function documentNumberError(error: unknown, locale: string, fallback: string): string {
  const message = error instanceof Error ? error.message
    : error && typeof error === "object" && "message" in error ? String(error.message || "") : "";
  if (/\b(?:SALES|PURCHASE)_ORDER_(?:STALE_VERSION|VERSION_REQUIRED)\b/.test(message)) {
    return orderConcurrencyError(error, locale, fallback);
  }
  if (message.includes("SALES_ORDER_NUMBER_ALREADY_USED")) {
    return locale === "tr"
      ? "Bu satış siparişi numarası zaten kullanılıyor. Lütfen başka bir sipariş numarası girin."
      : "This sales order number is already in use. Enter a different order number.";
  }
  if (message.includes("INVOICE_NUMBER_ALREADY_USED")) {
    return locale === "tr"
      ? "Bu fatura numarası zaten kullanılıyor. Lütfen başka bir fatura numarası girin."
      : "This invoice number is already in use. Enter a different invoice number.";
  }
  return message || fallback;
}
