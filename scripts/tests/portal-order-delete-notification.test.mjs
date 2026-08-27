import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const portalPage = fs.readFileSync(new URL("../../apps/web/src/modules/portal/pages/PortalPage.tsx", import.meta.url), "utf8");
const portalAccess = fs.readFileSync(new URL("../../netlify/functions/_shared/portal-access.mts", import.meta.url), "utf8");
const migration = fs.readFileSync(new URL("../../supabase/migrations/20260827090000_portal_sales_order_delete_notifications.sql", import.meta.url), "utf8");

test("customer portal exposes delete only for unsubmitted portal drafts", () => {
  assert.match(portalPage, /function canDeletePortalSalesOrder\(row: PortalSalesOrderRow\)/);
  assert.match(portalPage, /row\.source_channel === "portal" && !row\.portal_submitted_at/);
  assert.match(portalPage, /handleDeletePortalDraft\(row\)/);
});

test("portal snapshot reads seller deletion notifications without exposing audit logs directly", () => {
  assert.match(portalAccess, /fetchPortalNotifications\(/);
  assert.match(portalAccess, /event_type: "eq\.sales_order_deleted_by_admin"/);
  assert.match(portalAccess, /notifications,/);
});

test("admin confirmed-order deletion is guarded and emits a portal event", () => {
  assert.match(migration, /v_status = 'confirmed' and \(v_role = 'admin' or public\.is_superadmin\(\)\)/);
  assert.match(migration, /Sales order has downstream documents and cannot be deleted/);
  assert.match(migration, /sales_order_deleted_by_admin/);
  assert.match(migration, /portal_invite_id/);
});
