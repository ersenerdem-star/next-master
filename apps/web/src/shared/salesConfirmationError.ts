/** Explain server confirmation rejections without suggesting a retry can overwrite documents. */
export function salesConfirmationError(error: unknown, locale: string): string | null {
  const message = error instanceof Error ? error.message : "";
  const tr = locale === "tr";
  if (message.includes("SALES_CONFIRMATION_QUANTITY_RECHECK_REQUIRED") || message.includes("SALES_DRAFT_QUANTITY_RECHECK_REQUIRED")) return tr
    ? "Adet kademesi değişen bir satır var. Güncel tedarikçi seçeneklerini yenileyip fiyatı seçin; sonra siparişi onaylayın."
    : "A line's quantity tier changed. Refresh supplier options and select the current price before confirming.";
  if (message.includes("SALES_CONFIRMATION_HAS_DOCUMENTS")) return tr
    ? "Bu siparişe bağlı satın alma siparişi veya fatura var. Mevcut belgeleri kontrol etmeden onaylanamaz."
    : "This order already has purchase orders or invoices. Review those documents before confirming.";
  if (message.includes("SALES_CONFIRMATION_ALREADY_CONFIRMED")) return tr
    ? "Sipariş zaten onaylı. Güncel durumu görmek için siparişi yeniden açın."
    : "This order is already confirmed. Reopen it to see its current status.";
  if (message.includes("SALES_CONFIRMATION_PRICE_INVALID") || message.includes("SALES_CONFIRMATION_LINES_INVALID")) return tr
    ? "Her satırın parça kodu, miktarı, alış ve satış fiyatı geçerli ve sıfırdan büyük olmalı."
    : "Each line needs a valid part code and positive quantity, purchase price and sales price.";
  if (message.includes("PURCHASE_VENDOR_NOT_FOUND") || message.includes("PURCHASE_VENDOR_AMBIGUOUS") || message.includes("PURCHASE_VENDOR_INPUT_INVALID")) return tr
    ? "Satırlardaki tedarikçilerden biri bulunamadı veya birden fazla kayıtla eşleşiyor. Tedarikçiyi kontrol edin."
    : "A line supplier could not be resolved uniquely. Check the supplier setup.";
  if (message.includes("SALES_CONFIRMATION_DECISION_MISMATCH")) return tr
    ? "Önceki onay denemesi farklı bilgiler içeriyor. Siparişin güncel durumunu açıp kontrol edin."
    : "The previous confirmation attempt had different details. Reopen and review the order.";
  return null;
}
