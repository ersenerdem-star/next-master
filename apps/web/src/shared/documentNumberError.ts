import { orderConcurrencyError } from "./orderConcurrencyError";

/** Turn server-side document errors into actionable feedback. */
export function documentNumberError(error: unknown, locale: string, fallback: string): string {
  const message = error instanceof Error ? error.message
    : error && typeof error === "object" && "message" in error ? String(error.message || "") : "";
  if (/\b(?:SALES|PURCHASE)_ORDER_(?:STALE_VERSION|VERSION_REQUIRED)\b/.test(message)) {
    return orderConcurrencyError(error, locale, fallback);
  }
  if (message.includes("INVOICE_SOURCE_ORDER_STALE")) {
    return locale === "tr"
      ? "Satış siparişi değişti. Fatura oluşturmadan önce siparişi yeniden açıp kontrol edin."
      : "The sales order changed. Reopen and review it before creating the invoice.";
  }
  if (message.includes("SALES_ORDER_ALREADY_INVOICED")) {
    return locale === "tr"
      ? "Bu sipariş için zaten fatura var. Fatura listesini kontrol edin; tekrar tam fatura oluşturulmadı."
      : "An invoice already exists for this order. Check the invoice list; no duplicate full invoice was created.";
  }
  if (message.includes("INVOICE_SOURCE_PRICE_MISSING")) {
    return locale === "tr"
      ? "Fatura oluşturmadan önce siparişteki eksik alış ve satış fiyatlarını tamamlayın."
      : "Complete the missing purchase and sales prices before creating the invoice.";
  }
  if (message.includes("SALES_ORDER_NOT_CONFIRMED")) {
    return locale === "tr" ? "Yalnız onaylı siparişlerden fatura oluşturulabilir." : "Only confirmed orders can be invoiced.";
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
  if (message.includes("PAYMENT_NUMBER_ALREADY_USED")) {
    return locale === "tr"
      ? "Bu ödeme veya tahsilat numarası zaten kullanılıyor. Lütfen başka bir numara girin."
      : "This payment number is already in use. Enter a different number.";
  }
  return message || fallback;
}
