export type PaymentDraftEditor<T> = {
  // The original persisted identity, never the editable/new draft ID.
  persistedId: string;
  draft: T | null;
};

export function newPaymentDraft<T extends { id: string }>(draft: T): PaymentDraftEditor<T> {
  return { persistedId: "", draft: { ...draft } };
}

export function selectPaymentDraft<T extends { id: string }>(row: T): PaymentDraftEditor<T> {
  return { persistedId: row.id, draft: { ...row } };
}

export function initializePaymentDraft<T extends { id: string }>(
  current: PaymentDraftEditor<T>,
  rows: readonly T[],
): PaymentDraftEditor<T> {
  // Collection loading/refresh is not an editor selection. Preserve both new
  // drafts and unsaved edits even when the selected ID is absent from the list.
  if (current.draft || !rows.length) return current;
  return selectPaymentDraft(rows[0]);
}

export function updatePaymentDraft<T>(
  current: PaymentDraftEditor<T>,
  update: T | null | ((draft: T | null) => T | null),
): PaymentDraftEditor<T> {
  return { ...current, draft: typeof update === "function" ? (update as (draft: T | null) => T | null)(current.draft) : update };
}
