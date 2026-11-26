import test from "node:test";
import assert from "node:assert/strict";
import { documentNumberError } from "../../apps/web/src/shared/documentNumberError";

test("document-number collisions give an actionable message for each document type", () => {
  assert.match(documentNumberError(new Error("SALES_ORDER_NUMBER_ALREADY_USED"), "tr", "failed"), /siparişi numarası zaten kullanılıyor.*başka/i);
  assert.match(documentNumberError(new Error("INVOICE_NUMBER_ALREADY_USED"), "tr", "failed"), /fatura numarası zaten kullanılıyor.*başka/i);
  assert.match(documentNumberError({message:"INVOICE_NUMBER_ALREADY_USED"}, "en", "failed"), /invoice number is already in use/i);
});

test("unrelated errors remain visible", () => {
  assert.equal(documentNumberError(new Error("Original failure"), "tr", "fallback"), "Original failure");
  assert.equal(documentNumberError(null, "tr", "fallback"), "fallback");
});
