import { fetchAppSession } from "./appSessionApi";

export async function getCurrentOrgId(forceRefresh = false) {
  const session = await fetchAppSession(forceRefresh);
  const organizationId = String(session.organizationId || "");
  if (!organizationId) throw new Error("No organization found for current user");
  return organizationId;
}

export function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.trim());
}
