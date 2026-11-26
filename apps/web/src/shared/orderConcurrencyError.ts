/** Report a stale editor without losing the user's unsaved edits. */
export function orderConcurrencyError(error: unknown, locale: string, fallback: string): string {
  const message = error instanceof Error ? error.message
    : error && typeof error === "object" && "message" in error ? String(error.message || "") : "";
  if (/\b(?:SALES|PURCHASE)_ORDER_(?:STALE_VERSION|VERSION_REQUIRED)\b/.test(message)) {
    return locale === "tr"
      ? "Bu sipariş başka bir işlemde değişmiş veya eski bir ekranda açılmış. Kaydetmeden önce siparişi yeniden açıp değişiklikleri kontrol edin."
      : "This order changed elsewhere or was opened in an older session. Reopen it and review your changes before saving.";
  }
  return message || fallback;
}
