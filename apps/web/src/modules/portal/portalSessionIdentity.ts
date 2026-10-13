import type { PortalSnapshot } from "../../types/portalSession";

export function isPortalSnapshotForEmail(snapshot: PortalSnapshot, expectedEmail: string) {
  const expected = String(expectedEmail || "").trim().toLowerCase();
  const actual = String(snapshot?.invite?.email || "").trim().toLowerCase();
  return Boolean(expected && actual && expected === actual);
}
