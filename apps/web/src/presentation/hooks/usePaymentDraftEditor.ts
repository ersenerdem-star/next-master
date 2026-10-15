import { useCallback, useEffect, useState } from "react";
import { initializePaymentDraft, newPaymentDraft, selectPaymentDraft, updatePaymentDraft, type PaymentDraftEditor } from "../../shared/paymentDraftEditor";

export function usePaymentDraftEditor<T extends { id: string }>(rows: readonly T[]) {
  const [editor, setEditor] = useState<PaymentDraftEditor<T>>({ persistedId: "", draft: null });
  useEffect(() => {
    setEditor((current) => initializePaymentDraft(current, rows));
  }, [rows]);
  const setDraft = useCallback((update: T | null | ((draft: T | null) => T | null)) => {
    setEditor((current) => updatePaymentDraft(current, update));
  }, []);
  const startNew = useCallback((draft: T) => setEditor(newPaymentDraft(draft)), []);
  const selectExisting = useCallback((row: T) => setEditor(selectPaymentDraft(row)), []);
  return { draft: editor.draft, persistedId: editor.persistedId, setDraft, startNew, selectExisting };
}
