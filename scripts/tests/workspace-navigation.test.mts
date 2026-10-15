import test from "node:test";
import assert from "node:assert/strict";
import { workspaceNavigationItems, resolveWorkspaceDestination } from "../../apps/web/src/modules/admin/workspaceNavigation.ts";

const pages = ["Home", "Items", "CatalogReview", "Inventory", "Purchases", "Sales", "Reports", "Settings", "Messages", "Mira"].map((key) => ({ key, label: key }));
const sections = {
  Items: ["Catalog", "Code References"], CatalogReview: ["Observation Review"],
  Inventory: ["Warehouses", "Purchase Receives", "Stock Movements", "On Hand", "Transfers"],
  Purchases: ["Vendors", "Supplier Prices", "Purchase Orders", "Bills", "Payments Made"],
  Sales: ["Customers", "Sales Orders", "Invoices", "Payments Received", "Price Lists"],
  Reports: ["Procurement Dashboard", "Master", "Core Reports", "Item Transactions", "Inventory Analytics", "Status Center"],
  Settings: ["session", "users", "companies", "portals", "templates", "emails", "diagnostics"],
};
const labelled = Object.fromEntries(Object.entries(sections).map(([page, rows]) => [page, rows.map((key) => ({ key, label: key }))]));

test("every existing authorized screen has one unambiguous desktop destination", () => {
  const items = workspaceNavigationItems(pages, labelled).flatMap((group) => group.items);
  for (const [page, children] of Object.entries(sections)) {
    for (const section of children) {
      assert.equal(items.filter((item) => item.page === page && item.section === section).length, 1, `${page}/${section}`);
      assert.deepEqual(resolveWorkspaceDestination(page, section, pages, labelled), { page, section });
    }
  }
  assert.equal(items.filter((item) => item.page === "Home").length, 1);
  assert.equal(items.filter((item) => item.page === "Messages").length,1);
  assert.deepEqual(resolveWorkspaceDestination("Messages",undefined,pages,labelled),{page:"Messages"});
});

test("supplier upload compatibility selects the real price workspace; report tabs stay distinct", () => {
  assert.deepEqual(resolveWorkspaceDestination("Purchases", "Supplier Price Upload", pages, labelled), { page: "Purchases", section: "Supplier Prices" });
  assert.equal(resolveWorkspaceDestination("Reports", "Sales Reports", pages, labelled), null);
  for (const section of sections.Reports) assert.equal(resolveWorkspaceDestination("Reports", section, pages, labelled)?.section, section);
});

test("restricted actors cannot route through hidden parents or privileged subtabs", () => {
  const allowed = pages.filter((item) => ["Home", "Sales", "Settings"].includes(item.key));
  const scoped = { Sales: labelled.Sales.filter((item) => item.key !== "Price Lists"), Settings: labelled.Settings.filter((item) => item.key === "session") };
  const items = workspaceNavigationItems(allowed, scoped).flatMap((group) => group.items);
  assert.equal(resolveWorkspaceDestination("Reports", "Core Reports", allowed, scoped), null);
  assert.equal(resolveWorkspaceDestination("Sales", "Price Lists", allowed, scoped), null);
  assert.equal(resolveWorkspaceDestination("Settings", "users", allowed, scoped), null);
  assert.equal(items.some((item) => item.page === "Reports" || item.section === "users" || item.section === "Price Lists"), false);
  assert.deepEqual(resolveWorkspaceDestination("Settings", "session", allowed, scoped), { page: "Settings", section: "session" });
});
