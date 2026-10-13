import type { LocalCustomer } from "../types/customers";

function matchingCustomersByName<T extends Pick<LocalCustomer, "display_name" | "company_name">>(customers: T[], name: string) {
  const key = name.trim().toLowerCase();
  if (!key) return [];
  return customers.filter((item) =>
    item.display_name.trim().toLowerCase() === key || item.company_name.trim().toLowerCase() === key);
}

export function findCustomerByNameInList<T extends Pick<LocalCustomer, "display_name" | "company_name">>(customers: T[], name: string) {
  return matchingCustomersByName(customers, name)[0] || null;
}

export function findUniqueCustomerByNameInList<T extends Pick<LocalCustomer, "display_name" | "company_name">>(customers: T[], name: string) {
  const matches = matchingCustomersByName(customers, name);
  if (matches.length > 1) {
    throw new Error("Customer account name is ambiguous. Give the matching accounts distinct display names before refreshing prices.");
  }
  return matches[0] || null;
}

export function resolveUniqueCustomerIdFromMatches(nameMatches: Array<{ customer_id: string }>) {
  const ids = [...new Set(nameMatches.map((match) => String(match.customer_id || "").trim()).filter(Boolean))];
  if (ids.length > 1) {
    throw new Error("Customer account name is ambiguous. Give the matching accounts distinct display names before refreshing prices.");
  }
  return ids[0] || null;
}

export function assertInvoiceCustomerNameUnchanged(savedName: string, draftName: string) {
  if (savedName.trim().toLowerCase() !== draftName.trim().toLowerCase()) {
    throw new Error("Save the invoice customer name before refreshing prices.");
  }
}

export function resolveCustomerIdFromLinkedSalesOrders(
  invoiceCustomerName: string,
  linkedSalesOrderIds: string[],
  orders: Array<{ id: string; customer_id?: string | null; customer_name: string }>,
) {
  const nameKey = invoiceCustomerName.trim().toLowerCase();
  const ids = [...new Set(linkedSalesOrderIds.map((id) => id.trim()).filter(Boolean))];
  if (!nameKey || !ids.length || orders.length !== ids.length) return null;
  const byId = new Map(orders.map((order) => [order.id, order]));
  if (byId.size !== ids.length) return null;
  let customerId = "";
  for (const id of ids) {
    const order = byId.get(id);
    const orderCustomerId = String(order?.customer_id || "").trim();
    if (!orderCustomerId || order?.customer_name.trim().toLowerCase() !== nameKey) return null;
    if (customerId && customerId !== orderCustomerId) return null;
    customerId = orderCustomerId;
  }
  return customerId || null;
}

export function assertInvoiceCustomerBinding(
  accountId: string,
  uniqueCurrentNameCustomerId: string | null,
  linkedSalesOrderCustomerId: string | null,
) {
  if (uniqueCurrentNameCustomerId === accountId) return;
  if (uniqueCurrentNameCustomerId) {
    throw new Error("Invoice customer name and account ID differ. Resolve the customer link before refreshing prices.");
  }
  if (linkedSalesOrderCustomerId === accountId) return;
  throw new Error("Invoice customer name and account ID differ. Resolve the customer link before refreshing prices.");
}
