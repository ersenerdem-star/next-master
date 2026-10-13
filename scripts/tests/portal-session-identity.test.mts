import test from "node:test";
import assert from "node:assert/strict";
import { isPortalSnapshotForEmail } from "../../apps/web/src/modules/portal/portalSessionIdentity.ts";
import type { PortalSnapshot } from "../../apps/web/src/types/portalSession.ts";

function snapshot(email: string) {
  return { invite: { email } } as PortalSnapshot;
}

test("portal session restore accepts only the saved account identity", () => {
  assert.equal(isPortalSnapshotForEmail(snapshot("Buyer@Example.com"), " buyer@example.com "), true);
  assert.equal(isPortalSnapshotForEmail(snapshot("other@example.com"), "buyer@example.com"), false);
  assert.equal(isPortalSnapshotForEmail(snapshot(""), "buyer@example.com"), false);
  assert.equal(isPortalSnapshotForEmail(snapshot("buyer@example.com"), ""), false);
});
