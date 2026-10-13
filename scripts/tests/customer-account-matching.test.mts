import test from "node:test";
import assert from "node:assert/strict";
import {
  assertInvoiceCustomerBinding,
  assertInvoiceCustomerNameUnchanged,
  findCustomerByNameInList,
  findUniqueCustomerByNameInList,
  resolveCustomerIdFromLinkedSalesOrders,
  resolveUniqueCustomerIdFromMatches,
} from "../../apps/web/src/shared/customerAccountMatching.ts";

test("invoice repricing cannot choose an arbitrary account when names overlap", () => {
  const accounts = [
    { id: "a", display_name: "Acme", company_name: "Acme Trading" },
    { id: "b", display_name: "Other", company_name: "Acme" },
  ];
  assert.equal(findCustomerByNameInList(accounts, "acme")?.id, "a");
  assert.throws(() => findUniqueCustomerByNameInList(accounts, " ACME "), /ambiguous/);
  assert.equal(findUniqueCustomerByNameInList(accounts, "Acme Trading")?.id, "a");
  assert.equal(findUniqueCustomerByNameInList(accounts, "Unknown"), null);
  assert.equal(findUniqueCustomerByNameInList(accounts, ""), null);
});

test("a legacy bound customer id cannot bypass an ambiguous global name", () => {
  assert.throws(
    () => resolveUniqueCustomerIdFromMatches([
      { customer_id: "ea0f3ef0-d5a6-41cc-b58b-789ca07c31bd" },
      { customer_id: "5621d474-d090-4612-b181-8ca80a289fa1" },
    ]),
    /ambiguous/,
  );
});

test("unbound invoice price refresh fails closed on two database matches", () => {
  assert.equal(resolveUniqueCustomerIdFromMatches([]), null);
  assert.equal(resolveUniqueCustomerIdFromMatches([{ customer_id: "a" }]), "a");
  assert.throws(
    () => resolveUniqueCustomerIdFromMatches([{ customer_id: "a" }, { customer_id: "b" }]),
    /ambiguous/,
  );
});

test("edited invoice customer name must be saved before price refresh", () => {
  assert.doesNotThrow(() => assertInvoiceCustomerNameUnchanged(" Acme ", "ACME"));
  assert.throws(() => assertInvoiceCustomerNameUnchanged("Acme", "Another account"), /Save the invoice/);
});

test("a stale invoice customer id cannot price a renamed invoice for the former account", () => {
  assert.throws(
    () => assertInvoiceCustomerBinding("old-account", "new-account", "old-account"),
    /customer name and account ID differ/,
  );
  assert.doesNotThrow(() => assertInvoiceCustomerBinding("old-account", "old-account", null));
});

test("the linked sales order preserves a legitimate historical customer name after account rename", () => {
  assert.doesNotThrow(() => assertInvoiceCustomerBinding("same-account", null, "same-account"));
  assert.throws(
    () => assertInvoiceCustomerBinding("same-account", null, "different-account"),
    /customer name and account ID differ/,
  );
  assert.throws(() => assertInvoiceCustomerBinding("same-account", null, null), /customer name and account ID differ/);
});

test("a null invoice customer id can use only unanimous linked sales order identity", () => {
  const linkedIds = ["so-1", "so-2"];
  const rows = [
    { id: "so-1", customer_id: "account-a", customer_name: "Former Name" },
    { id: "so-2", customer_id: "account-a", customer_name: " former name " },
  ];
  assert.equal(resolveCustomerIdFromLinkedSalesOrders("Former Name", linkedIds, rows), "account-a");
  assert.equal(resolveCustomerIdFromLinkedSalesOrders("Former Name", linkedIds, rows.slice(0, 1)), null);
  assert.equal(resolveCustomerIdFromLinkedSalesOrders("Former Name", linkedIds, [
    rows[0], { ...rows[1], customer_id: "account-b" },
  ]), null);
  assert.equal(resolveCustomerIdFromLinkedSalesOrders("Former Name", linkedIds, [
    rows[0], { ...rows[1], customer_name: "Another Customer" },
  ]), null);
});
